import React, { useState } from 'react';
import { getConversationToken } from '../lib/auth';
import { getAtprotoIdentity } from '../lib/atproto-session';
import { createStatementRecord } from '../lib/atproto-records';
import PolisNet from '../lib/net';

const submitPerspectiveAPI = async (text, conversation_id, anonymous = false) => {
  const decodedToken = getConversationToken(conversation_id);
  const pid = decodedToken?.pid;

  const data = {
    txt: text,
    conversation_id,
    pid,
    vote: -1,
  };

  if (anonymous) {
    data._anonymous = true;
  }

  try {
    const resp = await PolisNet.polisPost('/comments', data);
    return resp;
  } catch (error) {
    console.error("Comment submission failed:", error);
    throw error;
  }
};


export default function SurveyForm({ s, conversation_id, conversationAt, isLoggedIn, authRequired }) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  const [commentError, setCommentError] = useState('');
  const [submitAnonymously, setSubmitAnonymously] = useState(false);
  const maxLength = 400;

  const showAnonymousToggle = isLoggedIn && !authRequired;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    const submittedText = text;
    const isAnonymous = submitAnonymously;
    setText('');
    try {
      // 1. Create record in user's repo FIRST (skip if anonymous)
      let atRecord = null;
      if (!isAnonymous && conversationAt?.uri && conversationAt?.cid) {
        atRecord = await createStatementRecord({
          conversationUri: conversationAt.uri,
          conversationCid: conversationAt.cid,
          text: submittedText,
        });
      }

      // 2. Submit to assembly server
      const result = await submitPerspectiveAPI(submittedText, conversation_id, isAnonymous);

      // 3. Store AT URI on server for future strongRefs (skip if anonymous)
      if (!isAnonymous && atRecord && result?.tid) {
        PolisNet.polisPost('/atproto/statement-record', {
          conversation_id,
          tid: result.tid,
          at_uri: atRecord.uri,
          at_cid: atRecord.cid,
        }).catch(() => {});
      }

      setFeedback(s.commentSent);
    } catch (error) {
      const errorText = error.responseText || error.message || '';
      if (errorText.includes('polis_err_post_votes_social_needed') ||
          errorText.includes('polis_err_post_comment_social_needed')) {
        setFeedback('');
        setText(submittedText);
        setCommentError('You need to sign in to submit a comment.');
      } else {
        setFeedback(s.commentSent || 'Comment submitted.');
      }
    }
  };

  return (
    <div>
      <div className="guidelines">
        <p dangerouslySetInnerHTML={{ __html: s.writeCommentHelpText }}/>
        <h2>{s.helpWriteListIntro}</h2>
        <ul>
          <li>{s.helpWriteListStandalone}</li>
          <li>{s.helpWriteListRaisNew}</li>
          <li>{s.helpWriteListShort}</li>
        </ul>
        <p dangerouslySetInnerHTML={{ __html: s.tipCommentsRandom }}></p>
      </div>
      <form className="submit-form" onSubmit={handleSubmit}>
        <div className="textarea-wrapper">
          <textarea
            placeholder={s.writePrompt}
            value={text}
            onChange={(e) => { setText(e.target.value); setFeedback(''); }}
            maxLength={maxLength}
          />
          <div className="char-counter">
            {text.length} / {maxLength}
          </div>
        </div>
        {showAnonymousToggle && (
          <label className="anonymous-toggle">
            <input
              type="checkbox"
              checked={submitAnonymously}
              onChange={(e) => setSubmitAnonymously(e.target.checked)}
            />
            Submit anonymously
          </label>
        )}
        <button type="submit" className="submit-button" disabled={!text.trim()}>
          {s.submitComment}
        </button>
      </form>
      {feedback && <p style={{ color: '#28a745', fontWeight: 'bold', marginTop: '0.5rem' }}>{feedback}</p>}
      {commentError && <p className="comment-error">{commentError}</p>}
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { getAtprotoIdentity } from '../lib/atproto-session';
import { getConversationToken } from '../lib/auth';
import PolisNet from '../lib/net';
import AtprotoLogin from './AtprotoLogin';
import UserIdentity from './UserIdentity';
import Survey from './Survey';
import SurveyForm from './SurveyForm';
import TopicAgenda from './topicAgenda/TopicAgenda';

export default function ConversationGate({
  conversation_id,
  initialStatement,
  authNeededToVote,
  authNeededToWrite,
  importanceEnabled,
  s,
  introHtml,
}) {
  const [identity, setIdentity] = useState(null);
  const [checked, setChecked] = useState(false);
  const [ready, setReady] = useState(false);
  const [statement, setStatement] = useState(initialStatement);
  const [conversationAt, setConversationAt] = useState({ uri: null, cid: null });

  useEffect(() => {
    const id = getAtprotoIdentity();
    setIdentity(id);
    setChecked(true);

    // If authenticated, call participationInit client-side to get the correct XID JWT.
    // This ensures the xid → pid resolution happens and the JWT is stored for
    // subsequent calls (nextComment, votes) to use the correct pid.
    if (id) {
      const existingToken = getConversationToken(conversation_id);
      const isXidToken = existingToken?.xid_participant === true;

      if (!existingToken || !isXidToken) {
        PolisNet.polisGet('/participationInit', { conversation_id, includePCA: false })
          .then((data) => {
            if (data?.nextComment) {
              setStatement(data.nextComment);
            }
            if (data?.conversation?.at_uri) {
              setConversationAt({ uri: data.conversation.at_uri, cid: data.conversation.at_cid });
            }
            setReady(true);
          })
          .catch(() => setReady(true));
      } else {
        setReady(true);
      }
    } else {
      setReady(true);
    }
  }, [conversation_id]);

  if (!checked) return null;

  const needsAuth = authNeededToVote || authNeededToWrite;
  const isLoggedIn = identity !== null;

  if (needsAuth && !isLoggedIn) {
    return <AtprotoLogin conversation_id={conversation_id} s={s} />;
  }

  if (isLoggedIn && !ready) return null;

  return (
    <>
      {isLoggedIn && <UserIdentity identity={identity} />}

      <TopicAgenda conversation_id={conversation_id} />

      {introHtml && (
        <p
          className="conversation-intro"
          dangerouslySetInnerHTML={{ __html: introHtml }}
        />
      )}

      <Survey
        initialStatement={statement}
        conversation_id={conversation_id}
        importanceEnabled={importanceEnabled}
        conversationAt={conversationAt}
        s={s}
      />

      <SurveyForm s={s} conversation_id={conversation_id} conversationAt={conversationAt} />
    </>
  );
}

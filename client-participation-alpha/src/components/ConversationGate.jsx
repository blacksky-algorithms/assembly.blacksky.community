import React, { useState, useEffect } from 'react';
import { getAtprotoIdentity } from '../lib/atproto-session';
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
  s,
  introHtml,
}) {
  const [identity, setIdentity] = useState(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setIdentity(getAtprotoIdentity());
    setChecked(true);
  }, []);

  // Still checking localStorage — render nothing to avoid flash
  if (!checked) return null;

  const needsAuth = authNeededToVote || authNeededToWrite;
  const isLoggedIn = identity !== null;

  // Auth gate: require login before showing participation UI
  if (needsAuth && !isLoggedIn) {
    return (
      <AtprotoLogin conversation_id={conversation_id} s={s} />
    );
  }

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
        initialStatement={initialStatement}
        conversation_id={conversation_id}
        s={s}
      />

      <SurveyForm s={s} conversation_id={conversation_id} />
    </>
  );
}

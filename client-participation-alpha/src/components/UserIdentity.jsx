import React from 'react';
import { clearAtprotoIdentity } from '../lib/atproto-session';

export default function UserIdentity({ identity }) {
  if (!identity) return null;

  const handleSignOut = () => {
    clearAtprotoIdentity();
    window.location.reload();
  };

  return (
    <div className="user-identity">
      <img
        src={identity.avatarUrl || ''}
        alt={identity.displayName}
        className="user-identity-avatar"
        onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
      />
      <div className="user-identity-avatar user-identity-avatar-placeholder" style={{ display: identity.avatarUrl ? 'none' : 'block' }} />
      <a className="user-identity-info" href={`https://blacksky.community/profile/${identity.did}`} target="_blank" rel="noopener noreferrer">
        <span className="user-identity-name">{identity.displayName}</span>
        <span className="user-identity-handle">@{identity.handle}</span>
      </a>
      {identity.blackskyMember && <span className="blacksky-member-badge">Blacksky Member</span>}
      {identity.blackskyFunder && <span className="blacksky-funder-badge">Blacksky Funder</span>}
      <button className="user-identity-signout" onClick={handleSignOut}>
        Sign out
      </button>
    </div>
  );
}

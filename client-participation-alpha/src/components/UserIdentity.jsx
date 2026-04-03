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
      {identity.avatarUrl ? (
        <img
          src={identity.avatarUrl}
          alt={identity.displayName}
          className="user-identity-avatar"
        />
      ) : (
        <div className="user-identity-avatar user-identity-avatar-placeholder" />
      )}
      <div className="user-identity-info">
        <span className="user-identity-name">{identity.displayName}</span>
        <span className="user-identity-handle">@{identity.handle}</span>
      </div>
      <button className="user-identity-signout" onClick={handleSignOut}>
        Sign out
      </button>
    </div>
  );
}

import React from 'react';
import { clearAtprotoIdentity } from '../lib/atproto-session';

export default function UserIdentity({ identity }) {
  if (!identity) return null;

  const handleSignOut = () => {
    clearAtprotoIdentity();
    window.location.reload();
  };

  const badges = [];
  if (identity.blackskyTeam) badges.push({ cls: 'blacksky-team-badge', label: 'Admin' });
  if (identity.blackskyMember) badges.push({ cls: 'blacksky-member-badge', label: 'Blacksky Member' });
  if (identity.blackskyFunder) badges.push({ cls: 'blacksky-funder-badge', label: 'Blacksky Funder' });
  if (identity.ossSupporter) badges.push({ cls: 'oss-supporter-badge', label: 'Open Source Supporter' });

  return (
    <div className="user-identity">
      <img
        src={identity.avatarUrl || ''}
        alt={identity.displayName}
        className="user-identity-avatar"
        onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
      />
      <div className="user-identity-avatar user-identity-avatar-placeholder" style={{ display: identity.avatarUrl ? 'none' : 'block' }} />
      <div className="user-identity-content">
        <div className="user-identity-top-row">
          <a className="user-identity-info" href={`https://blacksky.community/profile/${identity.did}`} target="_blank" rel="noopener noreferrer">
            <span className="user-identity-name">{identity.displayName}</span>
            <span className="user-identity-handle">@{identity.handle}</span>
          </a>
          <button className="user-identity-signout" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
        {badges.length > 0 && (
          <div className="user-identity-badges">
            {badges.map(b => <span key={b.cls} className={b.cls}>{b.label}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

const STORAGE_KEY = 'atproto_identity';

export interface AtprotoIdentity {
  did: string;
  handle: string;
  displayName: string;
  avatarUrl: string;
  blackskyMember?: boolean;
  blackskyFunder?: boolean;
  blackskyTeam?: boolean;
  ossSupporter?: boolean;
}

export function setAtprotoIdentity(identity: AtprotoIdentity): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function getAtprotoIdentity(): AtprotoIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AtprotoIdentity;
  } catch {
    return null;
  }
}

export function clearAtprotoIdentity(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return getAtprotoIdentity() !== null;
}

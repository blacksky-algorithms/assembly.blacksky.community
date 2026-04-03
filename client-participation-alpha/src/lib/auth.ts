/**
 * Helper function to get conversation ID from current URL path
 * Handles URLs like /alpha/2demo or just /2demo
 */
export function getConversationIdFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const pathname = window.location.pathname;
  // Match patterns like /alpha/2demo or just /2demo
  // Conversation IDs start with a digit followed by alphanumeric chars
  const match = pathname.match(/^\/(?:alpha\/)?([0-9][0-9A-Za-z]+)/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Decodes a JWT from localStorage without verifying its signature.
 */
function _getJwtPayload(key: string) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const jwt = localStorage.getItem(key);
    if (!jwt) return null;

    const payloadBase64 = jwt.split('.')[1];
    if (!payloadBase64) return null;

    const jsonPayload = atob(payloadBase64);
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

export function getConversationToken(conversation_id: string) {
  if (typeof window === 'undefined') {
    return null;
  }
  const tokenKey = `participant_token_${conversation_id}`;
  const rawToken = localStorage.getItem(tokenKey);

  if (!rawToken) {
    return null;
  }

  const payload = _getJwtPayload(tokenKey);
  if (!payload) {
    return null;
  }

  return {
    token: rawToken,
    ...payload
  };
}

export function setJwtToken(token: string) {
  if (typeof window === 'undefined') return;

  try {
    if (!token) return;

    const conversationId = _getConversationIdFromDecodedJwt(token);
    if (!conversationId) return;

    const tokenKey = `participant_token_${conversationId}`;
    if (window.localStorage) {
      window.localStorage.setItem(tokenKey, token);
    }
  } catch (e) {
    console.error('[Auth] Error storing JWT token:', e);
  }
}

function _getConversationIdFromDecodedJwt(token: string) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload.conversation_id || null;
  } catch {
    return null;
  }
}

/**
 * Automatically extract and store JWT token from API response
 */
export function handleJwtFromResponse(response: any): void {
  if (typeof window === 'undefined') return;
  if (response && response.auth && response.auth.token) {
    setJwtToken(response.auth.token);
  }
}

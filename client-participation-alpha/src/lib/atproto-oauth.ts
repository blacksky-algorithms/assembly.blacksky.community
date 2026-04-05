import { BrowserOAuthClient } from '@atproto/oauth-client-browser';

const OAUTH_BASE_URL: string =
  import.meta.env.PUBLIC_OAUTH_BASE_URL || 'https://assembly.blacksky.community';

const OAUTH_CLIENT_NAME: string =
  import.meta.env.PUBLIC_OAUTH_CLIENT_NAME || "Blacksky People's Assembly";

const OAUTH_SCOPE = 'atproto transition:email rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview repo:community.blacksky.assembly.conversation repo:community.blacksky.assembly.statement repo:community.blacksky.assembly.vote';

function isLoopback(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1'
  );
}

// Ensure consistent origin for IndexedDB state storage in dev.
// OAuth state is origin-specific — localhost and 127.0.0.1 are different origins.
// Loopback OAuth requires 127.0.0.1 per RFC 8252, so redirect localhost → 127.0.0.1.
export function ensureConsistentOrigin(): void {
  if (typeof window === 'undefined') return;
  if (window.location.hostname === 'localhost') {
    const port = window.location.port ? `:${window.location.port}` : '';
    window.location.replace(`http://127.0.0.1${port}${window.location.pathname}${window.location.search}${window.location.hash}`);
  }
}

let oauthClient: BrowserOAuthClient | null = null;

function createOAuthClient(): BrowserOAuthClient {
  if (isLoopback()) {
    const port = window.location.port ? `:${window.location.port}` : '';
    const redirectUri = `http://127.0.0.1${port}/auth/callback`;
    const clientId =
      `http://localhost` +
      `?redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPE)}`;

    return new BrowserOAuthClient({
      clientMetadata: {
        client_id: clientId,
        redirect_uris: [redirectUri],
        scope: OAUTH_SCOPE,
        token_endpoint_auth_method: 'none',
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        application_type: 'web',
        dpop_bound_access_tokens: true,
      },
      handleResolver: 'https://bsky.social',
    });
  }

  return new BrowserOAuthClient({
    clientMetadata: {
      client_id: `${OAUTH_BASE_URL}/oauth-client-metadata.json`,
      client_name: OAUTH_CLIENT_NAME,
      client_uri: OAUTH_BASE_URL,
      redirect_uris: [`${OAUTH_BASE_URL}/auth/callback`],
      scope: OAUTH_SCOPE,
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'web',
      dpop_bound_access_tokens: true,
    },
    handleResolver: 'https://bsky.social',
  });
}

export function getOAuthClient(): BrowserOAuthClient {
  if (!oauthClient) {
    oauthClient = createOAuthClient();
  }
  return oauthClient;
}

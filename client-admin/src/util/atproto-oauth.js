import { BrowserOAuthClient } from '@atproto/oauth-client-browser'

const OAUTH_BASE_URL = process.env.OAUTH_BASE_URL || 'https://assembly.blacksky.community'
const OAUTH_CLIENT_NAME = process.env.OAUTH_CLIENT_NAME || "Blacksky People's Assembly"
const OAUTH_SCOPE = 'atproto rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview'

function isLoopback() {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

let oauthClient = null

function createOAuthClient() {
  if (isLoopback()) {
    const port = window.location.port ? `:${window.location.port}` : ''
    const redirectUri = `http://127.0.0.1${port}/`
    const clientId =
      `http://localhost` +
      `?redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(OAUTH_SCOPE)}`

    return new BrowserOAuthClient({
      clientMetadata: {
        client_id: clientId,
        redirect_uris: [redirectUri],
        scope: OAUTH_SCOPE,
        token_endpoint_auth_method: 'none',
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        application_type: 'web',
        dpop_bound_access_tokens: true
      },
      handleResolver: 'https://bsky.social'
    })
  }

  return new BrowserOAuthClient({
    clientMetadata: {
      client_id: `${OAUTH_BASE_URL}/oauth-client-metadata.json`,
      client_name: OAUTH_CLIENT_NAME,
      client_uri: OAUTH_BASE_URL,
      redirect_uris: [`${OAUTH_BASE_URL}/`],
      scope: OAUTH_SCOPE,
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'web',
      dpop_bound_access_tokens: true
    },
    handleResolver: 'https://bsky.social'
  })
}

export function getOAuthClient() {
  if (!oauthClient) {
    oauthClient = createOAuthClient()
  }
  return oauthClient
}

const IDENTITY_KEY = 'atproto_admin_identity'

export function setAtprotoIdentity(identity) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
}

export function getAtprotoIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function clearAtprotoIdentity() {
  localStorage.removeItem(IDENTITY_KEY)
}

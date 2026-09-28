import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import {
  ASSEMBLY_SERVICE_DID,
  CREATE_SESSION_METHOD,
  OAUTH_SCOPE,
  getOAuthClient
} from './atproto-oauth'

jest.mock('@atproto/oauth-client-browser', () => ({ BrowserOAuthClient: jest.fn() }))

const CREATE_SESSION_SCOPE = 'rpc:community.blacksky.assembly.createSession?aud=*'

describe('admin console OAuth request', () => {
  it('names the service and the method that sign-in proof is bound to', () => {
    expect(ASSEMBLY_SERVICE_DID).toBe('did:web:assembly.blacksky.community')
    expect(CREATE_SESSION_METHOD).toBe('community.blacksky.assembly.createSession')
  })

  it('requests the scope that lets a session obtain sign-in proof, and nothing broader', () => {
    expect(OAUTH_SCOPE.split(' ')).toEqual([
      'atproto',
      'transition:email',
      'rpc:app.bsky.actor.getProfile?aud=*',
      CREATE_SESSION_SCOPE,
      'repo:community.blacksky.assembly.conversation',
      'repo:community.blacksky.assembly.statement',
      'repo:community.blacksky.assembly.vote'
    ])
  })

  it('requests a scope for exactly the method it asks proof for', () => {
    expect(OAUTH_SCOPE.split(' ')).toContain(`rpc:${CREATE_SESSION_METHOD}?aud=*`)
  })

  it('hands the scope to the OAuth client it signs in with', () => {
    getOAuthClient()

    expect(BrowserOAuthClient).toHaveBeenCalledTimes(1)
    const { clientMetadata } = BrowserOAuthClient.mock.calls[0][0]
    expect(clientMetadata.scope).toBe(OAUTH_SCOPE)
    expect(clientMetadata.scope.split(' ')).toContain(CREATE_SESSION_SCOPE)
    expect(new URL(clientMetadata.client_id).searchParams.get('scope')).toBe(OAUTH_SCOPE)
  })
})

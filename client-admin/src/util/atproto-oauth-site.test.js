/**
 * @jest-environment-options {"url": "https://assembly.blacksky.community/signin"}
 */
import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import { OAUTH_SCOPE, getOAuthClient } from './atproto-oauth'

jest.mock('@atproto/oauth-client-browser', () => ({ BrowserOAuthClient: jest.fn() }))

describe('admin console OAuth request on the site itself', () => {
  it('names the published client document and requests the sign-in scope', () => {
    getOAuthClient()

    expect(BrowserOAuthClient).toHaveBeenCalledTimes(1)
    const { clientMetadata } = BrowserOAuthClient.mock.calls[0][0]
    expect(clientMetadata.scope).toBe(OAUTH_SCOPE)
    expect(clientMetadata.client_id).toBe(
      'https://assembly.blacksky.community/oauth-client-metadata.json'
    )
    expect(clientMetadata.redirect_uris).toEqual(['https://assembly.blacksky.community/'])
  })
})

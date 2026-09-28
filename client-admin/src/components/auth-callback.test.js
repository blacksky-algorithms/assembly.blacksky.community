import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../theme'
import AuthCallback from './auth-callback'

const mockInit = jest.fn()
const mockGetProfile = jest.fn()
const mockGetSession = jest.fn()
const mockGetServiceAuth = jest.fn()
const mockAgent = jest.fn()

jest.mock('@atproto/oauth-client-browser', () => ({
  BrowserOAuthClient: jest.fn().mockImplementation(() => ({ init: mockInit }))
}))

jest.mock('@atproto/api', () => ({
  Agent: function Agent(session) {
    mockAgent(session)
    return {
      getProfile: mockGetProfile,
      com: {
        atproto: { server: { getSession: mockGetSession, getServiceAuth: mockGetServiceAuth } }
      }
    }
  }
}))

const ADMIN_TOKEN_KEY = 'atproto_admin_token'
const IDENTITY_KEY = 'atproto_identity'
const PROOF_MESSAGE =
  'We could not confirm this account with its host. Sign in again. If this keeps happening, your host may not support this sign-in yet.'

const did = 'did:plc:abcdefghijklmnopqrstuvwx'
const session = { did }
const identity = {
  did,
  handle: 'organizer.example.com',
  displayName: 'Organizer',
  avatarUrl: 'https://cdn.example.com/avatar.jpg'
}
const email = 'organizer@example.com'

const serverAnswers = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body)
})

const loginRequests = () =>
  window.fetch.mock.calls.map(([url, options]) => ({
    url,
    headers: options.headers,
    body: JSON.parse(options.body)
  }))

const openCallback = (props) =>
  render(
    <ThemeUIProvider theme={theme}>
      <MemoryRouter initialEntries={['/auth/callback']}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback {...props} />} />
          <Route path="/signin" element={<div>sign-in page</div>} />
          <Route path="/" element={<div>console home</div>} />
        </Routes>
      </MemoryRouter>
    </ThemeUIProvider>
  )

describe('AuthCallback', () => {
  let consoleError

  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    window.fetch = jest.fn()
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockInit.mockResolvedValue({ session })
    mockGetProfile.mockResolvedValue({
      data: {
        handle: identity.handle,
        displayName: identity.displayName,
        avatar: identity.avatarUrl
      }
    })
    mockGetSession.mockResolvedValue({ data: { email } })
    mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('signs in with proof from the new session', async () => {
    const onComplete = jest.fn()
    const onError = jest.fn()
    window.fetch.mockResolvedValue(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    openCallback({ onComplete, onError })

    expect(await screen.findAllByText('console home')).toHaveLength(1)
    expect(mockAgent.mock.calls).toEqual([[session]])
    expect(mockGetServiceAuth.mock.calls).toEqual([
      [
        {
          aud: 'did:web:assembly.blacksky.community',
          lxm: 'community.blacksky.assembly.createSession'
        }
      ]
    ])
    expect(loginRequests()).toEqual([
      {
        url: 'http://localhost/api/v3/auth/atproto-login',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proof-1' },
        body: { ...identity, email }
      }
    ])
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe('admin-1')
    expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(identity)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(0)
  })

  it('hands the reason to the sign-in page and stores nothing when the server refuses', async () => {
    const onComplete = jest.fn()
    const onError = jest.fn()
    window.fetch.mockResolvedValue(
      serverAnswers(401, { error: 'polis_err_atproto_auth_expired', status: 401 })
    )

    openCallback({ onComplete, onError })

    expect(await screen.findAllByText('sign-in page')).toHaveLength(1)
    expect(onError.mock.calls).toEqual([[PROOF_MESSAGE]])
    expect(onComplete).toHaveBeenCalledTimes(0)
    expect(window.fetch).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(0)
  })
})

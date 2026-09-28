import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserRouter } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import App from './app'
import rootReducer from './reducers'
import theme from './theme'

const mockInit = jest.fn()
const mockRestore = jest.fn()
const mockGetProfile = jest.fn()
const mockGetSession = jest.fn()
const mockGetServiceAuth = jest.fn()
const mockAgent = jest.fn()

jest.mock('@atproto/oauth-client-browser', () => ({
  BrowserOAuthClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    restore: mockRestore
  }))
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

jest.mock('./components/conversations-and-account/conversations', () => {
  return function MockConversations() {
    return <div>All Conversations</div>
  }
})

const LOGIN_URL = 'http://localhost/api/v3/auth/atproto-login'
const ADMIN_TOKEN_KEY = 'atproto_admin_token'
const IDENTITY_KEY = 'atproto_identity'
const PROOF_REQUEST = {
  aud: 'did:web:assembly.blacksky.community',
  lxm: 'community.blacksky.assembly.createSession'
}

const PROOF_MESSAGE =
  'We could not confirm this account with its host. Sign in again. If this keeps happening, your host may not support this sign-in yet.'
const UNSUPPORTED_DID_MESSAGE =
  'Accounts with a did:web identifier cannot sign in to the admin console yet.'
const LOOKUP_MESSAGE = 'We could not look up your account just now. Try again in a minute.'

const did = 'did:plc:abcdefghijklmnopqrstuvwx'
const session = { did }
const storedIdentity = {
  did,
  handle: 'organizer.example.com',
  displayName: 'Organizer',
  avatarUrl: 'https://cdn.example.com/avatar.jpg',
  blackskyMember: true
}
const freshIdentity = {
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
  window.fetch.mock.calls
    .filter(([url]) => url === LOGIN_URL)
    .map(([, options]) => ({ headers: options.headers, body: JSON.parse(options.body) }))

const openConsole = (path) => {
  window.history.pushState({}, '', path)
  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={configureStore({ reducer: rootReducer })}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Provider>
    </ThemeUIProvider>
  )
}

describe('admin console sign-in', () => {
  let consoleSpies

  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    window.fetch = jest.fn()
    consoleSpies = ['error', 'warn'].map((name) =>
      jest.spyOn(console, name).mockImplementation(() => {})
    )
    mockGetProfile.mockResolvedValue({
      data: {
        handle: freshIdentity.handle,
        displayName: freshIdentity.displayName,
        avatar: freshIdentity.avatarUrl
      }
    })
    mockGetSession.mockResolvedValue({ data: { email } })
  })

  afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore())
    window.history.pushState({}, '', '/')
  })

  describe('with an identity stored by a conversation page and no admin token', () => {
    beforeEach(() => {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(storedIdentity))
    })

    it('restores the OAuth session of that identity and signs in with proof', async () => {
      mockRestore.mockResolvedValue(session)
      mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
      window.fetch.mockResolvedValue(serverAnswers(200, { token: 'admin-1', uid: 7 }))

      openConsole('/')

      await waitFor(() => expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe('admin-1'))
      expect(mockRestore.mock.calls).toEqual([[did]])
      expect(mockAgent.mock.calls).toEqual([[session]])
      expect(mockGetServiceAuth.mock.calls).toEqual([[PROOF_REQUEST]])
      expect(loginRequests()).toEqual([
        {
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proof-1' },
          body: storedIdentity
        }
      ])
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(storedIdentity)
    })

    it('ends signed out on the sign-in page with the reason when the server refuses the proof', async () => {
      mockRestore.mockResolvedValue(session)
      mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
      window.fetch.mockResolvedValue(
        serverAnswers(401, { error: 'polis_err_atproto_auth_invalid', status: 401 })
      )

      openConsole('/')

      expect(await screen.findAllByText(PROOF_MESSAGE)).toHaveLength(1)
      expect(window.location.pathname).toBe('/signin')
      expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
      expect(screen.queryByText('All Conversations')).toBeNull()
      expect(loginRequests()).toEqual([
        {
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proof-1' },
          body: storedIdentity
        }
      ])
      expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(storedIdentity)
    })

    it('keeps the stored identity when the session cannot be restored and proof is required', async () => {
      mockRestore.mockRejectedValue(new Error('no session'))
      window.fetch.mockResolvedValue(
        serverAnswers(401, { error: 'polis_err_atproto_auth_missing', status: 401 })
      )

      openConsole('/')

      expect(await screen.findAllByText(PROOF_MESSAGE)).toHaveLength(1)
      expect(window.location.pathname).toBe('/signin')
      expect(mockRestore.mock.calls).toEqual([[did]])
      expect(mockGetServiceAuth).toHaveBeenCalledTimes(0)
      expect(loginRequests()).toEqual([
        { headers: { 'Content-Type': 'application/json' }, body: storedIdentity }
      ])
      expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(storedIdentity)
    })

    it('keeps the stored identity when the account host refuses to issue proof', async () => {
      mockRestore.mockResolvedValue(session)
      mockGetServiceAuth.mockRejectedValue(
        Object.assign(new Error('refused'), { status: 403, error: 'ScopeMissingError' })
      )
      window.fetch.mockResolvedValue(
        serverAnswers(401, { error: 'polis_err_atproto_auth_missing', status: 401 })
      )

      openConsole('/')

      expect(await screen.findAllByText(PROOF_MESSAGE)).toHaveLength(1)
      expect(mockGetServiceAuth.mock.calls).toEqual([[PROOF_REQUEST]])
      expect(loginRequests()).toEqual([
        { headers: { 'Content-Type': 'application/json' }, body: storedIdentity }
      ])
      expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(storedIdentity)
    })

    it('shows the lookup message when the server cannot look the account up', async () => {
      mockRestore.mockResolvedValue(session)
      mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
      window.fetch.mockResolvedValue(
        serverAnswers(503, { error: 'polis_err_atproto_did_resolution_failed', status: 503 })
      )

      openConsole('/')

      expect(await screen.findAllByText(LOOKUP_MESSAGE)).toHaveLength(1)
      expect(window.location.pathname).toBe('/signin')
      expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(storedIdentity)
    })
  })

  describe('returning from the authorization server', () => {
    it('signs in with proof from the new session', async () => {
      mockInit.mockResolvedValue({ session })
      mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
      window.fetch.mockResolvedValue(serverAnswers(200, { token: 'admin-1', uid: 7 }))

      openConsole('/?state=s1&code=c1')

      await waitFor(() => expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe('admin-1'))
      expect(mockInit).toHaveBeenCalledTimes(1)
      expect(mockRestore).toHaveBeenCalledTimes(0)
      expect(mockAgent.mock.calls).toEqual([[session]])
      expect(mockGetServiceAuth.mock.calls).toEqual([[PROOF_REQUEST]])
      expect(loginRequests()).toEqual([
        {
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proof-1' },
          body: { ...freshIdentity, email }
        }
      ])
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(freshIdentity)
    })

    it('ends on the sign-in page with the reason and stores nothing when the server refuses', async () => {
      mockInit.mockResolvedValue({ session })
      mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
      window.fetch.mockResolvedValue(
        serverAnswers(400, { error: 'polis_err_atproto_unsupported_did', status: 400 })
      )

      openConsole('/?state=s1&code=c1')

      expect(await screen.findAllByText(UNSUPPORTED_DID_MESSAGE)).toHaveLength(1)
      expect(window.location.pathname).toBe('/signin')
      expect(loginRequests()).toEqual([
        {
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proof-1' },
          body: { ...freshIdentity, email }
        }
      ])
      expect(localStorage.length).toBe(0)
    })

    it('does not remove an identity stored earlier when the server refuses', async () => {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(storedIdentity))
      mockInit.mockResolvedValue({ session })
      mockGetServiceAuth.mockResolvedValue({ data: { token: 'proof-1' } })
      window.fetch.mockResolvedValue(
        serverAnswers(401, { error: 'polis_err_atproto_auth_replayed', status: 401 })
      )

      openConsole('/?state=s1&code=c1')

      expect(await screen.findAllByText(PROOF_MESSAGE)).toHaveLength(1)
      expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
      expect(JSON.parse(localStorage.getItem(IDENTITY_KEY))).toEqual(storedIdentity)
    })
  })
})

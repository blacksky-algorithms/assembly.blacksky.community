import { loginWithProof, signInErrorMessage } from './atproto-login'

jest.mock('@atproto/oauth-client-browser', () => ({ BrowserOAuthClient: jest.fn() }))

const LOGIN_URL = 'http://localhost/api/v3/auth/atproto-login'
const ADMIN_TOKEN_KEY = 'atproto_admin_token'
const IDENTITY_KEY = 'atproto_identity'

const identity = {
  did: 'did:plc:abcdefghijklmnopqrstuvwx',
  handle: 'organizer.example.com',
  displayName: 'Organizer',
  avatarUrl: 'https://cdn.example.com/avatar.jpg'
}
const email = 'organizer@example.com'

const PROOF_MESSAGE =
  'We could not confirm this account with its host. Sign in again. If this keeps happening, your host may not support this sign-in yet.'
const UNSUPPORTED_DID_MESSAGE =
  'Accounts with a did:web identifier cannot sign in to the admin console yet.'
const LOOKUP_MESSAGE = 'We could not look up your account just now. Try again in a minute.'
const OTHER_MESSAGE = 'Sign-in did not complete. Try again.'

const serverAnswers = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body)
})

const hostGrants = (proof) => jest.fn().mockResolvedValue({ data: { token: proof } })

const requestAt = (index) => {
  const [url, options] = window.fetch.mock.calls[index]
  return { url, options, body: JSON.parse(options.body) }
}

describe('loginWithProof', () => {
  let warn

  beforeEach(() => {
    localStorage.clear()
    window.fetch = jest.fn()
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('asks the account host for proof bound to this service and this method', async () => {
    const getServiceAuth = hostGrants('proof-1')
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    await loginWithProof({ getServiceAuth, identity, email })

    expect(getServiceAuth).toHaveBeenCalledTimes(1)
    expect(getServiceAuth.mock.calls[0]).toEqual([
      {
        aud: 'did:web:assembly.blacksky.community',
        lxm: 'community.blacksky.assembly.createSession'
      }
    ])
  })

  it('sends the proof as a bearer token with the body the console has always sent', async () => {
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    await loginWithProof({ getServiceAuth: hostGrants('proof-1'), identity, email })

    expect(window.fetch).toHaveBeenCalledTimes(1)
    const { url, options, body } = requestAt(0)
    expect(url).toBe(LOGIN_URL)
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer proof-1'
    })
    expect(body).toEqual({ ...identity, email })
  })

  it('sends a null email when the session has none', async () => {
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    await loginWithProof({ getServiceAuth: hostGrants('proof-1'), identity, email: null })

    expect(requestAt(0).body).toEqual({ ...identity, email: null })
  })

  it('sends a stored identity unchanged and without an email field', async () => {
    const stored = { ...identity, blackskyMember: true }
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    await loginWithProof({ getServiceAuth: hostGrants('proof-1'), identity: stored })

    expect(requestAt(0).body).toEqual(stored)
  })

  it('asks for new proof on every attempt and never sends one twice', async () => {
    const getServiceAuth = jest
      .fn()
      .mockResolvedValueOnce({ data: { token: 'proof-1' } })
      .mockResolvedValueOnce({ data: { token: 'proof-2' } })
    window.fetch
      .mockResolvedValueOnce(serverAnswers(401, { error: 'polis_err_atproto_auth_expired' }))
      .mockResolvedValueOnce(serverAnswers(200, { token: 'admin-2', uid: 7 }))

    await expect(loginWithProof({ getServiceAuth, identity, email })).rejects.toThrow()
    await loginWithProof({ getServiceAuth, identity, email })

    expect(getServiceAuth).toHaveBeenCalledTimes(2)
    expect(window.fetch).toHaveBeenCalledTimes(2)
    expect(requestAt(0).options.headers.Authorization).toBe('Bearer proof-1')
    expect(requestAt(1).options.headers.Authorization).toBe('Bearer proof-2')
  })

  it('carries on without proof when the account host refuses to issue it', async () => {
    const refusal = Object.assign(new Error('refused'), { status: 403, error: 'ScopeMissingError' })
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    const token = await loginWithProof({
      getServiceAuth: jest.fn().mockRejectedValue(refusal),
      identity,
      email
    })

    expect(token).toBe('admin-1')
    expect(window.fetch).toHaveBeenCalledTimes(1)
    expect(requestAt(0).options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(requestAt(0).body).toEqual({ ...identity, email })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual([
      'Sign-in proof unavailable',
      { name: 'Error', status: 403, error: 'ScopeMissingError' }
    ])
  })

  it('carries on without proof when the account host answers without a token', async () => {
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    await loginWithProof({
      getServiceAuth: jest.fn().mockResolvedValue({ data: {} }),
      identity,
      email
    })

    expect(window.fetch).toHaveBeenCalledTimes(1)
    expect(requestAt(0).options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stores and returns the admin token when the server answers 200 with one', async () => {
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { token: 'admin-1', uid: 7 }))

    const token = await loginWithProof({ getServiceAuth: hostGrants('proof-1'), identity, email })

    expect(token).toBe('admin-1')
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe('admin-1')
  })

  it('throws the server error code and stores nothing when the server refuses', async () => {
    const storedIdentity = JSON.stringify(identity)
    localStorage.setItem(IDENTITY_KEY, storedIdentity)
    window.fetch.mockResolvedValueOnce(
      serverAnswers(401, {
        error: 'polis_err_atproto_auth_invalid',
        message: 'polis_err_atproto_auth_invalid',
        status: 401
      })
    )

    const failure = await loginWithProof({
      getServiceAuth: hostGrants('proof-1'),
      identity,
      email
    }).catch((err) => err)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.code).toBe('polis_err_atproto_auth_invalid')
    expect(failure.status).toBe(401)
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(IDENTITY_KEY)).toBe(storedIdentity)
    expect(localStorage.length).toBe(1)
  })

  it('throws and stores nothing when a 200 answer carries no token', async () => {
    window.fetch.mockResolvedValueOnce(serverAnswers(200, { uid: 7 }))

    const failure = await loginWithProof({
      getServiceAuth: hostGrants('proof-1'),
      identity,
      email
    }).catch((err) => err)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.status).toBe(200)
    expect(failure.code).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('throws and stores nothing when a refusal carries a token', async () => {
    window.fetch.mockResolvedValueOnce(
      serverAnswers(503, { error: 'polis_err_atproto_did_resolution_failed', token: 'admin-1' })
    )

    const failure = await loginWithProof({
      getServiceAuth: hostGrants('proof-1'),
      identity,
      email
    }).catch((err) => err)

    expect(failure.code).toBe('polis_err_atproto_did_resolution_failed')
    expect(failure.status).toBe(503)
    expect(localStorage.length).toBe(0)
  })

  it('throws with the status and no code when the answer is not JSON', async () => {
    window.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token'))
    })

    const failure = await loginWithProof({
      getServiceAuth: hostGrants('proof-1'),
      identity,
      email
    }).catch((err) => err)

    expect(failure.status).toBe(502)
    expect(failure.code).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('never writes the proof, the admin token or the email to the console', async () => {
    const methods = ['log', 'info', 'debug', 'error']
    const spies = methods.map((name) => jest.spyOn(console, name).mockImplementation(() => {}))
    const refusal = Object.assign(new Error('refused'), {
      status: 500,
      error: 'InternalServerError'
    })
    window.fetch
      .mockResolvedValueOnce(serverAnswers(200, { token: 'admin-secret-1', uid: 7 }))
      .mockResolvedValueOnce(serverAnswers(401, { error: 'polis_err_atproto_auth_replayed' }))
      .mockResolvedValueOnce(serverAnswers(401, { error: 'polis_err_atproto_auth_missing' }))

    await loginWithProof({ getServiceAuth: hostGrants('proof-secret-1'), identity, email })
    const replayed = await loginWithProof({
      getServiceAuth: hostGrants('proof-secret-2'),
      identity,
      email
    }).catch((err) => err)
    const missing = await loginWithProof({
      getServiceAuth: jest.fn().mockRejectedValue(refusal),
      identity,
      email
    }).catch((err) => err)

    const written = JSON.stringify([
      ...spies.flatMap((spy) => spy.mock.calls),
      ...warn.mock.calls,
      replayed.message,
      missing.message
    ])
    spies.forEach((spy) => spy.mockRestore())

    expect(warn).toHaveBeenCalledTimes(1)
    expect(written).not.toContain('proof-secret-1')
    expect(written).not.toContain('proof-secret-2')
    expect(written).not.toContain('admin-secret-1')
    expect(written).not.toContain(email)
  })
})

describe('signInErrorMessage', () => {
  it.each([
    'polis_err_atproto_auth_missing',
    'polis_err_atproto_auth_invalid',
    'polis_err_atproto_auth_expired',
    'polis_err_atproto_auth_replayed'
  ])('explains that the account could not be confirmed for %s', (code) => {
    expect(signInErrorMessage({ status: 401, code })).toBe(PROOF_MESSAGE)
  })

  it('explains that did:web accounts are not supported', () => {
    expect(signInErrorMessage({ status: 400, code: 'polis_err_atproto_unsupported_did' })).toBe(
      UNSUPPORTED_DID_MESSAGE
    )
  })

  it('explains that the account lookup failed for a 503', () => {
    expect(
      signInErrorMessage({ status: 503, code: 'polis_err_atproto_did_resolution_failed' })
    ).toBe(LOOKUP_MESSAGE)
  })

  it.each([
    [{ status: 400, code: 'polis_err_atproto_login_did_mismatch' }],
    [{ status: 500, code: 'polis_err_atproto_login' }],
    [{ status: 401, code: null }],
    [new TypeError('Failed to fetch')],
    [undefined]
  ])('falls back to a plain message for %p', (failure) => {
    expect(signInErrorMessage(failure)).toBe(OTHER_MESSAGE)
  })
})

import URLs from './url'
import { ASSEMBLY_SERVICE_DID, CREATE_SESSION_METHOD } from './atproto-oauth'

export const ADMIN_TOKEN_KEY = 'atproto_admin_token'

const PROOF_REJECTED_CODES = [
  'polis_err_atproto_auth_missing',
  'polis_err_atproto_auth_invalid',
  'polis_err_atproto_auth_expired',
  'polis_err_atproto_auth_replayed'
]
const UNSUPPORTED_DID_CODE = 'polis_err_atproto_unsupported_did'
const LOOKUP_FAILED_STATUS = 503

const PROOF_REJECTED_MESSAGE =
  'We could not confirm this account with its host. Sign in again. If this keeps happening, your host may not support this sign-in yet.'
const UNSUPPORTED_DID_MESSAGE =
  'Accounts with a did:web identifier cannot sign in to the admin console yet.'
const LOOKUP_FAILED_MESSAGE = 'We could not look up your account just now. Try again in a minute.'
const SIGN_IN_FAILED_MESSAGE = 'Sign-in did not complete. Try again.'

export function signInErrorMessage(err) {
  if (PROOF_REJECTED_CODES.includes(err?.code)) return PROOF_REJECTED_MESSAGE
  if (err?.code === UNSUPPORTED_DID_CODE) return UNSUPPORTED_DID_MESSAGE
  if (err?.status === LOOKUP_FAILED_STATUS) return LOOKUP_FAILED_MESSAGE
  return SIGN_IN_FAILED_MESSAGE
}

async function requestProof(getServiceAuth) {
  try {
    const result = await getServiceAuth({ aud: ASSEMBLY_SERVICE_DID, lxm: CREATE_SESSION_METHOD })
    const proof = result?.data?.token
    if (typeof proof === 'string' && proof !== '') return proof
    console.warn('Sign-in proof unavailable: the account host returned none')
  } catch (err) {
    console.warn('Sign-in proof unavailable', {
      name: err?.name,
      status: err?.status,
      error: err?.error
    })
  }
  return null
}

export async function loginWithProof({ getServiceAuth, identity, email }) {
  const proof = await requestProof(getServiceAuth)

  const headers = { 'Content-Type': 'application/json' }
  if (proof) headers.Authorization = `Bearer ${proof}`

  const resp = await fetch(`${URLs.urlPrefix}api/v3/auth/atproto-login`, {
    method: 'POST',
    headers,
    body: JSON.stringify(email === undefined ? identity : { ...identity, email })
  })
  const answer = await resp.json().catch(() => null)

  if (resp.status !== 200 || typeof answer?.token !== 'string' || answer.token === '') {
    const code = typeof answer?.error === 'string' ? answer.error : null
    const err = new Error(`Admin login failed: ${resp.status} ${code || 'no error code'}`)
    err.status = resp.status
    err.code = code
    throw err
  }

  localStorage.setItem(ADMIN_TOKEN_KEY, answer.token)
  return answer.token
}

/**
 * Auth shim: provides a useAuth() hook compatible with react-oidc-context API
 * but backed by atproto OAuth identity stored in localStorage.
 *
 * This allows all existing components that use useAuth() to work without modification.
 */
import { useState, useEffect } from 'react'
import { getAtprotoIdentity, clearAtprotoIdentity, isAdminTokenExpired } from './atproto-oauth'

const ADMIN_TOKEN_KEY = 'atproto_admin_token'

export function useAuth() {
  const [identity, setIdentity] = useState(() => getAtprotoIdentity())
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIdentity(getAtprotoIdentity())
    setIsLoading(false)
  }, [])

  const token = typeof window !== 'undefined' ? localStorage.getItem(ADMIN_TOKEN_KEY) : null

  return {
    isAuthenticated: identity !== null && token !== null && !isAdminTokenExpired(token),
    isLoading,
    user: identity ? { access_token: token, profile: identity } : null,
    error: null,
    signinRedirect: () => { window.location.href = '/signin' },
    removeUser: () => {
      clearAtprotoIdentity()
      localStorage.removeItem(ADMIN_TOKEN_KEY)
    },
    signinSilent: async () => null
  }
}

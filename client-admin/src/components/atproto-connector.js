import { useEffect, useRef } from 'react'
import { setOidcTokenGetter, setOidcActions } from '../util/net'
import { getAtprotoIdentity, clearAtprotoIdentity, isAdminTokenExpired } from '../util/atproto-oauth'

const ADMIN_TOKEN_KEY = 'atproto_admin_token'

const AtprotoConnector = ({ onAuthComplete }) => {
  const authWasReady = useRef(false)

  useEffect(() => {
    const identity = getAtprotoIdentity()
    const token = localStorage.getItem(ADMIN_TOKEN_KEY)

    if (identity && token && !isAdminTokenExpired(token)) {
      // Set up a token getter that returns the stored admin JWT
      const tokenGetter = async () => token
      setOidcTokenGetter(tokenGetter)

      // Set up sign out action
      setOidcActions({
        signinRedirect: () => {
          window.location.href = '/signin'
        },
        removeUser: () => {
          clearAtprotoIdentity()
          localStorage.removeItem(ADMIN_TOKEN_KEY)
          window.location.href = '/signin'
        }
      })

      if (!authWasReady.current) {
        authWasReady.current = true
        window.dispatchEvent(new Event('polisAuthReady'))
      }
    } else {
      setOidcTokenGetter(null)
      authWasReady.current = false
    }
  }, [onAuthComplete])

  return null
}

export default AtprotoConnector

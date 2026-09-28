import React, { useEffect } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router'
import { Box } from 'theme-ui'
import { Agent } from '@atproto/api'
import { getOAuthClient, setAtprotoIdentity } from '../util/atproto-oauth'
import { loginWithProof, signInErrorMessage } from '../util/atproto-login'
import Spinner from './framework/spinner'

const AuthCallback = ({ onComplete, onError }) => {
  const navigate = useNavigate()

  useEffect(() => {
    ;(async () => {
      try {
        const client = getOAuthClient()
        const result = await client.init()

        if (!result?.session) {
          navigate('/signin')
          return
        }

        // Fetch profile and session info (for email)
        const agent = new Agent(result.session)
        const [profile, sessionInfo] = await Promise.all([
          agent.getProfile({ actor: result.session.did }),
          agent.com.atproto.server.getSession()
        ])

        const identity = {
          did: result.session.did,
          handle: profile.data.handle,
          displayName: profile.data.displayName || profile.data.handle,
          avatarUrl: profile.data.avatar || ''
        }

        await loginWithProof({
          getServiceAuth: (params) => agent.com.atproto.server.getServiceAuth(params),
          identity,
          email: sessionInfo.data.email || null
        })
        setAtprotoIdentity(identity)

        if (onComplete) onComplete()
        navigate('/')
      } catch (err) {
        console.error('Auth callback error:', err)
        if (onError) onError(signInErrorMessage(err))
        navigate('/signin')
      }
    })()
  }, [navigate, onComplete, onError])

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '200px'
      }}>
      <Spinner />
    </Box>
  )
}

AuthCallback.propTypes = {
  onComplete: PropTypes.func,
  onError: PropTypes.func
}

export default AuthCallback

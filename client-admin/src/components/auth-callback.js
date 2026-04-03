import React, { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router'
import { Box, Text } from 'theme-ui'
import { Agent } from '@atproto/api'
import { getOAuthClient, setAtprotoIdentity } from '../util/atproto-oauth'
import URLs from '../util/url'
import Spinner from './framework/spinner'

const ADMIN_TOKEN_KEY = 'atproto_admin_token'

const AuthCallback = ({ onComplete }) => {
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    ;(async () => {
      try {
        const client = getOAuthClient()
        const result = await client.init()

        if (!result?.session) {
          navigate('/signin')
          return
        }

        // Fetch profile
        const agent = new Agent(result.session)
        const profile = await agent.getProfile({ actor: result.session.did })

        const identity = {
          did: result.session.did,
          handle: profile.data.handle,
          displayName: profile.data.displayName || profile.data.handle,
          avatarUrl: profile.data.avatar || ''
        }

        // Exchange DID for server admin JWT
        const resp = await fetch(`${URLs.urlPrefix}api/v3/auth/atproto-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(identity)
        })

        if (!resp.ok) {
          throw new Error(`Server login failed: ${resp.status}`)
        }

        const { token } = await resp.json()

        // Store identity and token
        setAtprotoIdentity(identity)
        localStorage.setItem(ADMIN_TOKEN_KEY, token)

        if (onComplete) onComplete()
        navigate('/')
      } catch (err) {
        console.error('Auth callback error:', err)
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [navigate, onComplete])

  if (error) {
    return (
      <Box sx={{ p: [4], textAlign: 'center' }}>
        <Text sx={{ color: 'red' }}>Login failed: {error}</Text>
      </Box>
    )
  }

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
  onComplete: PropTypes.func
}

export default AuthCallback

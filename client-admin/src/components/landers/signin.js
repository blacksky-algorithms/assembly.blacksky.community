// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import React, { useState } from 'react'
import PropTypes from 'prop-types'
import { Navigate } from 'react-router'
import { Heading, Box, Button, Input, Text } from 'theme-ui'
import StaticLayout from './lander-layout'
import { getOAuthClient } from '../../util/atproto-oauth'

const SignIn = ({ authed }) => {
  const [handle, setHandle] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState('')

  const handleSignIn = async () => {
    const trimmed = handle.trim()
    if (!trimmed || isProcessing) return

    setError('')
    setIsProcessing(true)

    try {
      const client = getOAuthClient()
      await client.signIn(trimmed)
      // Browser will redirect to authorization server
    } catch (err) {
      setIsProcessing(false)
      const message = err instanceof Error ? err.message : String(err)
      setError(message || 'Failed to start sign-in. Please check your handle and try again.')
    }
  }

  if (authed) {
    return <Navigate to={'/'} />
  }

  return (
    <StaticLayout>
      <Box>
        <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
          Sign In
        </Heading>
        <Box sx={{ maxWidth: 400 }}>
          <Input
            placeholder="Enter your atproto handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSignIn()}
            disabled={isProcessing}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            spellCheck="false"
            sx={{ mb: [2] }}
          />
          <Button
            sx={{ my: [2] }}
            id="signinButton"
            disabled={isProcessing || !handle.trim()}
            onClick={handleSignIn}>
            {isProcessing ? 'Signing in...' : 'Sign In'}
          </Button>
          {error && (
            <Text sx={{ color: 'red', mt: [2], fontSize: [1] }}>{error}</Text>
          )}
        </Box>
      </Box>
    </StaticLayout>
  )
}

SignIn.propTypes = {
  authed: PropTypes.bool
}

export default SignIn

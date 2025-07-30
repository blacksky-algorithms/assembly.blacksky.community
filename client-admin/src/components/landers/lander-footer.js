import { Component } from 'react'
import { Box, Link, Heading } from 'theme-ui'

import emoji from 'react-easy-emoji'

class Header extends Component {
  render() {
    return (
      <Box sx={{ mt: [3, null, 4] }}>
        <Heading as="h3" sx={{ fontSize: [4], lineHeight: 'body', my: [2, null, 3] }}>
          Legal
        </Heading>
        <Box sx={{ mb: [2, null, 3], maxWidth: '30em' }}>
          Blacksky People{'\''}s Assembly – a space for public deliberation
          and collective decision-making.
        </Box>
        <Box sx={{ mb: [2, null, 3] }}>
          © {new Date().getFullYear()} Blacksky Algorithms <Link href="https://blackskyweb.xyz/about/support/tos">TOS</Link>{' '}
          <Link href="https://blackskyweb.xyz/about/support/privacy-policy">Privacy</Link>
        </Box>
      </Box>
    )
  }
}

export default Header

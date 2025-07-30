import Layout from './lander-layout'
import { Heading, Box, Text, Link } from 'theme-ui'

const Index = () => {
  return (
    <Layout>
      <>
        <Heading as="h1" sx={{ my: [4, null, 5], fontSize: [6, null, 7] }}>
          Blacksky People{'\''}s Assembly
        </Heading>
        <Heading
          as="h3"
          sx={{
            fontSize: [3, null, 4],
            lineHeight: 'body',
            mb: [4, null, 5],
            color: 'mediumGray'
          }}>
          Blacksky People{'\''}s Assembly is a real-time system for gathering, analyzing and understanding what
          our community thinks in their own words, enabled by advanced statistics and machine learning.
        </Heading>
        <Heading as="h3" sx={{ fontSize: [4], lineHeight: 'body', mb: [2, null, 3] }}>
          Get Started
        </Heading>
        <Box sx={{ mb: [4, null, 5] }}>
          <Link href="/signin">Sign in</Link>
        </Box>
        <Heading as="h3" sx={{ fontSize: [4], lineHeight: 'body', my: [2, null, 3] }}>
          Contribute
        </Heading>
        <Box sx={{ mb: [4, null, 5] }}>
          Explore the code and join the developer community{' '}
          <Link target="_blank" href="https://github.com/blacksky-algorithms/">
            on Github
          </Link>
        </Box>
      </>
    </Layout>
  )
}

export default Index

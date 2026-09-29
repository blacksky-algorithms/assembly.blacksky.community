import { render, screen, fireEvent, act } from '@testing-library/react'
import { BrowserRouter as Router } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import SignIn from './signin'

const mockSignIn = jest.fn()

jest.mock('@atproto/oauth-client-browser', () => ({
  BrowserOAuthClient: jest.fn().mockImplementation(() => ({ signIn: mockSignIn }))
}))

const PROOF_MESSAGE =
  'We could not confirm this account with its host. Sign in again. If this keeps happening, your host may not support this sign-in yet.'
const LOOKUP_MESSAGE = 'We could not look up your account just now. Try again in a minute.'

const page = (props) => (
  <Router>
    <ThemeUIProvider theme={theme}>
      <SignIn authed={false} {...props} />
    </ThemeUIProvider>
  </Router>
)

describe('SignIn reason for a failed sign-in', () => {
  beforeEach(() => {
    mockSignIn.mockReset()
  })

  it('shows the message passed to it', () => {
    render(page({ signInError: PROOF_MESSAGE }))

    expect(screen.getAllByText(PROOF_MESSAGE)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
  })

  it('shows a message that arrives after the page is already open', () => {
    const { rerender } = render(page({ signInError: '' }))
    expect(screen.queryByText(LOOKUP_MESSAGE)).toBeNull()

    rerender(page({ signInError: LOOKUP_MESSAGE }))

    expect(screen.getAllByText(LOOKUP_MESSAGE)).toHaveLength(1)
  })

  it('clears the message when the person starts to sign in again', async () => {
    mockSignIn.mockReturnValue(new Promise(() => {}))
    render(page({ signInError: PROOF_MESSAGE }))
    expect(screen.getAllByText(PROOF_MESSAGE)).toHaveLength(1)

    fireEvent.change(screen.getByPlaceholderText('Enter your atproto handle'), {
      target: { value: 'organizer.example.com' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    })

    expect(mockSignIn).toHaveBeenCalledTimes(1)
    expect(mockSignIn).toHaveBeenCalledWith('organizer.example.com')
    expect(screen.queryByText(PROOF_MESSAGE)).toBeNull()
  })

  it('reports once that the message was shown, so that it is not shown again later', () => {
    const onSignInErrorShown = jest.fn()
    const { rerender } = render(page({ signInError: PROOF_MESSAGE, onSignInErrorShown }))

    rerender(page({ signInError: '', onSignInErrorShown }))

    expect(onSignInErrorShown).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText(PROOF_MESSAGE)).toHaveLength(1)
  })

  it('reports nothing when there is no message', () => {
    const onSignInErrorShown = jest.fn()

    render(page({ signInError: '', onSignInErrorShown }))

    expect(onSignInErrorShown).toHaveBeenCalledTimes(0)
  })
})

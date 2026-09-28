import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BrowserRouter as Router } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import SignIn from './signin'
import { getOAuthClient } from '../../util/atproto-oauth'

jest.mock('../../util/atproto-oauth', () => ({
  getOAuthClient: jest.fn()
}))

const mockNavigate = jest.fn()
jest.mock('react-router', () => ({
  ...jest.requireActual('react-router'),
  Navigate: ({ to }) => {
    mockNavigate(to)
    return null
  }
}))

const renderWithProviders = (component, options = {}) => {
  return render(
    <Router>
      <ThemeUIProvider theme={theme}>{component}</ThemeUIProvider>
    </Router>,
    options
  )
}

describe('SignIn', () => {
  let signIn

  beforeEach(() => {
    jest.clearAllMocks()
    signIn = jest.fn(() => new Promise(() => {}))
    getOAuthClient.mockReturnValue({ signIn })
  })

  it('renders sign in form when not authenticated', () => {
    renderWithProviders(<SignIn authed={false} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Sign In' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter your atproto handle')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign In' })).toHaveAttribute('id', 'signinButton')
  })

  it('redirects to home when authenticated', () => {
    renderWithProviders(<SignIn authed={true} />)

    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('keeps the button disabled until a handle is entered', () => {
    renderWithProviders(<SignIn authed={false} />)

    const button = screen.getByRole('button', { name: 'Sign In' })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Enter your atproto handle'), {
      target: { value: '   ' }
    })
    expect(button).toBeDisabled()

    fireEvent.click(button)
    expect(signIn).not.toHaveBeenCalled()
  })

  it('starts sign-in with the trimmed handle', () => {
    renderWithProviders(<SignIn authed={false} />)

    fireEvent.change(screen.getByPlaceholderText('Enter your atproto handle'), {
      target: { value: '  alice.example.com ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    expect(signIn).toHaveBeenCalledTimes(1)
    expect(signIn).toHaveBeenCalledWith('alice.example.com')
    expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled()
  })

  it('shows the error and allows another attempt when sign-in cannot start', async () => {
    signIn.mockRejectedValue(new Error('Unable to resolve handle'))
    renderWithProviders(<SignIn authed={false} />)

    fireEvent.change(screen.getByPlaceholderText('Enter your atproto handle'), {
      target: { value: 'alice.example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    expect(await screen.findByText('Unable to resolve handle')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled())
  })
})

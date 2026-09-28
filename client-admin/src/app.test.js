import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { MemoryRouter } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import App from './app'
import theme from './theme'

jest.mock('./actions', () => ({
  populateUserStore: jest.fn(() => ({ type: 'TEST_POPULATE_USER' }))
}))

jest.mock('./components/conversations-and-account/conversations', () => {
  return function MockConversations() {
    return <div>All Conversations</div>
  }
})

const tokenExpiringAt = (secondsSinceEpoch) =>
  ['e30', btoa(JSON.stringify({ exp: secondsSinceEpoch })), 'signature'].join('.')

const NOW = new Date('2026-01-01T00:00:00.000Z')
const NOW_SECONDS = NOW.getTime() / 1000

const renderApp = () => {
  const store = configureStore({
    reducer: (state) => state,
    preloadedState: { user: { user: null, loading: false, error: null } }
  })

  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={store}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </Provider>
    </ThemeUIProvider>
  )
}

describe('App Authentication Flow', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
    localStorage.clear()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('shows the sign in page when nobody is signed in', () => {
    renderApp()

    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument()
    expect(screen.queryByText('All Conversations')).not.toBeInTheDocument()
  })

  test('shows protected content to a signed-in admin', () => {
    localStorage.setItem(
      'atproto_identity',
      JSON.stringify({ did: 'did:plc:testadmin', handle: 'admin.example.com' })
    )
    localStorage.setItem('atproto_admin_token', tokenExpiringAt(NOW_SECONDS + 3600))

    renderApp()

    expect(screen.getByText('All Conversations')).toBeInTheDocument()
  })

  test('signs the admin out when the admin session has expired', () => {
    localStorage.setItem(
      'atproto_identity',
      JSON.stringify({ did: 'did:plc:testadmin', handle: 'admin.example.com' })
    )
    localStorage.setItem('atproto_admin_token', tokenExpiringAt(NOW_SECONDS - 1))

    renderApp()

    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument()
    expect(localStorage.getItem('atproto_identity')).toBeNull()
    expect(localStorage.getItem('atproto_admin_token')).toBeNull()
  })
})

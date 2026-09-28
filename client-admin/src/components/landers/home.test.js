import { render, screen, within } from '@testing-library/react'
import { BrowserRouter as Router } from 'react-router'
import { ThemeUIProvider } from 'theme-ui'
import theme from '../../theme'
import Home from './home'

const AllTheProviders = ({ children }) => {
  return (
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true
      }}>
      <ThemeUIProvider theme={theme}>{children}</ThemeUIProvider>
    </Router>
  )
}

const customRender = (ui, options) => render(ui, { wrapper: AllTheProviders, ...options })

describe('Home component', () => {
  it('renders the main heading', () => {
    customRender(<Home />)
    expect(
      screen.getByRole('heading', { level: 1, name: "Blacksky People's Assembly" })
    ).toBeInTheDocument()
  })

  it('renders the "Get Started" section', () => {
    customRender(<Home />)
    const getStartedSection = screen.getByRole('heading', { name: /Get Started/i }).parentElement
    expect(within(getStartedSection).getByRole('link', { name: /Sign in/i })).toBeInTheDocument()
  })

  it('links to the source code', () => {
    customRender(<Home />)
    expect(screen.getByRole('link', { name: 'on Github' })).toHaveAttribute(
      'href',
      'https://github.com/blacksky-algorithms/'
    )
  })
})

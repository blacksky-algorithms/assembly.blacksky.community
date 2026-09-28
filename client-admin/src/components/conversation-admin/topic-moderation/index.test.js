import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ThemeUIProvider } from 'theme-ui'
import { MemoryRouter, Routes, Route } from 'react-router'
import theme from '../../../theme'
import PolisNet from '../../../util/net'
import ConversationAdminContainer from '../index'

jest.mock('../../../actions', () => ({
  populateZidMetadataStore: jest.fn(() => ({ type: 'TEST_POPULATE_ZID_METADATA' })),
  resetMetadataStore: jest.fn(() => ({ type: 'TEST_RESET_ZID_METADATA' })),
  populateAllCommentStores: jest.fn(() => ({ type: 'TEST_POPULATE_COMMENTS' }))
}))

jest.mock('../../../util/auth-shim', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: null, error: null })
}))

jest.mock('../../../util/net', () => ({
  __esModule: true,
  default: { polisGet: jest.fn(), polisPost: jest.fn() }
}))

const topicsResponse = {
  status: 'success',
  topics_by_layer: {
    0: [
      {
        topic_key: '0_3',
        topic_name: 'Housing costs',
        layer_id: '0',
        cluster_id: '3',
        moderation: { status: 'pending', moderator: null, moderated_at: null, comment_count: 0 }
      }
    ]
  },
  total_topics: 1
}

const statsResponse = {
  status: 'success',
  stats: { total_topics: 1, pending: 1, accepted: 0, rejected: 0, meta: 0 }
}

const responseFor = (path) => (path.includes('/topicMod/stats') ? statsResponse : topicsResponse)

const requestedPaths = () => [
  ...window.fetch.mock.calls.map(([url]) => String(url)),
  ...PolisNet.polisGet.mock.calls.map(
    ([api, data]) => `${api}?${new URLSearchParams(data).toString()}`
  )
]

const renderAt = (path, zidMetadata = { conversation_id: 'test123', is_owner: true }) => {
  const store = configureStore({
    reducer: (state) => state,
    preloadedState: {
      zid_metadata: { zid_metadata: zidMetadata, loading: false, error: null },
      mod_comments_unmoderated: { unmoderated_comments: [] },
      mod_comments_accepted: { accepted_comments: [] },
      mod_comments_rejected: { rejected_comments: [] }
    }
  })

  return render(
    <ThemeUIProvider theme={theme}>
      <Provider store={store}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/m/:conversation_id/*" element={<ConversationAdminContainer />} />
          </Routes>
        </MemoryRouter>
      </Provider>
    </ThemeUIProvider>
  )
}

describe('Topics tab', () => {
  beforeEach(() => {
    window.fetch = jest.fn((url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(responseFor(String(url)))
      })
    )
    PolisNet.polisGet.mockReset()
    PolisNet.polisGet.mockImplementation((api) => Promise.resolve(responseFor(api)))
  })

  it('renders the topic tree at /m/:conversation_id/topics', async () => {
    renderAt('/m/test123/topics')

    expect(screen.getByRole('heading', { name: 'Topic Moderation' })).toBeInTheDocument()
    expect(await screen.findByText('Housing costs')).toBeInTheDocument()
    expect(requestedPaths()).toEqual(['/api/v3/topicMod/topics?conversation_id=test123'])
  })

  it('links each topic to its detail route under the same conversation', async () => {
    renderAt('/m/test123/topics')

    const viewComments = await screen.findByRole('button', { name: 'View Comments' })
    expect(viewComments.closest('a')).toHaveAttribute('href', '/m/test123/topics/topic/0_3')
  })

  it('links the three sections to absolute paths', () => {
    renderAt('/m/test123/topics/proximity')

    expect(screen.getByRole('link', { name: 'Topics Tree' })).toHaveAttribute(
      'href',
      '/m/test123/topics'
    )
    expect(screen.getByRole('link', { name: 'Proximity Map' })).toHaveAttribute(
      'href',
      '/m/test123/topics/proximity'
    )
    expect(screen.getByRole('link', { name: 'Statistics' })).toHaveAttribute(
      'href',
      '/m/test123/topics/stats'
    )
    expect(screen.getByText('Proximity Visualization Coming Soon')).toBeInTheDocument()
  })

  it('shows statistics for the conversation at /m/:conversation_id/topics/stats', async () => {
    renderAt('/m/test123/topics/stats')

    expect(
      await screen.findByRole('heading', { name: 'Topic Moderation Statistics' })
    ).toBeInTheDocument()
    expect(requestedPaths()).toEqual(['/api/v3/topicMod/stats?conversation_id=test123'])
  })

  it('shows the permission notice to a signed-in account that does not moderate the conversation', () => {
    renderAt('/m/test123/topics', { conversation_id: 'test123', is_owner: false, is_mod: false })

    expect(screen.queryByRole('heading', { name: 'Topic Moderation' })).not.toBeInTheDocument()
    expect(document.getElementById('no-permission-warning')).toBeInTheDocument()
    expect(requestedPaths()).toEqual([])
  })
})

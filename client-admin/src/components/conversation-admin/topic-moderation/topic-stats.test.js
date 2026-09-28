import { screen, waitFor } from '@testing-library/react'
import TopicStats from './topic-stats'
import PolisNet from '../../../util/net'
import { renderWithProviders } from '../../../test-utils'

jest.mock('../../../util/net')
jest.mock('../../../actions', () => ({}))

const renderStats = () => renderWithProviders(<TopicStats conversation_id="test123" />)

describe('TopicStats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reads moderation statistics through PolisNet', async () => {
    PolisNet.polisGet = jest.fn().mockResolvedValue({
      status: 'success',
      stats: { total_topics: 4, pending: 1, accepted: 2, rejected: 1, meta: 0 }
    })

    renderStats()

    await waitFor(() => {
      expect(screen.getByText('75.0% Complete')).toBeInTheDocument()
    })
    expect(PolisNet.polisGet).toHaveBeenCalledTimes(1)
    expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/topicMod/stats', {
      conversation_id: 'test123'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the load error when the read is refused', async () => {
    PolisNet.polisGet = jest.fn().mockRejectedValue(new Error('refused'))

    renderStats()

    await waitFor(() => {
      expect(screen.getByText('Error: Network error loading statistics')).toBeInTheDocument()
    })
    expect(PolisNet.polisGet).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})

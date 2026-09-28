import { screen, waitFor } from '@testing-library/react'
import TopicTree from './topic-tree'
import PolisNet from '../../../util/net'
import { renderWithProviders } from '../../../test-utils'

jest.mock('../../../util/net')
jest.mock('../../../actions', () => ({}))

const renderTree = () =>
  renderWithProviders(<TopicTree conversation_id="test123" match={{ url: '/m/test123/topics' }} />)

describe('TopicTree', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reads topics through PolisNet', async () => {
    PolisNet.polisGet = jest.fn().mockResolvedValue({
      status: 'success',
      topics_by_layer: {
        0: [{ topic_key: 'layer0_0', topic_name: 'Housing', moderation: { status: 'pending' } }]
      }
    })

    renderTree()

    await waitFor(() => {
      expect(screen.getByText('Housing')).toBeInTheDocument()
    })
    expect(PolisNet.polisGet).toHaveBeenCalledTimes(1)
    expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/topicMod/topics', {
      conversation_id: 'test123'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the load error when the read is refused', async () => {
    PolisNet.polisGet = jest.fn().mockRejectedValue(new Error('refused'))

    renderTree()

    await waitFor(() => {
      expect(screen.getByText('Error: Network error loading topics')).toBeInTheDocument()
    })
    expect(PolisNet.polisGet).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})

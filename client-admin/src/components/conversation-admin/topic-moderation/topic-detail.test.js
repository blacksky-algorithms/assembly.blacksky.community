import { screen, waitFor } from '@testing-library/react'
import TopicDetail from './topic-detail'
import PolisNet from '../../../util/net'
import { renderWithProviders } from '../../../test-utils'

jest.mock('../../../util/net')
jest.mock('../../../actions', () => ({}))

const renderDetail = () =>
  renderWithProviders(
    <TopicDetail
      match={{
        url: '/m/test123/topics/topic/job1%230_1',
        params: { conversation_id: 'test123', topicKey: 'job1%230_1' }
      }}
    />
  )

describe('TopicDetail', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reads the statements of a topic through PolisNet', async () => {
    PolisNet.polisGet = jest.fn().mockResolvedValue({
      status: 'success',
      comments: [{ comment_id: 4, comment_text: 'Build more homes', cluster_id: 1, layer_id: 0 }]
    })

    renderDetail()

    await waitFor(() => {
      expect(screen.getByText('Build more homes')).toBeInTheDocument()
    })
    expect(PolisNet.polisGet).toHaveBeenCalledTimes(1)
    expect(PolisNet.polisGet).toHaveBeenCalledWith('/api/v3/topicMod/topics/job1%230_1/comments', {
      conversation_id: 'test123'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the load error when the read is refused', async () => {
    PolisNet.polisGet = jest.fn().mockRejectedValue(new Error('refused'))

    renderDetail()

    await waitFor(() => {
      expect(screen.getByText('Error: Network error loading comments')).toBeInTheDocument()
    })
    expect(PolisNet.polisGet).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})

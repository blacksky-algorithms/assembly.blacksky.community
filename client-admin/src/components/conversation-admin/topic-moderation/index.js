// Copyright (C) 2012-present, The Authors. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

import ComponentHelpers from '../../../util/component-helpers'
import NoPermission from '../no-permission'
import { useSelector } from 'react-redux'
import { Heading, Flex, Box } from 'theme-ui'
import { Routes, Route, Link, useParams, useLocation } from 'react-router'

import TopicTree from './topic-tree'
import TopicStats from './topic-stats'

const TopicModeration = () => {
  const params = useParams()
  const location = useLocation()
  const zid_metadata = useSelector((state) => state.zid_metadata)

  if (zid_metadata.loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <div>Loading...</div>
      </Box>
    )
  }

  if (
    ComponentHelpers.shouldShowPermissionsError({
      zid_metadata: zid_metadata.zid_metadata,
      loading: zid_metadata.loading
    })
  ) {
    return <NoPermission />
  }

  const url = location.pathname.split('/')[4]
  const baseUrl = `/m/${params.conversation_id}/topics`

  return (
    <Box>
      <Heading
        as="h3"
        sx={{
          fontSize: [3, null, 4],
          lineHeight: 'body',
          mb: [3, null, 4]
        }}>
        Topic Moderation
      </Heading>
      <Flex sx={{ mb: [4] }}>
        <Link
          sx={{
            mr: [4],
            variant: url ? 'links.nav' : 'links.activeNav'
          }}
          to={baseUrl}>
          Topics Tree
        </Link>
        <Link
          sx={{
            mr: [4],
            variant: url === 'proximity' ? 'links.activeNav' : 'links.nav'
          }}
          to={`${baseUrl}/proximity`}>
          Proximity Map
        </Link>
        <Link
          sx={{
            mr: [4],
            variant: url === 'stats' ? 'links.activeNav' : 'links.nav'
          }}
          to={`${baseUrl}/stats`}>
          Statistics
        </Link>
      </Flex>
      <Box>
        <Routes>
          <Route
            path="/"
            element={<TopicTree conversation_id={params.conversation_id} baseUrl={baseUrl} />}
          />
          <Route path="proximity" element={<div>Proximity Visualization Coming Soon</div>} />
          <Route path="stats" element={<TopicStats conversation_id={params.conversation_id} />} />
          <Route path="topic/:topicKey" element={<div>Topic Detail Coming Soon</div>} />
        </Routes>
      </Box>
    </Box>
  )
}

export default TopicModeration

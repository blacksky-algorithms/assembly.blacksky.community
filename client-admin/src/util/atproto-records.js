/**
 * AT Protocol record creation for admin governance actions.
 * Creates conversation records in the admin's repo.
 */

import { Agent } from '@atproto/api'
import { getOAuthClient, getAtprotoIdentity } from './atproto-oauth'

async function getAgent() {
  const identity = getAtprotoIdentity()
  if (!identity) return null

  try {
    const client = getOAuthClient()
    const session = await client.restore(identity.did)
    return new Agent(session)
  } catch (err) {
    console.warn('Failed to restore atproto session:', err)
    return null
  }
}

/**
 * Create a conversation record in the admin's repo.
 */
export async function createConversationRecord({ topic, description, authRequired }) {
  const agent = await getAgent()
  if (!agent) return null

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: 'community.blacksky.assembly.conversation',
    record: {
      $type: 'community.blacksky.assembly.conversation',
      topic: topic || 'Untitled Conversation',
      description: description || undefined,
      authRequired: authRequired ?? true,
      createdAt: new Date().toISOString(),
    },
  })

  return { uri: result.data.uri, cid: result.data.cid }
}

/**
 * Update a conversation record in the admin's repo.
 */
export async function updateConversationRecord({ atUri, topic, description, authRequired }) {
  if (!atUri) return null

  const agent = await getAgent()
  if (!agent) return null

  // Extract rkey from AT URI: at://did/collection/rkey
  const rkey = atUri.split('/').pop()

  const result = await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: 'community.blacksky.assembly.conversation',
    rkey,
    record: {
      $type: 'community.blacksky.assembly.conversation',
      topic: topic || 'Untitled Conversation',
      description: description || undefined,
      authRequired: authRequired ?? true,
      createdAt: new Date().toISOString(),
    },
  })

  return { uri: result.data.uri, cid: result.data.cid }
}

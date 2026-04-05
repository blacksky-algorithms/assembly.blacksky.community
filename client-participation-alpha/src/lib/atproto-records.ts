/**
 * AT Protocol record creation for assembly governance actions.
 *
 * Each action (conversation, statement, vote) creates a record in the
 * user's repo, making governance data publicly auditable on the firehose.
 */

import { Agent } from '@atproto/api';
import { getOAuthClient } from './atproto-oauth';
import { getAtprotoIdentity } from './atproto-session';

/**
 * Restore an authenticated Agent from the stored OAuth session.
 * The BrowserOAuthClient persists sessions in IndexedDB.
 */
async function getAgent(): Promise<Agent | null> {
  const identity = getAtprotoIdentity();
  if (!identity) return null;

  try {
    const client = getOAuthClient();
    const session = await client.restore(identity.did);
    return new Agent(session);
  } catch (err) {
    console.warn('Failed to restore atproto session for PDS writes:', err);
    return null;
  }
}

/**
 * Create a conversation record in the owner's repo.
 */
export async function createConversationRecord(params: {
  topic: string;
  description?: string;
  authRequired?: boolean;
}): Promise<{ uri: string; cid: string } | null> {
  const agent = await getAgent();
  if (!agent) return null;

  try {
    const result = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: 'community.blacksky.assembly.conversation',
      record: {
        $type: 'community.blacksky.assembly.conversation',
        topic: params.topic,
        description: params.description || undefined,
        authRequired: params.authRequired ?? true,
        createdAt: new Date().toISOString(),
      },
    });

    return { uri: result.data.uri, cid: result.data.cid };
  } catch (err) {
    console.error('Failed to create conversation record in repo:', err);
    throw err;
  }
}

/**
 * Create a statement record in the participant's repo.
 * References the conversation via strongRef.
 */
export async function createStatementRecord(params: {
  conversationUri: string;
  conversationCid: string;
  text: string;
}): Promise<{ uri: string; cid: string } | null> {
  const agent = await getAgent();
  if (!agent) return null;

  try {
    const result = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: 'community.blacksky.assembly.statement',
      record: {
        $type: 'community.blacksky.assembly.statement',
        conversation: {
          uri: params.conversationUri,
          cid: params.conversationCid,
        },
        text: params.text,
        createdAt: new Date().toISOString(),
      },
    });

    return { uri: result.data.uri, cid: result.data.cid };
  } catch (err) {
    console.error('Failed to create statement record in repo:', err);
    throw err;
  }
}

/**
 * Create a vote record in the participant's repo.
 * References the statement via strongRef.
 */
export async function createVoteRecord(params: {
  statementUri: string;
  statementCid: string;
  value: number; // -1=agree, 0=pass, 1=disagree
}): Promise<{ uri: string; cid: string } | null> {
  const agent = await getAgent();
  if (!agent) return null;

  try {
    const result = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: 'community.blacksky.assembly.vote',
      record: {
        $type: 'community.blacksky.assembly.vote',
        subject: {
          uri: params.statementUri,
          cid: params.statementCid,
        },
        value: params.value,
        createdAt: new Date().toISOString(),
      },
    });

    return { uri: result.data.uri, cid: result.data.cid };
  } catch (err) {
    console.error('Failed to create vote record in repo:', err);
    throw err;
  }
}

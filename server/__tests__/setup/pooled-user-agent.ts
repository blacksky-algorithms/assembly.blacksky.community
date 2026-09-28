import type { Agent } from "supertest";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import { getOidcToken, newAgent, setAgentJwt } from "./api-test-helpers";
import { pool } from "./db-test-helpers";
import { getPooledTestUser } from "./test-user-helpers";

export async function signInPooledUser(
  index: number
): Promise<{ agent: Agent; uid: number }> {
  // An agent from getJwtAuthenticatedAgent can reach the app instance that
  // global setup loaded, where the calling test file's jest.mock calls do not
  // apply.
  const agent = await newAgent();
  setAgentJwt(agent, await getOidcToken(getPooledTestUser(index)));
  const response = await agent.get("/api/v3/users");
  if (response.status !== 200) {
    throw new Error(
      `Pooled user ${index} could not sign in: ${response.status}`
    );
  }
  return { agent, uid: response.body.uid };
}

export async function zidOf(conversationId: string): Promise<number> {
  const zinvites = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  return zinvites.rows[0].zid;
}

export async function joinAsParticipant(
  conversationId: string
): Promise<{ agent: Agent; uid: number }> {
  const users = await pool.query(
    "INSERT INTO users (created) VALUES (default) RETURNING uid"
  );
  const uid: number = users.rows[0].uid;
  const participants = await pool.query(
    "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, now_as_millis()) RETURNING pid",
    [uid, await zidOf(conversationId)]
  );
  const agent = await newAgent();
  setAgentJwt(
    agent,
    issueAnonymousJWT(conversationId, uid, participants.rows[0].pid)
  );
  return { agent, uid };
}

import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
  setAgentJwt,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

const runId = `${process.pid}_${Date.now()}`;

async function signIn(index: number): Promise<Agent> {
  const pooledUser = getPooledTestUser(index);
  const { agent } = await getJwtAuthenticatedAgent({
    email: pooledUser.email,
    hname: pooledUser.name,
    password: pooledUser.password,
  });
  return agent;
}

describe("POST /api/v3/topicMod/moderate authorization", () => {
  let ownerAgent: Agent;
  let otherUserAgent: Agent;
  let participantAgent: Agent;
  let conversationId: string;
  let zid: number;
  let tid: number;

  async function storedModeration(): Promise<{
    mod: number;
    is_meta: boolean;
  }> {
    const result = await pool.query(
      "SELECT mod, is_meta FROM comments WHERE zid = $1 AND tid = $2",
      [zid, tid]
    );
    return result.rows[0];
  }

  function moderation(action: string) {
    return {
      conversation_id: conversationId,
      comment_ids: [tid],
      action,
      moderator: "admin",
    };
  }

  beforeAll(async () => {
    ownerAgent = await signIn(1);
    otherUserAgent = await signIn(2);

    conversationId = await createConversation(ownerAgent, {
      topic: `topicMod authorization ${runId}`,
    });
    const zinvites = await pool.query(
      "SELECT zid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    zid = zinvites.rows[0].zid;

    const users = await pool.query(
      "INSERT INTO users (created) VALUES (default) RETURNING uid"
    );
    const participantUid: number = users.rows[0].uid;
    const participants = await pool.query(
      "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, now_as_millis()) RETURNING pid",
      [participantUid, zid]
    );
    const participantPid: number = participants.rows[0].pid;
    const comments = await pool.query(
      `INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid)
       VALUES ($1, $2, $3, 1, true, 0, $4, false, false, default, null)
       RETURNING tid`,
      [
        participantPid,
        zid,
        `Statement awaiting moderation ${runId}`,
        participantUid,
      ]
    );
    tid = comments.rows[0].tid;

    participantAgent = await newAgent();
    setAgentJwt(
      participantAgent,
      issueAnonymousJWT(conversationId, participantUid, participantPid)
    );
  });

  test("starts with an unmoderated statement", async () => {
    expect(await storedModeration()).toEqual({ mod: 0, is_meta: false });
  });

  test("returns 401 without a token", async () => {
    const agent = await newAgent();
    const response = await agent
      .post("/api/v3/topicMod/moderate")
      .send(moderation("accept"));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "No authentication token found" });
    expect(await storedModeration()).toEqual({ mod: 0, is_meta: false });
  });

  test("returns 401 for a token of no known type", async () => {
    const agent = await newAgent();
    setAgentJwt(agent, "not-a-token");
    const response = await agent
      .post("/api/v3/topicMod/moderate")
      .send(moderation("accept"));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid token format");
    expect(await storedModeration()).toEqual({ mod: 0, is_meta: false });
  });

  test("returns 403 for the participant who wrote the statement", async () => {
    const response = await participantAgent
      .post("/api/v3/topicMod/moderate")
      .send(moderation("accept"));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_topicmod_moderate_permission");
    expect(await storedModeration()).toEqual({ mod: 0, is_meta: false });
  });

  test("returns 403 for a signed-in user who does not moderate the conversation", async () => {
    const response = await otherUserAgent
      .post("/api/v3/topicMod/moderate")
      .send(moderation("accept"));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "polis_err_topicmod_moderate_permission",
      message: "polis_err_topicmod_moderate_permission",
      status: 403,
    });
    expect(await storedModeration()).toEqual({ mod: 0, is_meta: false });
  });

  test("applies the action for the owner", async () => {
    const accepted = await ownerAgent
      .post("/api/v3/topicMod/moderate")
      .send(moderation("accept"));

    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe("success");
    expect(accepted.body.message).toBe(
      "Moderation action 'accept' applied successfully"
    );
    expect(await storedModeration()).toEqual({ mod: 1, is_meta: false });

    const rejected = await ownerAgent
      .post("/api/v3/topicMod/moderate")
      .send(moderation("reject"));

    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("success");
    expect(await storedModeration()).toEqual({ mod: -1, is_meta: false });
  });
});

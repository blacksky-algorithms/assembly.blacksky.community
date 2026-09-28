import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Express } from "express";
import request from "supertest";
import { issueXidJWT } from "../../src/auth/xid-jwt";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  installPlcFetchMock,
  jsonResponse,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

const runId = `${process.pid}${Date.now()}`;

type Conversation = { owner: number; zid: number; conversationId: string };
type ParticipantRow = { pid: number; uid: number };
type VoteRow = { pid: number; tid: number; vote: number };

let app: Express;
let plc: PlcFetchMock;

async function createUser(): Promise<number> {
  const result = await pool.query(
    "INSERT INTO users (created) VALUES (default) RETURNING uid"
  );
  return result.rows[0].uid;
}

async function createConversation(
  label: string,
  options: { authNeededToVote: boolean }
): Promise<Conversation> {
  const owner = await createUser();
  const conversations = await pool.query(
    `INSERT INTO conversations
       (owner, org_id, topic, is_active, is_draft, is_anon, strict_moderation,
        auth_needed_to_vote, auth_needed_to_write)
     VALUES ($1, $1, $2, true, false, true, false, $3, false)
     RETURNING zid`,
    [owner, `Embed vote ${label} ${runId}`, options.authNeededToVote]
  );
  const zid: number = conversations.rows[0].zid;
  const conversationId = `9e${label}${runId}`;
  await pool.query("INSERT INTO zinvites (zid, zinvite) VALUES ($1, $2)", [
    zid,
    conversationId,
  ]);
  return { owner, zid, conversationId };
}

async function addParticipant(zid: number, uid: number): Promise<number> {
  const result = await pool.query(
    "INSERT INTO participants (uid, zid) VALUES ($1, $2) RETURNING pid",
    [uid, zid]
  );
  return result.rows[0].pid;
}

async function addStatement(
  conversation: Conversation,
  pid: number,
  label: string
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO comments (pid, zid, txt, uid, is_seed, mod, active)
     VALUES ($1, $2, $3, $4, true, 1, true)
     RETURNING tid`,
    [pid, conversation.zid, `Statement ${label} ${runId}`, conversation.owner]
  );
  return result.rows[0].tid;
}

async function participantsOf(zid: number): Promise<ParticipantRow[]> {
  const result = await pool.query(
    "SELECT pid, uid FROM participants WHERE zid = $1 ORDER BY pid",
    [zid]
  );
  return result.rows;
}

async function voteHistoryOf(zid: number): Promise<VoteRow[]> {
  const result = await pool.query(
    "SELECT pid, tid, vote FROM votes WHERE zid = $1 ORDER BY pid, tid, created",
    [zid]
  );
  return result.rows;
}

beforeAll(async () => {
  plc = installPlcFetchMock(
    {},
    {
      fallback: (async () =>
        jsonResponse(
          { error: "blocked in tests" },
          { status: 503 }
        )) as typeof fetch,
    }
  );
  app = await getApp();
});

afterAll(() => {
  plc.restore();
});

describe("POST /api/v3/embed/vote with a participant token", () => {
  test("honours a token for the participant numbered 0", async () => {
    const conversation = await createConversation("pz", {
      authNeededToVote: false,
    });
    const voterUid = await createUser();
    const xid = `first-visitor-${runId}`;
    await pool.query("INSERT INTO xids (owner, uid, xid) VALUES ($1, $2, $3)", [
      conversation.owner,
      voterUid,
      xid,
    ]);
    const voterPid = await addParticipant(conversation.zid, voterUid);
    expect(voterPid).toBe(0);
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    expect(ownerPid).toBe(1);
    const tid = await addStatement(conversation, ownerPid, "pz");
    const token = issueXidJWT(
      xid,
      conversation.conversationId,
      voterUid,
      voterPid
    );

    const response = await request(app)
      .post("/api/v3/embed/vote")
      .set("Authorization", `Bearer ${token}`)
      .send({ conversation_id: conversation.conversationId, tid, vote: 1 });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.currentPid).toBe(voterPid);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: voterPid, uid: voterUid },
      { pid: ownerPid, uid: conversation.owner },
    ]);
    expect(await voteHistoryOf(conversation.zid)).toEqual([
      { pid: voterPid, tid, vote: 1 },
    ]);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Express } from "express";
import request from "supertest";
import { issueXidJWT } from "../../src/auth/xid-jwt";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  installPlcFetchMock,
  jsonResponse,
  randomDidPlc,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

const runId = `${process.pid}${Date.now()}`;
const VOTE_COLLECTION = "community.blacksky.assembly.vote";
const UNKNOWN_STATEMENT = "polis_err_embed_vote_unknown_statement";

type Conversation = { owner: number; zid: number; conversationId: string };
type ParticipantRow = { pid: number; uid: number };
type VoteRow = { pid: number; tid: number; vote: number };

let app: Express;
let plc: PlcFetchMock;
const outbound: string[] = [];

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

async function xidRowsOf(xid: string, owner: number): Promise<number> {
  const result = await pool.query(
    "SELECT uid FROM xids WHERE xid = $1 AND owner = $2",
    [xid, owner]
  );
  return result.rows.length;
}

function lookupsOf(did: string): string[] {
  return [...plc.requests.map((entry) => entry.url), ...outbound].filter(
    (url) => url.includes(encodeURIComponent(did)) || url.includes(did)
  );
}

beforeAll(async () => {
  plc = installPlcFetchMock(
    {},
    {
      fallback: (async (input: unknown) => {
        outbound.push(String(input));
        return jsonResponse({ error: "blocked in tests" }, { status: 503 });
      }) as typeof fetch,
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

describe("POST /api/v3/embed/vote for a statement that is not in the conversation", () => {
  test("answers 404 and creates nothing for a visitor without a token", async () => {
    const conversation = await createConversation("ua", {
      authNeededToVote: false,
    });
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    const tid = await addStatement(conversation, ownerPid, "ua");

    const response = await request(app)
      .post("/api/v3/embed/vote")
      .send({
        conversation_id: conversation.conversationId,
        tid: tid + 1,
        vote: 1,
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe(UNKNOWN_STATEMENT);
    expect(await voteHistoryOf(conversation.zid)).toEqual([]);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: ownerPid, uid: conversation.owner },
    ]);
  });

  test("answers 404 and records no vote for a participant with a token", async () => {
    const conversation = await createConversation("ub", {
      authNeededToVote: false,
    });
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    const tid = await addStatement(conversation, ownerPid, "ub");
    const voterUid = await createUser();
    const xid = `token-holder-${runId}`;
    await pool.query("INSERT INTO xids (owner, uid, xid) VALUES ($1, $2, $3)", [
      conversation.owner,
      voterUid,
      xid,
    ]);
    const voterPid = await addParticipant(conversation.zid, voterUid);
    const token = issueXidJWT(
      xid,
      conversation.conversationId,
      voterUid,
      voterPid
    );

    const response = await request(app)
      .post("/api/v3/embed/vote")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversation_id: conversation.conversationId,
        tid: tid + 987654,
        vote: 1,
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe(UNKNOWN_STATEMENT);
    expect(await voteHistoryOf(conversation.zid)).toEqual([]);
  });

  test("answers 404 for a statement number that only another conversation has", async () => {
    const small = await createConversation("uc", { authNeededToVote: false });
    const smallOwnerPid = await addParticipant(small.zid, small.owner);
    const onlyTid = await addStatement(small, smallOwnerPid, "uc");
    const large = await createConversation("ud", { authNeededToVote: false });
    const largeOwnerPid = await addParticipant(large.zid, large.owner);
    await addStatement(large, largeOwnerPid, "ud first");
    const secondTid = await addStatement(large, largeOwnerPid, "ud second");
    expect(secondTid).toBe(onlyTid + 1);

    const response = await request(app).post("/api/v3/embed/vote").send({
      conversation_id: small.conversationId,
      tid: secondTid,
      vote: -1,
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe(UNKNOWN_STATEMENT);
    expect(await voteHistoryOf(small.zid)).toEqual([]);
    expect(await voteHistoryOf(large.zid)).toEqual([]);
  });

  test("answers 404 before looking up the account that signed the vote record", async () => {
    const conversation = await createConversation("ue", {
      authNeededToVote: true,
    });
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    const tid = await addStatement(conversation, ownerPid, "ue");
    const did = randomDidPlc();

    const response = await request(app)
      .post("/api/v3/embed/vote")
      .send({
        conversation_id: conversation.conversationId,
        tid: tid + 1,
        vote: 1,
        vote_at_uri: `at://${did}/${VOTE_COLLECTION}/3kunknown${runId}`,
      });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe(UNKNOWN_STATEMENT);
    expect(lookupsOf(did)).toEqual([]);
    expect(await xidRowsOf(did, conversation.owner)).toBe(0);
    expect(await voteHistoryOf(conversation.zid)).toEqual([]);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: ownerPid, uid: conversation.owner },
    ]);
  });
});

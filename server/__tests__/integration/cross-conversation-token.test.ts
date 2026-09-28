import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { issueStandardUserJWT } from "../../src/auth/standard-user-jwt";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  installPlcFetchMock,
  jsonResponse,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

const runId = `${process.pid}${Date.now()}`;
const OWNER_PID = 0;
const FIRST_VOTER_PID = 1;
const SECOND_VOTER_PID = 2;

type Conversation = {
  owner: number;
  zid: number;
  conversationId: string;
  tid: number;
};
type ParticipantRow = { pid: number; uid: number };
type VoteRow = { pid: number; tid: number; vote: number };
type TokenClaims = {
  conversation_id: string;
  uid: number;
  pid: number;
  xid?: string;
  oidc_sub?: string;
  anonymous_participant?: boolean;
  xid_participant?: boolean;
  standard_user_participant?: boolean;
};

let app: Express;
let plc: PlcFetchMock;

async function createUser(): Promise<number> {
  const result = await pool.query(
    "INSERT INTO users (created) VALUES (default) RETURNING uid"
  );
  return result.rows[0].uid;
}

async function createOpenConversation(
  label: string,
  owner: number
): Promise<Conversation> {
  const conversations = await pool.query(
    `INSERT INTO conversations
       (owner, org_id, topic, is_active, is_draft, is_anon, strict_moderation,
        auth_needed_to_vote, auth_needed_to_write)
     VALUES ($1, $1, $2, true, false, true, false, false, false)
     RETURNING zid`,
    [owner, `Cross conversation ${label} ${runId}`]
  );
  const zid: number = conversations.rows[0].zid;
  const conversationId = `9x${label}${runId}`;
  await pool.query("INSERT INTO zinvites (zid, zinvite) VALUES ($1, $2)", [
    zid,
    conversationId,
  ]);
  const participants = await pool.query(
    "INSERT INTO participants (uid, zid) VALUES ($1, $2) RETURNING pid",
    [owner, zid]
  );
  expect(participants.rows[0].pid).toBe(OWNER_PID);
  const comments = await pool.query(
    `INSERT INTO comments (pid, zid, txt, uid, is_seed, mod, active)
     VALUES ($1, $2, $3, $4, true, 1, true)
     RETURNING tid`,
    [OWNER_PID, zid, `Seed statement ${label} ${runId}`, owner]
  );
  return { owner, zid, conversationId, tid: comments.rows[0].tid };
}

async function participantsOf(zid: number): Promise<ParticipantRow[]> {
  const result = await pool.query(
    "SELECT pid, uid FROM participants WHERE zid = $1 ORDER BY pid",
    [zid]
  );
  return result.rows;
}

async function latestVotesOf(zid: number): Promise<VoteRow[]> {
  const result = await pool.query(
    "SELECT pid, tid, vote FROM votes_latest_unique WHERE zid = $1 ORDER BY pid, tid",
    [zid]
  );
  return result.rows;
}

async function voteHistoryOf(zid: number): Promise<VoteRow[]> {
  const result = await pool.query(
    "SELECT pid, tid, vote FROM votes WHERE zid = $1 ORDER BY created, pid, tid",
    [zid]
  );
  return result.rows;
}

async function xidUidOf(xid: string, owner: number): Promise<number[]> {
  const result = await pool.query(
    "SELECT uid FROM xids WHERE xid = $1 AND owner = $2",
    [xid, owner]
  );
  return result.rows.map((row) => row.uid);
}

function claimsOf(token: string): TokenClaims {
  return jwt.decode(token) as TokenClaims;
}

function postVote(
  conversation: Conversation,
  vote: number,
  options: { xid?: string; token?: string } = {}
) {
  const call = request(app).post("/api/v3/votes");
  if (options.token) {
    call.set("Authorization", `Bearer ${options.token}`);
  }
  return call.send({
    conversation_id: conversation.conversationId,
    tid: conversation.tid,
    vote,
    ...(options.xid ? { xid: options.xid } : {}),
  });
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

describe("a participant token used in a conversation it was not issued for", () => {
  test("an xid token from another owner's conversation cannot vote as the participant with the same number", async () => {
    const issuing = await createOpenConversation("va", await createUser());
    const target = await createOpenConversation("vb", await createUser());

    const victim = await postVote(target, -1, { xid: `victim-v-${runId}` });
    expect(victim.status).toBe(200);
    expect(victim.body.currentPid).toBe(FIRST_VOTER_PID);
    const [victimUid] = await xidUidOf(`victim-v-${runId}`, target.owner);

    const attacker = await postVote(issuing, 0, {
      xid: `attacker-v-${runId}`,
    });
    expect(attacker.status).toBe(200);
    expect(attacker.body.currentPid).toBe(FIRST_VOTER_PID);
    const attackerClaims = claimsOf(attacker.body.auth.token);
    expect(attackerClaims.conversation_id).toBe(issuing.conversationId);
    expect(attackerClaims.pid).toBe(FIRST_VOTER_PID);

    const attack = await postVote(target, 1, {
      token: attacker.body.auth.token,
    });

    expect(attack.status).toBe(200);
    expect(attack.body.currentPid).toBe(SECOND_VOTER_PID);
    expect(await latestVotesOf(target.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: target.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: target.tid, vote: 1 },
    ]);
    expect(await voteHistoryOf(target.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: target.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: target.tid, vote: 1 },
    ]);

    const participants = await participantsOf(target.zid);
    expect(participants).toHaveLength(3);
    expect(participants[OWNER_PID]).toEqual({
      pid: OWNER_PID,
      uid: target.owner,
    });
    expect(participants[FIRST_VOTER_PID]).toEqual({
      pid: FIRST_VOTER_PID,
      uid: victimUid,
    });
    const newcomer = participants[SECOND_VOTER_PID];
    expect(newcomer.pid).toBe(SECOND_VOTER_PID);
    expect([victimUid, attackerClaims.uid, target.owner]).not.toContain(
      newcomer.uid
    );

    const issued = claimsOf(attack.body.auth.token);
    expect(issued.conversation_id).toBe(target.conversationId);
    expect(issued.pid).toBe(SECOND_VOTER_PID);
    expect(issued.uid).toBe(newcomer.uid);
    expect(issued.anonymous_participant).toBe(true);
    expect(issued.xid).toBeUndefined();
  });

  test("an xid token from another owner's conversation cannot write a statement as the participant with the same number", async () => {
    const issuing = await createOpenConversation("ca", await createUser());
    const target = await createOpenConversation("cb", await createUser());

    const victim = await postVote(target, -1, { xid: `victim-c-${runId}` });
    expect(victim.status).toBe(200);
    expect(victim.body.currentPid).toBe(FIRST_VOTER_PID);
    const [victimUid] = await xidUidOf(`victim-c-${runId}`, target.owner);

    const attacker = await postVote(issuing, 0, {
      xid: `attacker-c-${runId}`,
    });
    expect(attacker.status).toBe(200);
    expect(attacker.body.currentPid).toBe(FIRST_VOTER_PID);
    const attackerClaims = claimsOf(attacker.body.auth.token);

    const txt = `Statement sent with a foreign token ${runId}`;
    const attack = await request(app)
      .post("/api/v3/comments")
      .set("Authorization", `Bearer ${attacker.body.auth.token}`)
      .send({ conversation_id: target.conversationId, txt, vote: 1 });

    expect(attack.status).toBe(200);
    expect(attack.body.currentPid).toBe(SECOND_VOTER_PID);
    const statementTid: number = attack.body.tid;
    expect(statementTid).toBe(target.tid + 1);

    const statements = await pool.query(
      "SELECT pid, uid FROM comments WHERE zid = $1 AND tid = $2",
      [target.zid, statementTid]
    );
    const participants = await participantsOf(target.zid);
    expect(participants).toHaveLength(3);
    expect(participants[FIRST_VOTER_PID]).toEqual({
      pid: FIRST_VOTER_PID,
      uid: victimUid,
    });
    const newcomer = participants[SECOND_VOTER_PID];
    expect([victimUid, attackerClaims.uid, target.owner]).not.toContain(
      newcomer.uid
    );
    expect(statements.rows).toEqual([
      { pid: SECOND_VOTER_PID, uid: newcomer.uid },
    ]);
    expect(await latestVotesOf(target.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: target.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: statementTid, vote: 1 },
    ]);
  });

  test("an anonymous token from another owner's conversation cannot vote as the participant with the same number", async () => {
    const issuing = await createOpenConversation("aa", await createUser());
    const target = await createOpenConversation("ab", await createUser());

    const victim = await postVote(target, -1);
    expect(victim.status).toBe(200);
    expect(victim.body.currentPid).toBe(FIRST_VOTER_PID);
    const victimUid = claimsOf(victim.body.auth.token).uid;

    const attacker = await postVote(issuing, 0);
    expect(attacker.status).toBe(200);
    expect(attacker.body.currentPid).toBe(FIRST_VOTER_PID);
    const attackerClaims = claimsOf(attacker.body.auth.token);
    expect(attackerClaims.anonymous_participant).toBe(true);

    const attack = await postVote(target, 1, {
      token: attacker.body.auth.token,
    });

    expect(attack.status).toBe(200);
    expect(attack.body.currentPid).toBe(SECOND_VOTER_PID);
    expect(await latestVotesOf(target.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: target.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: target.tid, vote: 1 },
    ]);
    const participants = await participantsOf(target.zid);
    expect(participants).toHaveLength(3);
    expect(participants[FIRST_VOTER_PID]).toEqual({
      pid: FIRST_VOTER_PID,
      uid: victimUid,
    });
    expect([victimUid, attackerClaims.uid, target.owner]).not.toContain(
      participants[SECOND_VOTER_PID].uid
    );
  });

  test("a signed-in user's token from another conversation keeps the user and not the participant number", async () => {
    const issuing = await createOpenConversation("sa", await createUser());
    const target = await createOpenConversation("sb", await createUser());

    const other = await postVote(target, -1, { xid: `other-s-${runId}` });
    expect(other.status).toBe(200);
    expect(other.body.currentPid).toBe(FIRST_VOTER_PID);
    const [otherUid] = await xidUidOf(`other-s-${runId}`, target.owner);

    const uid = await createUser();
    const issuingParticipants = await pool.query(
      "INSERT INTO participants (uid, zid) VALUES ($1, $2) RETURNING pid",
      [uid, issuing.zid]
    );
    expect(issuingParticipants.rows[0].pid).toBe(FIRST_VOTER_PID);
    const oidcSub = `auth0|cross-conversation-${runId}`;
    const token = issueStandardUserJWT(
      oidcSub,
      issuing.conversationId,
      uid,
      FIRST_VOTER_PID
    );

    const crossing = await postVote(target, 1, { token });

    expect(crossing.status).toBe(200);
    expect(crossing.body.currentPid).toBe(SECOND_VOTER_PID);
    expect(await latestVotesOf(target.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: target.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: target.tid, vote: 1 },
    ]);
    expect(await participantsOf(target.zid)).toEqual([
      { pid: OWNER_PID, uid: target.owner },
      { pid: FIRST_VOTER_PID, uid: otherUid },
      { pid: SECOND_VOTER_PID, uid },
    ]);
    const issued = claimsOf(crossing.body.auth.token);
    expect(issued.conversation_id).toBe(target.conversationId);
    expect(issued.uid).toBe(uid);
    expect(issued.pid).toBe(SECOND_VOTER_PID);
    expect(issued.oidc_sub).toBe(oidcSub);
  });
});

describe("an xid token used in another conversation of the same owner", () => {
  test("keeps the xid identity and takes its own participant", async () => {
    const owner = await createUser();
    const first = await createOpenConversation("oa", owner);
    const second = await createOpenConversation("ob", owner);
    const xid = `embed-visitor-${runId}`;

    const other = await postVote(second, -1, { xid: `other-o-${runId}` });
    expect(other.status).toBe(200);
    expect(other.body.currentPid).toBe(FIRST_VOTER_PID);
    const [otherUid] = await xidUidOf(`other-o-${runId}`, owner);

    const visit = await postVote(first, 0, { xid });
    expect(visit.status).toBe(200);
    expect(visit.body.currentPid).toBe(FIRST_VOTER_PID);
    const visitClaims = claimsOf(visit.body.auth.token);
    expect(await xidUidOf(xid, owner)).toEqual([visitClaims.uid]);

    const crossing = await postVote(second, 1, {
      token: visit.body.auth.token,
    });

    expect(crossing.status).toBe(200);
    expect(crossing.body.currentPid).toBe(SECOND_VOTER_PID);
    expect(await xidUidOf(xid, owner)).toEqual([visitClaims.uid]);
    expect(await participantsOf(second.zid)).toEqual([
      { pid: OWNER_PID, uid: owner },
      { pid: FIRST_VOTER_PID, uid: otherUid },
      { pid: SECOND_VOTER_PID, uid: visitClaims.uid },
    ]);
    expect(await latestVotesOf(second.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: second.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: second.tid, vote: 1 },
    ]);
    const issued = claimsOf(crossing.body.auth.token);
    expect(issued.conversation_id).toBe(second.conversationId);
    expect(issued.xid).toBe(xid);
    expect(issued.xid_participant).toBe(true);
    expect(issued.uid).toBe(visitClaims.uid);
    expect(issued.pid).toBe(SECOND_VOTER_PID);

    const repeated = await postVote(second, -1, {
      token: visit.body.auth.token,
      xid,
    });

    expect(repeated.status).toBe(200);
    expect(repeated.body.currentPid).toBe(SECOND_VOTER_PID);
    expect(await participantsOf(second.zid)).toHaveLength(3);
    expect(await latestVotesOf(second.zid)).toEqual([
      { pid: FIRST_VOTER_PID, tid: second.tid, vote: -1 },
      { pid: SECOND_VOTER_PID, tid: second.tid, vote: -1 },
    ]);
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Express } from "express";
import request from "supertest";
import { issueXidJWT } from "../../src/auth/xid-jwt";
import pg from "../../src/db/pg-query";
import { nextTid } from "../../src/utils/tid";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  createTestIdentity,
  installPlcFetchMock,
  jsonResponse,
  randomDidPlc,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

const runId = `${process.pid}${Date.now()}`;
const VOTE_COLLECTION = "community.blacksky.assembly.vote";
const STATEMENT_COLLECTION = "community.blacksky.assembly.statement";
const GET_RECORD = "https://pds.test.invalid/xrpc/com.atproto.repo.getRecord?";
const XID_LOOKUP = /^\s*select\b.*\bfrom xids where xid\b/i;
const PID_LOOKUP = /^\s*select pid from participants where\b/i;
const UNKNOWN_STATEMENT = "polis_err_embed_vote_unknown_statement";

type Conversation = { owner: number; zid: number; conversationId: string };
type ParticipantRow = { pid: number; uid: number };
type VoteRow = { pid: number; tid: number; vote: number };
type Statement = { tid: number; uri: string; cid: string };
type XidRow = {
  uid: number;
  x_name: string | null;
  x_profile_image_url: string | null;
};

let app: Express;
let plc: PlcFetchMock;
const outbound: string[] = [];
const records = new Map<string, Record<string, unknown>>();

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

async function xidRowsOf(xid: string, owner: number): Promise<XidRow[]> {
  const result = await pool.query(
    "SELECT uid, x_name, x_profile_image_url FROM xids WHERE xid = $1 AND owner = $2",
    [xid, owner]
  );
  return result.rows;
}

async function addPublishedStatement(
  conversation: Conversation,
  pid: number,
  label: string
): Promise<Statement> {
  const tid = await addStatement(conversation, pid, label);
  const publisher = randomDidPlc();
  const uri = `at://${publisher}/${STATEMENT_COLLECTION}/${nextTid()}`;
  const cid = `bafystatement${tid}x${conversation.zid}`;
  await pool.query(
    "UPDATE comments SET at_uri = $1, at_cid = $2 WHERE zid = $3 AND tid = $4",
    [uri, cid, conversation.zid, tid]
  );
  return { tid, uri, cid };
}

async function registerAccount(): Promise<string> {
  const identity = await createTestIdentity();
  plc.setDocument(identity.did, identity.document);
  return identity.did;
}

function publishVoteRecord(
  did: string,
  statement: Statement,
  value: number
): string {
  const uri = `at://${did}/${VOTE_COLLECTION}/${nextTid()}`;
  records.set(uri, {
    $type: VOTE_COLLECTION,
    subject: { uri: statement.uri, cid: statement.cid },
    value,
    createdAt: new Date().toISOString(),
  });
  return uri;
}

function serveRecord(url: string): Response {
  const query = new URLSearchParams(url.slice(GET_RECORD.length));
  const uri = `at://${query.get("repo")}/${query.get("collection")}/${query.get(
    "rkey"
  )}`;
  const value = records.get(uri);
  if (!value) {
    return jsonResponse({ error: "RecordNotFound" }, { status: 400 });
  }
  return jsonResponse({ uri, cid: `bafyvote${query.get("rkey")}`, value });
}

function postRecordVote(
  conversation: Conversation,
  statement: Statement,
  vote: number,
  voteUri: string
) {
  return request(app).post("/api/v3/embed/vote").send({
    conversation_id: conversation.conversationId,
    tid: statement.tid,
    vote,
    vote_at_uri: voteUri,
  });
}

function holdXidLookupsUntilArrived(count: number) {
  const queryP = pg.queryP.bind(pg);
  let arrived = 0;
  let release: () => void = () => undefined;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .spyOn(pg, "queryP")
    .mockImplementation(async (sql: string, params?: unknown[]) => {
      const rows = await queryP(sql, params);
      if (arrived < count && XID_LOOKUP.test(sql)) {
        arrived += 1;
        if (arrived === count) {
          release();
        }
        await allArrived;
      }
      return rows;
    });
}

function afterFirstXidLookup(action: () => Promise<void>) {
  const queryP = pg.queryP.bind(pg);
  let done = false;
  jest
    .spyOn(pg, "queryP")
    .mockImplementation(async (sql: string, params?: unknown[]) => {
      const rows = await queryP(sql, params);
      if (!done && XID_LOOKUP.test(sql)) {
        done = true;
        await action();
      }
      return rows;
    });
}

function afterFirstPidLookup(
  zid: number,
  uid: number,
  action: () => Promise<void>
) {
  const query = pg.query.bind(pg);
  let done = false;
  jest.spyOn(pg, "query").mockImplementation((sql: string, ...args: any[]) => {
    const [params, callback] = args;
    const isLookup =
      PID_LOOKUP.test(sql) && params[0] === zid && params[1] === uid;
    if (done || !isLookup) {
      return query(sql, ...args);
    }
    done = true;
    return query(sql, params, (err: unknown, result: unknown) => {
      action().then(() => callback(err, result), callback);
    });
  });
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
        const url = String(input);
        outbound.push(url);
        if (url.startsWith(GET_RECORD)) {
          return serveRecord(url);
        }
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
    expect(await xidRowsOf(did, conversation.owner)).toEqual([]);
    expect(await voteHistoryOf(conversation.zid)).toEqual([]);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: ownerPid, uid: conversation.owner },
    ]);
  });
});

describe("POST /api/v3/embed/vote for an account that has no participant yet", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("two concurrent first votes end on one user and one participant", async () => {
    const conversation = await createConversation("ra", {
      authNeededToVote: true,
    });
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    const first = await addPublishedStatement(conversation, ownerPid, "ra 1");
    const second = await addPublishedStatement(conversation, ownerPid, "ra 2");
    const did = await registerAccount();
    const firstRecord = publishVoteRecord(did, first, 1);
    const secondRecord = publishVoteRecord(did, second, -1);
    holdXidLookupsUntilArrived(2);

    const [firstVote, secondVote] = await Promise.all([
      postRecordVote(conversation, first, 1, firstRecord),
      postRecordVote(conversation, second, -1, secondRecord),
    ]);

    expect(firstVote.status).toBe(200);
    expect(secondVote.status).toBe(200);
    const xids = await xidRowsOf(did, conversation.owner);
    expect(xids).toHaveLength(1);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: ownerPid, uid: conversation.owner },
      { pid: ownerPid + 1, uid: xids[0].uid },
    ]);
    expect(firstVote.body.currentPid).toBe(ownerPid + 1);
    expect(secondVote.body.currentPid).toBe(ownerPid + 1);
    expect(await voteHistoryOf(conversation.zid)).toEqual([
      { pid: ownerPid + 1, tid: first.tid, vote: 1 },
      { pid: ownerPid + 1, tid: second.tid, vote: -1 },
    ]);
  });

  test("a record created by a concurrent request keeps its user, name and avatar", async () => {
    const conversation = await createConversation("rb", {
      authNeededToVote: true,
    });
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    const statement = await addPublishedStatement(conversation, ownerPid, "rb");
    const did = await registerAccount();
    const record = publishVoteRecord(did, statement, 1);
    const holderUid = await createUser();
    const stored = {
      uid: holderUid,
      x_name: `Stored Name ${runId}`,
      x_profile_image_url: `https://cdn.test.invalid/${runId}.png`,
    };
    afterFirstXidLookup(async () => {
      await pool.query(
        "INSERT INTO xids (owner, uid, xid, x_name, x_profile_image_url) VALUES ($1, $2, $3, $4, $5)",
        [
          conversation.owner,
          stored.uid,
          did,
          stored.x_name,
          stored.x_profile_image_url,
        ]
      );
    });

    const response = await postRecordVote(conversation, statement, 1, record);

    expect(response.status).toBe(200);
    expect(await xidRowsOf(did, conversation.owner)).toEqual([stored]);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: ownerPid, uid: conversation.owner },
      { pid: ownerPid + 1, uid: holderUid },
    ]);
    expect(response.body.currentPid).toBe(ownerPid + 1);
    expect(await voteHistoryOf(conversation.zid)).toEqual([
      { pid: ownerPid + 1, tid: statement.tid, vote: 1 },
    ]);
  });

  test("a participant created by a concurrent request is reused", async () => {
    const conversation = await createConversation("rc", {
      authNeededToVote: true,
    });
    const ownerPid = await addParticipant(conversation.zid, conversation.owner);
    const statement = await addPublishedStatement(conversation, ownerPid, "rc");
    const did = await registerAccount();
    const record = publishVoteRecord(did, statement, -1);
    const holderUid = await createUser();
    await pool.query("INSERT INTO xids (owner, uid, xid) VALUES ($1, $2, $3)", [
      conversation.owner,
      holderUid,
      did,
    ]);
    afterFirstPidLookup(conversation.zid, holderUid, async () => {
      expect(await addParticipant(conversation.zid, holderUid)).toBe(
        ownerPid + 1
      );
    });

    const response = await postRecordVote(conversation, statement, -1, record);

    expect(response.status).toBe(200);
    expect(response.body.currentPid).toBe(ownerPid + 1);
    expect(await participantsOf(conversation.zid)).toEqual([
      { pid: ownerPid, uid: conversation.owner },
      { pid: ownerPid + 1, uid: holderUid },
    ]);
    expect(await voteHistoryOf(conversation.zid)).toEqual([
      { pid: ownerPid + 1, tid: statement.tid, vote: -1 },
    ]);
  });
});

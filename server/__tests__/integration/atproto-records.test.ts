import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { Agent } from "supertest";
import { createAnonStatementRecord, getAnonDid } from "../../src/auth/anon-pds";
import { issueAnonymousJWT } from "../../src/auth/anonymous-jwt";
import { issueXidJWT } from "../../src/auth/xid-jwt";
import Config from "../../src/config";
import pg from "../../src/db/pg-query";
import logger from "../../src/utils/logger";
import { nextTid } from "../../src/utils/tid";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  installPlcFetchMock,
  jsonResponse,
  randomDidPlc,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

jest.mock("../../src/auth/anon-pds", () => {
  const actual = jest.requireActual("../../src/auth/anon-pds") as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    getAnonDid: jest.fn(),
    createAnonStatementRecord: jest.fn(),
  };
});

jest.mock("akismet", () => ({
  client: () => ({
    verifyKey: () => undefined,
    checkSpam: (...args: unknown[]) => {
      (args[1] as (err: unknown, spam: boolean) => void)(null, false);
    },
  }),
}));

type Reference = { at_uri: string; at_cid: string };
type StoredReference = { at_uri: string | null; at_cid: string | null };
type Account = { uid: number; did: string; token: string };
type Conversation = { conversationId: string; zid: number };
type Participant = { uid: number; pid: number };
type Statement = { tid: number; uid: number; pid: number };
type ApiResponse = { status: number; body: Record<string, unknown> };
type TokenOf = (participant: Participant) => string;

const mockedGetAnonDid = getAnonDid as jest.MockedFunction<typeof getAnonDid>;
const mockedCreateAnonStatement =
  createAnonStatementRecord as jest.MockedFunction<
    typeof createAnonStatementRecord
  >;

const CONVERSATION_ROUTE = "/api/v3/atproto/conversation-record";
const STATEMENT_ROUTE = "/api/v3/atproto/statement-record";
const CONVERSATION_COLLECTION = "community.blacksky.assembly.conversation";
const STATEMENT_COLLECTION = "community.blacksky.assembly.statement";
const VOTE_COLLECTION = "community.blacksky.assembly.vote";
const DID_MATCH_SETTING = "ATPROTO_RECORD_DID_MATCH";
const MISMATCH_WARNING = "polis_warn_atproto_record_did_mismatch";
const SERVICE_DID = randomDidPlc();
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const NO_REFERENCE: StoredReference = { at_uri: null, at_cid: null };
const MODES = [
  { mode: "by default", setting: undefined },
  { mode: "with DID equality enforced", setting: "enforce" },
];
const SETTINGS_THAT_DO_NOT_ENFORCE = [
  "",
  "observe",
  "true",
  "ENFORCE",
  " enforce",
  "enforce ",
];
const runId = `${process.pid}x${Date.now()}`;

const originalDidMatch = process.env[DID_MATCH_SETTING];
const originalKeyPaths = {
  jwtPrivateKeyPath: Config.jwtPrivateKeyPath,
  jwtPublicKeyPath: Config.jwtPublicKeyPath,
};
const createdUids: number[] = [];
const createdZids: number[] = [];

let agent: Agent;
let server: http.Server;
let network: PlcFetchMock;
let keyDir: string;
let adminPrivateKey: string;
let otherPrivateKey: string;
let sequence = 0;
let errors: jest.SpiedFunction<typeof logger.error>;
let warnings: jest.SpiedFunction<typeof logger.warn>;

function encodeBase32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

function buildCid(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  return `b${encodeBase32(
    Buffer.concat([Buffer.from([0x01, 0x71, 0x12, 0x20]), digest])
  )}`;
}

function recordUri(did: string, collection: string): string {
  return `at://${did}/${collection}/${nextTid()}`;
}

function referenceTo(at_uri: string): Reference {
  return { at_uri, at_cid: buildCid(at_uri) };
}

function conversationIn(did: string): Reference {
  return referenceTo(recordUri(did, CONVERSATION_COLLECTION));
}

function statementIn(did: string): Reference {
  return referenceTo(recordUri(did, STATEMENT_COLLECTION));
}

function newerVersionOf(stored: Reference): Reference {
  return { at_uri: stored.at_uri, at_cid: buildCid("a newer version") };
}

function setDidMatch(setting: string | undefined): void {
  if (setting === undefined) {
    delete process.env[DID_MATCH_SETTING];
  } else {
    process.env[DID_MATCH_SETTING] = setting;
  }
}

function logged(
  spy: jest.SpiedFunction<typeof logger.error>,
  message: string
): unknown[] {
  return spy.mock.calls
    .filter(([first]) => (first as unknown) === message)
    .map((call) => (call as unknown[])[1]);
}

function expectRefused(
  response: ApiResponse,
  status: number,
  code: string,
  detail: unknown
): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: code, message: code, status });
  expect(logged(errors, code)).toStrictEqual([detail]);
}

function failStatementsThatStartWith(
  start: string,
  failure: Error
): jest.SpiedFunction<typeof pg.queryP> {
  const actual = pg.queryP;
  return jest
    .spyOn(pg, "queryP")
    .mockImplementation(((sql: string, ...args: unknown[]) =>
      sql.startsWith(start)
        ? Promise.reject(failure)
        : actual(sql, ...args)) as typeof pg.queryP);
}

function signAdminToken(uid: number, did: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: did,
      uid,
      type: "atproto_admin",
      proof: "atproto_service_auth",
      iss: "assembly.blacksky.community",
      aud: "users",
      iat: now,
      exp: now + 600,
    },
    privateKey,
    { algorithm: "RS256" }
  );
}

function anonymousTokenFor(conversation: Conversation): TokenOf {
  return (participant) =>
    issueAnonymousJWT(
      conversation.conversationId,
      participant.uid,
      participant.pid
    );
}

function xidTokenFor(conversation: Conversation, xid: string): TokenOf {
  return (participant) =>
    issueXidJWT(
      xid,
      conversation.conversationId,
      participant.uid,
      participant.pid
    );
}

async function newUid(): Promise<number> {
  const users = await pool.query(
    "INSERT INTO users (created) VALUES (default) RETURNING uid"
  );
  createdUids.push(users.rows[0].uid);
  return users.rows[0].uid;
}

async function newAccount(): Promise<Account> {
  const uid = await newUid();
  const did = randomDidPlc();
  return { uid, did, token: signAdminToken(uid, did, adminPrivateKey) };
}

async function post(
  route: string,
  body: Record<string, unknown>,
  token?: string
): Promise<ApiResponse> {
  const sending = agent.post(route);
  if (token !== undefined) {
    sending.set("Authorization", `Bearer ${token}`);
  }
  const response = await sending.send(body);
  return { status: response.status, body: response.body };
}

async function newConversation(
  owner: Account,
  options: { draft?: boolean; signInToVote?: boolean } = {}
): Promise<Conversation> {
  sequence += 1;
  const created = await post(
    "/api/v3/conversations",
    {
      topic: `Record routes ${runId} ${sequence}`,
      is_draft: options.draft === true,
      is_active: true,
    },
    owner.token
  );
  expect(created.status).toBe(200);
  const conversationId = created.body.conversation_id as string;
  const zinvites = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  const zid: number = zinvites.rows[0].zid;
  createdZids.push(zid);
  await pool.query(
    "UPDATE conversations SET auth_needed_to_vote = $1 WHERE zid = $2",
    [options.signInToVote !== false, zid]
  );
  return { conversationId, zid };
}

async function newParticipant(
  conversation: Conversation,
  uid?: number
): Promise<Participant> {
  const participantUid = uid ?? (await newUid());
  const participants = await pool.query(
    "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, now_as_millis()) RETURNING pid",
    [participantUid, conversation.zid]
  );
  return { uid: participantUid, pid: participants.rows[0].pid };
}

async function newStatement(
  conversation: Conversation,
  author: Participant,
  opts: { isSeed?: boolean; reference?: StoredReference } = {}
): Promise<Statement> {
  sequence += 1;
  const comments = await pool.query(
    `INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, at_uri, at_cid)
     VALUES ($1, $2, $3, 1, true, 1, $4, false, $5, default, null, $6, $7)
     RETURNING tid`,
    [
      author.pid,
      conversation.zid,
      `Statement ${runId} ${sequence}`,
      author.uid,
      opts.isSeed === true,
      opts.reference?.at_uri ?? null,
      opts.reference?.at_cid ?? null,
    ]
  );
  return { tid: comments.rows[0].tid, uid: author.uid, pid: author.pid };
}

async function conversationReference(
  conversation: Conversation
): Promise<StoredReference> {
  const result = await pool.query(
    "SELECT at_uri, at_cid FROM conversations WHERE zid = $1",
    [conversation.zid]
  );
  return result.rows[0];
}

async function statementReference(
  conversation: Conversation,
  tid: number
): Promise<StoredReference> {
  const result = await pool.query(
    "SELECT at_uri, at_cid FROM comments WHERE zid = $1 AND tid = $2",
    [conversation.zid, tid]
  );
  return result.rows[0];
}

async function expectKeptFromAnotherAccount(
  conversation: Conversation
): Promise<void> {
  const stored = await conversationReference(conversation);
  const other = await newAccount();

  const response = await post(
    CONVERSATION_ROUTE,
    {
      conversation_id: conversation.conversationId,
      ...conversationIn(other.did),
    },
    other.token
  );

  expect(response.status).toBe(403);
  expect(await conversationReference(conversation)).toEqual(stored);
}

async function expectKeptFromCallerWithoutToken(
  conversation: Conversation,
  tid: number
): Promise<void> {
  const stored = await statementReference(conversation, tid);

  const response = await post(STATEMENT_ROUTE, {
    conversation_id: conversation.conversationId,
    tid,
    ...statementIn(randomDidPlc()),
  });

  expect(response.status).toBe(401);
  expect(await statementReference(conversation, tid)).toEqual(stored);
}

// Sends what the card sends: vote_at_uri only for a statement that has a
// reference.
async function cardVote(
  conversation: Conversation,
  tid: number
): Promise<ApiResponse> {
  const voterDid = randomDidPlc();
  const voter = await newParticipant(conversation);
  const reference = await statementReference(conversation, tid);
  const signed =
    reference.at_uri && reference.at_cid
      ? { vote_at_uri: recordUri(voterDid, VOTE_COLLECTION) }
      : {};
  return post(
    "/api/v3/embed/vote",
    { conversation_id: conversation.conversationId, tid, vote: -1, ...signed },
    xidTokenFor(conversation, voterDid)(voter)
  );
}

function newKeyPair(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

beforeAll(async () => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "atproto-records-"));
  const { privateKey, publicKey } = newKeyPair();
  adminPrivateKey = privateKey;
  otherPrivateKey = newKeyPair().privateKey;
  fs.writeFileSync(path.join(keyDir, "private.pem"), privateKey);
  fs.writeFileSync(path.join(keyDir, "public.pem"), publicKey);
  Config.jwtPrivateKeyPath = path.join(keyDir, "private.pem");
  Config.jwtPublicKeyPath = path.join(keyDir, "public.pem");

  network = installPlcFetchMock(
    {},
    {
      fallback: (async () =>
        jsonResponse(
          { error: "blocked in tests" },
          { status: 503 }
        )) as typeof fetch,
    }
  );
  server = http.createServer(await getApp());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  agent = request.agent(`http://127.0.0.1:${port}`);
});

beforeEach(() => {
  setDidMatch(undefined);
  mockedGetAnonDid.mockReset().mockReturnValue(SERVICE_DID);
  mockedCreateAnonStatement.mockReset().mockImplementation(async () => {
    const uri = recordUri(SERVICE_DID, STATEMENT_COLLECTION);
    return { uri, cid: buildCid(uri) };
  });
  errors = jest.spyOn(logger, "error");
  warnings = jest.spyOn(logger, "warn");
});

afterEach(() => {
  errors.mockRestore();
  warnings.mockRestore();
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const participants = await client.query(
      "SELECT uid FROM participants WHERE zid = ANY($1)",
      [createdZids]
    );
    const uids = createdUids.concat(participants.rows.map((row) => row.uid));
    for (const table of [
      "votes",
      "votes_latest_unique",
      "notification_tasks",
      "comments",
      "participants_extended",
      "participants",
      "zinvites",
      "conversations",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE zid = ANY($1)`, [
        createdZids,
      ]);
    }
    await client.query("DELETE FROM xids WHERE uid = ANY($1)", [uids]);
    await client.query("DELETE FROM users WHERE uid = ANY($1)", [uids]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.warn("atproto record test rows were not removed", err);
  } finally {
    client.release();
  }

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  network.restore();
  Object.assign(Config, originalKeyPaths);
  fs.rmSync(keyDir, { recursive: true, force: true });
  setDidMatch(originalDidMatch);
});

describe("POST /api/v3/atproto/conversation-record", () => {
  let owner: Account;
  let conversation: Conversation;

  function body(reference: Reference): Record<string, unknown> {
    return { conversation_id: conversation.conversationId, ...reference };
  }

  function context(uid: number = owner.uid): Record<string, unknown> {
    return { zid: conversation.zid, uid };
  }

  async function ownerAsParticipant(): Promise<Participant> {
    return newParticipant(conversation, owner.uid);
  }

  beforeEach(async () => {
    owner = await newAccount();
    conversation = await newConversation(owner, { draft: true });
  });

  describe.each(MODES)("$mode", ({ setting }) => {
    beforeEach(() => {
      setDidMatch(setting);
    });

    test("stores the reference for the owner whose repo holds the record, and keeps it from another account", async () => {
      const reference = conversationIn(owner.did);

      const response = await post(
        CONVERSATION_ROUTE,
        body(reference),
        owner.token
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(await conversationReference(conversation)).toEqual(reference);
      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
      const card = await agent.get(
        `/api/v3/embed/conversation?conversation_id=${conversation.conversationId}`
      );
      expect(card.status).toBe(200);
      expect(card.body.conversation.at_uri).toBe(reference.at_uri);
      expect(card.body.conversation.at_cid).toBe(reference.at_cid);
      await expectKeptFromAnotherAccount(conversation);
    });

    test.each([
      {
        token: "an anonymous token",
        tokenOf: (): TokenOf => anonymousTokenFor(conversation),
      },
      {
        token: "a token whose xid is not a DID",
        tokenOf: (): TokenOf => xidTokenFor(conversation, `member-${runId}`),
      },
    ])(
      "stores the reference for a moderator with $token, and keeps it from another account",
      async ({ tokenOf }) => {
        const reference = conversationIn(randomDidPlc());

        const response = await post(
          CONVERSATION_ROUTE,
          body(reference),
          tokenOf()(await ownerAsParticipant())
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect(await conversationReference(conversation)).toEqual(reference);
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
        await expectKeptFromAnotherAccount(conversation);
      }
    );

    test.each([
      {
        other: "another record",
        build: (): Reference => conversationIn(owner.did),
      },
      {
        other: "another record with the same CID",
        build: (stored: Reference): Reference => ({
          ...conversationIn(owner.did),
          at_cid: stored.at_cid,
        }),
      },
      { other: "another version of the record", build: newerVersionOf },
    ])(
      "answers 200 for the stored reference and 409 for $other",
      async ({ build }) => {
        const stored = conversationIn(owner.did);
        expect(
          (await post(CONVERSATION_ROUTE, body(stored), owner.token)).status
        ).toBe(200);

        const repeated = await post(
          CONVERSATION_ROUTE,
          body(stored),
          owner.token
        );
        const replaced = await post(
          CONVERSATION_ROUTE,
          body(build(stored)),
          owner.token
        );

        expect(repeated.status).toBe(200);
        expect(repeated.body).toEqual({ success: true });
        expectRefused(
          replaced,
          409,
          "polis_err_atproto_record_already_set",
          context()
        );
        expect(await conversationReference(conversation)).toEqual(stored);
      }
    );

    test("answers 500, stores nothing and logs the cause once when the database fails", async () => {
      const failure = new Error(`database failure ${runId}`);
      const queries = failStatementsThatStartWith(
        "UPDATE conversations SET at_uri",
        failure
      );

      const response = await post(
        CONVERSATION_ROUTE,
        body(conversationIn(owner.did)),
        owner.token
      );
      queries.mockRestore();

      expectRefused(
        response,
        500,
        "polis_err_store_conversation_record",
        failure
      );
      expect(await conversationReference(conversation)).toEqual(NO_REFERENCE);
    });

    test("answers 403 for a signed-in user who does not moderate the conversation", async () => {
      const other = await newAccount();

      const response = await post(
        CONVERSATION_ROUTE,
        body(conversationIn(other.did)),
        other.token
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_conversation_record_permission",
        context(other.uid)
      );
      expect(await conversationReference(conversation)).toEqual(NO_REFERENCE);
    });

    test("answers 403 for a participant of the conversation", async () => {
      const participant = await newParticipant(conversation);
      const did = randomDidPlc();

      const response = await post(
        CONVERSATION_ROUTE,
        body(conversationIn(did)),
        xidTokenFor(conversation, did)(participant)
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_conversation_record_permission",
        context(participant.uid)
      );
      expect(await conversationReference(conversation)).toEqual(NO_REFERENCE);
    });

    test("answers 403 for the owner of another conversation who replaces a stored reference", async () => {
      const stored = conversationIn(owner.did);
      expect(
        (await post(CONVERSATION_ROUTE, body(stored), owner.token)).status
      ).toBe(200);
      const other = await newAccount();
      await newConversation(other);

      const response = await post(
        CONVERSATION_ROUTE,
        body(conversationIn(other.did)),
        other.token
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_conversation_record_permission",
        context(other.uid)
      );
      expect(await conversationReference(conversation)).toEqual(stored);
    });

    test.each([
      {
        address: "a statement record",
        build: (did: string): string => recordUri(did, STATEMENT_COLLECTION),
      },
      {
        address: "a record of another application",
        build: (did: string): string => recordUri(did, "app.bsky.feed.post"),
      },
      {
        address: "an address with a fourth part",
        build: (did: string): string =>
          `${recordUri(did, CONVERSATION_COLLECTION)}/extra`,
      },
      {
        address: "a web address",
        build: (did: string): string =>
          `https://pds.test.invalid/${did}/${CONVERSATION_COLLECTION}/${nextTid()}`,
      },
      {
        address: "a handle in place of the DID",
        build: (): string =>
          `at://owner.test.invalid/${CONVERSATION_COLLECTION}/${nextTid()}`,
      },
      {
        address: "a record key of one dot",
        build: (did: string): string =>
          `at://${did}/${CONVERSATION_COLLECTION}/.`,
      },
      {
        address: "a record key of two dots",
        build: (did: string): string =>
          `at://${did}/${CONVERSATION_COLLECTION}/..`,
      },
    ])("answers 400 for $address as at_uri", async ({ build }) => {
      const response = await post(
        CONVERSATION_ROUTE,
        body(referenceTo(build(owner.did))),
        owner.token
      );

      expectRefused(
        response,
        400,
        "polis_err_atproto_record_uri_invalid",
        context()
      );
      expect(await conversationReference(conversation)).toEqual(NO_REFERENCE);
    });

    test("answers 400 for an at_cid that is not a record CID", async () => {
      const response = await post(
        CONVERSATION_ROUTE,
        body({ ...conversationIn(owner.did), at_cid: "bafyembedtest" }),
        owner.token
      );

      expectRefused(
        response,
        400,
        "polis_err_atproto_record_cid_invalid",
        context()
      );
      expect(await conversationReference(conversation)).toEqual(NO_REFERENCE);
    });
  });

  describe("when the caller's DID is not the DID in the address", () => {
    const callers = [
      {
        caller: "an admin token",
        tokenOf: async (): Promise<string> => owner.token,
      },
      {
        caller: "a moderator's participant token",
        tokenOf: async (): Promise<string> =>
          xidTokenFor(conversation, owner.did)(await ownerAsParticipant()),
      },
    ];

    test.each(callers)(
      "stores the reference and logs both DIDs for $caller",
      async ({ tokenOf }) => {
        const recordDid = randomDidPlc();
        const reference = conversationIn(recordDid);

        const response = await post(
          CONVERSATION_ROUTE,
          body(reference),
          await tokenOf()
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect(await conversationReference(conversation)).toEqual(reference);
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([
          { ...context(), caller_did: owner.did, record_did: recordDid },
        ]);
      }
    );

    test.each(callers)(
      "answers 403 for $caller when the setting is enforce",
      async ({ tokenOf }) => {
        setDidMatch("enforce");

        const response = await post(
          CONVERSATION_ROUTE,
          body(conversationIn(randomDidPlc())),
          await tokenOf()
        );

        expectRefused(
          response,
          403,
          "polis_err_atproto_record_did_mismatch",
          context()
        );
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
        expect(await conversationReference(conversation)).toEqual(NO_REFERENCE);
      }
    );

    test.each(SETTINGS_THAT_DO_NOT_ENFORCE)(
      "stores the reference and logs both DIDs when the setting is %j",
      async (setting) => {
        setDidMatch(setting);
        const recordDid = randomDidPlc();
        const reference = conversationIn(recordDid);

        const response = await post(
          CONVERSATION_ROUTE,
          body(reference),
          owner.token
        );

        expect(response.status).toBe(200);
        expect(await conversationReference(conversation)).toEqual(reference);
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([
          { ...context(), caller_did: owner.did, record_did: recordDid },
        ]);
      }
    );

    test("lets the conversation publish its seed statements and take votes from the card", async () => {
      const recordDid = randomDidPlc();
      const reference = conversationIn(recordDid);
      const stored = await post(
        CONVERSATION_ROUTE,
        body(reference),
        owner.token
      );
      expect(stored.status).toBe(200);
      const txt = `Seed ${runId}`;

      const seed = await post(
        "/api/v3/comments",
        { conversation_id: conversation.conversationId, txt, is_seed: true },
        owner.token
      );
      const tid = seed.body.tid as number;
      const vote = await cardVote(conversation, tid);

      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([
        { ...context(), caller_did: owner.did, record_did: recordDid },
      ]);
      expect(seed.status).toBe(200);
      expect(mockedCreateAnonStatement.mock.calls).toEqual([
        [
          {
            conversationUri: reference.at_uri,
            conversationCid: reference.at_cid,
            text: txt,
          },
        ],
      ]);
      expect(await statementReference(conversation, tid)).toEqual({
        at_uri: seed.body.at_uri,
        at_cid: seed.body.at_cid,
      });
      expect(seed.body.at_uri).toMatch(
        new RegExp(`^at://${SERVICE_DID}/${STATEMENT_COLLECTION}/`)
      );
      expect(vote.status).toBe(200);
      expect(vote.body.success).toBe(true);
    });
  });
});

describe("POST /api/v3/atproto/statement-record", () => {
  let owner: Account;
  let conversation: Conversation;
  let authorDid: string;
  let author: Participant;
  let authorToken: string;
  let statement: Statement;

  function body(
    reference: Reference,
    tid: number = statement.tid,
    xid: string = authorDid
  ): Record<string, unknown> {
    return {
      conversation_id: conversation.conversationId,
      tid,
      ...reference,
      xid,
      x_name: "Author",
    };
  }

  function context(
    uid: number = author.uid,
    tid: number = statement.tid
  ): Record<string, unknown> {
    return { zid: conversation.zid, tid, uid };
  }

  async function ownerAsParticipant(): Promise<Participant> {
    return newParticipant(conversation, owner.uid);
  }

  beforeEach(async () => {
    owner = await newAccount();
    conversation = await newConversation(owner);
    authorDid = randomDidPlc();
    author = await newParticipant(conversation);
    authorToken = xidTokenFor(conversation, authorDid)(author);
    statement = await newStatement(conversation, author);
  });

  describe.each(MODES)("$mode", ({ setting }) => {
    beforeEach(() => {
      setDidMatch(setting);
    });

    test("stores the reference for the participant who wrote the statement, and keeps it from a caller without a token", async () => {
      const reference = statementIn(authorDid);

      const response = await post(
        STATEMENT_ROUTE,
        body(reference),
        authorToken
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(await statementReference(conversation, statement.tid)).toEqual(
        reference
      );
      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
      const card = await agent.get(
        `/api/v3/embed/conversation?conversation_id=${conversation.conversationId}`
      );
      expect(card.status).toBe(200);
      expect(card.body.nextComment.tid).toBe(statement.tid);
      expect(card.body.nextComment.at_uri).toBe(reference.at_uri);
      expect(card.body.nextComment.at_cid).toBe(reference.at_cid);
      await expectKeptFromCallerWithoutToken(conversation, statement.tid);
    });

    test.each([
      {
        token: "an anonymous token",
        tokenOf: (): TokenOf => anonymousTokenFor(conversation),
      },
      {
        token: "a token whose xid is not a DID",
        tokenOf: (): TokenOf => xidTokenFor(conversation, `member-${runId}`),
      },
    ])(
      "stores the reference for an author with $token, and keeps it from a caller without a token",
      async ({ tokenOf }) => {
        const participant = await newParticipant(conversation);
        const written = await newStatement(conversation, participant);
        const reference = statementIn(randomDidPlc());

        const response = await post(
          STATEMENT_ROUTE,
          body(reference, written.tid),
          tokenOf()(participant)
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect(await statementReference(conversation, written.tid)).toEqual(
          reference
        );
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
        await expectKeptFromCallerWithoutToken(conversation, written.tid);
      }
    );

    test("stores the reference for an author signed in with an admin token whose repo holds the record, and keeps it from a caller without a token", async () => {
      const account = await newAccount();
      const written = await newStatement(
        conversation,
        await newParticipant(conversation, account.uid)
      );
      const reference = statementIn(account.did);

      const response = await post(
        STATEMENT_ROUTE,
        body(reference, written.tid, account.did),
        account.token
      );

      expect(response.status).toBe(200);
      expect(await statementReference(conversation, written.tid)).toEqual(
        reference
      );
      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
      await expectKeptFromCallerWithoutToken(conversation, written.tid);
    });

    test("stores the reference after a statement sent the way the participation page sends it, and keeps it from a caller without a token", async () => {
      const did = randomDidPlc();
      const identity = { xid: did, x_name: "Participant" };
      const submitted = await post("/api/v3/comments", {
        conversation_id: conversation.conversationId,
        txt: `Statement from the page ${runId}`,
        vote: -1,
        ...identity,
      });
      expect(submitted.status).toBe(200);
      const token = (submitted.body.auth as { token: string }).token;
      const tid = submitted.body.tid as number;
      const reference = statementIn(did);

      const response = await post(
        STATEMENT_ROUTE,
        {
          conversation_id: conversation.conversationId,
          tid,
          ...reference,
          ...identity,
        },
        token
      );

      expect(response.status).toBe(200);
      expect(await statementReference(conversation, tid)).toEqual(reference);
      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
      await expectKeptFromCallerWithoutToken(conversation, tid);
    });

    test("stores the reference for a participant who voted before signing in, and keeps it from a caller without a token", async () => {
      const open = await newConversation(owner, { signInToVote: false });
      const seed = await newStatement(
        open,
        await newParticipant(open, owner.uid),
        { isSeed: true }
      );
      const voted = await post("/api/v3/votes", {
        conversation_id: open.conversationId,
        tid: seed.tid,
        vote: 0,
      });
      expect(voted.status).toBe(200);
      const token = (voted.body.auth as { token: string }).token;
      expect(jwt.decode(token)).toMatchObject({ anonymous_participant: true });
      const did = randomDidPlc();
      const identity = { xid: did, x_name: "Participant" };
      const submitted = await post(
        "/api/v3/comments",
        {
          conversation_id: open.conversationId,
          txt: `Statement after signing in ${runId}`,
          vote: -1,
          ...identity,
        },
        token
      );
      expect(submitted.status).toBe(200);
      expect(submitted.body.auth).toBeUndefined();
      const tid = submitted.body.tid as number;
      const reference = statementIn(did);

      const response = await post(
        STATEMENT_ROUTE,
        {
          conversation_id: open.conversationId,
          tid,
          ...reference,
          ...identity,
        },
        token
      );

      expect(response.status).toBe(200);
      expect(await statementReference(open, tid)).toEqual(reference);
      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
      await expectKeptFromCallerWithoutToken(open, tid);
    });

    test.each([
      {
        other: "another record",
        build: (): Reference => statementIn(authorDid),
      },
      {
        other: "another record with the same CID",
        build: (stored: Reference): Reference => ({
          ...statementIn(authorDid),
          at_cid: stored.at_cid,
        }),
      },
      { other: "another version of the record", build: newerVersionOf },
    ])(
      "answers 200 for the stored reference and 409 for $other",
      async ({ build }) => {
        const stored = statementIn(authorDid);
        expect(
          (await post(STATEMENT_ROUTE, body(stored), authorToken)).status
        ).toBe(200);

        const repeated = await post(STATEMENT_ROUTE, body(stored), authorToken);
        const replaced = await post(
          STATEMENT_ROUTE,
          body(build(stored)),
          authorToken
        );

        expect(repeated.status).toBe(200);
        expect(repeated.body).toEqual({ success: true });
        expectRefused(
          replaced,
          409,
          "polis_err_atproto_record_already_set",
          context()
        );
        expect(await statementReference(conversation, statement.tid)).toEqual(
          stored
        );
      }
    );

    test("answers 500, stores nothing and logs the cause once when the database fails", async () => {
      const failure = new Error(`database failure ${runId}`);
      const queries = failStatementsThatStartWith(
        "UPDATE comments SET at_uri",
        failure
      );

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid)),
        authorToken
      );
      queries.mockRestore();

      expectRefused(response, 500, "polis_err_store_statement_record", failure);
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 401 without a token and keeps the reference of a seed statement", async () => {
      const stored = statementIn(SERVICE_DID);
      const seed = await newStatement(
        conversation,
        await ownerAsParticipant(),
        { isSeed: true, reference: stored }
      );

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(randomDidPlc()), seed.tid)
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "No authentication token found" });
      expect(await statementReference(conversation, seed.tid)).toEqual(stored);
    });

    test("answers 401 without a token for a statement that has no reference", async () => {
      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid))
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "No authentication token found" });
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 401 for an admin token that names the author and is signed with another key", async () => {
      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid)),
        signAdminToken(author.uid, authorDid, otherPrivateKey)
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Invalid admin token" });
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 403 for another participant of the conversation", async () => {
      const other = await newParticipant(conversation);
      const otherDid = randomDidPlc();

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(otherDid), statement.tid, otherDid),
        xidTokenFor(conversation, otherDid)(other)
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_statement_record_permission",
        context(other.uid)
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 403 for a participant of another conversation who holds the same pid", async () => {
      const elsewhere = await newConversation(owner);
      const other = await newParticipant(elsewhere);
      expect(other.pid).toBe(author.pid);

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid)),
        xidTokenFor(elsewhere, authorDid)(other)
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_statement_record_permission",
        context(other.uid)
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 403 for the author's token of another conversation", async () => {
      const elsewhere = await newConversation(owner);

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid)),
        xidTokenFor(elsewhere, authorDid)(author)
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_statement_record_permission",
        context()
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 403 for a token that names the author and another participant id", async () => {
      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid)),
        xidTokenFor(
          conversation,
          authorDid
        )({
          uid: author.uid,
          pid: author.pid + 1,
        })
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_statement_record_permission",
        context()
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 403 for the owner of the conversation", async () => {
      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(owner.did), statement.tid, owner.did),
        owner.token
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_statement_record_permission",
        context(owner.uid)
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test.each([
      {
        seed: "that has a reference",
        stored: (): StoredReference => statementIn(SERVICE_DID),
      },
      {
        seed: "that has no reference",
        stored: (): StoredReference => NO_REFERENCE,
      },
    ])(
      "answers 403 for a seed statement $seed, sent by the account that wrote it",
      async ({ stored }) => {
        const reference = stored();
        const seed = await newStatement(
          conversation,
          await ownerAsParticipant(),
          { isSeed: true, reference }
        );

        const response = await post(
          STATEMENT_ROUTE,
          body(statementIn(owner.did), seed.tid, owner.did),
          owner.token
        );

        expectRefused(
          response,
          403,
          "polis_err_atproto_statement_record_permission",
          context(owner.uid, seed.tid)
        );
        expect(await statementReference(conversation, seed.tid)).toEqual(
          reference
        );
      }
    );

    test.each([
      {
        token: "an anonymous token",
        tokenOf: (): TokenOf => anonymousTokenFor(conversation),
      },
      {
        token: "a token that names the service account",
        tokenOf: (): TokenOf => xidTokenFor(conversation, SERVICE_DID),
      },
    ])(
      "answers 403 for a record in the service account, sent with $token",
      async ({ tokenOf }) => {
        const participant = await newParticipant(conversation);
        const written = await newStatement(conversation, participant);

        const response = await post(
          STATEMENT_ROUTE,
          body(statementIn(SERVICE_DID), written.tid, SERVICE_DID),
          tokenOf()(participant)
        );

        expectRefused(
          response,
          403,
          "polis_err_atproto_record_did_mismatch",
          context(participant.uid, written.tid)
        );
        expect(await statementReference(conversation, written.tid)).toEqual(
          NO_REFERENCE
        );
      }
    );

    test("answers 404 for a statement that does not exist", async () => {
      const missing = statement.tid + 1000;

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(authorDid), missing),
        authorToken
      );

      expectRefused(
        response,
        404,
        "polis_err_atproto_statement_not_found",
        context(author.uid, missing)
      );
    });

    test.each([
      {
        address: "a conversation record",
        build: (did: string): string => recordUri(did, CONVERSATION_COLLECTION),
      },
      {
        address: "a vote record",
        build: (did: string): string => recordUri(did, VOTE_COLLECTION),
      },
      {
        address: "a record of another application",
        build: (did: string): string => recordUri(did, "app.bsky.feed.post"),
      },
      {
        address: "an address with a fourth part",
        build: (did: string): string =>
          `${recordUri(did, STATEMENT_COLLECTION)}/extra`,
      },
      {
        address: "a web address",
        build: (did: string): string =>
          `https://pds.test.invalid/${did}/${STATEMENT_COLLECTION}/${nextTid()}`,
      },
      {
        address: "a handle in place of the DID",
        build: (): string =>
          `at://author.test.invalid/${STATEMENT_COLLECTION}/${nextTid()}`,
      },
      {
        address: "a record key of one dot",
        build: (did: string): string => `at://${did}/${STATEMENT_COLLECTION}/.`,
      },
      {
        address: "a record key of two dots",
        build: (did: string): string =>
          `at://${did}/${STATEMENT_COLLECTION}/..`,
      },
    ])("answers 400 for $address as at_uri", async ({ build }) => {
      const response = await post(
        STATEMENT_ROUTE,
        body(referenceTo(build(authorDid))),
        authorToken
      );

      expectRefused(
        response,
        400,
        "polis_err_atproto_record_uri_invalid",
        context()
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("answers 400 for an at_cid that is not a record CID", async () => {
      const response = await post(
        STATEMENT_ROUTE,
        body({ ...statementIn(authorDid), at_cid: "bafyembedtest" }),
        authorToken
      );

      expectRefused(
        response,
        400,
        "polis_err_atproto_record_cid_invalid",
        context()
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });
  });

  describe("when the caller's DID is not the DID in the address", () => {
    type Caller = { uid: number; did: string; token: string; tid: number };

    const callers = [
      {
        caller: "a participant token",
        build: async (): Promise<Caller> => ({
          uid: author.uid,
          did: authorDid,
          token: authorToken,
          tid: statement.tid,
        }),
      },
      {
        caller: "an admin token",
        build: async (): Promise<Caller> => {
          const account = await newAccount();
          const written = await newStatement(
            conversation,
            await newParticipant(conversation, account.uid)
          );
          return { ...account, tid: written.tid };
        },
      },
    ];

    test.each(callers)(
      "stores the reference and logs both DIDs for $caller",
      async ({ build }) => {
        const caller = await build();
        const recordDid = randomDidPlc();
        const reference = statementIn(recordDid);

        const response = await post(
          STATEMENT_ROUTE,
          body(reference, caller.tid, caller.did),
          caller.token
        );

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect(await statementReference(conversation, caller.tid)).toEqual(
          reference
        );
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([
          {
            ...context(caller.uid, caller.tid),
            caller_did: caller.did,
            record_did: recordDid,
          },
        ]);
      }
    );

    test.each(callers)(
      "answers 403 for $caller when the setting is enforce",
      async ({ build }) => {
        setDidMatch("enforce");
        const caller = await build();

        const response = await post(
          STATEMENT_ROUTE,
          body(statementIn(randomDidPlc()), caller.tid, caller.did),
          caller.token
        );

        expectRefused(
          response,
          403,
          "polis_err_atproto_record_did_mismatch",
          context(caller.uid, caller.tid)
        );
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([]);
        expect(await statementReference(conversation, caller.tid)).toEqual(
          NO_REFERENCE
        );
      }
    );

    test.each(SETTINGS_THAT_DO_NOT_ENFORCE)(
      "stores the reference and logs both DIDs when the setting is %j",
      async (setting) => {
        setDidMatch(setting);
        const recordDid = randomDidPlc();
        const reference = statementIn(recordDid);

        const response = await post(
          STATEMENT_ROUTE,
          body(reference),
          authorToken
        );

        expect(response.status).toBe(200);
        expect(await statementReference(conversation, statement.tid)).toEqual(
          reference
        );
        expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([
          { ...context(), caller_did: authorDid, record_did: recordDid },
        ]);
      }
    );

    test("answers 403 when the setting is enforce and only the request body names the DID in the address", async () => {
      setDidMatch("enforce");
      const recordDid = randomDidPlc();

      const response = await post(
        STATEMENT_ROUTE,
        body(statementIn(recordDid), statement.tid, recordDid),
        authorToken
      );

      expectRefused(
        response,
        403,
        "polis_err_atproto_record_did_mismatch",
        context()
      );
      expect(await statementReference(conversation, statement.tid)).toEqual(
        NO_REFERENCE
      );
    });

    test("lets the card vote on the statement of a participant who changed accounts", async () => {
      const first = randomDidPlc();
      const second = randomDidPlc();
      const earlier = await post("/api/v3/comments", {
        conversation_id: conversation.conversationId,
        txt: `Earlier statement ${runId}`,
        vote: -1,
        xid: first,
        x_name: "First",
      });
      expect(earlier.status).toBe(200);
      const token = (earlier.body.auth as { token: string }).token;
      const claims = jwt.decode(token) as { uid: number; xid: string };
      expect(claims.xid).toBe(first);
      const identity = { xid: second, x_name: "Second" };
      const later = await post(
        "/api/v3/comments",
        {
          conversation_id: conversation.conversationId,
          txt: `Later statement ${runId}`,
          vote: -1,
          ...identity,
        },
        token
      );
      expect(later.status).toBe(200);
      const tid = later.body.tid as number;
      const reference = statementIn(second);

      const response = await post(
        STATEMENT_ROUTE,
        {
          conversation_id: conversation.conversationId,
          tid,
          ...reference,
          ...identity,
        },
        token
      );
      const vote = await cardVote(conversation, tid);

      expect(response.status).toBe(200);
      expect(await statementReference(conversation, tid)).toEqual(reference);
      expect(logged(warnings, MISMATCH_WARNING)).toStrictEqual([
        {
          ...context(claims.uid, tid),
          caller_did: first,
          record_did: second,
        },
      ]);
      expect(vote.status).toBe(200);
      expect(vote.body.success).toBe(true);
    });
  });
});

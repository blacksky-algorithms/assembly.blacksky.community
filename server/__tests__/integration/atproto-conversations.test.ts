import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
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
import { Client } from "pg";
import type { QueryResultRow } from "pg";
import request from "supertest";
import type { Agent } from "supertest";
import {
  ensureAnonSession,
  getAnonDid,
  putAnonStatementRecord,
} from "../../src/auth/anon-pds";
import { checkMembershipBatch } from "../../src/auth/atproto-admin";
import { clearAtprotoIdentityCache } from "../../src/auth/atproto-did";
import { generateTokenP } from "../../src/auth/generate-token";
import { detectLanguage } from "../../src/comment";
import Config from "../../src/config";
import pg from "../../src/db/pg-query";
import logger from "../../src/utils/logger";
import { isValidTid } from "../../src/utils/tid";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  TestIdentity,
  buildServiceAuthClaims,
  createTestIdentity,
  generateTestKeypair,
  installPlcFetchMock,
  jsonResponse,
  randomDidPlc,
  signServiceJwt,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

jest.mock("../../src/auth/anon-pds", () => ({
  getAnonDid: jest.fn(),
  ensureAnonSession: jest.fn(),
  putAnonStatementRecord: jest.fn(),
  createAnonStatementRecord: jest.fn(),
}));

jest.mock("../../src/auth/atproto-admin", () => {
  const actual = jest.requireActual("../../src/auth/atproto-admin") as Record<
    string,
    unknown
  >;
  return { ...actual, checkMembershipBatch: jest.fn() };
});

jest.mock("../../src/comment", () => {
  const actual = jest.requireActual("../../src/comment") as Record<
    string,
    unknown
  >;
  return { ...actual, detectLanguage: jest.fn() };
});

jest.mock("../../src/auth/generate-token", () => {
  const actual = jest.requireActual("../../src/auth/generate-token") as Record<
    string,
    unknown
  >;
  return { ...actual, generateTokenP: jest.fn() };
});

type PutParams = {
  rkey: string;
  conversationUri: string;
  conversationCid: string;
  text: string;
  createdAt: string;
};
type PutResult = { uri: string; cid: string } | null;
type Detection = { language: string | null; confidence: number | null };
type Body = {
  topic: string;
  statements: string[];
  conversation: { at_uri: string; at_cid: string };
};
type ApiResponse = {
  status: number;
  body: Record<string, unknown>;
  text: string;
};
type ConversationRow = {
  zid: number;
  owner: number;
  org_id: number;
  topic: string;
  description: string;
  is_active: boolean;
  is_draft: boolean;
  is_public: boolean;
  is_anon: boolean;
  strict_moderation: boolean;
  profanity_filter: boolean;
  spam_filter: boolean;
  auth_needed_to_vote: boolean;
  auth_needed_to_write: boolean;
  auth_opt_allow_3rdparty: boolean;
  at_uri: string;
  at_cid: string;
  participant_count: number;
};
type CreationRow = {
  zid: number;
  did: string;
  at_uri: string;
  content_hash: string;
  created: string;
  token_id: string | null;
};
type SeedRow = {
  tid: number;
  pid: number;
  uid: number;
  txt: string;
  created: string;
  velocity: number;
  mod: number;
  active: boolean;
  is_seed: boolean;
  is_meta: boolean;
  anon: boolean;
  lang: string | null;
  lang_confidence: number | null;
  at_uri: string;
  at_cid: string | null;
};
type OwnerRow = { did: string; owner: number; org_id: number };

const mockedGetAnonDid = getAnonDid as jest.MockedFunction<typeof getAnonDid>;
const mockedEnsureAnonSession = ensureAnonSession as jest.MockedFunction<
  typeof ensureAnonSession
>;
const mockedPut = putAnonStatementRecord as unknown as jest.Mock<
  (params: PutParams) => Promise<PutResult>
>;
const mockedMembership = checkMembershipBatch as jest.MockedFunction<
  typeof checkMembershipBatch
>;
const mockedDetect = detectLanguage as unknown as jest.Mock<
  (txt: string) => Promise<Detection[]>
>;
const mockedGenerateToken = generateTokenP as unknown as jest.Mock<
  (len: number, pseudoRandomOk: boolean) => Promise<string>
>;
const actualGenerateTokenP = (
  jest.requireActual("../../src/auth/generate-token") as {
    generateTokenP: (len: number, pseudoRandomOk: boolean) => Promise<string>;
  }
).generateTokenP;

const ROUTE = "/api/v3/atproto/conversations";
const LXM = "community.blacksky.assembly.createConversation";
const SERVICE_DID = "did:web:assembly.test.invalid";
const PLC_URL = "https://plc.test.invalid";
const CONVERSATION_COLLECTION = "community.blacksky.assembly.conversation";
const STATEMENT_COLLECTION = "community.blacksky.assembly.statement";
const PUBLISHER_DID = randomDidPlc();
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CREATE_LOCK_KEY = 873791985;
const HOUR_MILLIS = 60 * 60 * 1000;
const DAY_MILLIS = 24 * HOUR_MILLIS;
const runId = `${process.pid}x${Date.now()}`;

const ENV_NAMES = [
  "ATPROTO_APP_CREATE_ENABLED",
  "ATPROTO_SERVICE_DID",
  "ATPROTO_PLC_URL",
  "ATPROTO_APP_CREATE_ELIGIBILITY",
  "ATPROTO_APP_CREATE_ALLOWLIST",
  "ATPROTO_APP_CREATE_DAILY_CAP",
  "ATPROTO_APP_CREATE_HOURLY_CAP",
];
const originalEnv: Record<string, string | undefined> = {};
const originalKeyPaths = {
  jwtPrivateKeyPath: Config.jwtPrivateKeyPath,
  jwtPublicKeyPath: Config.jwtPublicKeyPath,
};

let agent: Agent;
let server: http.Server;
let plc: PlcFetchMock;
let keyDir: string;
let sequence = 0;
let errors: jest.SpiedFunction<typeof logger.error>;
const identities: TestIdentity[] = [];

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

function statementCid(params: { rkey: string; text: string }): string {
  return buildCid(`statement ${params.rkey} ${params.text}`);
}

function statementUri(rkey: string): string {
  return `at://${PUBLISHER_DID}/${STATEMENT_COLLECTION}/${rkey}`;
}

function contentHash(body: Body): string {
  return createHash("sha256")
    .update(JSON.stringify({ topic: body.topic, statements: body.statements }))
    .digest("hex");
}

async function newIdentity(): Promise<TestIdentity> {
  const identity = await createTestIdentity();
  plc.setDocument(identity.did, identity.document);
  identities.push(identity);
  return identity;
}

function buildBody(identity: TestIdentity, statementCount = 3): Body {
  sequence += 1;
  const label = `${runId} ${sequence}`;
  return {
    topic: `Topic ${label}`,
    statements: Array.from(
      Array(statementCount).keys(),
      (index) => `Statement ${index} of ${label}`
    ),
    conversation: {
      at_uri: `at://${identity.did}/${CONVERSATION_COLLECTION}/conv${runId}n${sequence}`,
      at_cid: buildCid(`conversation ${label}`),
    },
  };
}

async function tokenFor(
  identity: TestIdentity,
  claims: Record<string, unknown> = {}
): Promise<string> {
  return signServiceJwt({
    keypair: identity.keypair,
    claims: {
      ...buildServiceAuthClaims({
        iss: identity.did,
        aud: SERVICE_DID,
        lxm: LXM,
      }),
      ...claims,
    },
  });
}

async function send(body: unknown, token?: string): Promise<ApiResponse> {
  const request = agent.post(ROUTE);
  if (token !== undefined) {
    request.set("Authorization", `Bearer ${token}`);
  }
  const response = await request.send(body as object);
  return { status: response.status, body: response.body, text: response.text };
}

async function create(
  identity: TestIdentity,
  body: unknown
): Promise<ApiResponse> {
  return send(body, await tokenFor(identity));
}

function failureBody(code: string, status: number) {
  return { error: code, message: code, status };
}

async function rows<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await rows<{ n: string }>(sql, params))[0].n);
}

function conversationsAt(atUri: string): Promise<ConversationRow[]> {
  return rows("SELECT * FROM conversations WHERE at_uri = $1 ORDER BY zid", [
    atUri,
  ]);
}

function creationsOf(did: string): Promise<CreationRow[]> {
  return rows(
    "SELECT * FROM atproto_conversation_creations WHERE did = $1 ORDER BY zid",
    [did]
  );
}

function seedsOf(zid: number): Promise<SeedRow[]> {
  return rows("SELECT * FROM comments WHERE zid = $1 ORDER BY tid", [zid]);
}

async function ownerOf(zid: number): Promise<number> {
  const found = await rows<{ owner: number }>(
    "SELECT owner FROM conversations WHERE zid = $1",
    [zid]
  );
  expect(found).toHaveLength(1);
  return found[0].owner;
}

async function zidOf(conversationId: unknown): Promise<number> {
  const found = await rows<{ zid: number }>(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  expect(found).toHaveLength(1);
  return found[0].zid;
}

async function expectNothingCreated(
  identity: TestIdentity,
  body: Body
): Promise<void> {
  expect(await conversationsAt(body.conversation.at_uri)).toEqual([]);
  expect(await creationsOf(identity.did)).toEqual([]);
  expect(
    await count("SELECT COUNT(*) AS n FROM comments WHERE txt = ANY($1)", [
      body.statements,
    ])
  ).toBe(0);
  expect(mockedPut).not.toHaveBeenCalled();
}

function rkeyOf(atUri: string): string {
  return atUri.slice(atUri.lastIndexOf("/") + 1);
}

function setCaps(daily: number, hourly: number): void {
  process.env.ATPROTO_APP_CREATE_DAILY_CAP = String(daily);
  process.env.ATPROTO_APP_CREATE_HOURLY_CAP = String(hourly);
}

function wait(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

function refusals(code: string): unknown[] {
  return errors.mock.calls
    .filter(([message]) => (message as unknown) === code)
    .map((call) => (call as unknown[])[1]);
}

async function untilCreationWaitsForTheLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await count(
      `SELECT COUNT(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND classid = 0 AND objid = $1 AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      [CREATE_LOCK_KEY]
    );
    if (waiting > 0) {
      return;
    }
    await wait(20);
  }
  throw new Error("no request waited for the creation lock");
}

function creationsWaitingForTheLock(): Promise<number> {
  return count(
    `SELECT COUNT(*) AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND classid = 0 AND objid = $1 AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [CREATE_LOCK_KEY]
  );
}

async function whileCreationIsLocked(work: () => Promise<void>): Promise<void> {
  const holder = await pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock($1::bigint)", [
      CREATE_LOCK_KEY,
    ]);
    await work();
  } finally {
    await holder.query("SELECT pg_advisory_unlock_all()");
    holder.release();
  }
}

function creationsInTheLastHour(): Promise<number> {
  return count(
    "SELECT COUNT(*) AS n FROM atproto_conversation_creations WHERE created > now_as_millis() - $1::bigint",
    [HOUR_MILLIS]
  );
}

beforeAll(async () => {
  for (const name of ENV_NAMES) {
    originalEnv[name] = process.env[name];
  }

  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "atproto-conversations-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(path.join(keyDir, "private.pem"), privateKey);
  fs.writeFileSync(path.join(keyDir, "public.pem"), publicKey);
  Config.jwtPrivateKeyPath = path.join(keyDir, "private.pem");
  Config.jwtPublicKeyPath = path.join(keyDir, "public.pem");

  process.env.ATPROTO_SERVICE_DID = SERVICE_DID;
  process.env.ATPROTO_PLC_URL = PLC_URL;

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
  // A listener on every interface can share its port with another local
  // process that listens on 127.0.0.1 only, which then receives the requests.
  server = http.createServer(await getApp());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  agent = request.agent(`http://127.0.0.1:${port}`);
});

beforeEach(() => {
  jest.clearAllMocks();
  clearAtprotoIdentityCache();
  process.env.ATPROTO_APP_CREATE_ENABLED = "true";
  process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "any";
  process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
  setCaps(1000, 1000000);

  mockedGetAnonDid.mockReset().mockReturnValue(PUBLISHER_DID);
  mockedEnsureAnonSession.mockReset().mockResolvedValue(true);
  mockedPut.mockReset().mockImplementation(async (params) => ({
    uri: statementUri(params.rkey),
    cid: statementCid(params),
  }));
  mockedMembership.mockReset().mockResolvedValue(new Set<string>());
  mockedDetect
    .mockReset()
    .mockResolvedValue([{ language: null, confidence: null }]);
  mockedGenerateToken.mockReset().mockImplementation(actualGenerateTokenP);
  errors = jest.spyOn(logger, "error");
});

afterEach(() => {
  errors.mockRestore();
});

afterAll(async () => {
  const dids = identities.map((identity) => identity.did);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query(
      "SELECT a.zid, c.owner FROM atproto_conversation_creations a JOIN conversations c ON c.zid = a.zid WHERE a.did = ANY($1)",
      [dids]
    );
    const zids = created.rows.map((row) => row.zid);
    const owners = created.rows.map((row) => row.owner);
    for (const table of [
      "atproto_conversation_creations",
      "comments",
      "reports",
      "zinvites",
      "participants_extended",
      "participants",
      "conversations",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE zid = ANY($1)`, [zids]);
    }
    await client.query("DELETE FROM users WHERE uid = ANY($1)", [owners]);
    const logins = await client.query(
      "DELETE FROM oidc_user_mappings WHERE oidc_sub = ANY($1) RETURNING uid",
      [dids]
    );
    await client.query("DELETE FROM users WHERE uid = ANY($1)", [
      logins.rows.map((row) => row.uid),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.warn("atproto conversation test rows were not removed", err);
  } finally {
    client.release();
  }

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  plc.restore();
  Object.assign(Config, originalKeyPaths);
  fs.rmSync(keyDir, { recursive: true, force: true });
  for (const name of ENV_NAMES) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
});

describe("POST /api/v3/atproto/conversations", () => {
  describe("kill switch", () => {
    test.each([
      ["unset", undefined],
      ["false", "false"],
    ])(
      "answers 503 without a token when the setting is %s",
      async (label, value) => {
        if (value === undefined) {
          delete process.env.ATPROTO_APP_CREATE_ENABLED;
        } else {
          process.env.ATPROTO_APP_CREATE_ENABLED = value;
        }
        const identity = await newIdentity();

        const response = await send(buildBody(identity));

        expect(response.status).toBe(503);
        expect(response.body).toEqual(
          failureBody("polis_err_atproto_conversations_disabled", 503)
        );
      }
    );

    test("answers 503 with a valid token and creates nothing", async () => {
      process.env.ATPROTO_APP_CREATE_ENABLED = "false";
      const identity = await newIdentity();
      const body = buildBody(identity);

      const response = await create(identity, body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversations_disabled", 503)
      );
      await expectNothingCreated(identity, body);
      expect(mockedEnsureAnonSession).not.toHaveBeenCalled();
      expect(plc.requests.filter((r) => r.url.includes(identity.did))).toEqual(
        []
      );
    });

    test("answers 503 for an empty body before any parameter check", async () => {
      process.env.ATPROTO_APP_CREATE_ENABLED = "false";

      const response = await send({});

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversations_disabled", 503)
      );
    });
  });

  describe("authentication", () => {
    test("answers 401 without a token, before validating the body", async () => {
      const response = await send({});

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_missing", 401)
      );
    });

    test("answers 401 without a token for a valid body", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);

      const response = await send(body);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_missing", 401)
      );
      await expectNothingCreated(identity, body);
    });

    test("answers 401 for a token signed by another key", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const token = await signServiceJwt({
        keypair: await generateTestKeypair(),
        claims: buildServiceAuthClaims({
          iss: identity.did,
          aud: SERVICE_DID,
          lxm: LXM,
        }),
      });

      const response = await send(body, token);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_invalid", 401)
      );
      await expectNothingCreated(identity, body);
    });

    test("answers 401 for a token issued by atproto-login", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const login = await agent.post("/api/v3/auth/atproto-login").send({
        did: identity.did,
        handle: identity.handle,
      });
      expect(login.status).toBe(200);
      const decoded = jwt.decode(login.body.token, { complete: true });
      expect(decoded?.header.alg).toBe("RS256");
      expect(decoded?.payload).toMatchObject({
        sub: identity.did,
        uid: login.body.uid,
        type: "atproto_admin",
      });

      const response = await send(body, login.body.token);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_invalid", 401)
      );
      await expectNothingCreated(identity, body);
    });

    test.each([
      [
        "another method",
        (): Record<string, unknown> => ({
          lxm: "community.blacksky.assembly.createStatement",
        }),
      ],
      [
        "another audience",
        (): Record<string, unknown> => ({ aud: "did:web:other.test.invalid" }),
      ],
      [
        "the issuer as audience",
        (identity: TestIdentity): Record<string, unknown> => ({
          aud: identity.did,
        }),
      ],
    ])("answers 401 for a token for %s", async (label, claims) => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const token = await tokenFor(identity, claims(identity));

      const response = await send(body, token);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_invalid", 401)
      );
      await expectNothingCreated(identity, body);
    });

    test("answers 401 for an expired token", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const now = Math.floor(Date.now() / 1000);
      const token = await tokenFor(identity, { iat: now - 120, exp: now - 60 });

      const response = await send(body, token);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_expired", 401)
      );
      await expectNothingCreated(identity, body);
    });

    test("answers 400 for an issuer that is not a did:plc", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const token = await tokenFor(identity, {
        iss: "did:web:someone.test.invalid",
      });

      const response = await send(body, token);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_unsupported_did", 400)
      );
      await expectNothingCreated(identity, body);
    });

    test("answers 503 when the DID document cannot be fetched", async () => {
      const identity = await createTestIdentity();
      identities.push(identity);
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 500 })
      );
      const body = buildBody(identity);

      const response = await create(identity, body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_did_resolution_failed", 503)
      );
      await expectNothingCreated(identity, body);
    });

    test("accepts a token signed with a P-256 key", async () => {
      const identity = await createTestIdentity({ curve: "p256" });
      plc.setDocument(identity.did, identity.document);
      identities.push(identity);

      const response = await create(identity, buildBody(identity, 1));

      expect(response.status).toBe(201);
      expect(response.body.created).toBe(true);
    });

    test("takes the owner from the token, not from the body", async () => {
      const identity = await newIdentity();
      const other = await newIdentity();
      const body = buildBody(identity, 1);

      const response = await create(identity, {
        ...body,
        atproto_did: other.did,
        did: other.did,
        uid: 1,
      });

      expect(response.status).toBe(201);
      expect(await creationsOf(other.did)).toEqual([]);
      expect(
        (await creationsOf(identity.did)).map((row) => row.at_uri)
      ).toEqual([body.conversation.at_uri]);
    });
  });

  describe("eligibility", () => {
    test("answers 403 when the DID is not on the allowlist", async () => {
      const identity = await newIdentity();
      const listed = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "allowlist";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = `${
        listed.did
      }, ${randomDidPlc()}`;
      const body = buildBody(identity);

      const response = await create(identity, body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversation_not_eligible", 403)
      );
      expect(refusals("polis_err_atproto_conversation_not_eligible")).toEqual([
        { did: identity.did, reason: "issuer_not_listed" },
      ]);
      expect(plc.requests.filter((r) => r.url.includes(identity.did))).toEqual(
        []
      );
      await expectNothingCreated(identity, body);
      expect(mockedEnsureAnonSession).not.toHaveBeenCalled();
      expect(mockedMembership).not.toHaveBeenCalled();
    });

    test("answers 403 for everyone when the allowlist is empty", async () => {
      const identity = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "allowlist";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
      const body = buildBody(identity);

      const response = await create(identity, body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversation_not_eligible", 403)
      );
      await expectNothingCreated(identity, body);
    });

    test("uses the allowlist when the setting is missing", async () => {
      const identity = await newIdentity();
      delete process.env.ATPROTO_APP_CREATE_ELIGIBILITY;
      delete process.env.ATPROTO_APP_CREATE_ALLOWLIST;
      const body = buildBody(identity);

      const response = await create(identity, body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversation_not_eligible", 403)
      );
      await expectNothingCreated(identity, body);
    });

    test("creates for a DID on the allowlist", async () => {
      const identity = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "allowlist";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = `${randomDidPlc()},${
        identity.did
      }`;

      const response = await create(identity, buildBody(identity, 1));

      expect(response.status).toBe(201);
      expect(mockedMembership).not.toHaveBeenCalled();
    });

    test("answers 403 for a DID that is not a member", async () => {
      const identity = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "members";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = identity.did;
      mockedMembership.mockResolvedValue(new Set([randomDidPlc()]));
      const body = buildBody(identity);

      const response = await create(identity, body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversation_not_eligible", 403)
      );
      expect(mockedMembership.mock.calls).toEqual([[[identity.did]]]);
      await expectNothingCreated(identity, body);
    });

    test("creates for a member", async () => {
      const identity = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "members";
      mockedMembership.mockResolvedValue(new Set([identity.did]));

      const response = await create(identity, buildBody(identity, 1));

      expect(response.status).toBe(201);
      expect(mockedMembership.mock.calls).toEqual([[[identity.did]]]);
    });

    test("creates for anyone when the setting is any", async () => {
      const identity = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "any";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = randomDidPlc();

      const response = await create(identity, buildBody(identity, 1));

      expect(response.status).toBe(201);
      expect(mockedMembership).not.toHaveBeenCalled();
    });

    test("validates the body before checking eligibility", async () => {
      const identity = await newIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "members";
      const body = { ...buildBody(identity), topic: "   " };

      const response = await create(identity, body);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversation_topic_empty", 400)
      );
      expect(mockedMembership).not.toHaveBeenCalled();
    });
  });

  describe("creation", () => {
    test("creates the conversation and every row that belongs to it", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedDetect.mockImplementation(async (txt) => [
        {
          language: txt === body.statements[1] ? "fr" : "en",
          confidence: txt === body.statements[1] ? 0.5 : 0.25,
        },
      ]);
      const info = jest.spyOn(logger, "info");

      const response = await create(identity, {
        ...body,
        description: "A description that must not be stored",
      });

      expect(response.status).toBe(201);
      expect(Object.keys(response.body).sort()).toEqual([
        "conversation_id",
        "created",
        "report_id",
      ]);
      expect(response.body.created).toBe(true);
      expect(response.body.conversation_id).toMatch(/^[2-9][a-z2-9]{9}$/);
      expect(response.body.report_id).toMatch(/^r[2-9][a-z2-9]{19}$/);

      const conversations = await conversationsAt(body.conversation.at_uri);
      expect(conversations).toHaveLength(1);
      const conversation = conversations[0];
      const zid: number = conversation.zid;
      const uid: number = conversation.owner;
      expect(Number.isInteger(uid)).toBe(true);
      expect({
        owner: conversation.owner,
        org_id: conversation.org_id,
        topic: conversation.topic,
        description: conversation.description,
        is_active: conversation.is_active,
        is_draft: conversation.is_draft,
        is_public: conversation.is_public,
        is_anon: conversation.is_anon,
        strict_moderation: conversation.strict_moderation,
        profanity_filter: conversation.profanity_filter,
        spam_filter: conversation.spam_filter,
        auth_needed_to_vote: conversation.auth_needed_to_vote,
        auth_needed_to_write: conversation.auth_needed_to_write,
        auth_opt_allow_3rdparty: conversation.auth_opt_allow_3rdparty,
        at_uri: conversation.at_uri,
        at_cid: conversation.at_cid,
        participant_count: conversation.participant_count,
      }).toEqual({
        owner: uid,
        org_id: uid,
        topic: body.topic,
        description: "",
        is_active: true,
        is_draft: false,
        is_public: true,
        is_anon: false,
        strict_moderation: true,
        profanity_filter: true,
        spam_filter: true,
        auth_needed_to_vote: true,
        auth_needed_to_write: true,
        auth_opt_allow_3rdparty: true,
        at_uri: body.conversation.at_uri,
        at_cid: body.conversation.at_cid,
        participant_count: 1,
      });

      expect(
        await rows(
          "SELECT email, hname, username, is_owner FROM users WHERE uid = $1",
          [uid]
        )
      ).toEqual([
        { email: null, hname: null, username: null, is_owner: false },
      ]);
      expect(
        await rows(
          "SELECT * FROM oidc_user_mappings WHERE uid = $1 OR oidc_sub = $2 OR oidc_sub = $3",
          [uid, identity.did, `oauth2|atproto|${identity.did}`]
        )
      ).toEqual([]);
      expect(
        await rows(
          "SELECT * FROM xids WHERE uid = $1 OR owner = $1 OR xid = $2",
          [uid, identity.did]
        )
      ).toEqual([]);

      const zinvites = await rows(
        "SELECT zinvite, uuid FROM zinvites WHERE zid = $1",
        [zid]
      );
      expect(zinvites).toHaveLength(1);
      expect(zinvites[0].zinvite).toBe(response.body.conversation_id);
      expect(zinvites[0].uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );

      expect(
        await rows("SELECT pid, uid, zid FROM participants WHERE zid = $1", [
          zid,
        ])
      ).toEqual([{ pid: 0, uid, zid }]);
      expect(
        await rows(
          "SELECT uid, zid FROM participants_extended WHERE zid = $1",
          [zid]
        )
      ).toEqual([{ uid, zid }]);

      const seeds = await seedsOf(zid);
      const rkeys = seeds.map((seed) => rkeyOf(seed.at_uri));
      expect(rkeys).toHaveLength(3);
      for (const rkey of rkeys) {
        expect(isValidTid(rkey)).toBe(true);
      }
      expect([...rkeys].sort()).toEqual(rkeys);
      expect(new Set(rkeys).size).toBe(3);
      expect(
        seeds.map((seed) => ({
          tid: seed.tid,
          pid: seed.pid,
          uid: seed.uid,
          txt: seed.txt,
          velocity: seed.velocity,
          mod: seed.mod,
          active: seed.active,
          is_seed: seed.is_seed,
          is_meta: seed.is_meta,
          anon: seed.anon,
          lang: seed.lang,
          lang_confidence: seed.lang_confidence,
          at_uri: seed.at_uri,
          at_cid: seed.at_cid,
        }))
      ).toEqual(
        body.statements.map((text, index) => ({
          tid: index,
          pid: 0,
          uid,
          txt: text,
          velocity: 1,
          mod: 1,
          active: true,
          is_seed: true,
          is_meta: false,
          anon: false,
          lang: index === 1 ? "fr" : "en",
          lang_confidence: index === 1 ? 0.5 : 0.25,
          at_uri: statementUri(rkeys[index]),
          at_cid: statementCid({ rkey: rkeys[index], text }),
        }))
      );

      expect(mockedDetect.mock.calls).toEqual(
        body.statements.map((text) => [text])
      );
      expect(mockedPut.mock.calls).toEqual(
        body.statements.map((text, index) => [
          {
            rkey: rkeys[index],
            conversationUri: body.conversation.at_uri,
            conversationCid: body.conversation.at_cid,
            text,
            createdAt: new Date(Number(seeds[index].created)).toISOString(),
          },
        ])
      );
      for (const [params] of mockedPut.mock.calls) {
        expect(params.createdAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
        );
      }
      const databaseNow = await count("SELECT now_as_millis() AS n");
      expect(databaseNow - Number(seeds[0].created)).toBeGreaterThanOrEqual(0);
      expect(databaseNow - Number(seeds[0].created)).toBeLessThan(60000);

      expect(
        await rows("SELECT report_id FROM reports WHERE zid = $1", [zid])
      ).toEqual([{ report_id: response.body.report_id }]);

      expect(
        await rows(
          "SELECT zid, did, at_uri, content_hash FROM atproto_conversation_creations WHERE did = $1",
          [identity.did]
        )
      ).toEqual([
        {
          zid,
          did: identity.did,
          at_uri: body.conversation.at_uri,
          content_hash: contentHash(body),
        },
      ]);

      expect(
        info.mock.calls.filter(
          ([message]) => (message as unknown) === "atproto conversation created"
        )
      ).toEqual([
        [
          "atproto conversation created",
          {
            did: identity.did,
            zid,
            conversation_id: response.body.conversation_id,
          },
        ],
      ]);
      info.mockRestore();
    });

    test("stores the normalised topic and statements", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      const sent = {
        ...body,
        topic: `  Cafe\u0301 ${body.topic}\n`,
        statements: [
          `\t${body.statements[0]} cre\u0300me  `,
          body.statements[1],
        ],
      };
      const stored = {
        ...body,
        topic: `Caf\u00e9 ${body.topic}`,
        statements: [`${body.statements[0]} cr\u00e8me`, body.statements[1]],
      };

      const response = await create(identity, sent);

      expect(response.status).toBe(201);
      const zid = await zidOf(response.body.conversation_id);
      expect(
        await rows("SELECT topic FROM conversations WHERE zid = $1", [zid])
      ).toEqual([{ topic: stored.topic }]);
      expect((await seedsOf(zid)).map((seed) => seed.txt)).toEqual(
        stored.statements
      );
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual(
        stored.statements
      );
      expect(
        (await creationsOf(identity.did)).map((row) => row.content_hash)
      ).toEqual([contentHash(stored)]);
    });

    test("serves the statement with its record through the embed API", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);

      const response = await create(identity, body);
      expect(response.status).toBe(201);
      const zid = await zidOf(response.body.conversation_id);
      const seeds = await seedsOf(zid);

      const embed = await agent.get(
        `/api/v3/embed/conversation?conversation_id=${response.body.conversation_id}`
      );

      expect(embed.status).toBe(200);
      expect(embed.body.conversation).toEqual({
        conversation_id: response.body.conversation_id,
        topic: body.topic,
        description: "",
        is_active: true,
        auth_needed_to_vote: true,
        at_uri: body.conversation.at_uri,
        at_cid: body.conversation.at_cid,
      });
      expect(embed.body.report_id).toBe(response.body.report_id);
      expect(embed.body.nextComment).toMatchObject({
        tid: 0,
        txt: body.statements[0],
        is_seed: true,
        at_uri: statementUri(rkeyOf(seeds[0].at_uri)),
        at_cid: statementCid({
          rkey: rkeyOf(seeds[0].at_uri),
          text: body.statements[0],
        }),
      });
    });

    test("creates a conversation with ten statements in order", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 10);

      const response = await create(identity, body);

      expect(response.status).toBe(201);
      const zid = await zidOf(response.body.conversation_id);
      const seeds = await seedsOf(zid);
      expect(seeds.map((seed) => [seed.tid, seed.txt])).toEqual(
        body.statements.map((text, index) => [index, text])
      );
      const rkeys = seeds.map((seed) => rkeyOf(seed.at_uri));
      expect([...rkeys].sort()).toEqual(rkeys);
      expect(new Set(rkeys).size).toBe(10);
      expect(mockedPut.mock.calls.map(([params]) => params.rkey)).toEqual(
        rkeys
      );
    });

    test("reuses the owner when the same DID creates again", async () => {
      const identity = await newIdentity();
      const other = await newIdentity();

      const first = await create(identity, buildBody(identity, 1));
      const second = await create(identity, buildBody(identity, 1));
      const third = await create(other, buildBody(other, 1));

      expect([first.status, second.status, third.status]).toEqual([
        201, 201, 201,
      ]);
      expect(second.body.conversation_id).not.toBe(first.body.conversation_id);
      const owners = await rows<OwnerRow>(
        "SELECT a.did, c.owner, c.org_id FROM atproto_conversation_creations a JOIN conversations c ON c.zid = a.zid WHERE a.did = ANY($1) ORDER BY a.zid",
        [[identity.did, other.did]]
      );
      expect(owners).toHaveLength(3);
      expect(owners[0].did).toBe(identity.did);
      expect(owners[1]).toEqual(owners[0]);
      expect(owners[0].org_id).toBe(owners[0].owner);
      expect(owners[2].did).toBe(other.did);
      expect(owners[2].org_id).toBe(owners[2].owner);
      expect(owners[2].owner).not.toBe(owners[0].owner);
    });

    test("keeps the owner apart from the account made by atproto-login", async () => {
      const identity = await newIdentity();
      const login = await agent.post("/api/v3/auth/atproto-login").send({
        did: identity.did,
        handle: identity.handle,
      });
      expect(login.status).toBe(200);
      const loginUid: number = login.body.uid;

      const response = await create(identity, buildBody(identity, 1));

      expect(response.status).toBe(201);
      const zid = await zidOf(response.body.conversation_id);
      const conversation = (
        await rows<OwnerRow>(
          "SELECT owner, org_id FROM conversations WHERE zid = $1",
          [zid]
        )
      )[0];
      expect(conversation.owner).not.toBe(loginUid);
      expect(conversation.org_id).toBe(conversation.owner);
      expect(
        await rows(
          "SELECT oidc_sub, uid FROM oidc_user_mappings WHERE oidc_sub = $1 OR uid = $2",
          [identity.did, conversation.owner]
        )
      ).toEqual([{ oidc_sub: identity.did, uid: loginUid }]);
      expect(
        await rows("SELECT email FROM users WHERE uid = $1", [
          conversation.owner,
        ])
      ).toEqual([{ email: null }]);
    });

    test("never logs the token", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      const forged = await signServiceJwt({
        keypair: await generateTestKeypair(),
        claims: buildServiceAuthClaims({
          iss: identity.did,
          aud: SERVICE_DID,
          lxm: LXM,
        }),
      });
      const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
        jest.spyOn(logger, level)
      );
      const stdout = jest.spyOn(process.stdout, "write");
      const stderr = jest.spyOn(process.stderr, "write");

      const created = await send(buildBody(identity, 2), token);
      const invalid = await send({ topic: "" }, token);
      const rejected = await send(buildBody(identity, 2), forged);

      const logged = inspect(
        [...spies, stdout, stderr].map((spy) => spy.mock.calls),
        { depth: 10, maxArrayLength: null, maxStringLength: null }
      );
      for (const spy of [...spies, stdout, stderr]) {
        spy.mockRestore();
      }
      expect([created.status, invalid.status, rejected.status]).toEqual([
        201, 400, 401,
      ]);
      expect(logged).toContain("atproto conversation created");
      expect(logged).toContain("polis_err_atproto_auth_invalid");
      for (const secret of [token, forged]) {
        const [header, payload, signature] = secret.split(".");
        expect(logged).not.toContain(secret);
        expect(logged).not.toContain(signature);
        expect(logged).not.toContain(payload);
        expect(logged).not.toContain(`${header}.`);
      }
    });
  });

  describe("token reuse", () => {
    function tokenIdOf(token: string): string {
      return createHash("sha256").update(token, "utf8").digest("hex");
    }

    test("refuses a token that already created another conversation", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      const first = buildBody(identity, 1);
      const second = buildBody(identity, 2);

      const created = await send(first, token);
      jest.clearAllMocks();
      errors = jest.spyOn(logger, "error");
      const reused = await send(second, token);

      expect(created.status).toBe(201);
      expect(reused.status).toBe(401);
      expect(reused.body).toEqual(
        failureBody("polis_err_atproto_auth_replayed", 401)
      );
      expect(refusals("polis_err_atproto_auth_replayed")).toEqual([
        { did: identity.did },
      ]);
      expect(await conversationsAt(second.conversation.at_uri)).toEqual([]);
      expect(mockedPut).not.toHaveBeenCalled();
      expect(
        (await creationsOf(identity.did)).map((row) => [
          row.at_uri,
          row.token_id,
        ])
      ).toEqual([[first.conversation.at_uri, tokenIdOf(token)]]);
    });

    test("refuses a reused token that carries no jti", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity, { jti: undefined });

      const responses = [
        await send(buildBody(identity, 1), token),
        await send(buildBody(identity, 1), token),
      ];

      expect(responses.map((response) => response.status)).toEqual([201, 401]);
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });

    test("answers the same request again with the same token as a replay", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      const body = buildBody(identity, 1);

      const responses = [await send(body, token), await send(body, token)];

      expect(responses.map((response) => response.status)).toEqual([201, 200]);
      expect(responses[1].body).toEqual({
        conversation_id: responses[0].body.conversation_id,
        report_id: responses[0].body.report_id,
        created: false,
      });
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });

    test("creates the next conversation with a new token", async () => {
      const identity = await newIdentity();
      const tokens = [
        await tokenFor(identity, { jti: "first-token" }),
        await tokenFor(identity, { jti: "second-token" }),
      ];

      const responses = [
        await send(buildBody(identity, 1), tokens[0]),
        await send(buildBody(identity, 1), tokens[1]),
      ];

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(
        (await creationsOf(identity.did)).map((row) => row.token_id).sort()
      ).toEqual(tokens.map(tokenIdOf).sort());
    });

    test("does not use up a token on a refused request", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      const body = buildBody(identity, 1);

      const refused = await send({ ...body, topic: "   " }, token);
      const created = await send(body, token);

      expect(refused.status).toBe(400);
      expect(created.status).toBe(201);
    });

    test("lets only one of two simultaneous requests use a token", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);

      const responses = await Promise.all([
        send(buildBody(identity, 1), token),
        send(buildBody(identity, 1), token),
      ]);

      expect(
        responses.map((response) => response.status).sort((a, b) => a - b)
      ).toEqual([201, 401]);
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });
  });

  describe("replay", () => {
    test("answers 200 with the same ids and creates nothing new", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const first = await create(identity, body);
      expect(first.status).toBe(201);
      const zid = await zidOf(first.body.conversation_id);
      const seedsBefore = await seedsOf(zid);
      const owner = await ownerOf(zid);
      jest.clearAllMocks();
      const info = jest.spyOn(logger, "info");

      const second = await create(identity, body);
      const third = await create(identity, {
        ...body,
        topic: `  ${body.topic}  `,
        conversation: {
          ...body.conversation,
          at_cid: buildCid("a newer version of the record"),
        },
      });

      for (const replay of [second, third]) {
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual({
          conversation_id: first.body.conversation_id,
          report_id: first.body.report_id,
          created: false,
        });
      }
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect((await conversationsAt(body.conversation.at_uri))[0].at_cid).toBe(
        body.conversation.at_cid
      );
      expect(await creationsOf(identity.did)).toHaveLength(1);
      expect(await seedsOf(zid)).toEqual(seedsBefore);
      expect(
        await rows("SELECT zid FROM conversations WHERE owner = $1", [owner])
      ).toEqual([{ zid }]);
      expect(
        await count("SELECT COUNT(*) AS n FROM zinvites WHERE zid = $1", [zid])
      ).toBe(1);
      expect(
        await count("SELECT COUNT(*) AS n FROM reports WHERE zid = $1", [zid])
      ).toBe(1);
      expect(
        await count("SELECT COUNT(*) AS n FROM participants WHERE zid = $1", [
          zid,
        ])
      ).toBe(1);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM participants_extended WHERE zid = $1",
          [zid]
        )
      ).toBe(1);
      expect(mockedPut).not.toHaveBeenCalled();
      expect(mockedDetect).not.toHaveBeenCalled();
      expect(mockedGenerateToken).not.toHaveBeenCalled();
      expect(
        info.mock.calls.filter(
          ([message]) => (message as unknown) === "atproto conversation created"
        )
      ).toEqual([]);
      info.mockRestore();
    });

    test("answers a replay with the report made at creation", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      const first = await create(identity, body);
      expect(first.status).toBe(201);
      const zid = await zidOf(first.body.conversation_id);
      await pool.query(
        "INSERT INTO reports (zid, report_id, created) VALUES ($1, $2, now_as_millis() + 60000)",
        [zid, `rlater${runId}`]
      );

      const replay = await create(identity, body);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        conversation_id: first.body.conversation_id,
        report_id: first.body.report_id,
        created: false,
      });
    });

    test("answers 200 for a replay while the DID is over its quota", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      setCaps(1, 1000000);
      const first = await create(identity, body);
      expect(first.status).toBe(201);

      const replay = await create(identity, body);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        conversation_id: first.body.conversation_id,
        report_id: first.body.report_id,
        created: false,
      });
    });

    test("answers 200 when an identical request created it a moment earlier", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      let inner: ApiResponse | undefined;
      mockedDetect.mockImplementationOnce(async () => {
        inner = await create(identity, body);
        return [{ language: null, confidence: null }];
      });

      const outer = await create(identity, body);

      expect(inner?.status).toBe(201);
      expect(outer.status).toBe(200);
      expect(outer.body).toEqual({
        conversation_id: inner?.body.conversation_id,
        report_id: inner?.body.report_id,
        created: false,
      });
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect(await creationsOf(identity.did)).toHaveLength(1);
      expect(mockedPut).toHaveBeenCalledTimes(2);
    });

    test("creates once when identical requests arrive together", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      const tokens = await Promise.all([
        tokenFor(identity),
        tokenFor(identity),
        tokenFor(identity),
      ]);

      const responses = await Promise.all(
        tokens.map((token) => send(body, token))
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 200, 201,
      ]);
      expect(
        new Set(responses.map((response) => response.body.conversation_id)).size
      ).toBe(1);
      expect(
        new Set(responses.map((response) => response.body.report_id)).size
      ).toBe(1);
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect(await creationsOf(identity.did)).toHaveLength(1);
      const zid = await zidOf(responses[0].body.conversation_id);
      expect((await seedsOf(zid)).map((seed) => seed.txt)).toEqual(
        body.statements
      );
    });

    test.each([
      [
        "a changed statement",
        (body: Body) => ({
          ...body,
          statements: [body.statements[0], `${body.statements[1]} changed`],
        }),
      ],
      [
        "a changed topic",
        (body: Body) => ({
          ...body,
          topic: `${body.topic} changed`,
        }),
      ],
      [
        "statements in another order",
        (body: Body) => ({
          ...body,
          statements: [body.statements[1], body.statements[0]],
        }),
      ],
      [
        "one statement fewer",
        (body: Body) => ({
          ...body,
          statements: [body.statements[0]],
        }),
      ],
      [
        "a statement in another case",
        (body: Body) => ({
          ...body,
          statements: [body.statements[0].toUpperCase(), body.statements[1]],
        }),
      ],
    ])("answers 409 for the same record with %s", async (label, change) => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      const first = await create(identity, body);
      expect(first.status).toBe(201);
      const zid = await zidOf(first.body.conversation_id);
      const seedsBefore = await seedsOf(zid);
      jest.clearAllMocks();

      const response = await create(identity, change(body));

      expect(response.status).toBe(409);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_conversation_idempotency_mismatch", 409)
      );
      expect(
        refusals("polis_err_atproto_conversation_idempotency_mismatch")
      ).toEqual([{ did: identity.did }]);
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect(
        await rows("SELECT topic FROM conversations WHERE zid = $1", [zid])
      ).toEqual([{ topic: body.topic }]);
      expect(await seedsOf(zid)).toEqual(seedsBefore);
      expect(
        (await creationsOf(identity.did)).map((row) => row.content_hash)
      ).toEqual([contentHash(body)]);
      expect(mockedPut).not.toHaveBeenCalled();
      expect(mockedDetect).not.toHaveBeenCalled();
    });

    test("answers 409 when a different request for the record won the race", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      const winner = { ...body, topic: `${body.topic} from the winner` };
      let inner: ApiResponse | undefined;
      mockedDetect.mockImplementationOnce(async () => {
        inner = await create(identity, winner);
        return [{ language: null, confidence: null }];
      });

      const outer = await create(identity, body);

      expect(inner?.status).toBe(201);
      expect(outer.status).toBe(409);
      expect(outer.body).toEqual(
        failureBody("polis_err_atproto_conversation_idempotency_mismatch", 409)
      );
      expect(
        (await conversationsAt(body.conversation.at_uri)).map(
          (conversation) => conversation.topic
        )
      ).toEqual([winner.topic]);
      expect(
        (await creationsOf(identity.did)).map((row) => row.content_hash)
      ).toEqual([contentHash(winner)]);
    });

    test("lets another DID use the same record key", async () => {
      const identity = await newIdentity();
      const other = await newIdentity();
      const body = buildBody(identity, 1);
      const rkey = rkeyOf(body.conversation.at_uri);
      const otherBody = {
        ...body,
        conversation: {
          ...body.conversation,
          at_uri: `at://${other.did}/${CONVERSATION_COLLECTION}/${rkey}`,
        },
      };

      const first = await create(identity, body);
      const second = await create(other, otherBody);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body.conversation_id).not.toBe(first.body.conversation_id);
    });

    test("answers 410 when the conversation was removed", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      const first = await create(identity, body);
      expect(first.status).toBe(201);
      const zid = await zidOf(first.body.conversation_id);
      await pool.query("DELETE FROM zinvites WHERE zid = $1", [zid]);
      await pool.query("DELETE FROM reports WHERE zid = $1", [zid]);
      jest.clearAllMocks();

      const replay = await create(identity, body);

      expect(replay.status).toBe(410);
      expect(replay.body).toEqual(
        failureBody("polis_err_atproto_conversation_removed", 410)
      );
      expect(refusals("polis_err_atproto_conversation_removed")).toEqual([
        { did: identity.did, zid },
      ]);
      expect(mockedPut).not.toHaveBeenCalled();
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
    });
  });

  describe("quota", () => {
    test("answers 429 at the cap for one DID", async () => {
      const identity = await newIdentity();
      const other = await newIdentity();
      setCaps(2, 1000000);
      const first = await create(identity, buildBody(identity, 1));
      const second = await create(identity, buildBody(identity, 1));
      expect([first.status, second.status]).toEqual([201, 201]);
      jest.clearAllMocks();
      const body = buildBody(identity);

      const third = await create(identity, body);

      expect(third.status).toBe(429);
      expect(third.body).toEqual(
        failureBody("polis_err_atproto_conversation_quota_exceeded", 429)
      );
      expect(refusals("polis_err_atproto_conversation_quota_exceeded")).toEqual(
        [{ did: identity.did, cap: "did" }]
      );
      expect(await conversationsAt(body.conversation.at_uri)).toEqual([]);
      expect(await creationsOf(identity.did)).toHaveLength(2);
      expect(mockedPut).not.toHaveBeenCalled();
      expect(mockedEnsureAnonSession).not.toHaveBeenCalled();
      expect(mockedDetect).not.toHaveBeenCalled();

      const fromOther = await create(other, buildBody(other, 1));
      expect(fromOther.status).toBe(201);
    });

    test("counts one DID over a rolling 24 hours", async () => {
      const identity = await newIdentity();
      setCaps(1, 1000000);
      const first = await create(identity, buildBody(identity, 1));
      expect(first.status).toBe(201);
      const zid = await zidOf(first.body.conversation_id);

      await pool.query(
        "UPDATE atproto_conversation_creations SET created = now_as_millis() - $1::bigint WHERE zid = $2",
        [DAY_MILLIS - 60000, zid]
      );
      const inside = await create(identity, buildBody(identity, 1));
      await pool.query(
        "UPDATE atproto_conversation_creations SET created = now_as_millis() - $1::bigint WHERE zid = $2",
        [DAY_MILLIS + 1000, zid]
      );
      const outside = await create(identity, buildBody(identity, 1));

      expect(inside.status).toBe(429);
      expect(inside.body).toEqual(
        failureBody("polis_err_atproto_conversation_quota_exceeded", 429)
      );
      expect(outside.status).toBe(201);
      expect(await creationsOf(identity.did)).toHaveLength(2);
    });

    test("answers 429 at the cap for all DIDs together", async () => {
      const first = await newIdentity();
      const second = await newIdentity();
      const third = await newIdentity();
      setCaps(1000, (await creationsInTheLastHour()) + 1);
      const allowed = await create(first, buildBody(first, 1));
      expect(allowed.status).toBe(201);
      const zid = await zidOf(allowed.body.conversation_id);
      jest.clearAllMocks();
      const body = buildBody(second);

      const refused = await create(second, body);

      expect(refused.status).toBe(429);
      expect(refused.body).toEqual(
        failureBody("polis_err_atproto_conversation_quota_exceeded", 429)
      );
      expect(refusals("polis_err_atproto_conversation_quota_exceeded")).toEqual(
        [{ did: second.did, cap: "global" }]
      );
      await expectNothingCreated(second, body);
      expect(mockedEnsureAnonSession).not.toHaveBeenCalled();
      expect(mockedDetect).not.toHaveBeenCalled();

      await pool.query(
        "UPDATE atproto_conversation_creations SET created = now_as_millis() - $1::bigint WHERE zid = $2",
        [HOUR_MILLIS - 60000, zid]
      );
      const inside = await create(third, buildBody(third, 1));
      await pool.query(
        "UPDATE atproto_conversation_creations SET created = now_as_millis() - $1::bigint WHERE zid = $2",
        [HOUR_MILLIS + 1000, zid]
      );
      const outside = await create(third, buildBody(third, 1));

      expect(inside.status).toBe(429);
      expect(outside.status).toBe(201);
    });

    test("names the cap of the DID when both caps are reached", async () => {
      const identity = await newIdentity();
      setCaps(1, (await creationsInTheLastHour()) + 1);
      const first = await create(identity, buildBody(identity, 1));
      expect(first.status).toBe(201);
      jest.clearAllMocks();

      const second = await create(identity, buildBody(identity, 1));

      expect(second.status).toBe(429);
      expect(refusals("polis_err_atproto_conversation_quota_exceeded")).toEqual(
        [{ did: identity.did, cap: "did" }]
      );
    });

    test("answers 429 when another request used the quota a moment earlier", async () => {
      const identity = await newIdentity();
      setCaps(1, 1000000);
      const body = buildBody(identity, 2);
      const winner = buildBody(identity, 1);
      let inner: ApiResponse | undefined;
      mockedDetect.mockImplementationOnce(async () => {
        inner = await create(identity, winner);
        mockedPut.mockClear();
        return [{ language: null, confidence: null }];
      });

      const outer = await create(identity, body);

      expect(inner?.status).toBe(201);
      expect(outer.status).toBe(429);
      expect(outer.body).toEqual(
        failureBody("polis_err_atproto_conversation_quota_exceeded", 429)
      );
      expect(await conversationsAt(body.conversation.at_uri)).toEqual([]);
      expect(
        (await creationsOf(identity.did)).map((row) => row.at_uri)
      ).toEqual([winner.conversation.at_uri]);
      expect(
        await count("SELECT COUNT(*) AS n FROM comments WHERE txt = ANY($1)", [
          body.statements,
        ])
      ).toBe(0);
      expect(mockedPut).not.toHaveBeenCalled();
    });

    test("creates exactly up to the cap when requests arrive together", async () => {
      const identity = await newIdentity();
      setCaps(2, 1000000);
      const bodies = [
        buildBody(identity, 1),
        buildBody(identity, 1),
        buildBody(identity, 1),
        buildBody(identity, 1),
        buildBody(identity, 1),
      ];
      const tokens = await Promise.all(bodies.map(() => tokenFor(identity)));

      const responses = await Promise.all(
        bodies.map((body, index) => send(body, tokens[index]))
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 201, 429, 429, 429,
      ]);
      const created = await creationsOf(identity.did);
      expect(created).toHaveLength(2);
      expect(
        await count(
          "SELECT COUNT(DISTINCT c.owner) AS n FROM atproto_conversation_creations a JOIN conversations c ON c.zid = a.zid WHERE a.did = $1",
          [identity.did]
        )
      ).toBe(1);
      const createdUris = created.map((row) => row.at_uri).sort();
      const acceptedUris = responses
        .flatMap((response, index) =>
          response.status === 201 ? [bodies[index].conversation.at_uri] : []
        )
        .sort();
      expect(createdUris).toEqual(acceptedUris);
      expect(
        mockedPut.mock.calls.map(([params]) => params.conversationUri).sort()
      ).toEqual(acceptedUris);
    });
  });

  describe("creation lock", () => {
    test("creates only once the lock is free", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      const token = await tokenFor(identity);
      let settled = false;
      let pending: Promise<ApiResponse> | undefined;

      await whileCreationIsLocked(async () => {
        pending = send(body, token).then((response) => {
          settled = true;
          return response;
        });
        await untilCreationWaitsForTheLock();

        expect(settled).toBe(false);
        expect(mockedDetect.mock.calls).toEqual([[body.statements[0]]]);
        expect(mockedGenerateToken).not.toHaveBeenCalled();
        expect(await conversationsAt(body.conversation.at_uri)).toEqual([]);
        expect(await creationsOf(identity.did)).toEqual([]);
      });
      const response = await pending;

      expect(response?.status).toBe(201);
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });

    test("holds the lock until the creation is committed", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      const heldAtCommit: boolean[] = [];
      const runQuery = Client.prototype.query as (
        this: Client,
        ...args: unknown[]
      ) => unknown;
      const query = jest.spyOn(Client.prototype, "query") as unknown as {
        mockImplementation: (
          implementation: (this: Client, ...args: unknown[]) => unknown
        ) => void;
        mockRestore: () => void;
      };
      query.mockImplementation(function (this: Client, ...args: unknown[]) {
        if (args[0] !== "COMMIT") {
          return runQuery.apply(this, args);
        }
        return rows<{ free: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1::bigint) AS free",
          [CREATE_LOCK_KEY]
        ).then((found) => {
          heldAtCommit.push(!found[0].free);
          return runQuery.apply(this, args);
        });
      });

      let response: ApiResponse;
      try {
        response = await create(identity, body);
      } finally {
        query.mockRestore();
      }

      expect(response.status).toBe(201);
      expect(heldAtCommit).toEqual([true]);
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });

    test("answers 503 after waiting five seconds for the lock", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      let waited = -1;
      let pending: Promise<ApiResponse> | undefined;
      let answered: ApiResponse | undefined;

      await whileCreationIsLocked(async () => {
        const started = Date.now();
        pending = create(identity, body).then((response) => {
          waited = Date.now() - started;
          return response;
        });
        answered = await Promise.race([
          pending,
          wait(8000).then(() => undefined),
        ]);
      });
      await pending;

      expect(answered?.status).toBe(503);
      expect(answered?.body).toEqual(
        failureBody("polis_err_atproto_conversation_busy", 503)
      );
      expect(refusals("polis_err_atproto_conversation_busy")).toEqual([
        { did: identity.did },
      ]);
      expect(waited).toBeGreaterThanOrEqual(5000);
      expect(waited).toBeLessThan(6500);
      await expectNothingCreated(identity, body);

      const retried = await create(identity, body);

      expect(retried.status).toBe(201);
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });

    test("lets one creation at a time wait for the lock", async () => {
      const identities = await Promise.all([
        newIdentity(),
        newIdentity(),
        newIdentity(),
      ]);
      const bodies = identities.map((identity) => buildBody(identity, 1));
      const tokens = await Promise.all(
        identities.map((identity) => tokenFor(identity))
      );
      const waited: number[] = [];
      let mostWaiting = 0;
      let answered: ApiResponse[] = [];

      await whileCreationIsLocked(async () => {
        const started = Date.now();
        const pending = Promise.all(
          bodies.map((body, index) =>
            send(body, tokens[index]).then((response) => {
              waited.push(Date.now() - started);
              return response;
            })
          )
        );
        await untilCreationWaitsForTheLock();
        for (let sample = 0; sample < 40; sample += 1) {
          mostWaiting = Math.max(
            mostWaiting,
            await creationsWaitingForTheLock()
          );
          await wait(50);
        }
        answered = await pending;
      });

      expect(mostWaiting).toBe(1);
      expect(answered.map((response) => response.status)).toEqual([
        503, 503, 503,
      ]);
      expect(answered.map((response) => response.body)).toEqual([
        failureBody("polis_err_atproto_conversation_busy", 503),
        failureBody("polis_err_atproto_conversation_busy", 503),
        failureBody("polis_err_atproto_conversation_busy", 503),
      ]);
      expect(Math.min(...waited)).toBeGreaterThanOrEqual(5000);
      expect(Math.max(...waited)).toBeLessThan(6500);
      for (const [index, identity] of identities.entries()) {
        await expectNothingCreated(identity, bodies[index]);
      }
    });

    test("answers 503 at once when twenty creations are already waiting", async () => {
      const identities = await Promise.all(
        Array.from({ length: 21 }, () => newIdentity())
      );
      const bodies = identities.map((identity) => buildBody(identity, 1));
      const tokens = await Promise.all(
        identities.map((identity) => tokenFor(identity))
      );
      const early: ApiResponse[] = [];
      let locked = true;
      let pending: Promise<ApiResponse[]> | undefined;

      await whileCreationIsLocked(async () => {
        pending = Promise.all(
          bodies.map((body, index) =>
            send(body, tokens[index]).then((response) => {
              if (locked) {
                early.push(response);
              }
              return response;
            })
          )
        );
        await untilCreationWaitsForTheLock();
        await wait(500);
        locked = false;
      });
      const answered = (await pending) ?? [];

      expect(early.map((response) => response.status)).toEqual([503]);
      expect(early[0].body).toEqual(
        failureBody("polis_err_atproto_conversation_busy", 503)
      );
      expect(
        answered.map((response) => response.status).sort((a, b) => a - b)
      ).toEqual([...Array.from({ length: 20 }, () => 201), 503]);
    });

    test("leaves the lock timeout of pooled connections at its default", async () => {
      const identity = await newIdentity();
      const response = await create(identity, buildBody(identity, 1));
      expect(response.status).toBe(201);

      const settings = (await Promise.all(
        Array.from({ length: 12 }, () =>
          pg.queryP(
            "SELECT current_setting('lock_timeout') AS value, pg_sleep(0.05);"
          )
        )
      )) as Array<Array<{ value: string }>>;

      expect(settings.map((found) => found[0].value)).toEqual(
        Array.from({ length: 12 }, () => "0")
      );
    });

    test("answers a resent, a conflicting and a refused request while the lock is held", async () => {
      const identity = await newIdentity();
      setCaps(1, 1000000);
      const body = buildBody(identity, 1);
      const first = await create(identity, body);
      expect(first.status).toBe(201);

      const responses: ApiResponse[] = [];
      await whileCreationIsLocked(async () => {
        responses.push(await create(identity, body));
        responses.push(
          await create(identity, { ...body, topic: `${body.topic} changed` })
        );
        responses.push(await create(identity, buildBody(identity, 1)));
      });

      expect(responses.map((response) => response.status)).toEqual([
        200, 409, 429,
      ]);
    });
  });

  describe("validation", () => {
    const stackedE = "\u00e9\u0302";

    test("answers 403 when the record belongs to another DID", async () => {
      const identity = await newIdentity();
      const other = await newIdentity();
      const body = buildBody(other);

      const response = await create(identity, body);

      expect(response.status).toBe(403);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_record_did_mismatch", 403)
      );
      expect(refusals("polis_err_atproto_record_did_mismatch")).toEqual([
        { did: identity.did },
      ]);
      await expectNothingCreated(identity, body);
      expect(await creationsOf(other.did)).toEqual([]);
    });

    test.each([
      [
        "an empty topic",
        (body: Body) => ({ ...body, topic: "" }),
        "polis_err_atproto_conversation_topic_empty",
      ],
      [
        "a topic of spaces",
        (body: Body) => ({ ...body, topic: " \n\t " }),
        "polis_err_atproto_conversation_topic_empty",
      ],
      [
        "a topic of 201 graphemes",
        (body: Body) => ({ ...body, topic: stackedE.repeat(201) }),
        "polis_err_atproto_conversation_topic_too_long",
      ],
      [
        "a topic of 1001 bytes",
        (body: Body) => ({
          ...body,
          topic: `${"\u{1F44D}\u{1F3FD}".repeat(125)}a`,
        }),
        "polis_err_atproto_conversation_topic_too_long",
      ],
      [
        "a topic of 4000 characters",
        (body: Body) => ({ ...body, topic: "a".repeat(4000) }),
        "polis_err_atproto_conversation_topic_too_long",
      ],
      [
        "a topic with a NUL character",
        (body: Body) => ({ ...body, topic: `${body.topic}\u0000` }),
        "polis_err_atproto_conversation_text_invalid",
      ],
      [
        "no statements",
        (body: Body) => ({ ...body, statements: [] }),
        "polis_err_atproto_conversation_statements_count",
      ],
      [
        "eleven statements",
        (body: Body) => ({
          ...body,
          statements: Array.from(
            Array(11).keys(),
            (index) => `${body.statements[0]} ${index}`
          ),
        }),
        "polis_err_atproto_conversation_statements_count",
      ],
      [
        "an empty statement",
        (body: Body) => ({ ...body, statements: [body.statements[0], "  "] }),
        "polis_err_atproto_conversation_statement_empty",
      ],
      [
        "a statement of 401 graphemes",
        (body: Body) => ({
          ...body,
          statements: [body.statements[0], stackedE.repeat(401)],
        }),
        "polis_err_atproto_conversation_statement_too_long",
      ],
      [
        "a statement of 2001 bytes",
        (body: Body) => ({
          ...body,
          statements: [`\u65e5${"\u20d0".repeat(665)}abc`],
        }),
        "polis_err_atproto_conversation_statement_too_long",
      ],
      [
        "a statement of 998 code units",
        (body: Body) => ({
          ...body,
          statements: [`q${"\u0301".repeat(997)}`],
        }),
        "polis_err_atproto_conversation_statement_too_long",
      ],
      [
        "a statement with a NUL character",
        (body: Body) => ({
          ...body,
          statements: [`${body.statements[0]}\u0000`],
        }),
        "polis_err_atproto_conversation_text_invalid",
      ],
      [
        "a repeated statement",
        (body: Body) => ({
          ...body,
          statements: [body.statements[0], ` ${body.statements[0]} `],
        }),
        "polis_err_atproto_conversation_statement_duplicate",
      ],
      [
        "a statement repeated in another case",
        (body: Body) => ({
          ...body,
          statements: [body.statements[0], body.statements[0].toUpperCase()],
        }),
        "polis_err_atproto_conversation_statement_duplicate",
      ],
      [
        "a record in another collection",
        (body: Body) => ({
          ...body,
          conversation: {
            ...body.conversation,
            at_uri: body.conversation.at_uri.replace(
              CONVERSATION_COLLECTION,
              "app.bsky.feed.post"
            ),
          },
        }),
        "polis_err_atproto_record_uri_invalid",
      ],
      [
        "an invalid record key",
        (body: Body) => ({
          ...body,
          conversation: {
            ...body.conversation,
            at_uri: `${body.conversation.at_uri}/extra`,
          },
        }),
        "polis_err_atproto_record_uri_invalid",
      ],
      [
        "an at_cid that is not a record CID",
        (body: Body) => ({
          ...body,
          conversation: { ...body.conversation, at_cid: "bafyembedtest" },
        }),
        "polis_err_atproto_record_cid_invalid",
      ],
    ])("answers 400 for %s", async (label, change, code) => {
      const identity = await newIdentity();
      const body = buildBody(identity);

      const response = await create(identity, change(body));

      expect(response.status).toBe(400);
      expect(response.body).toEqual(failureBody(code, 400));
      expect(refusals(code)).toEqual([{ did: identity.did }]);
      await expectNothingCreated(identity, body);
      expect(mockedEnsureAnonSession).not.toHaveBeenCalled();
    });

    test.each([
      [
        "a missing topic",
        (body: Body) => ({
          statements: body.statements,
          conversation: body.conversation,
        }),
        "polis_err_param_missing_topic",
      ],
      [
        "a topic that is not text",
        (body: Body) => ({ ...body, topic: { text: body.topic } }),
        "polis_err_param_parse_failed_topic",
      ],
      [
        "a topic of 4001 characters",
        (body: Body) => ({ ...body, topic: "a".repeat(4001) }),
        "polis_err_param_parse_failed_topic",
      ],
      [
        "missing statements",
        (body: Body) => ({
          topic: body.topic,
          conversation: body.conversation,
        }),
        "polis_err_param_missing_statements",
      ],
      [
        "statements that are not a list",
        (body: Body) => ({ ...body, statements: body.statements.join(",") }),
        "polis_err_param_parse_failed_statements",
      ],
      [
        "a statement that is not text",
        (body: Body) => ({ ...body, statements: [body.statements[0], 5] }),
        "polis_err_param_parse_failed_statements",
      ],
      [
        "a missing record reference",
        (body: Body) => ({ topic: body.topic, statements: body.statements }),
        "polis_err_param_missing_conversation",
      ],
      [
        "a record reference without at_cid",
        (body: Body) => ({
          ...body,
          conversation: { at_uri: body.conversation.at_uri },
        }),
        "polis_err_param_parse_failed_conversation",
      ],
    ])("answers 400 for %s", async (label, change, reason) => {
      const identity = await newIdentity();
      const body = buildBody(identity);

      const response = await create(identity, change(body));

      expect(response.status).toBe(400);
      expect(response.text).toContain(reason);
      await expectNothingCreated(identity, body);
    });

    test("accepts the largest topic and statements", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const largest = {
        ...body,
        topic: `${body.topic} `.padEnd(200, "t"),
        statements: [
          `${body.statements[0]} `.padEnd(400, "s"),
          `\u65e5${"\u20d0".repeat(665)}ab`,
          `q${"\u0301".repeat(996)}`,
        ],
      };

      const response = await create(identity, largest);

      expect(response.status).toBe(201);
      const zid = await zidOf(response.body.conversation_id);
      expect(
        await rows("SELECT topic FROM conversations WHERE zid = $1", [zid])
      ).toEqual([{ topic: largest.topic }]);
      expect((await seedsOf(zid)).map((seed) => seed.txt)).toEqual(
        largest.statements
      );
    });
  });

  describe("statement records", () => {
    test("answers 503 before creating anything when there is no session", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedEnsureAnonSession.mockResolvedValue(false);

      const response = await create(identity, body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_seed_publisher_unavailable", 503)
      );
      expect(refusals("polis_err_atproto_seed_publisher_unavailable")).toEqual([
        { did: identity.did },
      ]);
      await expectNothingCreated(identity, body);
      expect(mockedDetect).not.toHaveBeenCalled();
      expect(mockedGenerateToken).not.toHaveBeenCalled();
    });

    test("answers 503 before creating anything when there is no service DID", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedGetAnonDid.mockReturnValue(null);

      const response = await create(identity, body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_seed_publisher_unavailable", 503)
      );
      await expectNothingCreated(identity, body);
      expect(mockedGenerateToken).not.toHaveBeenCalled();
    });

    test("starts the session before reading the service DID", async () => {
      const identity = await newIdentity();
      const order: string[] = [];
      mockedEnsureAnonSession.mockImplementation(async () => {
        order.push("session");
        return true;
      });
      mockedGetAnonDid.mockImplementation(() => {
        order.push("did");
        return PUBLISHER_DID;
      });

      const response = await create(identity, buildBody(identity, 1));

      expect(response.status).toBe(201);
      expect(order).toEqual(["session", "did"]);
    });

    test("resumes with the missing records after a failed write", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedPut
        .mockImplementationOnce(async (params) => ({
          uri: statementUri(params.rkey),
          cid: statementCid(params),
        }))
        .mockImplementationOnce(async () => null);

      const first = await create(identity, body);

      expect(first.status).toBe(503);
      expect(first.body).toEqual(
        failureBody("polis_err_atproto_statement_records_incomplete", 503)
      );
      const conversations = await conversationsAt(body.conversation.at_uri);
      expect(conversations).toHaveLength(1);
      const zid: number = conversations[0].zid;
      expect(
        refusals("polis_err_atproto_statement_records_incomplete")
      ).toEqual([{ did: identity.did, zid }]);
      const afterFirst = await seedsOf(zid);
      const rkeys = afterFirst.map((seed) => rkeyOf(seed.at_uri));
      expect(afterFirst.map((seed) => [seed.txt, seed.at_cid])).toEqual([
        [
          body.statements[0],
          statementCid({ rkey: rkeys[0], text: body.statements[0] }),
        ],
        [body.statements[1], null],
        [body.statements[2], null],
      ]);
      expect(afterFirst.map((seed) => seed.at_uri)).toEqual(
        rkeys.map(statementUri)
      );
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
        body.statements[1],
      ]);
      mockedPut.mockClear();
      mockedDetect.mockClear();
      mockedGenerateToken.mockClear();

      const second = await create(identity, body);

      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      expect(await zidOf(second.body.conversation_id)).toBe(zid);
      expect(
        await rows("SELECT report_id FROM reports WHERE zid = $1", [zid])
      ).toEqual([{ report_id: second.body.report_id }]);
      expect(mockedPut.mock.calls).toEqual(
        [1, 2].map((index) => [
          {
            rkey: rkeys[index],
            conversationUri: body.conversation.at_uri,
            conversationCid: body.conversation.at_cid,
            text: body.statements[index],
            createdAt: new Date(
              Number(afterFirst[index].created)
            ).toISOString(),
          },
        ])
      );
      expect(
        (await seedsOf(zid)).map((seed) => [seed.at_uri, seed.at_cid])
      ).toEqual(
        body.statements.map((text, index) => [
          statementUri(rkeys[index]),
          statementCid({ rkey: rkeys[index], text }),
        ])
      );
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect(await creationsOf(identity.did)).toHaveLength(1);
      expect(await seedsOf(zid)).toHaveLength(3);
      expect(mockedDetect).not.toHaveBeenCalled();
      expect(mockedGenerateToken).not.toHaveBeenCalled();

      mockedPut.mockClear();
      const third = await create(identity, body);

      expect(third.status).toBe(200);
      expect(third.body).toEqual(second.body);
      expect(mockedPut).not.toHaveBeenCalled();
    });

    test("answers 503 again while the writer keeps failing", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      mockedPut.mockImplementation(async () => null);

      const first = await create(identity, body);
      const second = await create(identity, body);

      expect([first.status, second.status]).toEqual([503, 503]);
      expect(second.body).toEqual(
        failureBody("polis_err_atproto_statement_records_incomplete", 503)
      );
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
        body.statements[0],
      ]);
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      expect(await creationsOf(identity.did)).toHaveLength(1);
    });

    test("answers 503 when the writer throws", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      mockedPut.mockImplementationOnce(async () => {
        throw new Error("writer failed");
      });

      const first = await create(identity, body);
      const second = await create(identity, body);

      expect(first.status).toBe(503);
      expect(first.body).toEqual(
        failureBody("polis_err_atproto_statement_records_incomplete", 503)
      );
      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      expect(mockedPut).toHaveBeenCalledTimes(2);
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
    });

    test("stores the address the record was written to", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      const movedDid = randomDidPlc();
      mockedPut.mockImplementation(async (params) => ({
        uri: `at://${movedDid}/${STATEMENT_COLLECTION}/${params.rkey}`,
        cid: statementCid(params),
      }));

      const response = await create(identity, body);

      expect(response.status).toBe(201);
      const zid = await zidOf(response.body.conversation_id);
      const [params] = mockedPut.mock.calls[0];
      expect(
        (await seedsOf(zid)).map((seed) => [seed.at_uri, seed.at_cid])
      ).toEqual([
        [
          `at://${movedDid}/${STATEMENT_COLLECTION}/${params.rkey}`,
          statementCid({ rkey: params.rkey, text: body.statements[0] }),
        ],
      ]);
    });

    test("does not write a record that was stored in the meantime", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      const storedElsewhere = buildCid(`stored elsewhere ${runId}`);
      mockedPut.mockImplementationOnce(async (params) => {
        await pool.query(
          "UPDATE comments SET at_cid = $1 WHERE txt = $2 AND zid = (SELECT zid FROM conversations WHERE at_uri = $3)",
          [storedElsewhere, body.statements[1], body.conversation.at_uri]
        );
        return { uri: statementUri(params.rkey), cid: statementCid(params) };
      });

      const response = await create(identity, body);

      expect(response.status).toBe(201);
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
        body.statements[2],
      ]);
      const zid = await zidOf(response.body.conversation_id);
      const seeds = await seedsOf(zid);
      expect(seeds.map((seed) => seed.at_cid)).toEqual([
        statementCid({
          rkey: rkeyOf(seeds[0].at_uri),
          text: body.statements[0],
        }),
        storedElsewhere,
        statementCid({
          rkey: rkeyOf(seeds[2].at_uri),
          text: body.statements[2],
        }),
      ]);
    });

    test("skips a statement taken down after the commit", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedPut.mockImplementationOnce(async (params) => {
        await pool.query(
          "UPDATE comments SET mod = -1, active = false WHERE txt = $1 AND zid = (SELECT zid FROM conversations WHERE at_uri = $2)",
          [body.statements[1], body.conversation.at_uri]
        );
        return { uri: statementUri(params.rkey), cid: statementCid(params) };
      });

      const first = await create(identity, body);

      expect(first.status).toBe(503);
      expect(first.body).toEqual(
        failureBody("polis_err_atproto_statement_records_incomplete", 503)
      );
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
        body.statements[2],
      ]);
      const zid: number = (await conversationsAt(body.conversation.at_uri))[0]
        .zid;
      const seeds = await seedsOf(zid);
      expect(seeds.map((seed) => [seed.txt, seed.mod, seed.active])).toEqual([
        [body.statements[0], 1, true],
        [body.statements[1], -1, false],
        [body.statements[2], 1, true],
      ]);
      expect(seeds.map((seed) => seed.at_cid)).toEqual([
        statementCid({
          rkey: rkeyOf(seeds[0].at_uri),
          text: body.statements[0],
        }),
        null,
        statementCid({
          rkey: rkeyOf(seeds[2].at_uri),
          text: body.statements[2],
        }),
      ]);
      mockedPut.mockClear();

      const second = await create(identity, body);

      expect(second.status).toBe(503);
      expect(mockedPut).not.toHaveBeenCalled();
      expect((await seedsOf(zid))[1].at_cid).toBeNull();
    });

    test.each([
      ["rejected", "UPDATE comments SET mod = -1 WHERE zid = $1 AND tid = 1"],
      [
        "inactive",
        "UPDATE comments SET active = false WHERE zid = $1 AND tid = 1",
      ],
    ])("skips a statement that is only %s", async (label, takedown) => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      mockedPut.mockImplementationOnce(async (params) => {
        const found = await conversationsAt(body.conversation.at_uri);
        await pool.query(takedown, [found[0].zid]);
        return { uri: statementUri(params.rkey), cid: statementCid(params) };
      });

      const response = await create(identity, body);

      expect(response.status).toBe(503);
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
      ]);
    });

    test("publishes a statement that waits for moderation", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 2);
      mockedPut.mockImplementationOnce(async (params) => {
        const found = await conversationsAt(body.conversation.at_uri);
        await pool.query(
          "UPDATE comments SET mod = 0 WHERE zid = $1 AND tid = 1",
          [found[0].zid]
        );
        return { uri: statementUri(params.rkey), cid: statementCid(params) };
      });

      const response = await create(identity, body);

      expect(response.status).toBe(201);
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual(
        body.statements
      );
    });

    test("skips every statement of a conversation closed after the commit", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedPut.mockImplementationOnce(async (params) => {
        await pool.query(
          "UPDATE conversations SET is_active = false WHERE at_uri = $1",
          [body.conversation.at_uri]
        );
        return { uri: statementUri(params.rkey), cid: statementCid(params) };
      });

      const first = await create(identity, body);

      expect(first.status).toBe(503);
      expect(first.body).toEqual(
        failureBody("polis_err_atproto_statement_records_incomplete", 503)
      );
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
      ]);
      const zid: number = (await conversationsAt(body.conversation.at_uri))[0]
        .zid;
      expect((await seedsOf(zid)).map((seed) => seed.at_cid === null)).toEqual([
        false,
        true,
        true,
      ]);
    });

    test.each([
      [
        "the conversation has no record CID",
        "UPDATE conversations SET at_cid = NULL WHERE zid = $1",
      ],
      [
        "the conversation has no record URI",
        "UPDATE conversations SET at_uri = NULL WHERE zid = $1",
      ],
      [
        "the statement has no valid record key",
        "UPDATE comments SET at_uri = at_uri || 'x' WHERE zid = $1 AND tid = 1",
      ],
      [
        "the statement has no creation time",
        "UPDATE comments SET created = NULL WHERE zid = $1 AND tid = 1",
      ],
    ])("writes no record while %s", async (label, damage) => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      let zid = -1;
      mockedPut.mockImplementationOnce(async (params) => {
        zid = (await conversationsAt(body.conversation.at_uri))[0].zid;
        await pool.query(damage, [zid]);
        return { uri: statementUri(params.rkey), cid: statementCid(params) };
      });

      const response = await create(identity, body);

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_statement_records_incomplete", 503)
      );
      expect(refusals("atproto statement record cannot be built")).toEqual([
        { zid, tid: 1 },
      ]);
      expect(mockedPut.mock.calls.map(([params]) => params.text)).toEqual([
        body.statements[0],
      ]);
      expect((await seedsOf(zid)).map((seed) => seed.at_cid === null)).toEqual([
        false,
        true,
        true,
      ]);
    });

    test("does not write records for statements added by other means", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity, 1);
      const first = await create(identity, body);
      expect(first.status).toBe(201);
      const zid = await zidOf(first.body.conversation_id);
      const owner = await ownerOf(zid);
      await pool.query(
        `INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid)
         VALUES (0, $1, $2, 1, true, 1, $3, false, true, default, null)`,
        [zid, `Added later ${runId}`, owner]
      );
      mockedPut.mockClear();

      const replay = await create(identity, body);

      expect(replay.status).toBe(200);
      expect(mockedPut).not.toHaveBeenCalled();
    });
  });

  describe("failure inside the transaction", () => {
    test("leaves no rows and lets the same request succeed later", async () => {
      const identity = await newIdentity();
      const earlier = await create(identity, buildBody(identity, 1));
      expect(earlier.status).toBe(201);
      const takenReportId = earlier.body.report_id as string;
      const ownerBefore = await rows(
        "SELECT c.owner FROM atproto_conversation_creations a JOIN conversations c ON c.zid = a.zid WHERE a.did = $1",
        [identity.did]
      );

      const fresh = await newIdentity();
      const body = buildBody(fresh);
      jest.clearAllMocks();
      const zinvites: string[] = [];
      mockedGenerateToken.mockImplementation(async (len, pseudoRandomOk) => {
        if (len === 20) {
          return takenReportId.slice(1);
        }
        const token = await actualGenerateTokenP(len, pseudoRandomOk);
        zinvites.push(token);
        return token;
      });
      const poolStatements = [
        jest.spyOn(pg, "queryP"),
        jest.spyOn(pg, "query"),
      ];

      const failed = await create(fresh, body);
      const sentThroughThePool = poolStatements.flatMap((spy) =>
        spy.mock.calls.map(([sql]) => String(sql).trim())
      );
      for (const spy of poolStatements) {
        spy.mockRestore();
      }

      expect(failed.status).toBe(500);
      expect(failed.body).toEqual(
        failureBody("polis_err_atproto_conversation_create_failed", 500)
      );
      expect(mockedGenerateToken.mock.calls).toEqual([
        [10, false],
        [20, false],
      ]);
      expect(zinvites).toHaveLength(1);
      await expectNothingCreated(fresh, body);
      expect(
        await rows("SELECT * FROM zinvites WHERE zinvite = $1", [zinvites[0]])
      ).toEqual([]);
      expect(
        await rows("SELECT zid FROM reports WHERE report_id = $1", [
          takenReportId,
        ])
      ).toEqual([{ zid: await zidOf(earlier.body.conversation_id) }]);
      expect(
        sentThroughThePool.filter((sql) =>
          sql.includes("atproto_conversation_creations")
        )
      ).toHaveLength(3);
      expect(
        sentThroughThePool.filter((sql) =>
          /^(insert|update|delete)\b/i.test(sql)
        )
      ).toEqual([]);
      expect(
        await rows(
          "SELECT c.owner FROM atproto_conversation_creations a JOIN conversations c ON c.zid = a.zid WHERE a.did = $1",
          [identity.did]
        )
      ).toEqual(ownerBefore);

      mockedGenerateToken.mockImplementation(actualGenerateTokenP);
      const retried = await create(fresh, body);

      expect(retried.status).toBe(201);
      expect(retried.body.created).toBe(true);
      expect(retried.body.report_id).not.toBe(takenReportId);
      expect(await conversationsAt(body.conversation.at_uri)).toHaveLength(1);
      const zid = await zidOf(retried.body.conversation_id);
      expect((await seedsOf(zid)).map((seed) => seed.txt)).toEqual(
        body.statements
      );
      expect(mockedPut).toHaveBeenCalledTimes(3);
    });

    test("leaves no rows when a statement cannot be stored", async () => {
      const identity = await newIdentity();
      const body = buildBody(identity);
      mockedDetect.mockImplementation(async (txt) => [
        {
          language: txt === body.statements[2] ? "x".repeat(11) : "en",
          confidence: 1,
        },
      ]);

      const failed = await create(identity, body);

      expect(failed.status).toBe(500);
      expect(failed.body).toEqual(
        failureBody("polis_err_atproto_conversation_create_failed", 500)
      );
      await expectNothingCreated(identity, body);

      mockedDetect.mockResolvedValue([{ language: "en", confidence: 1 }]);
      const retried = await create(identity, body);

      expect(retried.status).toBe(201);
    });
  });
});

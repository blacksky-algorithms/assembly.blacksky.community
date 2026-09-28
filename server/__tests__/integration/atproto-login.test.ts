import { generateKeyPairSync } from "node:crypto";
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
import type { PoolClient, QueryResultRow } from "pg";
import request from "supertest";
import type { Agent } from "supertest";
import { clearAtprotoIdentityCache } from "../../src/auth/atproto-did";
import Config from "../../src/config";
import logger from "../../src/utils/logger";
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
  randomDidWeb,
  signServiceJwt,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

type ApiResponse = {
  status: number;
  body: Record<string, unknown>;
};
type LoginBody = {
  did?: string;
  handle?: string;
  email?: string;
  displayName?: string;
};
type UserRow = {
  uid: number;
  hname: string | null;
  username: string | null;
  email: string | null;
  is_owner: boolean;
};
type MappingRow = { oidc_sub: string; uid: number };
type SeededAccount = {
  did: string;
  handle: string;
  email: string | null;
  uid: number;
};

const ROUTE = "/api/v3/auth/atproto-login";
const LXM = "community.blacksky.assembly.createSession";
const CREATE_CONVERSATION_LXM =
  "community.blacksky.assembly.createConversation";
const SERVICE_DID = "did:web:assembly.test.invalid";
const PLC_URL = "https://plc.test.invalid";
const PROOF = "atproto_service_auth";
const AIP_PREFIX = "oauth2|atproto|";
const LOGIN_LOG = "atproto admin login";
const UNPROVEN_LOGIN_LOG = "atproto admin login without proof";
const REFUSED_PROOF_LOG = "atproto admin login: proof was not accepted";
const EMAIL_NOT_STORED_LOG = "atproto admin login: email was not stored";
const runId = `${process.pid}x${Date.now()}`;

const ENV_NAMES = [
  "ATPROTO_LOGIN_PROOF",
  "ATPROTO_SERVICE_DID",
  "ATPROTO_PLC_URL",
  "ATPROTO_APP_CREATE_ELIGIBILITY",
  "ATPROTO_APP_CREATE_ALLOWLIST",
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
const subjects: string[] = [];
const uids: number[] = [];
const zids: number[] = [];

function nextLabel(): string {
  sequence += 1;
  return `${runId}n${sequence}`;
}

async function newIdentity(
  params: { handle?: string | null; did?: string } = {}
): Promise<TestIdentity> {
  const identity = await createTestIdentity(params);
  plc.setDocument(identity.did, identity.document);
  subjects.push(identity.did, `${AIP_PREFIX}${identity.did}`);
  return identity;
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

async function forgedTokenFor(identity: TestIdentity): Promise<string> {
  return tokenFor({ ...identity, keypair: await generateTestKeypair() });
}

async function login(body: LoginBody, token?: string): Promise<ApiResponse> {
  const pending = agent.post(ROUTE);
  if (token !== undefined) {
    pending.set("Authorization", `Bearer ${token}`);
  }
  const response = await pending.send(body);
  if (typeof response.body?.uid === "number") {
    uids.push(response.body.uid);
  }
  return { status: response.status, body: response.body };
}

function legacyBody(identity: TestIdentity, extra: LoginBody = {}): LoginBody {
  return { did: identity.did, handle: String(identity.handle), ...extra };
}

function failureBody(code: string, status: number) {
  return { error: code, message: code, status };
}

function claimsOf(response: ApiResponse): Record<string, unknown> {
  const decoded = jwt.decode(String(response.body.token), { complete: true });
  expect(decoded?.header.alg).toBe("RS256");
  return decoded?.payload as Record<string, unknown>;
}

async function rows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

function mappingsOf(did: string): Promise<MappingRow[]> {
  return rows(
    "SELECT oidc_sub, uid FROM oidc_user_mappings WHERE oidc_sub = $1 OR oidc_sub = $2 ORDER BY oidc_sub",
    [did, `${AIP_PREFIX}${did}`]
  );
}

function mappingsTo(uid: number): Promise<MappingRow[]> {
  return rows(
    "SELECT oidc_sub, uid FROM oidc_user_mappings WHERE uid = $1 ORDER BY oidc_sub",
    [uid]
  );
}

function usersNamed(username: string | null): Promise<UserRow[]> {
  return rows(
    "SELECT uid, hname, username, email, is_owner FROM users WHERE username = $1 ORDER BY uid",
    [username]
  );
}

async function userOf(uid: unknown): Promise<UserRow> {
  const found = await rows<UserRow>(
    "SELECT uid, hname, username, email, is_owner FROM users WHERE uid = $1",
    [uid]
  );
  expect(found).toHaveLength(1);
  return found[0];
}

async function insertUser(fields: {
  hname: string;
  username: string;
  email: string | null;
}): Promise<number> {
  const created = await rows<{ uid: number }>(
    "INSERT INTO users (hname, username, email, is_owner) VALUES ($1, $2, $3, true) RETURNING uid",
    [fields.hname, fields.username, fields.email]
  );
  uids.push(created[0].uid);
  return created[0].uid;
}

async function insertMapping(subject: string, uid: number): Promise<void> {
  subjects.push(subject);
  await rows("INSERT INTO oidc_user_mappings (oidc_sub, uid) VALUES ($1, $2)", [
    subject,
    uid,
  ]);
}

async function seedAccount(params: {
  email: string | null;
  mapping: "bare" | "prefixed" | "none";
}): Promise<SeededAccount> {
  const label = nextLabel();
  const did = randomDidPlc();
  const handle = `seeded-${label}.test.invalid`;
  const uid = await insertUser({
    hname: `Seeded ${label}`,
    username: handle,
    email: params.email,
  });
  if (params.mapping !== "none") {
    await insertMapping(
      params.mapping === "bare" ? did : `${AIP_PREFIX}${did}`,
      uid
    );
  }
  return { did, handle, email: params.email, uid };
}

async function insertConversation(owner: number): Promise<number> {
  const created = await rows<{ zid: number }>(
    "INSERT INTO conversations (owner, org_id, topic, description, is_active, is_draft, is_public) VALUES ($1, $1, $2, '', true, false, true) RETURNING zid",
    [owner, `Login ${nextLabel()}`]
  );
  zids.push(created[0].zid);
  return created[0].zid;
}

function newEmail(): string {
  return `login-${nextLabel()}@example.invalid`;
}

function wait(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}

async function untilBlockedBy(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await rows<{ n: string }>(
      "SELECT COUNT(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [pid]
    );
    if (Number(blocked[0].n) > 0) {
      return;
    }
    await wait(20);
  }
  throw new Error("no request waited for the other session");
}

async function whileHolding(
  prepare: (holder: PoolClient) => Promise<void>,
  send: () => Promise<ApiResponse>,
  whileBlocked: () => Promise<void> = async () => undefined
): Promise<ApiResponse> {
  const holder = await pool.connect();
  let pending: Promise<ApiResponse> | undefined;
  try {
    await holder.query("BEGIN");
    await prepare(holder);
    pending = send();
    await untilBlockedBy(await backendPid(holder));
    await whileBlocked();
    await holder.query("COMMIT");
  } catch (err) {
    await holder.query("ROLLBACK");
    await pending?.catch(() => undefined);
    throw err;
  } finally {
    holder.release();
  }
  return pending;
}

function logged(
  spy: jest.SpiedFunction<typeof logger.info>,
  message: string
): unknown[] {
  return spy.mock.calls
    .filter(([first]) => (first as unknown) === message)
    .map((call) => (call as unknown[])[1]);
}

function setMode(mode: string): void {
  process.env.ATPROTO_LOGIN_PROOF = mode;
}

beforeAll(async () => {
  for (const name of ENV_NAMES) {
    originalEnv[name] = process.env[name];
  }
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

  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "atproto-login-"));
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

  server = http.createServer(await getApp());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  agent = request.agent(`http://127.0.0.1:${port}`);
});

beforeEach(() => {
  clearAtprotoIdentityCache();
  setMode("required");
  process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "any";
  process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const participants = await client.query(
      "SELECT uid FROM participants WHERE zid = ANY($1)",
      [zids]
    );
    for (const table of [
      "comments",
      "zinvites",
      "participants_extended",
      "participants",
      "conversations",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE zid = ANY($1)`, [zids]);
    }
    const mapped = await client.query(
      "DELETE FROM oidc_user_mappings WHERE oidc_sub = ANY($1) RETURNING uid",
      [subjects]
    );
    await client.query("DELETE FROM users WHERE uid = ANY($1)", [
      [
        ...uids,
        ...mapped.rows.map((row) => row.uid),
        ...participants.rows.map((row) => row.uid),
      ],
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.warn("atproto login test rows were not removed", err);
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

describe("POST /api/v3/auth/atproto-login", () => {
  describe("when proof is required", () => {
    test("answers 401 without a token, before validating the body", async () => {
      const response = await login({});

      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_missing", 401)
      );
    });

    test.each([
      ["unset", undefined],
      ["empty", ""],
      ["in another case", "Optional"],
      ["followed by a space", "optional "],
      ["another word", "off"],
    ])(
      "answers 401 without a token and creates nothing when the setting is %s",
      async (label, value) => {
        if (value === undefined) {
          delete process.env.ATPROTO_LOGIN_PROOF;
        } else {
          setMode(value);
        }
        const identity = await newIdentity();

        const response = await login(
          legacyBody(identity, { email: newEmail() })
        );

        expect(response.status).toBe(401);
        expect(response.body).toEqual(
          failureBody("polis_err_atproto_auth_missing", 401)
        );
        expect(await mappingsOf(identity.did)).toEqual([]);
        expect(await usersNamed(identity.handle)).toEqual([]);
      }
    );

    test("issues a token that carries the proof for a valid token and an empty body", async () => {
      const identity = await newIdentity();

      const response = await login({}, await tokenFor(identity));

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(["token", "uid"]);
      expect(claimsOf(response)).toMatchObject({
        sub: identity.did,
        uid: response.body.uid,
        type: "atproto_admin",
        proof: PROOF,
      });
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: response.body.uid },
      ]);
      expect(await usersNamed(identity.handle)).toEqual([
        {
          uid: response.body.uid,
          hname: identity.handle,
          username: identity.handle,
          email: null,
          is_owner: true,
        },
      ]);
    });

    test("accepts a body that names the proven account", async () => {
      const identity = await newIdentity();

      const response = await login(
        legacyBody(identity),
        await tokenFor(identity)
      );

      expect(response.status).toBe(200);
      expect(claimsOf(response)).toMatchObject({
        sub: identity.did,
        proof: PROOF,
      });
    });

    test("answers 401 for a token that names another account and is signed with another key", async () => {
      const victim = await newIdentity();
      const before = await login({}, await tokenFor(victim));
      const victimRow = await userOf(before.body.uid);

      const response = await login(
        { email: newEmail(), displayName: "Someone else" },
        await forgedTokenFor(victim)
      );

      expect(before.status).toBe(200);
      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_auth_invalid", 401)
      );
      expect(await mappingsOf(victim.did)).toEqual([
        { oidc_sub: victim.did, uid: before.body.uid },
      ]);
      expect(await userOf(before.body.uid)).toEqual(victimRow);
    });

    test.each<{
      name: string;
      claims: () => Record<string, unknown>;
      status: number;
      code: string;
    }>([
      {
        name: "a token for creating conversations",
        claims: () => ({ lxm: CREATE_CONVERSATION_LXM }),
        status: 401,
        code: "polis_err_atproto_auth_invalid",
      },
      {
        name: "a token without a method",
        claims: () => ({ lxm: undefined }),
        status: 401,
        code: "polis_err_atproto_auth_invalid",
      },
      {
        name: "a token for another audience",
        claims: () => ({ aud: "did:web:other.test.invalid" }),
        status: 401,
        code: "polis_err_atproto_auth_invalid",
      },
      {
        name: "an expired token",
        claims: () => {
          const now = Math.floor(Date.now() / 1000);
          return { iat: now - 600, exp: now - 300 };
        },
        status: 401,
        code: "polis_err_atproto_auth_expired",
      },
      {
        name: "a did:web issuer whose document cannot be fetched",
        claims: () => ({ iss: "did:web:admin.test.invalid" }),
        status: 503,
        code: "polis_err_atproto_did_resolution_failed",
      },
      {
        name: "an issuer that is neither did:plc nor did:web",
        claims: () => ({
          iss: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        }),
        status: 400,
        code: "polis_err_atproto_unsupported_did",
      },
    ])("answers $status $code for $name", async ({ claims, status, code }) => {
      const identity = await newIdentity();

      const response = await login(
        legacyBody(identity),
        await tokenFor(identity, claims())
      );

      expect(response.status).toBe(status);
      expect(response.body).toEqual(failureBody(code, status));
      expect(await mappingsOf(identity.did)).toEqual([]);
      expect(await usersNamed(identity.handle)).toEqual([]);
    });

    test("signs in an account with a did:web identifier", async () => {
      const identity = await newIdentity({ did: randomDidWeb() });

      const response = await login({}, await tokenFor(identity));

      expect(response.status).toBe(200);
      expect(claimsOf(response)).toMatchObject({
        sub: identity.did,
        uid: response.body.uid,
        proof: "atproto_service_auth",
      });
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: response.body.uid },
      ]);
    });

    test("answers 503 when the DID directory cannot be asked", async () => {
      const identity = await newIdentity();
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 500 })
      );

      const response = await login(
        legacyBody(identity),
        await tokenFor(identity)
      );

      expect(response.status).toBe(503);
      expect(response.body).toEqual(
        failureBody("polis_err_atproto_did_resolution_failed", 503)
      );
      expect(await mappingsOf(identity.did)).toEqual([]);
    });

    test.each<{ name: string; header: (token: string) => string }>([
      { name: "another scheme", header: (token) => `Basic ${token}` },
      { name: "a bare token", header: (token) => token },
      {
        name: "two tokens",
        header: (token) => `Bearer ${token} ${token}`,
      },
    ])(
      "answers 401 for an Authorization header with $name",
      async ({ header }) => {
        const identity = await newIdentity();

        const response = await agent
          .post(ROUTE)
          .set("Authorization", header(await tokenFor(identity)))
          .send(legacyBody(identity));

        expect(response.status).toBe(401);
        expect(response.body).toEqual(
          failureBody("polis_err_atproto_auth_invalid", 401)
        );
        expect(await mappingsOf(identity.did)).toEqual([]);
      }
    );

    test("is not limited by the list of accounts that may start conversations", async () => {
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "allowlist";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
      const identity = await newIdentity();

      const response = await login({}, await tokenFor(identity));

      expect(response.status).toBe(200);
      expect(claimsOf(response)).toMatchObject({
        sub: identity.did,
        proof: PROOF,
      });
    });
  });

  describe("account named in the body", () => {
    test.each([["required"], ["optional"]])(
      "answers 400 when it is not the proven account and proof is %s",
      async (mode) => {
        setMode(mode);
        const identity = await newIdentity();
        const other = await newIdentity();

        const response = await login(
          legacyBody(other),
          await tokenFor(identity)
        );

        expect(response.status).toBe(400);
        expect(response.body).toEqual(
          failureBody("polis_err_atproto_login_did_mismatch", 400)
        );
        for (const account of [identity, other]) {
          expect(await mappingsOf(account.did)).toEqual([]);
          expect(await usersNamed(account.handle)).toEqual([]);
        }
      }
    );

    test("does not use up the token when it is refused", async () => {
      const identity = await newIdentity();
      const other = await newIdentity();
      const token = await tokenFor(identity);

      const refused = await login(legacyBody(other), token);
      const accepted = await login(legacyBody(identity), token);

      expect([refused.status, accepted.status]).toEqual([400, 200]);
      expect(claimsOf(accepted)).toMatchObject({
        sub: identity.did,
        proof: PROOF,
      });
    });
  });

  describe("token reuse", () => {
    test("refuses a token that was already used", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      const errors = jest.spyOn(logger, "error");

      const first = await login({}, token);
      const second = await login({}, token);

      expect(first.status).toBe(200);
      expect(second.status).toBe(401);
      expect(second.body).toEqual(
        failureBody("polis_err_atproto_auth_replayed", 401)
      );
      expect(logged(errors, "polis_err_atproto_auth_replayed")).toEqual([
        { did: identity.did, reason: "token_reused" },
      ]);
    });

    test("refuses a reused token that carries no jti", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity, { jti: undefined });

      const responses = [await login({}, token), await login({}, token)];

      expect(responses.map((response) => response.status)).toEqual([200, 401]);
    });

    test("lets only one of two simultaneous requests use a token", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);

      const responses = await Promise.all([login({}, token), login({}, token)]);

      expect(
        responses.map((response) => response.status).sort((a, b) => a - b)
      ).toEqual([200, 401]);
      expect(await mappingsOf(identity.did)).toHaveLength(1);
    });

    test("accepts the next token of the same account", async () => {
      const identity = await newIdentity();

      const responses = [
        await login({}, await tokenFor(identity)),
        await login({}, await tokenFor(identity)),
      ];

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses[1].body.uid).toBe(responses[0].body.uid);
    });

    test("does not use up a token that failed verification", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 500 })
      );

      const refused = await login({}, token);
      plc.setDocument(identity.did, identity.document);
      clearAtprotoIdentityCache();
      const accepted = await login({}, token);

      expect([refused.status, accepted.status]).toEqual([503, 200]);
    });
  });

  describe("account lookup", () => {
    test("returns the account of an existing mapping and changes nothing", async () => {
      const identity = await newIdentity();
      const first = await login(
        { displayName: "First name", email: newEmail() },
        await tokenFor(identity)
      );
      const row = await userOf(first.body.uid);

      const second = await login(
        { displayName: "Second name", email: newEmail() },
        await tokenFor(identity)
      );

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body.uid).toBe(first.body.uid);
      expect(row.hname).toBe("First name");
      expect(await userOf(first.body.uid)).toEqual(row);
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: first.body.uid },
      ]);
      expect(await usersNamed(identity.handle)).toHaveLength(1);
    });

    test("returns the account of a mapping with the prefixed subject and creates no rows", async () => {
      const account = await seedAccount({ email: null, mapping: "prefixed" });
      const identity = await createTestIdentity({ did: account.did });
      plc.setDocument(identity.did, identity.document);
      const row = await userOf(account.uid);

      const response = await login({}, await tokenFor(identity));

      expect(response.status).toBe(200);
      expect(response.body.uid).toBe(account.uid);
      expect(claimsOf(response)).toMatchObject({
        sub: account.did,
        uid: account.uid,
        proof: PROOF,
      });
      expect(await mappingsOf(account.did)).toEqual([
        { oidc_sub: `${AIP_PREFIX}${account.did}`, uid: account.uid },
      ]);
      expect(await usersNamed(identity.handle)).toEqual([]);
      expect(await userOf(account.uid)).toEqual(row);
    });

    test("prefers the mapping with the bare subject", async () => {
      const prefixed = await seedAccount({ email: null, mapping: "prefixed" });
      const bare = await insertUser({
        hname: "Bare",
        username: `bare-${nextLabel()}.test.invalid`,
        email: null,
      });
      await insertMapping(prefixed.did, bare);
      const identity = await createTestIdentity({ did: prefixed.did });
      plc.setDocument(identity.did, identity.document);

      const responses = [
        await login({}, await tokenFor(identity)),
        await login({}, await tokenFor(identity)),
        await login({}, await tokenFor(identity)),
      ];

      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200,
      ]);
      expect(responses.map((response) => response.body.uid)).toEqual([
        bare,
        bare,
        bare,
      ]);
      expect(await mappingsOf(prefixed.did)).toEqual([
        { oidc_sub: prefixed.did, uid: bare },
        { oidc_sub: `${AIP_PREFIX}${prefixed.did}`, uid: prefixed.uid },
      ]);
    });

    test("names a new account after the DID document and not after the body", async () => {
      const identity = await newIdentity();
      const posted = `posted-${nextLabel()}.test.invalid`;

      const response = await login(
        { handle: posted, displayName: "Shown name" },
        await tokenFor(identity)
      );

      expect(response.status).toBe(200);
      expect(await userOf(response.body.uid)).toEqual({
        uid: response.body.uid,
        hname: "Shown name",
        username: identity.handle,
        email: null,
        is_owner: true,
      });
      expect(await usersNamed(posted)).toEqual([]);
    });

    test("names an account without a handle after its DID", async () => {
      const identity = await newIdentity({ handle: null });

      const response = await login(
        { handle: `posted-${nextLabel()}.test.invalid` },
        await tokenFor(identity)
      );

      expect(response.status).toBe(200);
      expect(await userOf(response.body.uid)).toEqual({
        uid: response.body.uid,
        hname: identity.did,
        username: identity.did,
        email: null,
        is_owner: true,
      });
    });

    test("stores a handle of 200 characters as a username of 128", async () => {
      const did = randomDidPlc();
      const handle = [
        `${did.slice(-8)}${"a".repeat(55)}`,
        "b".repeat(63),
        "c".repeat(59),
        "test.invalid",
      ].join(".");
      const identity = await createTestIdentity({ did, handle });
      plc.setDocument(identity.did, identity.document);
      subjects.push(did);

      const response = await login({}, await tokenFor(identity));

      expect(handle).toHaveLength(200);
      expect(response.status).toBe(200);
      expect(await userOf(response.body.uid)).toEqual({
        uid: response.body.uid,
        hname: handle,
        username: handle.slice(0, 128),
        email: null,
        is_owner: true,
      });
    });
  });

  describe("email", () => {
    test("stores the posted address on a new account", async () => {
      const identity = await newIdentity();
      const email = newEmail();

      const response = await login({ email }, await tokenFor(identity));

      expect(response.status).toBe(200);
      expect((await userOf(response.body.uid)).email).toBe(email);
    });

    test("stores an address of 256 characters and not one of 257", async () => {
      const identities = [await newIdentity(), await newIdentity()];
      const domain = `@${nextLabel()}.example.invalid`;
      const emails = [256, 257].map(
        (length) => `${"a".repeat(length - domain.length)}${domain}`
      );
      const warnings = jest.spyOn(logger, "warn");

      const responses = [
        await login({ email: emails[0] }, await tokenFor(identities[0])),
        await login({ email: emails[1] }, await tokenFor(identities[1])),
      ];

      expect(emails.map((email) => email.length)).toEqual([256, 257]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect((await userOf(responses[0].body.uid)).email).toBe(emails[0]);
      expect((await userOf(responses[1].body.uid)).email).toBeNull();
      expect(logged(warnings, EMAIL_NOT_STORED_LOG)).toEqual([]);
    });

    test("does not store an address without an at sign", async () => {
      const identity = await newIdentity();

      const response = await login(
        { email: `not-an-address-${nextLabel()}` },
        await tokenFor(identity)
      );

      expect(response.status).toBe(200);
      expect((await userOf(response.body.uid)).email).toBeNull();
    });

    test("never stores the handle as the address", async () => {
      const identity = await newIdentity();

      const response = await login(
        legacyBody(identity),
        await tokenFor(identity)
      );

      expect(response.status).toBe(200);
      expect(await userOf(response.body.uid)).toEqual({
        uid: response.body.uid,
        hname: identity.handle,
        username: identity.handle,
        email: null,
        is_owner: true,
      });
    });

    test("cannot take over an account that has a mapping", async () => {
      const victim = await seedAccount({ email: newEmail(), mapping: "bare" });
      const zid = await insertConversation(victim.uid);
      const victimRow = await userOf(victim.uid);
      const attacker = await newIdentity();

      const response = await login(
        {
          email: String(victim.email),
          handle: victim.handle,
          displayName: "Attacker",
        },
        await tokenFor(attacker)
      );

      expect(response.status).toBe(200);
      expect(response.body.uid).not.toBe(victim.uid);
      expect(claimsOf(response)).toMatchObject({
        sub: attacker.did,
        uid: response.body.uid,
      });
      expect(await mappingsOf(victim.did)).toEqual([
        { oidc_sub: victim.did, uid: victim.uid },
      ]);
      expect(await mappingsTo(victim.uid)).toEqual([
        { oidc_sub: victim.did, uid: victim.uid },
      ]);
      expect(await userOf(victim.uid)).toEqual(victimRow);
      expect(await userOf(response.body.uid)).toEqual({
        uid: response.body.uid,
        hname: "Attacker",
        username: attacker.handle,
        email: null,
        is_owner: true,
      });
      expect(
        await rows("SELECT owner FROM conversations WHERE zid = $1", [zid])
      ).toEqual([{ owner: victim.uid }]);
    });

    test("cannot take over an account that has no mapping", async () => {
      const victim = await seedAccount({ email: newEmail(), mapping: "none" });
      const victimRow = await userOf(victim.uid);
      const attacker = await newIdentity();

      const response = await login(
        { email: String(victim.email), handle: victim.handle },
        await tokenFor(attacker)
      );

      expect(response.status).toBe(200);
      expect(response.body.uid).not.toBe(victim.uid);
      expect(await mappingsTo(victim.uid)).toEqual([]);
      expect(await userOf(victim.uid)).toEqual(victimRow);
      expect((await userOf(response.body.uid)).email).toBeNull();
      expect(await mappingsOf(attacker.did)).toEqual([
        { oidc_sub: attacker.did, uid: response.body.uid },
      ]);
    });

    test("does not store an address another account has in another case", async () => {
      const label = nextLabel();
      const victim = await seedAccount({
        email: `Owner-${label}@Example.invalid`,
        mapping: "none",
      });
      const attacker = await newIdentity();

      const response = await login(
        { email: `owner-${label}@example.invalid` },
        await tokenFor(attacker)
      );

      expect(response.status).toBe(200);
      expect(response.body.uid).not.toBe(victim.uid);
      expect((await userOf(response.body.uid)).email).toBeNull();
      expect((await userOf(victim.uid)).email).toBe(victim.email);
    });

    test("answers 200 without the address when another account takes it at the same moment", async () => {
      const identity = await newIdentity();
      const email = newEmail();
      const taker = `taker-${nextLabel()}.test.invalid`;
      const warnings = jest.spyOn(logger, "warn");

      const response = await whileHolding(
        async (holder) => {
          const created = await holder.query(
            "INSERT INTO users (hname, username, email, is_owner) VALUES ($1, $1, $2, true) RETURNING uid",
            [taker, email]
          );
          uids.push(created.rows[0].uid);
        },
        async () => login({ email }, await tokenFor(identity))
      );

      expect(response.status).toBe(200);
      expect((await userOf(response.body.uid)).email).toBeNull();
      expect((await usersNamed(taker)).map((row) => row.email)).toEqual([
        email,
      ]);
      expect(logged(warnings, EMAIL_NOT_STORED_LOG)).toEqual([
        { uid: response.body.uid, code: "23505" },
      ]);
    });
  });

  describe("simultaneous first logins", () => {
    test("give two requests for one account the same new account", async () => {
      const identity = await newIdentity();
      const tokens = [await tokenFor(identity), await tokenFor(identity)];

      const responses = await Promise.all(
        tokens.map((token) => login({}, token))
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses[1].body.uid).toBe(responses[0].body.uid);
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: responses[0].body.uid },
      ]);
      expect((await usersNamed(identity.handle)).map((row) => row.uid)).toEqual(
        [responses[0].body.uid]
      );
    });

    test("give a request with proof and one without the same new account", async () => {
      setMode("optional");
      const identity = await newIdentity();
      const token = await tokenFor(identity);

      const responses = await Promise.all([
        login({}, token),
        login(legacyBody(identity)),
      ]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses[1].body.uid).toBe(responses[0].body.uid);
      expect(responses.map((response) => claimsOf(response).proof)).toEqual([
        PROOF,
        undefined,
      ]);
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: responses[0].body.uid },
      ]);
      expect((await usersNamed(identity.handle)).map((row) => row.uid)).toEqual(
        [responses[0].body.uid]
      );
    });

    test("wait for the lock on the account and create nothing before they hold it", async () => {
      const identity = await newIdentity();
      let createdWhileWaiting: unknown[] = [];

      const response = await whileHolding(
        async (holder) => {
          await holder.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [identity.did]
          );
        },
        async () => login({}, await tokenFor(identity)),
        async () => {
          createdWhileWaiting = [
            ...(await mappingsOf(identity.did)),
            ...(await usersNamed(identity.handle)),
          ];
        }
      );

      expect(createdWhileWaiting).toEqual([]);
      expect(response.status).toBe(200);
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: response.body.uid },
      ]);
    });

    test("answer with the account another session mapped without taking the lock", async () => {
      const identity = await newIdentity();
      const other = `other-session-${nextLabel()}.test.invalid`;
      let mapped = 0;

      const response = await whileHolding(
        async (holder) => {
          const created = await holder.query(
            "INSERT INTO users (hname, username, is_owner) VALUES ($1, $1, true) RETURNING uid",
            [other]
          );
          mapped = created.rows[0].uid;
          uids.push(mapped);
          await holder.query(
            "INSERT INTO oidc_user_mappings (oidc_sub, uid) VALUES ($1, $2)",
            [identity.did, mapped]
          );
        },
        async () => login({ email: newEmail() }, await tokenFor(identity))
      );

      expect(response.status).toBe(200);
      expect(response.body.uid).toBe(mapped);
      expect(claimsOf(response)).toMatchObject({
        sub: identity.did,
        uid: mapped,
        proof: PROOF,
      });
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: mapped },
      ]);
      expect(await usersNamed(identity.handle)).toEqual([]);
      expect((await userOf(mapped)).email).toBeNull();
    });
  });

  describe("when proof is optional", () => {
    beforeEach(() => {
      setMode("optional");
    });

    test("issues a token without the proof for a body without a token", async () => {
      const identity = await newIdentity();
      const infos = jest.spyOn(logger, "info");
      const warnings = jest.spyOn(logger, "warn");

      const response = await login(
        legacyBody(identity, { displayName: "Shown name" })
      );

      expect(response.status).toBe(200);
      const claims = claimsOf(response);
      expect(claims).toMatchObject({
        sub: identity.did,
        uid: response.body.uid,
        type: "atproto_admin",
      });
      expect(Object.keys(claims)).not.toContain("proof");
      expect(await mappingsOf(identity.did)).toEqual([
        { oidc_sub: identity.did, uid: response.body.uid },
      ]);
      expect(await usersNamed(identity.handle)).toEqual([
        {
          uid: response.body.uid,
          hname: "Shown name",
          username: identity.handle,
          email: null,
          is_owner: true,
        },
      ]);
      expect(logged(infos, LOGIN_LOG)).toEqual([]);
      expect(logged(warnings, UNPROVEN_LOGIN_LOG)).toEqual([
        {
          did: identity.did,
          uid: response.body.uid,
          proof: false,
          mode: "optional",
        },
      ]);
    });

    test("issues a token that carries the proof for a valid token", async () => {
      const identity = await newIdentity();

      const response = await login({}, await tokenFor(identity));

      expect(response.status).toBe(200);
      expect(claimsOf(response)).toMatchObject({
        sub: identity.did,
        proof: PROOF,
      });
    });

    test.each<{ name: string; body: (identity: TestIdentity) => LoginBody }>([
      { name: "an empty body", body: () => ({}) },
      {
        name: "a body without a DID",
        body: (identity) => ({ handle: String(identity.handle) }),
      },
      {
        name: "a body without a handle",
        body: (identity) => ({ did: identity.did }),
      },
    ])("answers 400 for $name when there is no proof", async ({ body }) => {
      const identity = await newIdentity();

      const responses = [
        await login(body(identity)),
        await login(body(identity), await forgedTokenFor(identity)),
      ];

      for (const response of responses) {
        expect(response.status).toBe(400);
        expect(response.body).toEqual(
          failureBody("polis_err_atproto_login_missing_params", 400)
        );
      }
      expect(await mappingsOf(identity.did)).toEqual([]);
      expect(await usersNamed(identity.handle)).toEqual([]);
    });

    test.each<{
      name: string;
      reason: string;
      claimed: (identity: TestIdentity) => string;
      token: (identity: TestIdentity) => Promise<string>;
    }>([
      {
        name: "a token signed with another key",
        reason: "bad_signature",
        claimed: (identity) => identity.did,
        token: (identity) => forgedTokenFor(identity),
      },
      {
        name: "an expired token",
        reason: "expired",
        claimed: (identity) => identity.did,
        token: (identity) => {
          const now = Math.floor(Date.now() / 1000);
          return tokenFor(identity, { iat: now - 600, exp: now - 300 });
        },
      },
      {
        name: "a token for creating conversations",
        reason: "bad_lxm",
        claimed: (identity) => identity.did,
        token: (identity) =>
          tokenFor(identity, { lxm: CREATE_CONVERSATION_LXM }),
      },
      {
        name: "a did:web issuer whose document cannot be fetched",
        reason: "did_resolution_failed",
        claimed: () => "did:web:admin.test.invalid",
        token: (identity) =>
          tokenFor(identity, { iss: "did:web:admin.test.invalid" }),
      },
      {
        name: "a DID directory that cannot be asked",
        reason: "did_resolution_failed",
        claimed: (identity) => identity.did,
        token: (identity) => {
          plc.setResponder(identity.did, () =>
            jsonResponse({ message: "unavailable" }, { status: 500 })
          );
          return tokenFor(identity);
        },
      },
    ])(
      "handles $name as a login without proof and logs one warning",
      async ({ reason, claimed, token }) => {
        const identity = await newIdentity();
        const warnings = jest.spyOn(logger, "warn");

        const response = await login(
          legacyBody(identity),
          await token(identity)
        );

        expect(response.status).toBe(200);
        const claims = claimsOf(response);
        expect(claims).toMatchObject({
          sub: identity.did,
          uid: response.body.uid,
        });
        expect(Object.keys(claims)).not.toContain("proof");
        expect(logged(warnings, REFUSED_PROOF_LOG)).toEqual([
          { did: claimed(identity), reason },
        ]);
        expect(await mappingsOf(identity.did)).toEqual([
          { oidc_sub: identity.did, uid: response.body.uid },
        ]);
      }
    );

    test("handles a header that is not a bearer token as a login without proof", async () => {
      const identity = await newIdentity();
      const warnings = jest.spyOn(logger, "warn");

      const response = await agent
        .post(ROUTE)
        .set("Authorization", `Basic ${await tokenFor(identity)}`)
        .send(legacyBody(identity));
      uids.push(response.body.uid);

      expect(response.status).toBe(200);
      expect(Object.keys(claimsOf(response))).not.toContain("proof");
      expect(logged(warnings, REFUSED_PROOF_LOG)).toEqual([
        { did: null, reason: "not_a_bearer_token" },
      ]);
    });

    test("handles a token that was already used as a login without proof", async () => {
      const identity = await newIdentity();
      const token = await tokenFor(identity);
      const warnings = jest.spyOn(logger, "warn");

      const first = await login(legacyBody(identity), token);
      const second = await login(legacyBody(identity), token);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body.uid).toBe(first.body.uid);
      expect(claimsOf(first).proof).toBe(PROOF);
      expect(Object.keys(claimsOf(second))).not.toContain("proof");
      expect(logged(warnings, REFUSED_PROOF_LOG)).toEqual([
        { did: identity.did, reason: "token_reused" },
      ]);
    });

    test.each<{
      name: string;
      stored: (victim: SeededAccount) => string;
      body: (victim: SeededAccount) => LoginBody;
    }>([
      {
        name: "the address of another account",
        stored: () => newEmail(),
        body: (victim) => ({ email: String(victim.email) }),
      },
      {
        name: "a handle that another account has as its address",
        stored: () => `stored-${nextLabel()}.test.invalid`,
        body: (victim) => ({ handle: String(victim.email) }),
      },
    ])(
      "gives a body with $name an account of its own",
      async ({ stored, body }) => {
        const victim = await seedAccount({ email: null, mapping: "bare" });
        await rows("UPDATE users SET email = $2 WHERE uid = $1", [
          victim.uid,
          stored(victim),
        ]);
        const victimRow = await userOf(victim.uid);
        victim.email = victimRow.email;
        const attacker = await newIdentity();

        const response = await login({
          ...legacyBody(attacker),
          ...body(victim),
        });

        expect(response.status).toBe(200);
        expect(response.body.uid).not.toBe(victim.uid);
        expect(await mappingsOf(victim.did)).toEqual([
          { oidc_sub: victim.did, uid: victim.uid },
        ]);
        expect(await mappingsTo(victim.uid)).toEqual([
          { oidc_sub: victim.did, uid: victim.uid },
        ]);
        expect(await userOf(victim.uid)).toEqual(victimRow);
        expect((await userOf(response.body.uid)).email).toBeNull();
        expect(await mappingsOf(attacker.did)).toEqual([
          { oidc_sub: attacker.did, uid: response.body.uid },
        ]);
      }
    );

    test("stores no address for a body without one", async () => {
      const identity = await newIdentity();

      const response = await login(legacyBody(identity));

      expect(response.status).toBe(200);
      expect(await userOf(response.body.uid)).toEqual({
        uid: response.body.uid,
        hname: identity.handle,
        username: identity.handle,
        email: null,
        is_owner: true,
      });
    });

    test.each<{ name: string; handle: () => string }>([
      {
        name: "200 characters",
        handle: () => `${nextLabel()}.`.padEnd(200, "h"),
      },
      {
        name: "129 characters that take 253 code units",
        handle: () => `${"\u{1D49C}".repeat(124)}abcde`,
      },
    ])(
      "stores a posted handle of $name as a username of 128",
      async ({ handle }) => {
        const identity = await newIdentity();
        const posted = handle();

        const response = await login({ did: identity.did, handle: posted });

        expect(Array.from(posted).length).toBeGreaterThan(128);
        expect(response.status).toBe(200);
        expect(await userOf(response.body.uid)).toEqual({
          uid: response.body.uid,
          hname: posted,
          username: Array.from(posted).slice(0, 128).join(""),
          email: null,
          is_owner: true,
        });
      }
    );
  });

  describe("admin token", () => {
    async function signIn(mode: string, proven: boolean): Promise<string> {
      setMode(mode);
      const identity = await newIdentity();
      const response = await login(
        legacyBody(identity),
        proven ? await tokenFor(identity) : undefined
      );
      expect(response.status).toBe(200);
      setMode("required");
      return String(response.body.token);
    }

    async function conversationsWith(token: string): Promise<ApiResponse> {
      const response = await agent
        .get("/api/v3/conversations")
        .set("Authorization", `Bearer ${token}`);
      return { status: response.status, body: response.body };
    }

    test("without the proof is refused when proof is required and accepted when it is optional", async () => {
      const token = await signIn("optional", false);

      setMode("required");
      const required = await conversationsWith(token);
      const recent = await agent
        .get("/api/v3/conversations/recently_started")
        .set("Authorization", `Bearer ${token}`);
      setMode("optional");
      const optional = await conversationsWith(token);

      expect(required.status).toBe(401);
      expect(required.body).toEqual({ error: "Invalid admin token" });
      expect(recent.status).toBe(401);
      expect(recent.body).toEqual({ error: "Invalid admin token" });
      expect(optional.status).toBe(200);
      expect(optional.body).toEqual([]);
    });

    test("with the proof is accepted whether proof is required or optional", async () => {
      const token = await signIn("required", true);

      setMode("required");
      const required = await conversationsWith(token);
      setMode("optional");
      const optional = await conversationsWith(token);

      expect(jwt.decode(token)).toMatchObject({ proof: PROOF });
      expect([required.status, optional.status]).toEqual([200, 200]);
      expect([required.body, optional.body]).toEqual([[], []]);
    });

    test("without the proof cannot store a statement when proof is required", async () => {
      const owner = await signIn("required", true);
      const stale = await signIn("optional", false);
      const created = await agent
        .post("/api/v3/conversations")
        .set("Authorization", `Bearer ${owner}`)
        .send({ topic: `Login ${nextLabel()}`, description: "" });
      const conversationId = created.body.conversation_id;
      const found = await rows<{ zid: number }>(
        "SELECT zid FROM zinvites WHERE zinvite = $1",
        [conversationId]
      );
      zids.push(...found.map((row) => row.zid));
      const txt = `Statement from a stale tab ${nextLabel()}`;

      const response = await agent
        .post("/api/v3/comments")
        .set("Authorization", `Bearer ${stale}`)
        .send({ conversation_id: conversationId, txt, is_seed: true });

      expect(created.status).toBe(200);
      expect(found).toHaveLength(1);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Invalid admin token" });
      expect(
        await rows("SELECT tid FROM comments WHERE zid = $1 OR txt = $2", [
          found[0].zid,
          txt,
        ])
      ).toEqual([]);
      expect(
        await rows("SELECT pid FROM participants WHERE zid = $1", [
          found[0].zid,
        ])
      ).toEqual([]);
    });
  });

  describe("logging", () => {
    test("writes one line for a login, with the account, the proof and the mode", async () => {
      const identity = await newIdentity();
      const infos = jest.spyOn(logger, "info");

      const response = await login(
        { email: newEmail() },
        await tokenFor(identity)
      );

      expect(response.status).toBe(200);
      expect(logged(infos, LOGIN_LOG)).toEqual([
        {
          did: identity.did,
          uid: response.body.uid,
          proof: true,
          mode: "required",
        },
      ]);
      expect(
        infos.mock.calls.filter(([first]) =>
          String(first).startsWith(LOGIN_LOG)
        )
      ).toHaveLength(1);
    });

    test("never writes a token or an address", async () => {
      const victim = await seedAccount({ email: newEmail(), mapping: "bare" });
      const identities = [
        await newIdentity(),
        await newIdentity(),
        await newIdentity(),
        await newIdentity(),
      ];
      const tokens = [
        await tokenFor(identities[0]),
        await forgedTokenFor(identities[1]),
        await tokenFor(identities[2]),
        await forgedTokenFor(identities[3]),
      ];
      const emails = [newEmail(), newEmail(), newEmail(), newEmail()];
      const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
        jest.spyOn(logger, level)
      );
      const stdout = jest.spyOn(process.stdout, "write");
      const stderr = jest.spyOn(process.stderr, "write");

      const accepted = await login({ email: emails[0] }, tokens[0]);
      const reused = await login({ email: emails[0] }, tokens[0]);
      const refused = await login({ email: emails[1] }, tokens[1]);
      const mismatched = await login(
        legacyBody(identities[3], { email: emails[2] }),
        tokens[2]
      );
      const taken = await login(
        { email: String(victim.email) },
        await tokenFor(identities[2])
      );
      setMode("optional");
      const observed = await login(
        legacyBody(identities[3], { email: emails[3] }),
        tokens[3]
      );
      const unproven = await login(
        legacyBody(identities[1], { email: emails[1] })
      );

      // In development mode every request body is logged at debug level.
      const written = inspect(
        [...spies, stdout, stderr].map((spy) =>
          spy.mock.calls.filter(
            ([first]) => (first as unknown) !== "middleware_log_request_body"
          )
        ),
        { depth: 10, maxArrayLength: null, maxStringLength: null }
      );
      for (const spy of [...spies, stdout, stderr]) {
        spy.mockRestore();
      }
      expect([
        accepted.status,
        reused.status,
        refused.status,
        mismatched.status,
        taken.status,
        observed.status,
        unproven.status,
      ]).toEqual([200, 401, 401, 400, 200, 200, 200]);
      expect(written).toContain(LOGIN_LOG);
      expect(written).toContain(REFUSED_PROOF_LOG);
      expect(written).toContain("polis_err_atproto_auth_invalid");
      expect(written).toContain("polis_err_atproto_auth_replayed");
      expect(written).toContain("polis_err_atproto_login_did_mismatch");
      for (const secret of [
        ...tokens,
        String(accepted.body.token),
        String(observed.body.token),
      ]) {
        const [header, payload, signature] = secret.split(".");
        expect(written).not.toContain(secret);
        expect(written).not.toContain(signature);
        expect(written).not.toContain(payload);
        expect(written).not.toContain(`${header}.`);
      }
      for (const email of [...emails, String(victim.email)]) {
        expect(written).not.toContain(email);
      }
    });
  });
});

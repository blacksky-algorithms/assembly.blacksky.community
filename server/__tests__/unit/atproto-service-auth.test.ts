import { createHash } from "node:crypto";
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
import {
  ServiceAuthError,
  atprotoServiceAuth,
  verifyServiceJwt,
} from "../../src/auth/atproto-service-auth";
import Config from "../../src/config";
import logger from "../../src/utils/logger";
import {
  PlcFetchMock,
  TestIdentity,
  TestKeypair,
  buildDidDocument,
  buildServiceAuthClaims,
  createTestIdentity,
  didWebDocumentUrl,
  encodeJwtSegment,
  generateTestKeypair,
  installPlcFetchMock,
  jsonResponse,
  randomDidWeb,
  signServiceJwt,
} from "../setup/atproto-test-helpers";

const PLC_URL = "https://plc.test.invalid";
const AUD = "did:web:assembly.test.invalid";
const LXM = "community.blacksky.assembly.createConversation";
const NOW = 1_800_000_000;
const MAX_TOKEN_BYTES = 4096;
const SIGNATURE_LENGTH = 86;
const CURVE_ORDERS = {
  secp256k1: BigInt(
    "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
  ),
  p256: BigInt(
    "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
  ),
};

type Claims = Record<string, unknown>;

function claimsFor(identity: TestIdentity, overrides: Claims = {}): Claims {
  const claims = {
    ...buildServiceAuthClaims({
      iss: identity.did,
      aud: AUD,
      lxm: LXM,
      nowSeconds: NOW,
      jti: "jti-fixed-value",
    }),
    ...overrides,
  };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[name];
  }
  return claims;
}

function verify(token: string) {
  return verifyServiceJwt(token, { aud: AUD, lxm: LXM, nowSeconds: NOW });
}

function tokenIdOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function rejection(promise: Promise<unknown>): Promise<ServiceAuthError> {
  try {
    await promise;
  } catch (err) {
    return err as ServiceAuthError;
  }
  throw new Error("expected the promise to reject");
}

function expectInvalid(err: ServiceAuthError, reason: string) {
  expect(err).toBeInstanceOf(ServiceAuthError);
  expect({
    code: err.code,
    status: err.status,
    reason: err.message,
  }).toEqual({
    code: "polis_err_atproto_auth_invalid",
    status: 401,
    reason,
  });
}

function withHighS(token: string, curve: keyof typeof CURVE_ORDERS): string {
  const [header, payload, signature] = token.split(".");
  const bytes = Buffer.from(signature, "base64url");
  const s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
  const highS = (CURVE_ORDERS[curve] - s).toString(16).padStart(64, "0");
  const malleated = Buffer.concat([
    bytes.subarray(0, 32),
    Buffer.from(highS, "hex"),
  ]);
  return `${header}.${payload}.${malleated.toString("base64url")}`;
}

async function signTokenOfLength(
  identity: TestIdentity,
  length: number
): Promise<string> {
  for (const kid of ["", "a", "ab"]) {
    const header = kid === "" ? {} : { kid };
    const headerLength = encodeJwtSegment({
      typ: "JWT",
      alg: identity.keypair.jwtAlg,
      ...header,
    }).length;
    for (let padding = 0; padding <= length; padding += 1) {
      const claims = claimsFor(identity, { pad: "p".repeat(padding) });
      const total =
        headerLength + encodeJwtSegment(claims).length + SIGNATURE_LENGTH + 2;
      if (total === length) {
        return signServiceJwt({ keypair: identity.keypair, claims, header });
      }
      if (total > length) break;
    }
  }
  throw new Error(`could not build a token of ${length} bytes`);
}

describe("atproto service auth", () => {
  let previousPlcUrl: string | undefined;
  let previousServiceDid: string | undefined;
  let plc: PlcFetchMock;
  let alice: TestIdentity;

  beforeAll(() => {
    previousPlcUrl = process.env.ATPROTO_PLC_URL;
    previousServiceDid = process.env.ATPROTO_SERVICE_DID;
    process.env.ATPROTO_PLC_URL = PLC_URL;
    process.env.ATPROTO_SERVICE_DID = AUD;
  });

  afterAll(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    };
    restore("ATPROTO_PLC_URL", previousPlcUrl);
    restore("ATPROTO_SERVICE_DID", previousServiceDid);
  });

  beforeEach(async () => {
    plc = installPlcFetchMock();
    alice = await createTestIdentity({
      curve: "secp256k1",
      handle: "alice.test.invalid",
    });
    plc.setDocument(alice.did, alice.document);
  });

  afterEach(() => {
    plc.restore();
    jest.restoreAllMocks();
  });

  describe("verifyServiceJwt accepts", () => {
    test("a valid ES256K token", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const verified = await verify(token);

      expect(alice.keypair.jwtAlg).toBe("ES256K");
      expect(verified).toEqual({
        did: alice.did,
        handle: "alice.test.invalid",
        jti: "jti-fixed-value",
        tokenId: tokenIdOf(token),
      });
      expect(verified.tokenId).toMatch(/^[0-9a-f]{64}$/);
      expect(plc.requests.map((request) => request.url)).toEqual([
        `${PLC_URL}/${alice.did}`,
      ]);
    });

    test("a valid ES256 token", async () => {
      const bob = await createTestIdentity({
        curve: "p256",
        handle: "bob.test.invalid",
      });
      plc.setDocument(bob.did, bob.document);
      const token = await signServiceJwt({
        keypair: bob.keypair,
        claims: claimsFor(bob),
      });

      const verified = await verify(token);

      expect(bob.keypair.jwtAlg).toBe("ES256");
      expect(verified).toEqual({
        did: bob.did,
        handle: "bob.test.invalid",
        jti: "jti-fixed-value",
        tokenId: tokenIdOf(token),
      });
    });

    test("a token without jti, iat and typ, from an account without a handle", async () => {
      const carol = await createTestIdentity({ handle: null });
      plc.setDocument(carol.did, carol.document);
      const token = await signServiceJwt({
        keypair: carol.keypair,
        claims: claimsFor(carol, { jti: undefined, iat: undefined }),
        header: { typ: undefined },
      });

      const verified = await verify(token);

      expect(verified).toEqual({
        did: carol.did,
        handle: null,
        jti: null,
        tokenId: tokenIdOf(token),
      });
    });

    test.each<{ name: string; overrides: Claims }>([
      { name: "exp 10 seconds in the past", overrides: { exp: NOW - 10 } },
      { name: "exp 300 seconds ahead", overrides: { exp: NOW + 300 } },
      { name: "iat 60 seconds ahead", overrides: { iat: NOW + 60 } },
      { name: "nbf 10 seconds ahead", overrides: { nbf: NOW + 10 } },
      { name: "a fractional exp", overrides: { exp: NOW + 59.5 } },
    ])("$name", async ({ overrides }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, overrides),
      });

      const verified = await verify(token);

      expect(verified.did).toBe(alice.did);
    });

    test("a token of exactly 4096 bytes", async () => {
      const token = await signTokenOfLength(alice, MAX_TOKEN_BYTES);
      expect(Buffer.byteLength(token, "utf8")).toBe(4096);

      const verified = await verify(token);

      expect(verified.did).toBe(alice.did);
    });

    test("a token checked against the current time", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: buildServiceAuthClaims({
          iss: alice.did,
          aud: AUD,
          lxm: LXM,
          jti: "jti-current-time",
        }),
      });

      const verified = await verifyServiceJwt(token, { aud: AUD, lxm: LXM });

      expect(verified).toEqual({
        did: alice.did,
        handle: "alice.test.invalid",
        jti: "jti-current-time",
        tokenId: tokenIdOf(token),
      });
    });
  });

  describe("verifyServiceJwt token id", () => {
    test("is the same for the same token and differs between tokens", async () => {
      const first = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { jti: "jti-first" }),
      });
      const second = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { jti: "jti-second" }),
      });

      const results = [
        await verify(first),
        await verify(first),
        await verify(second),
      ];

      expect(results.map((result) => result.tokenId)).toEqual([
        tokenIdOf(first),
        tokenIdOf(first),
        tokenIdOf(second),
      ]);
      expect(tokenIdOf(first)).not.toBe(tokenIdOf(second));
    });

    test("differs between two tokens that carry no jti", async () => {
      const first = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { jti: undefined, exp: NOW + 30 }),
      });
      const second = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { jti: undefined, exp: NOW + 31 }),
      });

      const results = [await verify(first), await verify(second)];

      expect(results.map((result) => result.jti)).toEqual([null, null]);
      expect(results[0].tokenId).toBe(tokenIdOf(first));
      expect(results[1].tokenId).toBe(tokenIdOf(second));
      expect(results[0].tokenId).not.toBe(results[1].tokenId);
    });
  });

  describe("verifyServiceJwt with a list of admitted issuers", () => {
    function verifyListed(token: string, listed: string[]) {
      const admitIssuer = jest.fn((did: string) => listed.includes(did));
      return {
        admitIssuer,
        result: verifyServiceJwt(token, {
          aud: AUD,
          lxm: LXM,
          nowSeconds: NOW,
          admitIssuer,
        }),
      };
    }

    test("refuses an issuer that is not listed without asking the directory", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const { admitIssuer, result } = verifyListed(token, []);
      const err = await rejection(result);

      expect(err).toBeInstanceOf(ServiceAuthError);
      expect({
        code: err.code,
        status: err.status,
        reason: err.message,
        did: err.did,
      }).toEqual({
        code: "polis_err_atproto_conversation_not_eligible",
        status: 403,
        reason: "issuer_not_listed",
        did: alice.did,
      });
      expect(admitIssuer.mock.calls).toEqual([[alice.did]]);
      expect(plc.requests).toHaveLength(0);
    });

    test("refuses an unlisted issuer whatever the signature is", async () => {
      const stranger = await generateTestKeypair("secp256k1");
      const token = await signServiceJwt({
        keypair: stranger,
        claims: claimsFor(alice),
      });

      const err = await rejection(verifyListed(token, []).result);

      expect(err.code).toBe("polis_err_atproto_conversation_not_eligible");
      expect(plc.requests).toHaveLength(0);
    });

    test("verifies a listed issuer as usual", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const verified = await verifyListed(token, [alice.did]).result;

      expect(verified.did).toBe(alice.did);
      expect(plc.requests).toHaveLength(1);
    });

    test("still refuses a forged token that names a listed issuer", async () => {
      const stranger = await generateTestKeypair("secp256k1");
      const token = await signServiceJwt({
        keypair: stranger,
        claims: claimsFor(alice),
      });

      const err = await rejection(verifyListed(token, [alice.did]).result);

      expectInvalid(err, "bad_signature");
    });

    test("checks the claims before the list", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { aud: "did:web:other.test.invalid" }),
      });

      const { admitIssuer, result } = verifyListed(token, []);
      const err = await rejection(result);

      expectInvalid(err, "bad_audience");
      expect(admitIssuer).not.toHaveBeenCalled();
    });
  });

  describe("verifyServiceJwt rejects before any request", () => {
    test.each<{ name: string; overrides: Claims; reason: string }>([
      {
        name: "a wrong aud",
        overrides: { aud: "did:web:other.test.invalid" },
        reason: "bad_audience",
      },
      {
        name: "a missing aud",
        overrides: { aud: undefined },
        reason: "bad_audience",
      },
      {
        name: "an aud list that contains the service",
        overrides: { aud: [AUD] },
        reason: "bad_audience",
      },
      {
        name: "an aud with a service fragment",
        overrides: { aud: `${AUD}#assembly` },
        reason: "bad_audience",
      },
      {
        name: "a missing lxm",
        overrides: { lxm: undefined },
        reason: "missing_lxm",
      },
      { name: "a null lxm", overrides: { lxm: null }, reason: "missing_lxm" },
      {
        name: "a wrong lxm",
        overrides: { lxm: "app.bsky.feed.getTimeline" },
        reason: "bad_lxm",
      },
      {
        name: "an lxm that extends the method",
        overrides: { lxm: `${LXM}.extra` },
        reason: "bad_lxm",
      },
      { name: "an lxm wildcard", overrides: { lxm: "*" }, reason: "bad_lxm" },
      { name: "an lxm list", overrides: { lxm: [LXM] }, reason: "bad_lxm" },
      {
        name: "an exp 301 seconds ahead",
        overrides: { exp: NOW + 301 },
        reason: "exp_too_far_ahead",
      },
      {
        name: "a missing exp",
        overrides: { exp: undefined },
        reason: "bad_exp",
      },
      {
        name: "an exp that is a string",
        overrides: { exp: String(NOW + 60) },
        reason: "bad_exp",
      },
      {
        name: "an iat 61 seconds ahead",
        overrides: { iat: NOW + 61 },
        reason: "iat_in_future",
      },
      {
        name: "an iat that is a string",
        overrides: { iat: String(NOW) },
        reason: "bad_iat",
      },
      {
        name: "an nbf 11 seconds ahead",
        overrides: { nbf: NOW + 11 },
        reason: "not_yet_valid",
      },
      {
        name: "an nbf that is a string",
        overrides: { nbf: String(NOW) },
        reason: "bad_nbf",
      },
      {
        name: "a jti that is a number",
        overrides: { jti: 12345 },
        reason: "bad_jti",
      },
      {
        name: "a missing iss",
        overrides: { iss: undefined },
        reason: "missing_iss",
      },
      {
        name: "an iss that is a number",
        overrides: { iss: 12345 },
        reason: "missing_iss",
      },
    ])("$name", async ({ overrides, reason }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, overrides),
      });

      const err = await rejection(verify(token));

      expectInvalid(err, reason);
      expect(plc.requests).toHaveLength(0);
    });

    test("a token without aud when the expected audience is not set", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { aud: undefined }),
      });

      const err = await rejection(
        verifyServiceJwt(token, {
          aud: undefined as unknown as string,
          lxm: LXM,
          nowSeconds: NOW,
        })
      );

      expectInvalid(err, "bad_audience");
      expect(plc.requests).toHaveLength(0);
    });

    test.each([
      { name: "11 seconds ago", exp: NOW - 11 },
      { name: "an hour ago", exp: NOW - 3600 },
    ])("a token that expired $name", async ({ exp }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { exp, iat: exp - 60 }),
      });

      const err = await rejection(verify(token));

      expect(err).toBeInstanceOf(ServiceAuthError);
      expect({
        code: err.code,
        status: err.status,
        reason: err.message,
      }).toEqual({
        code: "polis_err_atproto_auth_expired",
        status: 401,
        reason: "expired",
      });
      expect(plc.requests).toHaveLength(0);
    });

    test.each<{ name: string; issuer: (identity: TestIdentity) => string }>([
      {
        name: "with a fragment",
        issuer: (identity) => `${identity.did}#atproto_labeler`,
      },
      { name: "that is a did:web", issuer: () => "did:web:alice.test.invalid" },
      {
        name: "that is a did:key",
        issuer: (identity) => identity.keypair.didKey,
      },
      {
        name: "that is a did:plc in upper case",
        issuer: (identity) => identity.did.toUpperCase(),
      },
      { name: "that is not a DID", issuer: () => "alice.test.invalid" },
    ])("an iss $name", async ({ issuer }) => {
      const iss = issuer(alice);
      plc.setDocument(iss, { ...alice.document, id: iss });
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, { iss }),
      });

      const err = await rejection(verify(token));

      expect(err).toBeInstanceOf(ServiceAuthError);
      expect({
        code: err.code,
        status: err.status,
        reason: err.message,
      }).toEqual({
        code: "polis_err_atproto_unsupported_did",
        status: 400,
        reason: "unsupported_issuer",
      });
      expect(plc.requests).toHaveLength(0);
    });

    test("an unsupported iss before it looks at aud, lxm or exp", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, {
          iss: "did:web:alice.test.invalid",
          aud: "did:web:other.test.invalid",
          lxm: "app.bsky.feed.getTimeline",
          exp: NOW - 3600,
        }),
      });

      const err = await rejection(verify(token));

      expect({
        code: err.code,
        status: err.status,
        reason: err.message,
      }).toEqual({
        code: "polis_err_atproto_unsupported_did",
        status: 400,
        reason: "unsupported_issuer",
      });
      expect(plc.requests).toHaveLength(0);
    });

    test("a wrong aud before it looks at exp", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice, {
          aud: "did:web:other.test.invalid",
          exp: NOW - 3600,
        }),
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "bad_audience");
      expect(plc.requests).toHaveLength(0);
    });

    test.each([
      ["none", "unsupported_alg"],
      ["HS256", "unsupported_alg"],
      ["RS256", "unsupported_alg"],
      ["ES384", "unsupported_alg"],
      ["EdDSA", "unsupported_alg"],
      ["es256k", "unsupported_alg"],
      [undefined, "unsupported_alg"],
      [["ES256K"], "unsupported_alg"],
    ])("alg %p", async (alg, reason) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
        header: { alg },
      });

      const err = await rejection(verify(token));

      expectInvalid(err, reason);
      expect(plc.requests).toHaveLength(0);
    });

    test("alg none with an empty signature", async () => {
      const header = encodeJwtSegment({ typ: "JWT", alg: "none" });
      const payload = encodeJwtSegment(claimsFor(alice));

      const err = await rejection(verify(`${header}.${payload}.`));

      expectInvalid(err, "malformed_token");
      expect(plc.requests).toHaveLength(0);
    });

    test.each([["at+jwt"], ["refresh+jwt"], ["dpop+jwt"], ["AT+JWT"]])(
      "typ %s",
      async (typ) => {
        const token = await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
          header: { typ },
        });

        const err = await rejection(verify(token));

        expectInvalid(err, "forbidden_typ");
        expect(plc.requests).toHaveLength(0);
      }
    );

    test("a header with critical extensions", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
        header: { crit: ["exp"] },
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "unsupported_crit");
      expect(plc.requests).toHaveLength(0);
    });

    test("a token of 4097 bytes", async () => {
      const token = await signTokenOfLength(alice, MAX_TOKEN_BYTES + 1);
      expect(Buffer.byteLength(token, "utf8")).toBe(4097);

      const err = await rejection(verify(token));

      expectInvalid(err, "token_too_large");
      expect(plc.requests).toHaveLength(0);
    });

    test.each<{ name: string; mangle: (token: string) => string }>([
      { name: "an empty string", mangle: () => "" },
      {
        name: "two segments",
        mangle: (token) => token.split(".").slice(0, 2).join("."),
      },
      {
        name: "four segments",
        mangle: (token) => `${token}.${token.split(".")[2]}`,
      },
      {
        name: "an empty payload",
        mangle: (token) => token.replace(/\.[^.]+\./, ".."),
      },
      { name: "base64 padding", mangle: (token) => `${token}=` },
      { name: "standard base64 characters", mangle: (token) => `${token}+/` },
      { name: "a space", mangle: (token) => `${token} ` },
      { name: "a line break", mangle: (token) => `${token}\n` },
    ])("a token with $name", async ({ mangle }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(mangle(token)));

      expectInvalid(err, "malformed_token");
      expect(plc.requests).toHaveLength(0);
    });

    test("a token that is not a string", async () => {
      const err = await rejection(verify(undefined as unknown as string));

      expectInvalid(err, "malformed_token");
    });

    test("a signature whose encoding carries unused bits", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const lastCharacter = alphabet.indexOf(token.slice(-1));
      const variants = [1, 2, 3].map(
        (unusedBits) =>
          `${token.slice(0, -1)}${alphabet[lastCharacter + unusedBits]}`
      );
      const signatureBytes = (value: string) =>
        Buffer.from(value.split(".")[2], "base64url").toString("hex");

      const accepted = await verify(token);
      plc.requests.length = 0;
      const errors = [];
      for (const variant of variants) {
        errors.push(await rejection(verify(variant)));
      }

      expect(lastCharacter % 4).toBe(0);
      expect(accepted.did).toBe(alice.did);
      expect(variants.map(signatureBytes)).toEqual([
        signatureBytes(token),
        signatureBytes(token),
        signatureBytes(token),
      ]);
      for (const err of errors) {
        expectInvalid(err, "malformed_token");
      }
      expect(plc.requests).toHaveLength(0);
    });

    test.each([
      {
        name: "is not JSON",
        header: Buffer.from("not json").toString("base64url"),
      },
      { name: "is a JSON array", header: encodeJwtSegment(["ES256K"]) },
      { name: "is a JSON string", header: encodeJwtSegment("ES256K") },
      { name: "is JSON null", header: encodeJwtSegment(null) },
    ])("a header that $name", async ({ header }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      const [, payload, signature] = token.split(".");

      const err = await rejection(verify(`${header}.${payload}.${signature}`));

      expectInvalid(err, "malformed_header");
      expect(plc.requests).toHaveLength(0);
    });

    test.each([
      {
        name: "is not JSON",
        payload: Buffer.from("not json").toString("base64url"),
      },
      {
        name: "is a JSON array",
        payload: encodeJwtSegment(["not", "claims"]),
      },
      { name: "is JSON null", payload: encodeJwtSegment(null) },
    ])("a payload that $name", async ({ payload }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      const [header, , signature] = token.split(".");

      const err = await rejection(verify(`${header}.${payload}.${signature}`));

      expectInvalid(err, "malformed_payload");
      expect(plc.requests).toHaveLength(0);
    });
  });

  describe("verifyServiceJwt rejects a signature", () => {
    test("when the payload was changed after signing", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      const [header, , signature] = token.split(".");
      const payload = encodeJwtSegment(
        claimsFor(alice, { jti: "jti-other-value" })
      );

      const err = await rejection(verify(`${header}.${payload}.${signature}`));

      expectInvalid(err, "bad_signature");
      expect(plc.requests).toHaveLength(1);
    });

    test("when the issuer was changed to another account after signing", async () => {
      const mallory = await createTestIdentity();
      plc.setDocument(mallory.did, mallory.document);
      const token = await signServiceJwt({
        keypair: mallory.keypair,
        claims: claimsFor(mallory),
      });
      const [header, , signature] = token.split(".");
      const payload = encodeJwtSegment(claimsFor(alice));

      const err = await rejection(verify(`${header}.${payload}.${signature}`));

      expectInvalid(err, "bad_signature");
      expect(plc.requests.map((request) => request.url)).toEqual([
        `${PLC_URL}/${alice.did}`,
      ]);
    });

    test("when the header was changed after signing", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      const [, payload, signature] = token.split(".");
      const header = encodeJwtSegment({
        typ: "JWT",
        alg: "ES256K",
        kid: "added",
      });

      const err = await rejection(verify(`${header}.${payload}.${signature}`));

      expectInvalid(err, "bad_signature");
    });

    test("made with a key that is not in the DID document", async () => {
      const stranger = await generateTestKeypair("secp256k1");
      const token = await signServiceJwt({
        keypair: stranger,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "bad_signature");
      expect(plc.requests).toHaveLength(1);
    });

    test("with an ES256 header when the account key is secp256k1", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
        header: { alg: "ES256" },
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "alg_does_not_match_key");
      expect(plc.requests).toHaveLength(1);
    });

    test("with an ES256K header when the account key is P-256", async () => {
      const bob = await createTestIdentity({ curve: "p256" });
      plc.setDocument(bob.did, bob.document);
      const token = await signServiceJwt({
        keypair: bob.keypair,
        claims: claimsFor(bob),
        header: { alg: "ES256K" },
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "alg_does_not_match_key");
    });

    test.each<["secp256k1" | "p256"]>([["secp256k1"], ["p256"]])(
      "in the high-S form on %s",
      async (curve) => {
        const identity = await createTestIdentity({ curve });
        plc.setDocument(identity.did, identity.document);
        const token = await signServiceJwt({
          keypair: identity.keypair,
          claims: claimsFor(identity),
        });
        const malleated = withHighS(token, curve);

        const accepted = await verify(token);
        const err = await rejection(verify(malleated));

        expect(malleated).not.toBe(token);
        expect(accepted.did).toBe(identity.did);
        expectInvalid(err, "bad_signature");
      }
    );

    test.each([
      { name: "63 bytes", length: 63 },
      { name: "65 bytes", length: 65 },
      { name: "1 byte", length: 1 },
    ])("of $name", async ({ length }) => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      const [header, payload, signature] = token.split(".");
      const bytes = Buffer.concat([
        Buffer.from(signature, "base64url"),
        Buffer.alloc(1),
      ]).subarray(0, length);

      const err = await rejection(
        verify(`${header}.${payload}.${bytes.toString("base64url")}`)
      );

      expectInvalid(err, "bad_signature");
    });
  });

  describe("verifyServiceJwt and key rotation", () => {
    async function rotateKey(identity: TestIdentity): Promise<TestKeypair> {
      const rotated = await generateTestKeypair(identity.keypair.curve);
      plc.setDocument(
        identity.did,
        buildDidDocument({
          did: identity.did,
          multikey: rotated.multikey,
          handle: "alice-renamed.test.invalid",
        })
      );
      return rotated;
    }

    test("refreshes a stale cached key once and then accepts", async () => {
      await verify(
        await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
        })
      );
      expect(plc.requests).toHaveLength(1);
      const rotated = await rotateKey(alice);
      const token = await signServiceJwt({
        keypair: rotated,
        claims: claimsFor(alice),
      });

      const verified = await verify(token);

      expect(verified).toEqual({
        did: alice.did,
        handle: "alice-renamed.test.invalid",
        jti: "jti-fixed-value",
        tokenId: tokenIdOf(token),
      });
      expect(plc.requests).toHaveLength(2);

      await verify(token);

      expect(plc.requests).toHaveLength(2);
    });

    test("refreshes when the account moved to a key on the other curve", async () => {
      await verify(
        await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
        })
      );
      const rotated = await generateTestKeypair("p256");
      plc.setDocument(
        alice.did,
        buildDidDocument({ did: alice.did, multikey: rotated.multikey })
      );
      const token = await signServiceJwt({
        keypair: rotated,
        claims: claimsFor(alice),
      });

      const verified = await verify(token);

      expect(verified.did).toBe(alice.did);
      expect(plc.requests).toHaveLength(2);
    });

    test("stops accepting the old key after the refresh", async () => {
      const oldToken = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });
      await verify(oldToken);
      const rotated = await rotateKey(alice);
      await verify(
        await signServiceJwt({ keypair: rotated, claims: claimsFor(alice) })
      );

      const err = await rejection(verify(oldToken));

      expectInvalid(err, "bad_signature");
      expect(plc.requests).toHaveLength(2);
    });

    test("refreshes once and rejects when the key did not change", async () => {
      await verify(
        await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
        })
      );
      const stranger = await generateTestKeypair("secp256k1");
      const forged = await signServiceJwt({
        keypair: stranger,
        claims: claimsFor(alice),
      });

      const first = await rejection(verify(forged));
      const second = await rejection(verify(forged));

      expectInvalid(first, "bad_signature");
      expectInvalid(second, "bad_signature");
      expect(plc.requests).toHaveLength(2);
    });

    test("accepts two requests that arrive while the rotated key is being fetched", async () => {
      await verify(
        await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
        })
      );
      const rotated = await generateTestKeypair("secp256k1");
      let release: (response: Response) => void = () => undefined;
      plc.setResponder(
        alice.did,
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );
      const token = await signServiceJwt({
        keypair: rotated,
        claims: claimsFor(alice),
      });

      const requests = [verify(token), verify(token)];
      await new Promise((resolve) => setImmediate(resolve));
      release(
        jsonResponse(
          buildDidDocument({ did: alice.did, multikey: rotated.multikey })
        )
      );
      const verified = await Promise.all(requests);

      expect(verified.map((entry) => entry.did)).toEqual([
        alice.did,
        alice.did,
      ]);
      expect(plc.requests).toHaveLength(2);
    });

    test("answers 503 when the refresh cannot reach the directory", async () => {
      await verify(
        await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
        })
      );
      plc.setResponder(alice.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 503 })
      );
      const stranger = await generateTestKeypair("secp256k1");
      const forged = await signServiceJwt({
        keypair: stranger,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(forged));

      expect({
        code: err.code,
        status: err.status,
        reason: err.message,
      }).toEqual({
        code: "polis_err_atproto_did_resolution_failed",
        status: 503,
        reason: "did_resolution_failed",
      });
    });
  });

  describe("verifyServiceJwt and the DID directory", () => {
    test.each([[500], [502], [429]])(
      "answers 503 when the directory answers %i",
      async (status) => {
        plc.setResponder(alice.did, () =>
          jsonResponse({ message: "unavailable" }, { status })
        );
        const token = await signServiceJwt({
          keypair: alice.keypair,
          claims: claimsFor(alice),
        });

        const err = await rejection(verify(token));

        expect(err).toBeInstanceOf(ServiceAuthError);
        expect({
          code: err.code,
          status: err.status,
          reason: err.message,
        }).toEqual({
          code: "polis_err_atproto_did_resolution_failed",
          status: 503,
          reason: "did_resolution_failed",
        });
      }
    );

    test("answers 503 when the directory cannot be reached", async () => {
      plc.setResponder(alice.did, () => {
        throw new TypeError("fetch failed");
      });
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(token));

      expect(err.code).toBe("polis_err_atproto_did_resolution_failed");
      expect(err.status).toBe(503);
    });

    test("answers 401 when the directory does not know the DID", async () => {
      plc.remove(alice.did);
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "issuer_has_no_usable_key");
      expect(plc.requests).toHaveLength(1);
    });

    test("answers 401 when the document has no #atproto key", async () => {
      plc.setDocument(
        alice.did,
        buildDidDocument({
          did: alice.did,
          multikey: alice.keypair.multikey,
          keyId: `${alice.did}#atproto_label`,
        })
      );
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "issuer_has_no_usable_key");
    });

    test("answers 401 when the document belongs to another DID", async () => {
      const mallory = await createTestIdentity();
      plc.setDocument(alice.did, mallory.document);
      const token = await signServiceJwt({
        keypair: mallory.keypair,
        claims: claimsFor(alice),
      });

      const err = await rejection(verify(token));

      expectInvalid(err, "issuer_has_no_usable_key");
    });
  });

  describe("verifyServiceJwt and did:web issuers", () => {
    let wendy: TestIdentity;
    let wendyHost: string;

    beforeEach(async () => {
      wendy = await createTestIdentity({
        did: randomDidWeb(),
        handle: "wendy.test.invalid",
      });
      wendyHost = wendy.did.slice("did:web:".length);
      plc.setDocument(wendy.did, wendy.document);
      jest.spyOn(logger, "warn").mockImplementation(() => logger);
    });

    function verifyAllowingWeb(token: string) {
      return verifyServiceJwt(token, {
        aud: AUD,
        lxm: LXM,
        nowSeconds: NOW,
        allowDidWeb: true,
      });
    }

    function expectUnsupported(err: ServiceAuthError) {
      expect(err).toBeInstanceOf(ServiceAuthError);
      expect({
        code: err.code,
        status: err.status,
        reason: err.message,
      }).toEqual({
        code: "polis_err_atproto_unsupported_did",
        status: 400,
        reason: "unsupported_issuer",
      });
    }

    test("accepts a valid token when the caller allows did:web", async () => {
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy),
      });

      const verified = await verifyAllowingWeb(token);

      expect(verified).toEqual({
        did: wendy.did,
        handle: "wendy.test.invalid",
        jti: "jti-fixed-value",
        tokenId: tokenIdOf(token),
      });
      expect(plc.lookups).toEqual([wendyHost]);
      expect(plc.requests.map((request) => request.url)).toEqual([
        didWebDocumentUrl(wendy.did),
      ]);
    });

    test("accepts a valid ES256 token when the caller allows did:web", async () => {
      const walter = await createTestIdentity({
        did: randomDidWeb(),
        curve: "p256",
        handle: null,
      });
      plc.setDocument(walter.did, walter.document);
      const token = await signServiceJwt({
        keypair: walter.keypair,
        claims: claimsFor(walter),
      });

      const verified = await verifyAllowingWeb(token);

      expect(walter.keypair.jwtAlg).toBe("ES256");
      expect(verified).toEqual({
        did: walter.did,
        handle: null,
        jti: "jti-fixed-value",
        tokenId: tokenIdOf(token),
      });
    });

    test.each<{ name: string; allowDidWeb: boolean | undefined }>([
      { name: "is left out", allowDidWeb: undefined },
      { name: "is false", allowDidWeb: false },
      { name: "is text", allowDidWeb: "true" as unknown as boolean },
      { name: "is a number", allowDidWeb: 1 as unknown as boolean },
    ])(
      "refuses a valid token before any lookup when allowDidWeb $name",
      async ({ allowDidWeb }) => {
        const token = await signServiceJwt({
          keypair: wendy.keypair,
          claims: claimsFor(wendy),
        });

        const err = await rejection(
          verifyServiceJwt(token, {
            aud: AUD,
            lxm: LXM,
            nowSeconds: NOW,
            allowDidWeb,
          })
        );

        expectUnsupported(err);
        expect(plc.lookups).toEqual([]);
        expect(plc.requests).toEqual([]);
      }
    );

    test("refuses a did:web identity that another caller had resolved", async () => {
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy),
      });
      await verifyAllowingWeb(token);

      const err = await rejection(verify(token));

      expectUnsupported(err);
      expect(plc.lookups).toEqual([wendyHost]);
      expect(plc.requests).toHaveLength(1);
    });

    test.each([
      { name: "a host without a dot", iss: "did:web:localhost" },
      { name: "upper case in the host", iss: "did:web:Wendy.test.invalid" },
      { name: "an encoded port", iss: "did:web:wendy.test.invalid%3A8443" },
      { name: "a port", iss: "did:web:wendy.test.invalid:8443" },
      { name: "path segments", iss: "did:web:wendy.test.invalid:user:wendy" },
      { name: "percent-encoding", iss: "did:web:wend%79.test.invalid" },
      { name: "an IPv4 address", iss: "did:web:127.0.0.1" },
      { name: "a fragment", iss: "did:web:wendy.test.invalid#atproto" },
      { name: "a trailing dot", iss: "did:web:wendy.test.invalid." },
      { name: "surrounding whitespace", iss: " did:web:wendy.test.invalid " },
      { name: "a did:key", iss: "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1" },
    ])(
      "refuses an issuer with $name before any lookup although did:web is allowed",
      async ({ iss }) => {
        const token = await signServiceJwt({
          keypair: wendy.keypair,
          claims: claimsFor(wendy, { iss }),
        });

        const err = await rejection(verifyAllowingWeb(token));

        expectUnsupported(err);
        expect(plc.lookups).toEqual([]);
        expect(plc.requests).toEqual([]);
      }
    );

    test.each<{ name: string; overrides: Claims; reason: string }>([
      {
        name: "another audience",
        overrides: { aud: "did:web:other.test.invalid" },
        reason: "bad_audience",
      },
      {
        name: "the issuer as audience",
        overrides: { aud: "did:web:wendy.test.invalid" },
        reason: "bad_audience",
      },
      {
        name: "another method",
        overrides: { lxm: "community.blacksky.assembly.participate" },
        reason: "bad_lxm",
      },
      {
        name: "no method",
        overrides: { lxm: undefined },
        reason: "missing_lxm",
      },
      {
        name: "an expiry too far ahead",
        overrides: { exp: NOW + 301 },
        reason: "exp_too_far_ahead",
      },
    ])(
      "rejects a did:web token with $name before any lookup",
      async ({ overrides, reason }) => {
        const token = await signServiceJwt({
          keypair: wendy.keypair,
          claims: claimsFor(wendy, overrides),
        });

        const err = await rejection(verifyAllowingWeb(token));

        expectInvalid(err, reason);
        expect(plc.lookups).toEqual([]);
        expect(plc.requests).toEqual([]);
      }
    );

    test("rejects an expired did:web token before any lookup", async () => {
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy, { exp: NOW - 11 }),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expect(err.code).toBe("polis_err_atproto_auth_expired");
      expect(err.status).toBe(401);
      expect(plc.lookups).toEqual([]);
    });

    test("applies the list of admitted issuers before any lookup", async () => {
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy),
      });
      const admitIssuer = jest.fn((did: string) => did !== wendy.did);

      const err = await rejection(
        verifyServiceJwt(token, {
          aud: AUD,
          lxm: LXM,
          nowSeconds: NOW,
          allowDidWeb: true,
          admitIssuer,
        })
      );

      expect(err.code).toBe("polis_err_atproto_conversation_not_eligible");
      expect(err.status).toBe(403);
      expect(admitIssuer.mock.calls).toEqual([[wendy.did]]);
      expect(plc.lookups).toEqual([]);
      expect(plc.requests).toEqual([]);
    });

    test("still accepts a did:plc issuer when did:web is allowed", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(alice),
      });

      const verified = await verifyAllowingWeb(token);

      expect(verified.did).toBe(alice.did);
      expect(plc.lookups).toEqual([]);
      expect(plc.requests.map((request) => request.url)).toEqual([
        `${PLC_URL}/${alice.did}`,
      ]);
    });

    test("rejects a token signed with a key that is not in the document", async () => {
      const token = await signServiceJwt({
        keypair: await generateTestKeypair("secp256k1"),
        claims: claimsFor(wendy),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expectInvalid(err, "bad_signature");
      expect(plc.requests).toHaveLength(1);
    });

    test("rejects a token that a did:plc account signed in the name of a did:web", async () => {
      const token = await signServiceJwt({
        keypair: alice.keypair,
        claims: claimsFor(wendy),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expectInvalid(err, "bad_signature");
    });

    test("refreshes a rotated key once and then accepts", async () => {
      await verifyAllowingWeb(
        await signServiceJwt({
          keypair: wendy.keypair,
          claims: claimsFor(wendy),
        })
      );
      const rotated = await generateTestKeypair("secp256k1");
      plc.setDocument(
        wendy.did,
        buildDidDocument({
          did: wendy.did,
          multikey: rotated.multikey,
          handle: "wendy-renamed.test.invalid",
        })
      );
      const token = await signServiceJwt({
        keypair: rotated,
        claims: claimsFor(wendy),
      });

      const verified = await verifyAllowingWeb(token);

      expect(verified.handle).toBe("wendy-renamed.test.invalid");
      expect(plc.requests).toHaveLength(2);

      await verifyAllowingWeb(token);

      expect(plc.requests).toHaveLength(2);
    });

    test("refreshes once and rejects when the key did not change", async () => {
      await verifyAllowingWeb(
        await signServiceJwt({
          keypair: wendy.keypair,
          claims: claimsFor(wendy),
        })
      );
      const forged = await signServiceJwt({
        keypair: await generateTestKeypair("secp256k1"),
        claims: claimsFor(wendy),
      });

      const first = await rejection(verifyAllowingWeb(forged));
      const second = await rejection(verifyAllowingWeb(forged));

      expectInvalid(first, "bad_signature");
      expectInvalid(second, "bad_signature");
      expect(plc.requests).toHaveLength(2);
      expect(plc.lookups).toHaveLength(2);
    });

    test.each([
      ["loopback", "127.0.0.1"],
      ["private", "10.0.0.7"],
      ["link-local", "169.254.169.254"],
      ["unique-local", "fd00::7"],
    ])(
      "answers 503 without a request when the host has the %s address %s",
      async (kind, address) => {
        plc.setAddresses(wendyHost, [address]);
        const token = await signServiceJwt({
          keypair: wendy.keypair,
          claims: claimsFor(wendy),
        });

        const err = await rejection(verifyAllowingWeb(token));

        expect({
          code: err.code,
          status: err.status,
          reason: err.message,
        }).toEqual({
          code: "polis_err_atproto_did_resolution_failed",
          status: 503,
          reason: "did_resolution_failed",
        });
        expect(plc.lookups).toEqual([wendyHost]);
        expect(plc.requests).toEqual([]);
      }
    );

    test("answers 503 when the host cannot be reached", async () => {
      plc.setResponder(wendy.did, () => {
        throw new TypeError("fetch failed");
      });
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expect(err.code).toBe("polis_err_atproto_did_resolution_failed");
      expect(err.status).toBe(503);
    });

    test("answers 401 when the host has no document", async () => {
      plc.setResponder(wendy.did, () =>
        jsonResponse({ message: "not found" }, { status: 404 })
      );
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expectInvalid(err, "issuer_has_no_usable_key");
    });

    test("answers 401 when the document belongs to another DID", async () => {
      const mallory = await createTestIdentity({ did: randomDidWeb() });
      plc.setDocument(
        wendy.did,
        buildDidDocument({
          did: mallory.did,
          multikey: mallory.keypair.multikey,
          keyId: "#atproto",
        })
      );
      const token = await signServiceJwt({
        keypair: mallory.keypair,
        claims: claimsFor(wendy),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expectInvalid(err, "issuer_has_no_usable_key");
    });

    test("answers 401 when the document has no #atproto key", async () => {
      plc.setDocument(
        wendy.did,
        buildDidDocument({
          did: wendy.did,
          multikey: wendy.keypair.multikey,
          keyId: `${wendy.did}#atproto_label`,
        })
      );
      const token = await signServiceJwt({
        keypair: wendy.keypair,
        claims: claimsFor(wendy),
      });

      const err = await rejection(verifyAllowingWeb(token));

      expectInvalid(err, "issuer_has_no_usable_key");
    });
  });

  describe("atprotoServiceAuth middleware", () => {
    function respond() {
      const res = {
        status: jest.fn(),
        json: jest.fn(),
      };
      res.status.mockReturnValue(res);
      return res;
    }

    async function currentToken(
      identity: TestIdentity,
      overrides: Claims = {}
    ): Promise<string> {
      return signServiceJwt({
        keypair: identity.keypair,
        claims: {
          ...buildServiceAuthClaims({
            iss: identity.did,
            aud: AUD,
            lxm: LXM,
          }),
          ...overrides,
        },
      });
    }

    function expectFailure(
      res: ReturnType<typeof respond>,
      next: jest.Mock,
      status: number,
      code: string
    ) {
      expect(next).not.toHaveBeenCalled();
      expect(res.status.mock.calls).toEqual([[status]]);
      expect(res.json.mock.calls).toEqual([
        [{ error: code, message: code, status }],
      ]);
    }

    let previousEligibility: string | undefined;
    let previousAllowlist: string | undefined;
    let errors: jest.SpiedFunction<typeof logger.error>;

    beforeEach(() => {
      errors = jest.spyOn(logger, "error").mockImplementation(() => logger);
      jest.spyOn(logger, "warn").mockImplementation(() => logger);
      previousEligibility = process.env.ATPROTO_APP_CREATE_ELIGIBILITY;
      previousAllowlist = process.env.ATPROTO_APP_CREATE_ALLOWLIST;
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "any";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
    });

    afterEach(() => {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      };
      restore("ATPROTO_APP_CREATE_ELIGIBILITY", previousEligibility);
      restore("ATPROTO_APP_CREATE_ALLOWLIST", previousAllowlist);
    });

    test("sets req.p.atproto_did, atproto_handle and atproto_token_id and continues", async () => {
      const token = await currentToken(alice);
      const req: { headers: Record<string, string>; p?: Claims } = {
        headers: { authorization: `Bearer ${token}` },
      };
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(req, res, next);

      expect(req.p).toEqual({
        atproto_did: alice.did,
        atproto_handle: "alice.test.invalid",
        atproto_token_id: tokenIdOf(token),
      });
      expect(next.mock.calls).toEqual([[]]);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    test("keeps parameters that are already on req.p", async () => {
      const carol = await createTestIdentity({ handle: null });
      plc.setDocument(carol.did, carol.document);
      const token = await currentToken(carol);
      const req = {
        headers: { authorization: `bearer ${token}` },
        p: { topic: "kept" } as Claims,
      };
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(req, respond(), next);

      expect(req.p).toEqual({
        topic: "kept",
        atproto_did: carol.did,
        atproto_handle: null,
        atproto_token_id: tokenIdOf(token),
      });
      expect(next).toHaveBeenCalledTimes(1);
    });

    test("overwrites an atproto_did and atproto_token_id that came from the request", async () => {
      const token = await currentToken(alice);
      const req = {
        headers: { authorization: `Bearer ${token}` },
        p: {
          atproto_did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
          atproto_handle: "mallory.test.invalid",
          atproto_token_id: "chosen-by-the-caller",
        } as Claims,
      };

      await atprotoServiceAuth(LXM)(req, respond(), jest.fn());

      expect(req.p).toEqual({
        atproto_did: alice.did,
        atproto_handle: "alice.test.invalid",
        atproto_token_id: tokenIdOf(token),
      });
    });

    test("answers 403 for a DID outside the allowlist without asking the directory", async () => {
      const listed = await createTestIdentity();
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "allowlist";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = listed.did;
      const req: { headers: Record<string, string>; p?: Claims } = {
        headers: { authorization: `Bearer ${await currentToken(alice)}` },
      };
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(req, res, next);

      expectFailure(
        res,
        next,
        403,
        "polis_err_atproto_conversation_not_eligible"
      );
      expect(req.p).toBeUndefined();
      expect(plc.requests).toHaveLength(0);
      expect(errors.mock.calls).toEqual([
        [
          "polis_err_atproto_conversation_not_eligible",
          { did: alice.did, reason: "issuer_not_listed" },
        ],
      ]);
    });

    test("answers 403 for everyone when the allowlist is empty or the setting is missing", async () => {
      const token = await currentToken(alice);
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
      const statuses: number[][] = [];
      for (const eligibility of ["allowlist", undefined, "unknown"]) {
        if (eligibility === undefined) {
          delete process.env.ATPROTO_APP_CREATE_ELIGIBILITY;
        } else {
          process.env.ATPROTO_APP_CREATE_ELIGIBILITY = eligibility;
        }
        const res = respond();
        await atprotoServiceAuth(LXM)(
          { headers: { authorization: `Bearer ${token}` } },
          res,
          jest.fn()
        );
        statuses.push(
          res.status.mock.calls.map(([status]) => status as number)
        );
      }

      expect(statuses).toEqual([[403], [403], [403]]);
      expect(plc.requests).toHaveLength(0);
    });

    test("continues for a DID on the allowlist", async () => {
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "allowlist";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = ` ${alice.did} `;
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(
        { headers: { authorization: `Bearer ${await currentToken(alice)}` } },
        respond(),
        next
      );

      expect(next.mock.calls).toEqual([[]]);
      expect(plc.requests).toHaveLength(1);
    });

    test("leaves the membership check to the route", async () => {
      process.env.ATPROTO_APP_CREATE_ELIGIBILITY = "members";
      process.env.ATPROTO_APP_CREATE_ALLOWLIST = "";
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(
        { headers: { authorization: `Bearer ${await currentToken(alice)}` } },
        respond(),
        next
      );

      expect(next.mock.calls).toEqual([[]]);
      expect(plc.requests).toHaveLength(1);
    });

    test.each<{ name: string; headers: Record<string, string> }>([
      { name: "there is no Authorization header", headers: {} },
      {
        name: "the Authorization header is empty",
        headers: { authorization: "" },
      },
      {
        name: "the Authorization header is blank",
        headers: { authorization: "   " },
      },
    ])(
      "answers 401 polis_err_atproto_auth_missing when $name",
      async ({ headers }) => {
        const req: { headers: Record<string, string>; p?: Claims } = {
          headers,
        };
        const res = respond();
        const next = jest.fn();

        await atprotoServiceAuth(LXM)(req, res, next);

        expectFailure(res, next, 401, "polis_err_atproto_auth_missing");
        expect(req.p).toBeUndefined();
        expect(plc.requests).toHaveLength(0);
      }
    );

    test("answers 401 when the request has no headers at all", async () => {
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)({}, res, next);

      expectFailure(res, next, 401, "polis_err_atproto_auth_missing");
    });

    test.each<{ name: string; header: (token: string) => string }>([
      { name: "uses another scheme", header: (token) => `Basic ${token}` },
      { name: "is a bare token", header: (token) => token },
      { name: "has no token", header: () => "Bearer" },
      {
        name: "holds two tokens",
        header: (token) => `Bearer ${token} ${token}`,
      },
    ])(
      "answers 401 polis_err_atproto_auth_invalid when the header $name",
      async ({ header }) => {
        const req: { headers: Record<string, string>; p?: Claims } = {
          headers: { authorization: header(await currentToken(alice)) },
        };
        const res = respond();
        const next = jest.fn();

        await atprotoServiceAuth(LXM)(req, res, next);

        expectFailure(res, next, 401, "polis_err_atproto_auth_invalid");
        expect(req.p).toBeUndefined();
        expect(plc.requests).toHaveLength(0);
      }
    );

    test("checks the audience against the configured service DID", async () => {
      const token = await currentToken(alice, {
        aud: "did:web:assembly.blacksky.community",
      });
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(
        { headers: { authorization: `Bearer ${token}` } },
        res,
        next
      );

      expectFailure(res, next, 401, "polis_err_atproto_auth_invalid");
    });

    test("reads the service DID on every request", async () => {
      const token = await currentToken(alice, {
        aud: "did:web:second.test.invalid",
      });
      const next = jest.fn();
      process.env.ATPROTO_SERVICE_DID = "did:web:second.test.invalid";
      try {
        await atprotoServiceAuth(LXM)(
          { headers: { authorization: `Bearer ${token}` } },
          respond(),
          next
        );
      } finally {
        process.env.ATPROTO_SERVICE_DID = AUD;
      }

      expect(next).toHaveBeenCalledTimes(1);
    });

    test("checks lxm against the method the middleware was made for", async () => {
      const token = await currentToken(alice);
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth("community.blacksky.assembly.other")(
        { headers: { authorization: `Bearer ${token}` } },
        res,
        next
      );

      expectFailure(res, next, 401, "polis_err_atproto_auth_invalid");
    });

    test("answers 401 polis_err_atproto_auth_expired for an expired token", async () => {
      const expired = Math.floor(Date.now() / 1000) - 120;
      const token = await currentToken(alice, {
        iat: expired - 60,
        exp: expired,
      });
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(
        { headers: { authorization: `Bearer ${token}` } },
        res,
        next
      );

      expectFailure(res, next, 401, "polis_err_atproto_auth_expired");
    });

    test("answers 400 polis_err_atproto_unsupported_did for a did:web issuer", async () => {
      const token = await currentToken(alice, {
        iss: "did:web:alice.test.invalid",
      });
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(
        { headers: { authorization: `Bearer ${token}` } },
        res,
        next
      );

      expectFailure(res, next, 400, "polis_err_atproto_unsupported_did");
    });

    test("answers 400 for a valid token of a did:web account without any lookup", async () => {
      const wendy = await createTestIdentity({ did: randomDidWeb() });
      plc.setDocument(wendy.did, wendy.document);
      const token = await currentToken(wendy);
      const req: { headers: Record<string, string>; p?: Claims } = {
        headers: { authorization: `Bearer ${token}` },
      };
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(req, res, next);

      expectFailure(res, next, 400, "polis_err_atproto_unsupported_did");
      expect(req.p).toBeUndefined();
      expect(plc.lookups).toEqual([]);
      expect(plc.requests).toEqual([]);
    });

    test("answers 503 polis_err_atproto_did_resolution_failed when the directory is down", async () => {
      plc.setResponder(alice.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 500 })
      );
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(
        { headers: { authorization: `Bearer ${await currentToken(alice)}` } },
        res,
        next
      );

      expectFailure(res, next, 503, "polis_err_atproto_did_resolution_failed");
    });

    test("answers 500 and does not continue when verification fails unexpectedly", async () => {
      const token = await currentToken(alice);
      jest.spyOn(Config, "getAtprotoCreateSettings").mockImplementation(() => {
        throw new Error("settings unavailable");
      });
      const req: { headers: Record<string, string>; p?: Claims } = {
        headers: { authorization: `Bearer ${token}` },
      };
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(req, res, next);

      expectFailure(res, next, 500, "polis_err_atproto_auth_failed");
      expect(req.p).toBeUndefined();
    });

    test("answers 401 for a forged signature", async () => {
      const stranger = await generateTestKeypair("secp256k1");
      const token = await currentToken({ ...alice, keypair: stranger });
      const req: { headers: Record<string, string>; p?: Claims } = {
        headers: { authorization: `Bearer ${token}` },
      };
      const res = respond();
      const next = jest.fn();

      await atprotoServiceAuth(LXM)(req, res, next);

      expectFailure(res, next, 401, "polis_err_atproto_auth_invalid");
      expect(req.p).toBeUndefined();
    });

    test("never writes the token to the log", async () => {
      const levels = ["error", "warn", "info", "debug", "log"] as const;
      const written: string[] = [];
      for (const level of levels) {
        jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          written.push(inspect(args, { depth: 8 }));
          return logger;
        });
      }
      const stranger = await generateTestKeypair("secp256k1");
      const tokens = [
        await currentToken({ ...alice, keypair: stranger }),
        await currentToken(alice, { aud: "did:web:other.test.invalid" }),
        await currentToken(alice, { exp: 1, iat: 0 }),
        await currentToken(alice, { iss: "did:web:alice.test.invalid" }),
        `${await currentToken(alice)}.extra`,
      ];

      for (const token of tokens) {
        await atprotoServiceAuth(LXM)(
          { headers: { authorization: `Bearer ${token}` } },
          respond(),
          jest.fn()
        );
      }

      expect(written).toHaveLength(5);
      const log = written.join("\n");
      for (const token of tokens) {
        for (const segment of token.split(".")) {
          expect(log.includes(segment)).toBe(false);
        }
      }
    });
  });
});

import { randomBytes } from "node:crypto";
import { P256Keypair, Secp256k1Keypair } from "@atproto/crypto";
import { clearAtprotoIdentityCache } from "../../src/auth/atproto-did";
import Config from "../../src/config";

export type TestCurve = "secp256k1" | "p256";

export type TestKeypair = {
  curve: TestCurve;
  jwtAlg: string;
  didKey: string;
  multikey: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
};

export type TestDidDocument = Record<string, unknown>;

export type TestIdentity = {
  did: string;
  handle: string | null;
  keypair: TestKeypair;
  document: TestDidDocument;
};

export type PlcResponder = (
  init: RequestInit | undefined
) => Response | Promise<Response>;

export type PlcFetchMock = {
  requests: Array<{ url: string; init: RequestInit | undefined }>;
  setDocument(did: string, document: TestDidDocument): void;
  setResponder(did: string, responder: PlcResponder): void;
  remove(did: string): void;
  restore(): void;
};

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DID_KEY_PREFIX = "did:key:";

export async function generateTestKeypair(
  curve: TestCurve = "secp256k1"
): Promise<TestKeypair> {
  const keypair =
    curve === "p256"
      ? await P256Keypair.create()
      : await Secp256k1Keypair.create();
  const didKey = keypair.did();
  return {
    curve,
    jwtAlg: keypair.jwtAlg,
    didKey,
    multikey: didKey.slice(DID_KEY_PREFIX.length),
    sign: (data: Uint8Array) => keypair.sign(data),
  };
}

export function randomDidPlc(): string {
  const suffix = Array.from(
    randomBytes(24),
    (byte) => BASE32_ALPHABET[byte % BASE32_ALPHABET.length]
  ).join("");
  return `did:plc:${suffix}`;
}

export function buildDidDocument(params: {
  did: string;
  multikey: string;
  handle?: string | null;
  keyId?: string;
  pdsEndpoint?: string;
}): TestDidDocument {
  const { did, multikey, handle = null } = params;
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
    ],
    id: did,
    alsoKnownAs: handle === null ? [] : [`at://${handle}`],
    verificationMethod: [
      {
        id: params.keyId ?? `${did}#atproto`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: multikey,
      },
    ],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: params.pdsEndpoint ?? "https://pds.test.invalid",
      },
    ],
  };
}

export async function createTestIdentity(
  params: { curve?: TestCurve; handle?: string | null; did?: string } = {}
): Promise<TestIdentity> {
  const did = params.did ?? randomDidPlc();
  const handle =
    params.handle === undefined
      ? `user-${did.slice(-8)}.test.invalid`
      : params.handle;
  const keypair = await generateTestKeypair(params.curve);
  return {
    did,
    handle,
    keypair,
    document: buildDidDocument({ did, multikey: keypair.multikey, handle }),
  };
}

export function encodeJwtSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function buildServiceAuthClaims(params: {
  iss: string;
  aud: string;
  lxm: string;
  nowSeconds?: number;
  lifetimeSeconds?: number;
  jti?: string;
}): Record<string, unknown> {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    iat: now,
    iss: params.iss,
    aud: params.aud,
    exp: now + (params.lifetimeSeconds ?? 60),
    lxm: params.lxm,
    jti: params.jti ?? randomBytes(16).toString("hex"),
  };
}

export async function signServiceJwt(params: {
  keypair: TestKeypair;
  claims: Record<string, unknown>;
  header?: Record<string, unknown>;
}): Promise<string> {
  const header = {
    typ: "JWT",
    alg: params.keypair.jwtAlg,
    ...params.header,
  };
  const signedData = `${encodeJwtSegment(header)}.${encodeJwtSegment(
    params.claims
  )}`;
  const signature = await params.keypair.sign(Buffer.from(signedData, "ascii"));
  return `${signedData}.${Buffer.from(signature).toString("base64url")}`;
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

export function installPlcFetchMock(
  documents: Record<string, TestDidDocument> = {},
  options: { fallback?: typeof fetch } = {}
): PlcFetchMock {
  const originalFetch = globalThis.fetch;
  const responders = new Map<string, PlcResponder>();
  const requests: PlcFetchMock["requests"] = [];

  const serveDocument = (did: string, document: TestDidDocument) => {
    responders.set(did, () => jsonResponse(document));
  };
  for (const [did, document] of Object.entries(documents)) {
    serveDocument(did, document);
  }

  const mockedFetch = async (
    input: unknown,
    init?: RequestInit
  ): Promise<Response> => {
    const url = requestUrl(input);
    const prefix = `${Config.getAtprotoCreateSettings().plcUrl}/`;
    if (!url.startsWith(prefix)) {
      if (options.fallback) {
        return options.fallback(input as RequestInfo, init);
      }
      throw new Error(`unexpected fetch in a test: ${url}`);
    }
    requests.push({ url, init });
    const did = decodeURIComponent(url.slice(prefix.length));
    const responder = responders.get(did);
    if (!responder) {
      return jsonResponse(
        { message: `DID not registered: ${did}` },
        { status: 404 }
      );
    }
    return responder(init);
  };

  clearAtprotoIdentityCache();
  globalThis.fetch = mockedFetch as typeof fetch;

  return {
    requests,
    setDocument: serveDocument,
    setResponder: (did, responder) => {
      responders.set(did, responder);
    },
    remove: (did) => {
      responders.delete(did);
    },
    restore: () => {
      globalThis.fetch = originalFetch;
      clearAtprotoIdentityCache();
    },
  };
}

import { randomBytes } from "node:crypto";
import dns from "node:dns";
import net from "node:net";
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
  lookups: string[];
  setDocument(did: string, document: TestDidDocument): void;
  setResponder(did: string, responder: PlcResponder): void;
  setUrlResponder(url: string, responder: PlcResponder): void;
  setAddresses(host: string, addresses: string[]): void;
  setResolver(host: string, resolver: () => Promise<string[]>): void;
  remove(did: string): void;
  restore(): void;
};

export const TEST_PUBLIC_ADDRESS = "93.184.215.14";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DID_KEY_PREFIX = "did:key:";
const DID_WEB_PREFIX = "did:web:";
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

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

export function randomDidWeb(): string {
  return `${DID_WEB_PREFIX}host-${randomBytes(8).toString("hex")}.test.invalid`;
}

export function didWebDocumentUrl(did: string): string {
  return `https://${did.slice(DID_WEB_PREFIX.length)}/.well-known/did.json`;
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
  const originalLookup = dns.promises.lookup;
  const responders = new Map<string, PlcResponder>();
  const urlResponders = new Map<string, PlcResponder>();
  const resolvers = new Map<string, () => Promise<string[]>>();
  const requests: PlcFetchMock["requests"] = [];
  const lookups: string[] = [];

  const setUrlResponder = (url: string, responder: PlcResponder) => {
    urlResponders.set(url, responder);
    const host = new URL(url).hostname;
    if (!resolvers.has(host)) {
      resolvers.set(host, async () => [TEST_PUBLIC_ADDRESS]);
    }
  };
  const setResponder = (did: string, responder: PlcResponder) => {
    if (did.startsWith(DID_WEB_PREFIX)) {
      setUrlResponder(didWebDocumentUrl(did), responder);
    } else {
      responders.set(did, responder);
    }
  };
  const serveDocument = (did: string, document: TestDidDocument) => {
    setResponder(did, () => jsonResponse(document));
  };
  for (const [did, document] of Object.entries(documents)) {
    serveDocument(did, document);
  }

  const respond = async (
    url: string,
    init: RequestInit | undefined
  ): Promise<Response | null> => {
    const prefix = `${Config.getAtprotoCreateSettings().plcUrl}/`;
    if (url.startsWith(prefix)) {
      requests.push({ url, init });
      const did = decodeURIComponent(url.slice(prefix.length));
      const responder = responders.get(did);
      return responder
        ? responder(init)
        : jsonResponse(
            { message: `DID not registered: ${did}` },
            { status: 404 }
          );
    }
    const responder = urlResponders.get(url);
    if (!responder) return null;
    requests.push({ url, init });
    return responder(init);
  };

  const mockedFetch = async (
    input: unknown,
    init?: RequestInit
  ): Promise<Response> => {
    const url = requestUrl(input);
    const response = await respond(url, init);
    if (response === null) {
      if (options.fallback) {
        return options.fallback(input as RequestInfo, init);
      }
      throw new Error(`unexpected fetch in a test: ${url}`);
    }
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.includes(response.status) || location === null) {
      return response;
    }
    if (init?.redirect === "error") {
      throw new TypeError("fetch failed");
    }
    if (init?.redirect === "manual") {
      return response;
    }
    return mockedFetch(new URL(location, url).toString(), init);
  };

  const mockedLookup = async (host: string) => {
    lookups.push(host);
    const resolver = resolvers.get(host);
    if (!resolver) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        code: "ENOTFOUND",
        syscall: "getaddrinfo",
        hostname: host,
      });
    }
    return (await resolver()).map((address) => ({
      address,
      family: net.isIP(address),
    }));
  };

  clearAtprotoIdentityCache();
  globalThis.fetch = mockedFetch as typeof fetch;
  dns.promises.lookup = mockedLookup as typeof dns.promises.lookup;

  return {
    requests,
    lookups,
    setDocument: serveDocument,
    setResponder,
    setUrlResponder,
    setAddresses: (host, addresses) => {
      resolvers.set(host, async () => addresses);
    },
    setResolver: (host, resolver) => {
      resolvers.set(host, resolver);
    },
    remove: (did) => {
      if (did.startsWith(DID_WEB_PREFIX)) {
        urlResponders.delete(didWebDocumentUrl(did));
      } else {
        responders.delete(did);
      }
    },
    restore: () => {
      globalThis.fetch = originalFetch;
      dns.promises.lookup = originalLookup;
      clearAtprotoIdentityCache();
    },
  };
}

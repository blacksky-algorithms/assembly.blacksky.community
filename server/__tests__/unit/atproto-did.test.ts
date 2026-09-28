import { once } from "node:events";
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
  AtprotoDidError,
  clearAtprotoIdentityCache,
  isSupportedAtprotoDid,
  resolveAtprotoIdentity,
  resolveAtprotoIdentityWithSource,
} from "../../src/auth/atproto-did";
import {
  PlcFetchMock,
  TestDidDocument,
  buildDidDocument,
  createTestIdentity,
  generateTestKeypair,
  installPlcFetchMock,
  jsonResponse,
  randomDidPlc,
} from "../setup/atproto-test-helpers";

const PLC_URL = "https://plc.test.invalid";
const MAX_BODY_BYTES = 64 * 1024;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THIRTY_SECONDS_MS = 30 * 1000;

function padDocumentTo(document: TestDidDocument, bytes: number): string {
  const unpadded = JSON.stringify({ ...document, padding: "" });
  const padding = "x".repeat(bytes - Buffer.byteLength(unpadded, "utf8"));
  return JSON.stringify({ ...document, padding });
}

async function rejection(promise: Promise<unknown>): Promise<AtprotoDidError> {
  try {
    await promise;
  } catch (err) {
    return err as AtprotoDidError;
  }
  throw new Error("expected the promise to reject");
}

describe("atproto DID resolver", () => {
  let previousPlcUrl: string | undefined;
  let plc: PlcFetchMock;

  beforeAll(() => {
    previousPlcUrl = process.env.ATPROTO_PLC_URL;
    process.env.ATPROTO_PLC_URL = PLC_URL;
  });

  afterAll(() => {
    if (previousPlcUrl === undefined) {
      delete process.env.ATPROTO_PLC_URL;
    } else {
      process.env.ATPROTO_PLC_URL = previousPlcUrl;
    }
  });

  beforeEach(() => {
    plc = installPlcFetchMock();
  });

  afterEach(() => {
    plc.restore();
    jest.restoreAllMocks();
  });

  describe("supported identifiers", () => {
    test("accepts a did:plc with 24 base32 characters", () => {
      expect(isSupportedAtprotoDid("did:plc:abcdefghijklmnopqrstuvwx")).toBe(
        true
      );
      expect(isSupportedAtprotoDid("did:plc:234567abcdefghijklmnopqr")).toBe(
        true
      );
    });

    test.each([
      { name: "a did:web", did: "did:web:example.com" },
      {
        name: "a did:key",
        did: "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",
      },
      {
        name: "a did:plc that is too short",
        did: "did:plc:abcdefghijklmnopqrstuvw",
      },
      {
        name: "a did:plc that is too long",
        did: "did:plc:abcdefghijklmnopqrstuvwxy",
      },
      {
        name: "upper case characters",
        did: "did:plc:ABCDEFGHIJKLMNOPQRSTUVWX",
      },
      {
        name: "characters outside base32",
        did: "did:plc:abcdefghijklmnopqrstuv01",
      },
      { name: "a fragment", did: "did:plc:abcdefghijklmnopqrstuvwx#atproto" },
      { name: "a path", did: "did:plc:abcdefghijklmnopqrstuvwx/log" },
      { name: "a trailing newline", did: "did:plc:abcdefghijklmnopqrstuvwx\n" },
      { name: "an empty string", did: "" },
    ])("rejects $name without a request", async ({ did }) => {
      expect(isSupportedAtprotoDid(did)).toBe(false);

      const err = await rejection(resolveAtprotoIdentity(did));

      expect(err).toBeInstanceOf(AtprotoDidError);
      expect(err.code).toBe("unsupported_did");
      expect(plc.requests).toHaveLength(0);
    });
  });

  describe("document handling", () => {
    test("returns the signing key and handle of a secp256k1 account", async () => {
      const identity = await createTestIdentity({
        curve: "secp256k1",
        handle: "alice.test.invalid",
      });
      plc.setDocument(identity.did, identity.document);

      const resolved = await resolveAtprotoIdentity(identity.did);

      expect(resolved).toEqual({
        did: identity.did,
        signingKey: `did:key:${identity.keypair.multikey}`,
        handle: "alice.test.invalid",
      });
      expect(resolved.signingKey).toBe(identity.keypair.didKey);
      expect(resolved.signingKey.startsWith("did:key:zQ3s")).toBe(true);
    });

    test("returns the signing key of a P-256 account", async () => {
      const identity = await createTestIdentity({ curve: "p256" });
      plc.setDocument(identity.did, identity.document);

      const resolved = await resolveAtprotoIdentity(identity.did);

      expect(resolved.signingKey).toBe(identity.keypair.didKey);
      expect(resolved.signingKey.startsWith("did:key:zDn")).toBe(true);
    });

    test("requests the document from the configured directory without following redirects", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      const timeout = jest.spyOn(AbortSignal, "timeout");

      await resolveAtprotoIdentity(identity.did);

      expect(plc.requests).toHaveLength(1);
      expect(plc.requests[0].url).toBe(`${PLC_URL}/${identity.did}`);
      expect(plc.requests[0].init?.redirect).toBe("error");
      expect(plc.requests[0].init?.method).toBeUndefined();
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(3000);
      expect(plc.requests[0].init?.signal).toBe(timeout.mock.results[0].value);
    });

    test("accepts the bare #atproto key id", async () => {
      const did = randomDidPlc();
      const keypair = await generateTestKeypair();
      plc.setDocument(
        did,
        buildDidDocument({ did, multikey: keypair.multikey, keyId: "#atproto" })
      );

      const resolved = await resolveAtprotoIdentity(did);

      expect(resolved.signingKey).toBe(keypair.didKey);
    });

    test("picks the #atproto key among several verification methods", async () => {
      const did = randomDidPlc();
      const signing = await generateTestKeypair();
      const labeler = await generateTestKeypair();
      const document = buildDidDocument({ did, multikey: signing.multikey });
      document.verificationMethod = [
        {
          id: `${did}#atproto_label`,
          type: "Multikey",
          controller: did,
          publicKeyMultibase: labeler.multikey,
        },
        ...(document.verificationMethod as unknown[]),
      ];
      plc.setDocument(did, document);

      const resolved = await resolveAtprotoIdentity(did);

      expect(resolved.signingKey).toBe(signing.didKey);
    });

    test("uses the first at:// entry of alsoKnownAs as the handle", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, {
        ...identity.document,
        alsoKnownAs: [
          "https://example.test.invalid/profile",
          "at://First.Test.Invalid",
          "at://second.test.invalid",
        ],
      });

      const resolved = await resolveAtprotoIdentity(identity.did);

      expect(resolved.handle).toBe("first.test.invalid");
    });

    test.each<{ name: string; alsoKnownAs: unknown }>([
      { name: "alsoKnownAs is missing", alsoKnownAs: undefined },
      { name: "alsoKnownAs is empty", alsoKnownAs: [] },
      {
        name: "alsoKnownAs has no at:// entry",
        alsoKnownAs: ["https://example.test.invalid"],
      },
      {
        name: "alsoKnownAs is not an array",
        alsoKnownAs: "at://alice.test.invalid",
      },
      {
        name: "the handle is not a valid hostname",
        alsoKnownAs: ["at://<script>.test.invalid"],
      },
      {
        name: "the handle has a path",
        alsoKnownAs: ["at://alice.test.invalid/app.bsky"],
      },
      {
        name: "the handle is longer than 253 characters",
        alsoKnownAs: [`at://${"a.".repeat(126)}ab`],
      },
    ])("returns a null handle when $name", async ({ alsoKnownAs }) => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, { ...identity.document, alsoKnownAs });

      const resolved = await resolveAtprotoIdentity(identity.did);

      expect(resolved).toEqual({
        did: identity.did,
        signingKey: identity.keypair.didKey,
        handle: null,
      });
    });

    test("rejects a document whose id is another DID", async () => {
      const identity = await createTestIdentity();
      const other = await createTestIdentity();
      plc.setDocument(identity.did, other.document);

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err).toBeInstanceOf(AtprotoDidError);
      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(
        "DID document id does not match the requested DID"
      );
    });

    test("rejects a document without an #atproto key", async () => {
      const did = randomDidPlc();
      const keypair = await generateTestKeypair();
      plc.setDocument(
        did,
        buildDidDocument({
          did,
          multikey: keypair.multikey,
          keyId: `${did}#atproto_label`,
        })
      );

      const err = await rejection(resolveAtprotoIdentity(did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(
        "DID document has no #atproto verification method"
      );
    });

    test("rejects an #atproto key that belongs to another DID", async () => {
      const did = randomDidPlc();
      const keypair = await generateTestKeypair();
      plc.setDocument(
        did,
        buildDidDocument({
          did,
          multikey: keypair.multikey,
          keyId: `${randomDidPlc()}#atproto`,
        })
      );

      const err = await rejection(resolveAtprotoIdentity(did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(
        "DID document has no #atproto verification method"
      );
    });

    test("rejects a document without verification methods", async () => {
      const identity = await createTestIdentity();
      const document = { ...identity.document };
      delete document.verificationMethod;
      plc.setDocument(identity.did, document);

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(
        "DID document has no #atproto verification method"
      );
    });

    test("rejects an #atproto key that is not a Multikey", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, {
        ...identity.document,
        verificationMethod: [
          {
            id: `${identity.did}#atproto`,
            type: "EcdsaSecp256k1VerificationKey2019",
            controller: identity.did,
            publicKeyMultibase: identity.keypair.multikey,
          },
        ],
      });

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(
        "#atproto verification method is not a Multikey"
      );
    });

    test("rejects a Multikey that is not a supported curve", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, {
        ...identity.document,
        verificationMethod: [
          {
            id: `${identity.did}#atproto`,
            type: "Multikey",
            controller: identity.did,
            publicKeyMultibase:
              "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          },
        ],
      });

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(
        "#atproto verification method has an unusable key"
      );
    });

    test.each([
      {
        name: "is not JSON",
        body: "<html>not json</html>",
        message: "DID document is not valid JSON",
      },
      {
        name: "is a JSON array",
        body: "[]",
        message: "DID document is not an object",
      },
      {
        name: "is JSON null",
        body: "null",
        message: "DID document is not an object",
      },
      { name: "is empty", body: "", message: "DID document is not valid JSON" },
    ])("rejects a body that $name", async ({ body, message }) => {
      const did = randomDidPlc();
      plc.setResponder(did, () => new Response(body, { status: 200 }));

      const err = await rejection(resolveAtprotoIdentity(did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe(message);
    });
  });

  describe("directory failures", () => {
    test.each([
      [500, "resolution_failed", "DID directory answered with status 500"],
      [502, "resolution_failed", "DID directory answered with status 502"],
      [429, "resolution_failed", "DID directory answered with status 429"],
      [201, "resolution_failed", "DID directory answered with status 201"],
      [
        404,
        "invalid_document",
        "DID directory has no active document (status 404)",
      ],
      [
        410,
        "invalid_document",
        "DID directory has no active document (status 410)",
      ],
    ])(
      "rejects a response with status %i as %s",
      async (status, code, message) => {
        const identity = await createTestIdentity();
        plc.setResponder(identity.did, () =>
          jsonResponse(identity.document, { status })
        );

        const err = await rejection(resolveAtprotoIdentity(identity.did));

        expect(err).toBeInstanceOf(AtprotoDidError);
        expect(err.code).toBe(code);
        expect(err.message).toBe(message);
      }
    );

    test("rejects a DID the directory does not know", async () => {
      const err = await rejection(resolveAtprotoIdentity(randomDidPlc()));

      expect(err.code).toBe("invalid_document");
      expect(plc.requests).toHaveLength(1);
    });

    test("gives up when the directory does not answer within 3 seconds", async () => {
      const identity = await createTestIdentity();
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = jest
        .spyOn(AbortSignal, "timeout")
        .mockImplementation(() => realTimeout(25));
      plc.setResponder(identity.did, async (init) => {
        await once(init.signal, "abort");
        throw init.signal.reason;
      });

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err).toBeInstanceOf(AtprotoDidError);
      expect(err.code).toBe("resolution_failed");
      expect(err.message).toBe("DID directory request failed (TimeoutError)");
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(3000);
    });

    test("reports a network error or refused redirect as a failed resolution", async () => {
      const identity = await createTestIdentity();
      plc.setResponder(identity.did, () => {
        throw new TypeError("fetch failed");
      });

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err).toBeInstanceOf(AtprotoDidError);
      expect(err.code).toBe("resolution_failed");
      expect(err.message).toBe("DID directory request failed (TypeError)");
    });
  });

  describe("body size", () => {
    test("accepts a document of exactly 64 KB", async () => {
      const identity = await createTestIdentity();
      const body = padDocumentTo(identity.document, MAX_BODY_BYTES);
      expect(Buffer.byteLength(body, "utf8")).toBe(65536);
      plc.setResponder(identity.did, () => new Response(body));

      const resolved = await resolveAtprotoIdentity(identity.did);

      expect(resolved.signingKey).toBe(identity.keypair.didKey);
    });

    test("refuses a document one byte over 64 KB", async () => {
      const identity = await createTestIdentity();
      const body = padDocumentTo(identity.document, MAX_BODY_BYTES + 1);
      expect(Buffer.byteLength(body, "utf8")).toBe(65537);
      plc.setResponder(identity.did, () => new Response(body));

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe("DID document is too large");
    });

    test("stops reading a streamed body once it passes 64 KB", async () => {
      const identity = await createTestIdentity();
      const chunk = new Uint8Array(16 * 1024).fill(0x20);
      let chunksServed = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksServed += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      plc.setResponder(identity.did, () => new Response(stream));

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe("DID document is too large");
      expect(cancelled).toBe(true);
      expect(chunksServed).toBeLessThanOrEqual(6);
    });

    test("refuses a declared length over 64 KB whatever the body holds", async () => {
      const identity = await createTestIdentity();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Buffer.from(JSON.stringify(identity.document), "utf8")
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      plc.setResponder(
        identity.did,
        () => new Response(stream, { headers: { "content-length": "65537" } })
      );

      const err = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(err.message).toBe("DID document is too large");
      expect(cancelled).toBe(true);
    });

    test("accepts a declared length of exactly 64 KB", async () => {
      const identity = await createTestIdentity();
      const body = padDocumentTo(identity.document, MAX_BODY_BYTES);
      plc.setResponder(
        identity.did,
        () => new Response(body, { headers: { "content-length": "65536" } })
      );

      const resolved = await resolveAtprotoIdentity(identity.did);

      expect(resolved.signingKey).toBe(identity.keypair.didKey);
    });
  });

  describe("caching", () => {
    let now: number;

    beforeEach(() => {
      now = 1_800_000_000_000;
      jest.spyOn(Date, "now").mockImplementation(() => now);
    });

    test("serves a document from the cache for 5 minutes", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);

      const first = await resolveAtprotoIdentityWithSource(identity.did);
      now += FIVE_MINUTES_MS;
      const second = await resolveAtprotoIdentityWithSource(identity.did);

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.identity).toEqual(first.identity);
      expect(plc.requests).toHaveLength(1);

      now += 1;
      const third = await resolveAtprotoIdentityWithSource(identity.did);

      expect(third.cached).toBe(false);
      expect(plc.requests).toHaveLength(2);
    });

    test("does not pick up a rotated key until the cache expires", async () => {
      const identity = await createTestIdentity();
      const rotated = await generateTestKeypair();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      plc.setDocument(
        identity.did,
        buildDidDocument({ did: identity.did, multikey: rotated.multikey })
      );

      now += FIVE_MINUTES_MS;
      const cached = await resolveAtprotoIdentity(identity.did);
      now += 1;
      const fresh = await resolveAtprotoIdentity(identity.did);

      expect(cached.signingKey).toBe(identity.keypair.didKey);
      expect(fresh.signingKey).toBe(rotated.didKey);
    });

    test("remembers a failure for 30 seconds", async () => {
      const identity = await createTestIdentity();
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 503 })
      );

      const first = await rejection(resolveAtprotoIdentity(identity.did));
      plc.setDocument(identity.did, identity.document);
      now += THIRTY_SECONDS_MS;
      const second = await rejection(resolveAtprotoIdentity(identity.did));

      expect(first.code).toBe("resolution_failed");
      expect(second).toBeInstanceOf(AtprotoDidError);
      expect(second.code).toBe("resolution_failed");
      expect(second.message).toBe("DID directory answered with status 503");
      expect(plc.requests).toHaveLength(1);

      now += 1;
      const third = await resolveAtprotoIdentity(identity.did);

      expect(third.signingKey).toBe(identity.keypair.didKey);
      expect(plc.requests).toHaveLength(2);
    });

    test("remembers an invalid document for 30 seconds", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, {
        ...identity.document,
        id: randomDidPlc(),
      });

      const first = await rejection(resolveAtprotoIdentity(identity.did));
      plc.setDocument(identity.did, identity.document);
      now += THIRTY_SECONDS_MS;
      const second = await rejection(resolveAtprotoIdentity(identity.did));

      expect(first.code).toBe("invalid_document");
      expect(second.code).toBe("invalid_document");
      expect(second.message).toBe(
        "DID document id does not match the requested DID"
      );
      expect(plc.requests).toHaveLength(1);
    });

    test("fetches again when a refresh is forced", async () => {
      const identity = await createTestIdentity();
      const rotated = await generateTestKeypair();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      plc.setDocument(
        identity.did,
        buildDidDocument({ did: identity.did, multikey: rotated.multikey })
      );

      const refreshed = await resolveAtprotoIdentityWithSource(identity.did, {
        forceRefresh: true,
      });

      expect(refreshed.cached).toBe(false);
      expect(refreshed.identity.signingKey).toBe(rotated.didKey);
      expect(plc.requests).toHaveLength(2);

      const afterwards = await resolveAtprotoIdentityWithSource(identity.did);

      expect(afterwards.cached).toBe(true);
      expect(afterwards.identity.signingKey).toBe(rotated.didKey);
      expect(plc.requests).toHaveLength(2);
    });

    test("forces at most one refresh per DID every 30 seconds", async () => {
      const identity = await createTestIdentity();
      const other = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      plc.setDocument(other.did, other.document);
      await resolveAtprotoIdentity(identity.did);
      await resolveAtprotoIdentity(other.did);

      await resolveAtprotoIdentity(identity.did, { forceRefresh: true });
      now += THIRTY_SECONDS_MS;
      const throttled = await resolveAtprotoIdentityWithSource(identity.did, {
        forceRefresh: true,
      });

      expect(throttled.cached).toBe(true);
      expect(plc.requests.map((request) => request.url)).toEqual([
        `${PLC_URL}/${identity.did}`,
        `${PLC_URL}/${other.did}`,
        `${PLC_URL}/${identity.did}`,
      ]);

      const otherRefreshed = await resolveAtprotoIdentityWithSource(other.did, {
        forceRefresh: true,
      });
      now += 1;
      const allowed = await resolveAtprotoIdentityWithSource(identity.did, {
        forceRefresh: true,
      });

      expect(otherRefreshed.cached).toBe(false);
      expect(allowed.cached).toBe(false);
      expect(plc.requests).toHaveLength(5);
    });

    test("a forced refresh of an unknown DID is an ordinary lookup", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);

      await resolveAtprotoIdentity(identity.did, { forceRefresh: true });
      const refreshed = await resolveAtprotoIdentityWithSource(identity.did, {
        forceRefresh: true,
      });

      expect(refreshed.cached).toBe(false);
      expect(plc.requests).toHaveLength(2);
    });

    test("keeps the cached document when a forced refresh cannot reach the directory", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 503 })
      );

      const err = await rejection(
        resolveAtprotoIdentity(identity.did, { forceRefresh: true })
      );
      const afterwards = await resolveAtprotoIdentityWithSource(identity.did);

      expect(err.code).toBe("resolution_failed");
      expect(afterwards.cached).toBe(true);
      expect(afterwards.identity.signingKey).toBe(identity.keypair.didKey);
      expect(plc.requests).toHaveLength(2);
    });

    test("drops the cached document when a forced refresh finds the DID deactivated", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "DID not available" }, { status: 410 })
      );

      const err = await rejection(
        resolveAtprotoIdentity(identity.did, { forceRefresh: true })
      );
      const afterwards = await rejection(resolveAtprotoIdentity(identity.did));

      expect(err.code).toBe("invalid_document");
      expect(afterwards.code).toBe("invalid_document");
      expect(afterwards.message).toBe(
        "DID directory has no active document (status 410)"
      );
      expect(plc.requests).toHaveLength(2);
    });

    test("tries a forced refresh again at once when the directory did not answer", async () => {
      const identity = await createTestIdentity();
      const rotated = await generateTestKeypair();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      plc.setResponder(identity.did, () =>
        jsonResponse({ message: "unavailable" }, { status: 502 })
      );

      const failed = await rejection(
        resolveAtprotoIdentityWithSource(identity.did, { forceRefresh: true })
      );
      plc.setDocument(
        identity.did,
        buildDidDocument({ did: identity.did, multikey: rotated.multikey })
      );
      now += 1000;
      const retried = await resolveAtprotoIdentityWithSource(identity.did, {
        forceRefresh: true,
      });

      expect(failed.code).toBe("resolution_failed");
      expect(retried.cached).toBe(false);
      expect(retried.identity.signingKey).toBe(rotated.didKey);
      expect(plc.requests).toHaveLength(3);
    });

    test("tries a forced refresh again at once when it was refused for lack of budget", async () => {
      const identity = await createTestIdentity();
      const rotated = await generateTestKeypair();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      for (let i = 0; i < 119; i++) {
        await rejection(resolveAtprotoIdentity(randomDidPlc()));
      }
      plc.setDocument(
        identity.did,
        buildDidDocument({ did: identity.did, multikey: rotated.multikey })
      );

      const refused = await rejection(
        resolveAtprotoIdentityWithSource(identity.did, { forceRefresh: true })
      );
      now += 60_000;
      const retried = await resolveAtprotoIdentityWithSource(identity.did, {
        forceRefresh: true,
      });

      expect(refused.message).toBe("too many DID lookups");
      expect(retried.cached).toBe(false);
      expect(retried.identity.signingKey).toBe(rotated.didKey);
      expect(plc.requests).toHaveLength(121);
    });

    test("keeps the pause after a forced refresh that found the DID deactivated", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      plc.remove(identity.did);

      const first = await rejection(
        resolveAtprotoIdentityWithSource(identity.did, { forceRefresh: true })
      );
      now += 1000;
      const second = await rejection(
        resolveAtprotoIdentityWithSource(identity.did, { forceRefresh: true })
      );

      expect(first.code).toBe("invalid_document");
      expect(second.code).toBe("invalid_document");
      expect(plc.requests).toHaveLength(2);
    });

    test("a forced refresh joins the refresh that is already in flight", async () => {
      const identity = await createTestIdentity();
      const rotated = await generateTestKeypair();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      let release: (response: Response) => void = () => undefined;
      plc.setResponder(
        identity.did,
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );

      const lookups = [
        resolveAtprotoIdentityWithSource(identity.did, { forceRefresh: true }),
        resolveAtprotoIdentityWithSource(identity.did, { forceRefresh: true }),
      ];
      await new Promise((resolve) => setImmediate(resolve));
      release(
        jsonResponse(
          buildDidDocument({ did: identity.did, multikey: rotated.multikey })
        )
      );
      const resolved = await Promise.all(lookups);

      expect(
        resolved.map((entry) => [entry.identity.signingKey, entry.cached])
      ).toEqual([
        [rotated.didKey, false],
        [rotated.didKey, false],
      ]);
      expect(plc.requests).toHaveLength(2);
    });

    test("a lookup that is not forced is served from the cache while a refresh is in flight", async () => {
      const identity = await createTestIdentity();
      const rotated = await generateTestKeypair();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      let release: (response: Response) => void = () => undefined;
      plc.setResponder(
        identity.did,
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );

      const refresh = resolveAtprotoIdentity(identity.did, {
        forceRefresh: true,
      });
      const meanwhile = await resolveAtprotoIdentityWithSource(identity.did);
      await new Promise((resolve) => setImmediate(resolve));
      release(
        jsonResponse(
          buildDidDocument({ did: identity.did, multikey: rotated.multikey })
        )
      );
      const refreshed = await refresh;

      expect(meanwhile).toEqual({
        identity: {
          did: identity.did,
          signingKey: identity.keypair.didKey,
          handle: identity.handle,
        },
        cached: true,
      });
      expect(refreshed.signingKey).toBe(rotated.didKey);
      expect(plc.requests).toHaveLength(2);
    });

    test("shares one request between concurrent lookups of the same DID", async () => {
      const identity = await createTestIdentity();
      let release: (response: Response) => void = () => undefined;
      plc.setResponder(
        identity.did,
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );

      const lookups = [
        resolveAtprotoIdentity(identity.did),
        resolveAtprotoIdentity(identity.did),
        resolveAtprotoIdentity(identity.did),
      ];
      await new Promise((resolve) => setImmediate(resolve));
      release(jsonResponse(identity.document));
      const resolved = await Promise.all(lookups);

      expect(plc.requests).toHaveLength(1);
      expect(resolved.map((entry) => entry.signingKey)).toEqual([
        identity.keypair.didKey,
        identity.keypair.didKey,
        identity.keypair.didKey,
      ]);
    });

    test("refuses an eleventh lookup while ten are in flight", async () => {
      const waiting = await Promise.all(
        Array.from({ length: 10 }, () => createTestIdentity())
      );
      const releases: (() => void)[] = [];
      for (const identity of waiting) {
        plc.setResponder(
          identity.did,
          () =>
            new Promise<Response>((resolve) => {
              releases.push(() => resolve(jsonResponse(identity.document)));
            })
        );
      }
      const extra = await createTestIdentity();
      plc.setDocument(extra.did, extra.document);

      const lookups = waiting.map((identity) =>
        resolveAtprotoIdentity(identity.did)
      );
      await new Promise((resolve) => setImmediate(resolve));
      const refused = await rejection(resolveAtprotoIdentity(extra.did));

      expect(refused).toBeInstanceOf(AtprotoDidError);
      expect(refused.code).toBe("resolution_failed");
      expect(refused.message).toBe("too many DID lookups");
      expect(plc.requests).toHaveLength(10);

      releases[0]();
      await lookups[0];
      const admitted = await resolveAtprotoIdentityWithSource(extra.did);

      expect(admitted.cached).toBe(false);
      expect(admitted.identity.signingKey).toBe(extra.keypair.didKey);
      expect(plc.requests).toHaveLength(11);

      releases.slice(1).forEach((release) => release());
      const resolved = await Promise.all(lookups);
      expect(resolved.map((identity) => identity.did)).toEqual(
        waiting.map((identity) => identity.did)
      );
    });

    test("refuses lookups past 120 in a minute and admits them again in the next", async () => {
      for (let i = 0; i < 120; i++) {
        const unknown = await rejection(resolveAtprotoIdentity(randomDidPlc()));
        expect(unknown.code).toBe("invalid_document");
      }
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);

      now += 59_999;
      const refused = await rejection(resolveAtprotoIdentity(identity.did));

      expect(refused.code).toBe("resolution_failed");
      expect(refused.message).toBe("too many DID lookups");
      expect(plc.requests).toHaveLength(120);

      now += 1;
      const admitted = await resolveAtprotoIdentityWithSource(identity.did);

      expect(admitted.cached).toBe(false);
      expect(admitted.identity.signingKey).toBe(identity.keypair.didKey);
      expect(plc.requests).toHaveLength(121);
    });

    test("does not count a lookup served from the cache", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);
      for (let i = 0; i < 119; i++) {
        await rejection(resolveAtprotoIdentity(randomDidPlc()));
      }

      const cached = await resolveAtprotoIdentityWithSource(identity.did);
      const refused = await rejection(resolveAtprotoIdentity(randomDidPlc()));

      expect(cached.cached).toBe(true);
      expect(refused.message).toBe("too many DID lookups");
      expect(plc.requests).toHaveLength(120);
    });

    test("forgets everything when the cache is cleared", async () => {
      const identity = await createTestIdentity();
      plc.setDocument(identity.did, identity.document);
      await resolveAtprotoIdentity(identity.did);

      clearAtprotoIdentityCache();
      const resolved = await resolveAtprotoIdentityWithSource(identity.did);

      expect(resolved.cached).toBe(false);
      expect(plc.requests).toHaveLength(2);
    });
  });

  describe("test fetch mock", () => {
    test("refuses requests to any other host", async () => {
      await expect(fetch("https://example.test.invalid/")).rejects.toThrow(
        "unexpected fetch in a test: https://example.test.invalid/"
      );
      expect(plc.requests).toHaveLength(0);
    });
  });
});

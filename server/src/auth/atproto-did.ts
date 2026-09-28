import { parseMultikey } from "@atproto/crypto";
import LruCache from "lru-cache";
import Config from "../config";
import logger from "../utils/logger";

export type AtprotoIdentity = {
  did: string;
  signingKey: string;
  handle: string | null;
};

export type AtprotoDidErrorCode =
  | "unsupported_did"
  | "resolution_failed"
  | "invalid_document";

export class AtprotoDidError extends Error {
  code: AtprotoDidErrorCode;

  constructor(code: AtprotoDidErrorCode, message: string) {
    super(message);
    this.name = "AtprotoDidError";
    this.code = code;
  }
}

type CacheEntry =
  | { identity: AtprotoIdentity }
  | { failure: { code: AtprotoDidErrorCode; message: string } };

const DID_PLC_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const HANDLE_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HANDLE_LENGTH = 253;
const HANDLE_URI_PREFIX = "at://";
const FETCH_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 64 * 1024;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const FORCED_REFRESH_INTERVAL_MS = 30 * 1000;
const MAX_CACHED_DIDS = 10000;
const MAX_CONCURRENT_LOOKUPS = 10;
const MAX_LOOKUPS_PER_MINUTE = 120;
const LOOKUP_WINDOW_MS = 60 * 1000;

const identityCache = new LruCache<string, CacheEntry>({
  max: MAX_CACHED_DIDS,
});
const recentForcedRefreshes = new LruCache<string, boolean>({
  max: MAX_CACHED_DIDS,
  maxAge: FORCED_REFRESH_INTERVAL_MS,
});
const pendingLookups = new Map<string, Promise<AtprotoIdentity>>();
const lookupWindow = { start: 0, admitted: 0, refused: 0 };

export function isSupportedAtprotoDid(did: unknown): did is string {
  return typeof did === "string" && DID_PLC_PATTERN.test(did);
}

export function clearAtprotoIdentityCache(): void {
  identityCache.reset();
  recentForcedRefreshes.reset();
  pendingLookups.clear();
  lookupWindow.start = 0;
  lookupWindow.admitted = 0;
  lookupWindow.refused = 0;
}

// Every token naming a new DID costs one request to the directory, and the
// caller is not known to be genuine until that request has been answered.
function admitLookup(): boolean {
  const now = Date.now();
  if (now - lookupWindow.start >= LOOKUP_WINDOW_MS) {
    lookupWindow.start = now;
    lookupWindow.admitted = 0;
    lookupWindow.refused = 0;
  }
  if (
    pendingLookups.size < MAX_CONCURRENT_LOOKUPS &&
    lookupWindow.admitted < MAX_LOOKUPS_PER_MINUTE
  ) {
    lookupWindow.admitted += 1;
    return true;
  }
  lookupWindow.refused += 1;
  if (lookupWindow.refused === 1) {
    logger.warn("atproto DID lookups are being refused", {
      inFlight: pendingLookups.size,
      admittedThisMinute: lookupWindow.admitted,
    });
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidDocument(message: string): AtprotoDidError {
  return new AtprotoDidError("invalid_document", message);
}

function extractHandle(alsoKnownAs: unknown): string | null {
  if (!Array.isArray(alsoKnownAs)) return null;
  const entry = alsoKnownAs.find(
    (aka) => typeof aka === "string" && aka.startsWith(HANDLE_URI_PREFIX)
  );
  if (typeof entry !== "string") return null;
  const handle = entry.slice(HANDLE_URI_PREFIX.length).toLowerCase();
  return handle.length <= MAX_HANDLE_LENGTH && HANDLE_PATTERN.test(handle)
    ? handle
    : null;
}

function parseIdentity(did: string, body: string): AtprotoIdentity {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw invalidDocument("DID document is not valid JSON");
  }
  if (!isRecord(document)) {
    throw invalidDocument("DID document is not an object");
  }
  if (document.id !== did) {
    throw invalidDocument("DID document id does not match the requested DID");
  }

  const methods = Array.isArray(document.verificationMethod)
    ? document.verificationMethod
    : [];
  const method = methods.find(
    (candidate) =>
      isRecord(candidate) &&
      (candidate.id === `${did}#atproto` || candidate.id === "#atproto")
  );
  if (!isRecord(method)) {
    throw invalidDocument("DID document has no #atproto verification method");
  }
  if (
    method.type !== "Multikey" ||
    typeof method.publicKeyMultibase !== "string"
  ) {
    throw invalidDocument("#atproto verification method is not a Multikey");
  }
  try {
    parseMultikey(method.publicKeyMultibase);
  } catch {
    throw invalidDocument("#atproto verification method has an unusable key");
  }

  return {
    did,
    signingKey: `did:key:${method.publicKeyMultibase}`,
    handle: extractHandle(document.alsoKnownAs),
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (err) {
    logger.debug("atproto DID lookup: could not discard response body", err);
  }
}

async function readBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    await discardBody(response);
    throw invalidDocument("DID document is too large");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw invalidDocument("DID document is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchIdentity(did: string): Promise<AtprotoIdentity> {
  const { plcUrl } = Config.getAtprotoCreateSettings();
  try {
    const response = await fetch(`${plcUrl}/${did}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 410) {
      await discardBody(response);
      throw invalidDocument(
        `DID directory has no active document (status ${response.status})`
      );
    }
    if (response.status !== 200) {
      await discardBody(response);
      throw new AtprotoDidError(
        "resolution_failed",
        `DID directory answered with status ${response.status}`
      );
    }
    return parseIdentity(did, await readBody(response));
  } catch (err) {
    if (err instanceof AtprotoDidError) throw err;
    const cause =
      isRecord(err) && typeof err.name === "string"
        ? err.name
        : "unknown error";
    throw new AtprotoDidError(
      "resolution_failed",
      `DID directory request failed (${cause})`
    );
  }
}

function lookup(
  did: string,
  previous: CacheEntry | undefined
): Promise<AtprotoIdentity> {
  const pending = pendingLookups.get(did);
  if (pending) return pending;
  if (!admitLookup()) {
    return Promise.reject(
      new AtprotoDidError("resolution_failed", "too many DID lookups")
    );
  }

  const started = fetchIdentity(did)
    .then(
      (identity) => {
        identityCache.set(did, { identity }, SUCCESS_TTL_MS);
        return identity;
      },
      (err: AtprotoDidError) => {
        logger.warn("atproto DID lookup failed", {
          did,
          code: err.code,
          reason: err.message,
        });
        const keepPrevious =
          err.code === "resolution_failed" &&
          previous !== undefined &&
          "identity" in previous;
        if (!keepPrevious) {
          identityCache.set(
            did,
            { failure: { code: err.code, message: err.message } },
            FAILURE_TTL_MS
          );
        }
        throw err;
      }
    )
    .finally(() => {
      pendingLookups.delete(did);
    });
  pendingLookups.set(did, started);
  return started;
}

export async function resolveAtprotoIdentityWithSource(
  did: string,
  opts?: { forceRefresh?: boolean }
): Promise<{ identity: AtprotoIdentity; cached: boolean }> {
  if (!isSupportedAtprotoDid(did)) {
    throw new AtprotoDidError(
      "unsupported_did",
      "only did:plc identifiers are supported"
    );
  }

  const forced = opts?.forceRefresh === true;
  const entry = identityCache.get(did);
  if (entry) {
    const refreshInFlight = forced ? pendingLookups.get(did) : undefined;
    if (refreshInFlight) {
      return { identity: await refreshInFlight, cached: false };
    }
    if (!forced || recentForcedRefreshes.get(did)) {
      if ("failure" in entry) {
        throw new AtprotoDidError(entry.failure.code, entry.failure.message);
      }
      return { identity: entry.identity, cached: true };
    }
    recentForcedRefreshes.set(did, true);
  }

  try {
    return { identity: await lookup(did, entry), cached: false };
  } catch (err) {
    // A refresh the directory never answered has refreshed nothing, so the
    // next request must be allowed to try again.
    if (
      forced &&
      err instanceof AtprotoDidError &&
      err.code === "resolution_failed"
    ) {
      recentForcedRefreshes.del(did);
    }
    throw err;
  }
}

export async function resolveAtprotoIdentity(
  did: string,
  opts?: { forceRefresh?: boolean }
): Promise<AtprotoIdentity> {
  const { identity } = await resolveAtprotoIdentityWithSource(did, opts);
  return identity;
}

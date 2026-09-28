import { parseMultikey } from "@atproto/crypto";
import LruCache from "lru-cache";
import Config from "../config";
import logger from "../utils/logger";
import {
  OUTBOUND_TIMEOUT_MS,
  OutboundRequestError,
  OutboundResponse,
  discardBody,
  guardedFetch,
  readBody,
} from "./outbound-guard";

export type AtprotoIdentity = {
  did: string;
  signingKey: string;
  handle: string | null;
  pds: string | null;
};

export type AtprotoDidOptions = { allowDidWeb?: boolean };

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
const DID_WEB_PREFIX = "did:web:";
const DID_WEB_DOCUMENT_PATH = "/.well-known/did.json";
const DID_WEB_DOCUMENT_TYPES = "application/did+ld+json, application/json";
const HOSTNAME_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;
const HANDLE_URI_PREFIX = "at://";
const PDS_SERVICE_ID = "#atproto_pds";
const PDS_SERVICE_TYPE = "AtprotoPersonalDataServer";
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

function isHostname(value: string): boolean {
  return value.length <= MAX_HOSTNAME_LENGTH && HOSTNAME_PATTERN.test(value);
}

export function isCanonicalDidWeb(did: unknown): did is string {
  return (
    typeof did === "string" &&
    did.startsWith(DID_WEB_PREFIX) &&
    isHostname(did.slice(DID_WEB_PREFIX.length))
  );
}

export function isResolvableAtprotoDid(
  did: unknown,
  opts?: AtprotoDidOptions
): did is string {
  return (
    isSupportedAtprotoDid(did) ||
    (opts?.allowDidWeb === true && isCanonicalDidWeb(did))
  );
}

export function clearAtprotoIdentityCache(): void {
  identityCache.reset();
  recentForcedRefreshes.reset();
  pendingLookups.clear();
  lookupWindow.start = 0;
  lookupWindow.admitted = 0;
  lookupWindow.refused = 0;
}

// Every token naming a new DID costs one request to the directory or to the
// host of the DID, and the caller is not known to be genuine until that
// request has been answered.
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
  return isHostname(handle) ? handle : null;
}

function extractPds(did: string, services: unknown): string | null {
  if (!Array.isArray(services)) return null;
  const service = services.find(
    (candidate) =>
      isRecord(candidate) &&
      (candidate.id === PDS_SERVICE_ID ||
        candidate.id === `${did}${PDS_SERVICE_ID}`)
  );
  if (
    !isRecord(service) ||
    service.type !== PDS_SERVICE_TYPE ||
    typeof service.serviceEndpoint !== "string"
  ) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(service.serviceEndpoint);
  } catch {
    return null;
  }
  const isBareOrigin =
    (endpoint.protocol === "https:" || endpoint.protocol === "http:") &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    endpoint.pathname === "/" &&
    endpoint.search === "" &&
    endpoint.hash === "";
  return isBareOrigin ? endpoint.origin : null;
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
    pds: extractPds(did, document.service),
  };
}

async function requestFromDirectory(did: string): Promise<OutboundResponse> {
  const { plcUrl } = Config.getAtprotoCreateSettings();
  const response = await fetch(`${plcUrl}/${did}`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await discardBody(response);
    return { status: response.status, body: "" };
  }
  return { status: response.status, body: await readBody(response) };
}

function requestFromHost(did: string): Promise<OutboundResponse> {
  const host = did.slice(DID_WEB_PREFIX.length);
  return guardedFetch(`https://${host}${DID_WEB_DOCUMENT_PATH}`, {
    accept: DID_WEB_DOCUMENT_TYPES,
  });
}

async function fetchIdentity(did: string): Promise<AtprotoIdentity> {
  const fromHost = did.startsWith(DID_WEB_PREFIX);
  const source = fromHost ? "DID host" : "DID directory";
  try {
    const { status, body } = fromHost
      ? await requestFromHost(did)
      : await requestFromDirectory(did);
    if (status === 404 || status === 410) {
      throw invalidDocument(
        `${source} has no active document (status ${status})`
      );
    }
    if (status !== 200) {
      throw new AtprotoDidError(
        "resolution_failed",
        `${source} answered with status ${status}`
      );
    }
    return parseIdentity(did, body);
  } catch (err) {
    if (err instanceof AtprotoDidError) throw err;
    if (err instanceof OutboundRequestError) {
      if (err.code === "too_large") {
        throw invalidDocument("DID document is too large");
      }
      throw new AtprotoDidError(
        "resolution_failed",
        `${source} request failed (${err.message})`
      );
    }
    const cause =
      isRecord(err) && typeof err.name === "string"
        ? err.name
        : "unknown error";
    throw new AtprotoDidError(
      "resolution_failed",
      `${source} request failed (${cause})`
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
  opts?: AtprotoDidOptions & { forceRefresh?: boolean }
): Promise<{ identity: AtprotoIdentity; cached: boolean }> {
  if (!isResolvableAtprotoDid(did, opts)) {
    throw new AtprotoDidError(
      "unsupported_did",
      opts?.allowDidWeb === true
        ? "only did:plc and did:web identifiers are supported"
        : "only did:plc identifiers are supported"
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
  opts?: AtprotoDidOptions & { forceRefresh?: boolean }
): Promise<AtprotoIdentity> {
  const { identity } = await resolveAtprotoIdentityWithSource(did, opts);
  return identity;
}

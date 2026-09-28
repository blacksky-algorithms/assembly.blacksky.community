import { parseDidKey, verifySignature } from "@atproto/crypto";
import { createHash } from "crypto";
import Config from "../config";
import { failJson } from "../utils/fail";
import {
  AtprotoDidError,
  AtprotoIdentity,
  isSupportedAtprotoDid,
  resolveAtprotoIdentityWithSource,
} from "./atproto-did";

export type ServiceAuthErrorCode =
  | "polis_err_atproto_auth_missing"
  | "polis_err_atproto_auth_invalid"
  | "polis_err_atproto_auth_expired"
  | "polis_err_atproto_unsupported_did"
  | "polis_err_atproto_did_resolution_failed"
  | "polis_err_atproto_conversation_not_eligible";

export class ServiceAuthError extends Error {
  code: string;
  status: number;
  did?: string;

  constructor(
    code: ServiceAuthErrorCode,
    status: number,
    reason: string,
    did?: string
  ) {
    super(reason);
    this.name = "ServiceAuthError";
    this.code = code;
    this.status = status;
    this.did = did;
  }
}

type VerifiedClaims = {
  alg: string;
  iss: string;
  jti: string | null;
  signedData: Uint8Array;
  signature: Uint8Array;
};

const MAX_TOKEN_BYTES = 4096;
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const SUPPORTED_ALGS = ["ES256K", "ES256"];
const FORBIDDEN_TYPS = ["at+jwt", "refresh+jwt", "dpop+jwt"];
const EXPIRY_SKEW_SECONDS = 10;
const MAX_SECONDS_UNTIL_EXPIRY = 300;
const MAX_IAT_SECONDS_AHEAD = 60;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

function invalid(reason: string): ServiceAuthError {
  return new ServiceAuthError("polis_err_atproto_auth_invalid", 401, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8")
    );
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function checkClaims(
  token: string,
  opts: { aud: string; lxm: string; nowSeconds?: number }
): VerifiedClaims {
  if (typeof token !== "string" || token.length === 0) {
    throw invalid("malformed_token");
  }
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw invalid("token_too_large");
  }
  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    !segments.every((segment) => SEGMENT_PATTERN.test(segment))
  ) {
    throw invalid("malformed_token");
  }

  const signature = Buffer.from(segments[2], "base64url");
  if (signature.toString("base64url") !== segments[2]) {
    throw invalid("malformed_token");
  }

  const header = decodeJsonSegment(segments[0]);
  if (!header) {
    throw invalid("malformed_header");
  }
  const alg = header.alg;
  if (typeof alg !== "string" || !SUPPORTED_ALGS.includes(alg)) {
    throw invalid("unsupported_alg");
  }
  if (
    typeof header.typ === "string" &&
    FORBIDDEN_TYPS.includes(header.typ.toLowerCase())
  ) {
    throw invalid("forbidden_typ");
  }
  if (header.crit !== undefined) {
    throw invalid("unsupported_crit");
  }

  const payload = decodeJsonSegment(segments[1]);
  if (!payload) {
    throw invalid("malformed_payload");
  }
  const { iss, aud, lxm, exp, iat, nbf, jti } = payload;
  if (typeof iss !== "string") {
    throw invalid("missing_iss");
  }
  if (!isSupportedAtprotoDid(iss)) {
    throw new ServiceAuthError(
      "polis_err_atproto_unsupported_did",
      400,
      "unsupported_issuer"
    );
  }
  if (typeof aud !== "string" || aud !== opts.aud) {
    throw invalid("bad_audience");
  }
  if (lxm === undefined || lxm === null) {
    throw invalid("missing_lxm");
  }
  if (lxm !== opts.lxm) {
    throw invalid("bad_lxm");
  }

  const now = opts.nowSeconds ?? Date.now() / 1000;
  if (!isTimestamp(exp)) {
    throw invalid("bad_exp");
  }
  if (now > exp + EXPIRY_SKEW_SECONDS) {
    throw new ServiceAuthError(
      "polis_err_atproto_auth_expired",
      401,
      "expired"
    );
  }
  if (exp > now + MAX_SECONDS_UNTIL_EXPIRY) {
    throw invalid("exp_too_far_ahead");
  }
  if (iat !== undefined) {
    if (!isTimestamp(iat)) {
      throw invalid("bad_iat");
    }
    if (iat > now + MAX_IAT_SECONDS_AHEAD) {
      throw invalid("iat_in_future");
    }
  }
  if (nbf !== undefined) {
    if (!isTimestamp(nbf)) {
      throw invalid("bad_nbf");
    }
    if (nbf > now + EXPIRY_SKEW_SECONDS) {
      throw invalid("not_yet_valid");
    }
  }
  if (jti !== undefined && typeof jti !== "string") {
    throw invalid("bad_jti");
  }

  return {
    alg,
    iss,
    jti: typeof jti === "string" ? jti : null,
    signedData: Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"),
    signature,
  };
}

async function resolveIssuer(
  did: string,
  forceRefresh: boolean
): Promise<{ identity: AtprotoIdentity; cached: boolean }> {
  try {
    return await resolveAtprotoIdentityWithSource(did, { forceRefresh });
  } catch (err) {
    if (!(err instanceof AtprotoDidError)) throw err;
    if (err.code === "unsupported_did") {
      throw new ServiceAuthError(
        "polis_err_atproto_unsupported_did",
        400,
        "unsupported_issuer"
      );
    }
    if (err.code === "resolution_failed") {
      throw new ServiceAuthError(
        "polis_err_atproto_did_resolution_failed",
        503,
        "did_resolution_failed"
      );
    }
    throw invalid("issuer_has_no_usable_key");
  }
}

async function checkSignature(
  claims: VerifiedClaims,
  signingKey: string
): Promise<"ok" | "alg_does_not_match_key" | "bad_signature"> {
  try {
    if (parseDidKey(signingKey).jwtAlg !== claims.alg) {
      return "alg_does_not_match_key";
    }
    const valid = await verifySignature(
      signingKey,
      claims.signedData,
      claims.signature,
      { jwtAlg: claims.alg }
    );
    return valid ? "ok" : "bad_signature";
  } catch {
    return "bad_signature";
  }
}

export async function verifyServiceJwt(
  token: string,
  opts: {
    aud: string;
    lxm: string;
    nowSeconds?: number;
    admitIssuer?: (did: string) => boolean;
  }
): Promise<{
  did: string;
  handle: string | null;
  jti: string | null;
  tokenId: string;
}> {
  const claims = checkClaims(token, opts);
  if (opts.admitIssuer && !opts.admitIssuer(claims.iss)) {
    throw new ServiceAuthError(
      "polis_err_atproto_conversation_not_eligible",
      403,
      "issuer_not_listed",
      claims.iss
    );
  }

  let issuer = await resolveIssuer(claims.iss, false);
  let outcome = await checkSignature(claims, issuer.identity.signingKey);
  if (outcome !== "ok" && issuer.cached) {
    const refreshed = await resolveIssuer(claims.iss, true);
    if (refreshed.identity.signingKey !== issuer.identity.signingKey) {
      outcome = await checkSignature(claims, refreshed.identity.signingKey);
    }
    issuer = refreshed;
  }
  if (outcome !== "ok") {
    throw invalid(outcome);
  }

  return {
    did: claims.iss,
    handle: issuer.identity.handle,
    jti: claims.jti,
    tokenId: createHash("sha256").update(token, "utf8").digest("hex"),
  };
}

export function atprotoServiceAuth(lxm: string) {
  return async function atprotoServiceAuthMiddleware(
    req: {
      headers?: { authorization?: string };
      p?: Record<string, unknown>;
    },
    res: unknown,
    next: (err?: unknown) => void
  ): Promise<void> {
    const authorization = req.headers?.authorization;
    if (typeof authorization !== "string" || authorization.trim() === "") {
      failJson(res, 401, "polis_err_atproto_auth_missing");
      return;
    }

    let verified: { did: string; handle: string | null; tokenId: string };
    try {
      const bearer = BEARER_PATTERN.exec(authorization.trim());
      if (!bearer) {
        throw invalid("not_a_bearer_token");
      }
      const settings = Config.getAtprotoCreateSettings();
      verified = await verifyServiceJwt(bearer[1], {
        aud: settings.serviceDid,
        lxm,
        admitIssuer:
          settings.eligibility === "allowlist"
            ? (did) => settings.allowlist.includes(did)
            : undefined,
      });
    } catch (err) {
      if (err instanceof ServiceAuthError) {
        failJson(
          res,
          err.status,
          err.code,
          err.did ? { did: err.did, reason: err.message } : err
        );
        return;
      }
      failJson(res, 500, "polis_err_atproto_auth_failed", err);
      return;
    }

    req.p = req.p || {};
    req.p.atproto_did = verified.did;
    req.p.atproto_handle = verified.handle;
    req.p.atproto_token_id = verified.tokenId;
    next();
  };
}

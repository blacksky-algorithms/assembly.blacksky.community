import jwt from "jsonwebtoken";
import LruCache from "lru-cache";
import fs from "node:fs";
import pgLib from "pg";
import Config from "../config";
import logger from "../utils/logger";
import {
  MAX_SECONDS_TOKEN_IS_ACCEPTED,
  ServiceAuthError,
  readBearerToken,
  readClaimedIssuer,
  verifyServiceJwt,
} from "./atproto-service-auth";
import { failJson } from "../utils/fail";
import pg, { TransactionQuery, withTransaction } from "../db/pg-query";
import { isPolisDev } from "../utils/common";

// eslint-disable-next-line no-restricted-properties
const FEEDGEN_DATABASE_URL = process.env.FEEDGEN_DATABASE_URL || "";
// eslint-disable-next-line no-restricted-properties
const FEEDGEN_MEMBER_LIST = process.env.FEEDGEN_MEMBER_LIST || "blacksky";
let feedgenPool: pgLib.Pool | null = null;

export function getFeedgenPool(): pgLib.Pool {
  if (!feedgenPool) {
    // Strip sslmode from URL — we configure SSL via the pool options
    const connStr = FEEDGEN_DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, '');
    feedgenPool = new pgLib.Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
    // The pool attaches the whole client to the error it emits, so only the
    // message and code are logged.
    feedgenPool.on("error", (err: Error & { code?: string }) => {
      logger.error("feedgen_pool_idle_client_error", {
        error: err.message,
        code: err.code,
      });
    });
  }
  return feedgenPool;
}

export function isFeedgenConfigured(): boolean {
  return !!FEEDGEN_DATABASE_URL;
}

const JWT_ALGORITHM = "RS256" as const;
const JWT_EXPIRATION_SECONDS = 30 * 24 * 60 * 60; // 30 days

// AIP stores DIDs with this prefix in oidc_user_mappings
const AIP_DID_PREFIX = "oauth2|atproto|";

function getPrivateKey(): string {
  const keyPath = Config.jwtPrivateKeyPath;
  if (!keyPath) throw new Error("JWT_PRIVATE_KEY_PATH not configured");
  return fs.readFileSync(keyPath, "utf8");
}

export const ATPROTO_ADMIN_JWT_TYPE = "atproto_admin";
export const ATPROTO_ADMIN_PROOF = "atproto_service_auth";
export const ATPROTO_LOGIN_LXM = "community.blacksky.assembly.createSession";

const MAX_HNAME_LENGTH = 746;
const MAX_USERNAME_LENGTH = 128;
const MAX_EMAIL_LENGTH = 256;
const UNIQUE_VIOLATION = "23505";
const MAX_USED_TOKENS = 10000;

const usedLoginTokens = new LruCache<string, boolean>({
  max: MAX_USED_TOKENS,
  maxAge: MAX_SECONDS_TOKEN_IS_ACCEPTED * 1000,
});

type LoginParams = {
  did?: string;
  handle?: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
};

type ProvenAccount = { did: string; handle: string | null };

type JsonResponse = {
  status: (code: number) => { json: (body: unknown) => void };
};

export function logAtprotoLoginMode(): void {
  logger.warn("atproto admin login proof mode", {
    mode: Config.getAtprotoLoginSettings().proof,
  });
}

function issueAdminJWT(uid: number, did: string, proven: boolean): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: did,
    uid,
    type: ATPROTO_ADMIN_JWT_TYPE,
    iss: "assembly.blacksky.community",
    aud: "users",
    iat: now,
    exp: now + JWT_EXPIRATION_SECONDS,
    ...(proven ? { proof: ATPROTO_ADMIN_PROOF } : {}),
  };

  return jwt.sign(payload, getPrivateKey(), { algorithm: JWT_ALGORITHM });
}

/**
 * Verify an atproto admin JWT and return the payload.
 */
export function verifyAtprotoAdminJWT(token: string): any {
  const keyPath = Config.jwtPublicKeyPath;
  if (!keyPath) throw new Error("JWT_PUBLIC_KEY_PATH not configured");
  const publicKey = fs.readFileSync(keyPath, "utf8");
  const payload = jwt.verify(token, publicKey, {
    algorithms: [JWT_ALGORITHM],
  }) as { proof?: unknown };
  if (
    Config.getAtprotoLoginSettings().proof === "required" &&
    payload.proof !== ATPROTO_ADMIN_PROOF
  ) {
    throw new Error("admin token was issued without proof of the account");
  }
  return payload;
}

/**
 * Check if a token is an atproto admin JWT.
 */
export function isAtprotoAdminJWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token) as any;
    return decoded?.type === ATPROTO_ADMIN_JWT_TYPE;
  } catch {
    return false;
  }
}

function cut(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

async function findUidByDid(
  query: TransactionQuery,
  did: string
): Promise<number | null> {
  const rows = await query(
    "SELECT uid FROM oidc_user_mappings WHERE oidc_sub = $1 OR oidc_sub = $2 ORDER BY (oidc_sub = $1) DESC LIMIT 1;",
    [did, `${AIP_DID_PREFIX}${did}`]
  );
  return rows.length > 0 ? rows[0].uid : null;
}

async function findOrCreateUser(
  did: string,
  profile: { handle: string | null; displayName?: string }
): Promise<{ uid: number; created: boolean }> {
  const hname = cut(
    profile.displayName || profile.handle || did,
    MAX_HNAME_LENGTH
  );
  const username = cut(profile.handle || did, MAX_USERNAME_LENGTH);
  try {
    return await withTransaction(async (query) => {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0));", [
        did,
      ]);
      const existing = await findUidByDid(query, did);
      if (existing !== null) {
        return { uid: existing, created: false };
      }
      const users = await query(
        "INSERT INTO users (hname, username, is_owner, created) VALUES ($1, $2, true, default) RETURNING uid;",
        [hname, username]
      );
      const uid: number = users[0].uid;
      await query(
        "INSERT INTO oidc_user_mappings (oidc_sub, uid) VALUES ($1, $2);",
        [did, uid]
      );
      return { uid, created: true };
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== UNIQUE_VIOLATION) {
      throw err;
    }
    const existing = await withTransaction((query) =>
      findUidByDid(query, did)
    );
    if (existing === null) {
      throw err;
    }
    return { uid: existing, created: false };
  }
}

async function storeEmail(
  uid: number,
  email: string | undefined
): Promise<void> {
  if (!email || !email.includes("@") || email.length > MAX_EMAIL_LENGTH) {
    return;
  }
  try {
    await withTransaction((query) =>
      query(
        "UPDATE users SET email = $2 WHERE uid = $1 AND email IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($2));",
        [uid, email]
      )
    );
  } catch (err) {
    // The database error quotes the address, so only its code is logged.
    logger.warn("atproto admin login: email was not stored", {
      uid,
      code: (err as { code?: unknown } | null)?.code,
    });
  }
}

class LoginDidMismatch extends Error {
  did: string;

  constructor(did: string) {
    super("polis_err_atproto_login_did_mismatch");
    this.name = "LoginDidMismatch";
    this.did = did;
  }
}

async function proveAccount(
  authorization: string,
  postedDid: string | undefined
): Promise<ProvenAccount> {
  const verified = await verifyServiceJwt(readBearerToken(authorization), {
    aud: Config.getAtprotoCreateSettings().serviceDid,
    lxm: ATPROTO_LOGIN_LXM,
    allowDidWeb: true,
  });
  if (postedDid && postedDid !== verified.did) {
    throw new LoginDidMismatch(verified.did);
  }
  if (usedLoginTokens.has(verified.tokenId)) {
    throw new ServiceAuthError(
      "polis_err_atproto_auth_replayed",
      401,
      "token_reused"
    );
  }
  usedLoginTokens.set(verified.tokenId, true);
  return { did: verified.did, handle: verified.handle };
}

/**
 * POST /api/v3/auth/atproto-login
 */
export async function handle_POST_atproto_login(
  req: { headers?: { authorization?: string }; p?: LoginParams },
  res: JsonResponse
): Promise<void> {
  const params = req.p ?? {};
  const mode = Config.getAtprotoLoginSettings().proof;
  const authorization = req.headers?.authorization;
  const presented =
    typeof authorization === "string" && authorization.trim() !== "";

  if (!presented && mode === "required") {
    failJson(res, 401, "polis_err_atproto_auth_missing");
    return;
  }

  try {
    let proven: ProvenAccount | null = null;
    if (presented) {
      try {
        proven = await proveAccount(authorization, params.did);
      } catch (err) {
        if (err instanceof LoginDidMismatch) {
          failJson(res, 400, "polis_err_atproto_login_did_mismatch", {
            did: err.did,
          });
          return;
        }
        const refusal = err instanceof ServiceAuthError ? err : null;
        const details = {
          did: readClaimedIssuer(authorization),
          reason: refusal ? refusal.message : "verification_failed",
        };
        if (mode === "required") {
          if (!refusal) {
            throw err;
          }
          failJson(res, refusal.status, refusal.code, details);
          return;
        }
        logger.warn("atproto admin login: proof was not accepted", details);
      }
    }

    const did = proven ? proven.did : params.did;
    const handle = proven ? proven.handle : params.handle;
    if (!did || (!proven && !handle)) {
      failJson(res, 400, "polis_err_atproto_login_missing_params");
      return;
    }

    const { uid, created } = await findOrCreateUser(did, {
      handle: handle || null,
      displayName: params.displayName,
    });
    if (created) {
      await storeEmail(uid, params.email);
    }

    const token = issueAdminJWT(uid, did, proven !== null);
    const entry = { did, uid, proof: proven !== null, mode };
    if (proven) {
      logger.info("atproto admin login", entry);
    } else {
      logger.warn("atproto admin login without proof", entry);
    }
    res.status(200).json({ token, uid });
  } catch (err) {
    failJson(res, 500, "polis_err_atproto_login", err);
  }
}

/**
 * GET /api/v3/auth/check-membership?did={did}
 *
 * Checks if a DID is a member of the Blacksky feed by querying the
 * rsky-feedgen read-only database directly.
 */
export async function handle_GET_check_membership(
  req: { p: { did: string } },
  res: any
) {
  const { did } = req.p;

  if (!did) {
    failJson(res, 400, "polis_err_check_membership_missing_did");
    return;
  }

  if (!FEEDGEN_DATABASE_URL) {
    // No feedgen DB configured — return not a member
    res.status(200).json({ member: false, lists: [] });
    return;
  }

  try {
    const pool = getFeedgenPool();
    const result = await pool.query(
      "SELECT list FROM membership WHERE did = $1 AND included = true",
      [did]
    );

    const lists = result.rows.map((r: any) => r.list);
    res.status(200).json({ member: lists.length > 0, lists });
  } catch (err) {
    logger.error("polis_err_check_membership", err);
    // Non-fatal — return not a member on error
    res.status(200).json({ member: false, lists: [] });
  }
}

/**
 * Batch check membership for multiple DIDs. Used by comment author lookup.
 */
export async function checkMembershipBatch(
  dids: string[]
): Promise<Set<string>> {
  if (!FEEDGEN_DATABASE_URL || dids.length === 0) {
    return new Set();
  }

  try {
    const pool = getFeedgenPool();
    const result = await pool.query(
      "SELECT DISTINCT did FROM membership WHERE did = ANY($1) AND included = true AND list = $2",
      [dids, FEEDGEN_MEMBER_LIST]
    );
    return new Set(result.rows.map((r: any) => r.did));
  } catch (err) {
    logger.warn("Failed to batch check membership", err);
    return new Set();
  }
}

// --- Open Collective Role Check ---

const OC_API_URL = "https://api.opencollective.com/graphql/v2/48bfae6881ed345f608594793c5e1bdd3fba9519";
const OC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OcRoleCache {
  funderEmails: Set<string>;  // BACKER role
  teamEmails: Set<string>;    // CONTRIBUTOR, ADMIN, ACCOUNTANT roles
}

let ocCache: OcRoleCache | null = null;
let ocCacheTimestamp = 0;

const OC_MEMBERS_QUERY = `
  query account($slug: String, $role: [MemberRole], $limit: Int, $offset: Int) {
    account(slug: $slug) {
      members(role: $role, limit: $limit, offset: $offset) {
        totalCount
        nodes {
          account {
            emails
          }
        }
      }
    }
  }
`;

export async function fetchOcMembersByRole(
  role: string,
): Promise<Set<string>> {
  const emails = new Set<string>();
  let offset = 0;
  let total = 0;

  do {
    const resp = await fetch(OC_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: OC_MEMBERS_QUERY,
        variables: { slug: "blacksky", role: [role], limit: 1000, offset },
      }),
    });
    const data = await resp.json();
    const members = data?.data?.account?.members;
    for (const node of members?.nodes || []) {
      for (const email of node?.account?.emails || []) {
        emails.add(email.toLowerCase());
      }
    }
    total = members?.totalCount || 0;
    offset += 1000;
  } while (offset < total);

  return emails;
}

async function refreshOcCache(): Promise<OcRoleCache> {
  const now = Date.now();
  if (ocCache && now - ocCacheTimestamp < OC_CACHE_TTL_MS) {
    return ocCache;
  }

  try {
    // Fetch all roles in parallel
    const [backers, contributors, admins, accountants] = await Promise.all([
      fetchOcMembersByRole("BACKER"),
      fetchOcMembersByRole("CONTRIBUTOR"),
      fetchOcMembersByRole("ADMIN"),
      fetchOcMembersByRole("ACCOUNTANT"),
    ]);

    const teamEmails = new Set<string>();
    for (const e of contributors) teamEmails.add(e);
    for (const e of admins) teamEmails.add(e);
    for (const e of accountants) teamEmails.add(e);

    ocCache = { funderEmails: backers, teamEmails };
    ocCacheTimestamp = now;
    logger.info(`Refreshed OC cache: ${backers.size} funders, ${teamEmails.size} team`);
    return ocCache;
  } catch (err) {
    logger.warn("Failed to fetch OC members", err);
    return ocCache || { funderEmails: new Set(), teamEmails: new Set() };
  }
}

/**
 * GET /api/v3/auth/check-funder?email={email}
 *
 * Returns funder (BACKER) and team (CONTRIBUTOR/ADMIN/ACCOUNTANT) status.
 */
export async function handle_GET_check_funder(
  req: { p: { email: string } },
  res: any
) {
  const { email } = req.p;

  if (!email) {
    res.status(200).json({ funder: false, team: false });
    return;
  }

  try {
    const cache = await refreshOcCache();
    const lowerEmail = email.toLowerCase();
    res.status(200).json({
      funder: cache.funderEmails.has(lowerEmail),
      team: cache.teamEmails.has(lowerEmail),
    });
  } catch (err) {
    logger.error("polis_err_check_funder", err);
    res.status(200).json({ funder: false, team: false });
  }
}

// --- OSS Supporter Check ---

import {
  isOssSupporter,
  ensureGithubCacheReady,
} from "./github-supporters";

// Kick off background cache build on module load
ensureGithubCacheReady();

/**
 * GET /api/v3/auth/check-oss-supporter?did={did}&handle={handle}&email={email}
 */
export async function handle_GET_check_oss_supporter(
  req: { p: { did?: string; handle?: string; email?: string } },
  res: any
) {
  const { did, handle, email } = req.p;
  ensureGithubCacheReady(); // Refresh if stale

  const supporter = isOssSupporter(did, handle, email);
  res.status(200).json({ supporter });
}

// --- Badge Overrides Admin API ---

const VALID_BADGES = ["blacksky_member", "blacksky_funder", "blacksky_team", "oss_supporter"];

/**
 * GET /api/v3/admin/badges?did={did}
 * Returns all badge overrides for a DID.
 */
export async function handle_GET_badges(
  req: { p: { did: string } },
  res: any
) {
  const { did } = req.p;
  if (!did) {
    failJson(res, 400, "polis_err_badges_missing_did");
    return;
  }

  try {
    const rows = (await pg.queryP(
      "SELECT badge, is_granted FROM badge_overrides WHERE did = $1",
      [did]
    )) as any[];
    res.status(200).json({ did, overrides: rows });
  } catch (err) {
    logger.error("polis_err_get_badges", err);
    failJson(res, 500, "polis_err_get_badges");
  }
}

/**
 * POST /api/v3/admin/badges
 * Grant or revoke a badge for a DID.
 * Body: { did, badge, is_granted }
 * is_granted=true → force badge on
 * is_granted=false → force badge off (prevents automatic re-addition)
 */
export async function handle_POST_badges(
  req: { p: { uid?: number; did: string; badge: string; is_granted: boolean } },
  res: any
) {
  const { uid, did, badge, is_granted } = req.p;

  if (!isPolisDev(uid)) {
    failJson(res, 403, "polis_err_badges_permission");
    return;
  }

  if (!did || !badge) {
    failJson(res, 400, "polis_err_badges_missing_params");
    return;
  }

  if (!VALID_BADGES.includes(badge)) {
    failJson(res, 400, `polis_err_badges_invalid_badge: ${badge}. Valid: ${VALID_BADGES.join(", ")}`);
    return;
  }

  try {
    await pg.queryP(
      `INSERT INTO badge_overrides (did, badge, is_granted)
       VALUES ($1, $2, $3)
       ON CONFLICT (did, badge) DO UPDATE SET is_granted = $3`,
      [did, badge, is_granted]
    );

    logger.info("Badge override set", { did, badge, is_granted, uid });
    res.status(200).json({ did, badge, is_granted });
  } catch (err) {
    logger.error("polis_err_post_badges", err);
    failJson(res, 500, "polis_err_post_badges");
  }
}

/**
 * DELETE /api/v3/admin/badges?did={did}&badge={badge}
 * Remove a badge override (returns to automatic detection).
 */
export async function handle_DELETE_badges(
  req: { p: { uid?: number; did: string; badge: string } },
  res: any
) {
  const { uid, did, badge } = req.p;

  if (!isPolisDev(uid)) {
    failJson(res, 403, "polis_err_badges_permission");
    return;
  }

  if (!did || !badge) {
    failJson(res, 400, "polis_err_badges_missing_params");
    return;
  }

  try {
    await pg.queryP(
      "DELETE FROM badge_overrides WHERE did = $1 AND badge = $2",
      [did, badge]
    );

    logger.info("Badge override removed", { did, badge, uid });
    res.status(200).json({ did, badge, removed: true });
  } catch (err) {
    logger.error("polis_err_delete_badges", err);
    failJson(res, 500, "polis_err_delete_badges");
  }
}

/**
 * Check badge overrides for a DID. Returns a map of badge → is_granted.
 * Used during login to merge with automatic detection.
 */
export async function getBadgeOverrides(
  did: string
): Promise<Record<string, boolean>> {
  try {
    const rows = (await pg.queryP(
      "SELECT badge, is_granted FROM badge_overrides WHERE did = $1",
      [did]
    )) as any[];

    const overrides: Record<string, boolean> = {};
    for (const row of rows) {
      overrides[row.badge] = row.is_granted;
    }
    return overrides;
  } catch {
    return {};
  }
}

import jwt from "jsonwebtoken";
import fs from "node:fs";
import pgLib from "pg";
import Config from "../config";
import logger from "../utils/logger";
import { getOrCreateUserIDFromOidcSub } from "./create-user";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";

// eslint-disable-next-line no-restricted-properties
const FEEDGEN_DATABASE_URL = process.env.FEEDGEN_DATABASE_URL || "";
let feedgenPool: pgLib.Pool | null = null;

function getFeedgenPool(): pgLib.Pool {
  if (!feedgenPool) {
    // Strip sslmode from URL — we configure SSL via the pool options
    const connStr = FEEDGEN_DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, '');
    feedgenPool = new pgLib.Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return feedgenPool;
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

function issueAdminJWT(uid: number, did: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: did,
    uid,
    type: ATPROTO_ADMIN_JWT_TYPE,
    iss: "assembly.blacksky.community",
    aud: "users",
    iat: now,
    exp: now + JWT_EXPIRATION_SECONDS,
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
  return jwt.verify(token, publicKey, { algorithms: [JWT_ALGORITHM] });
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

/**
 * Look up existing user by DID in oidc_user_mappings.
 * Checks both bare DID and AIP-prefixed format (oauth2|atproto|did:plc:xxx).
 */
async function findUidByDid(did: string): Promise<number | null> {
  const rows = (await pg.queryP(
    "SELECT uid FROM oidc_user_mappings WHERE oidc_sub = $1 OR oidc_sub = $2 LIMIT 1",
    [did, `${AIP_DID_PREFIX}${did}`]
  )) as any[];

  return rows.length > 0 ? rows[0].uid : null;
}

/**
 * POST /api/v3/auth/atproto-login
 *
 * Exchanges an atproto DID + email for a server-issued admin JWT.
 * Matches existing users by DID (oidc_user_mappings) or email (users table).
 * Creates a new user if no match is found.
 */
export async function handle_POST_atproto_login(
  req: { p: { did: string; handle: string; email?: string; displayName?: string; avatarUrl?: string } },
  res: any
) {
  const { did, handle, email, displayName } = req.p;

  if (!did || !handle) {
    failJson(res, 400, "polis_err_atproto_login_missing_params");
    return;
  }

  try {
    // First check for existing DID mapping (including AIP-prefixed format)
    let uid = await findUidByDid(did);

    if (uid) {
      logger.info("atproto admin login: found existing DID mapping", { did, uid });
    } else {
      // No DID mapping — use getOrCreateUserIDFromOidcSub which matches by email
      // Use the atproto account email if available, fall back to handle
      const userEmail = email || handle;
      uid = await getOrCreateUserIDFromOidcSub(did, {
        email: userEmail,
        name: displayName || handle,
        nickname: handle,
      });
      logger.info("atproto admin login: created/matched user", { did, handle, email: userEmail, uid });
    }

    const token = issueAdminJWT(uid, did);

    res.status(200).json({ token, uid });
  } catch (err) {
    logger.error("polis_err_atproto_login", err);
    failJson(res, 500, "polis_err_atproto_login");
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
      "SELECT DISTINCT did FROM membership WHERE did = ANY($1) AND included = true AND list = 'blacksky'",
      [dids]
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
  query account($slug: String, $role: MemberRole, $limit: Int, $offset: Int) {
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

async function fetchOcMembersByRole(
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
        variables: { slug: "blacksky", role, limit: 1000, offset },
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

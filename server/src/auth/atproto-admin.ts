import jwt from "jsonwebtoken";
import fs from "node:fs";
import Config from "../config";
import logger from "../utils/logger";
import { getOrCreateUserIDFromOidcSub } from "./create-user";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";

const JWT_ALGORITHM = "RS256" as const;
const JWT_EXPIRATION_SECONDS = 30 * 24 * 60 * 60; // 30 days

// AIP stores DIDs with this prefix in oidc_user_mappings
const AIP_DID_PREFIX = "oauth2|atproto|";

function getPrivateKey(): string {
  const keyPath = Config.jwtPrivateKeyPath;
  if (!keyPath) throw new Error("JWT_PRIVATE_KEY_PATH not configured");
  return fs.readFileSync(keyPath, "utf8");
}

function issueAdminJWT(uid: number, did: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: did,
    uid,
    iss: Config.authIssuer || "assembly.blacksky.community",
    aud: Config.authAudience || "users",
    iat: now,
    exp: now + JWT_EXPIRATION_SECONDS,
  };

  return jwt.sign(payload, getPrivateKey(), { algorithm: JWT_ALGORITHM });
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

import jwt from "jsonwebtoken";
import fs from "node:fs";
import Config from "../config";
import logger from "../utils/logger";
import { getOrCreateUserIDFromOidcSub } from "./create-user";
import { failJson } from "../utils/fail";

const JWT_ALGORITHM = "RS256" as const;
const JWT_EXPIRATION_SECONDS = 30 * 24 * 60 * 60; // 30 days

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
 * POST /api/v3/auth/atproto-login
 *
 * Exchanges an atproto DID for a server-issued admin JWT.
 * Creates a new user if the DID hasn't been seen before.
 * Reuses existing oidc_user_mappings table, treating DID as the oidc_sub.
 */
export async function handle_POST_atproto_login(
  req: { p: { did: string; handle: string; displayName?: string; avatarUrl?: string } },
  res: any
) {
  const { did, handle, displayName, avatarUrl } = req.p;

  if (!did || !handle) {
    failJson(res, 400, "polis_err_atproto_login_missing_params");
    return;
  }

  try {
    // Reuse existing user mapping logic — DID is the oidc_sub.
    // The handle serves as the email for user creation (since email is required by the schema).
    const uid = await getOrCreateUserIDFromOidcSub(did, {
      email: handle,
      name: displayName || handle,
      nickname: handle,
    });

    const token = issueAdminJWT(uid, did);

    logger.info("atproto admin login", { did, handle, uid });

    res.status(200).json({ token, uid });
  } catch (err) {
    logger.error("polis_err_atproto_login", err);
    failJson(res, 500, "polis_err_atproto_login");
  }
}

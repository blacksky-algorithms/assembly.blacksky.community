/**
 * Identity sync cron — pre-populates and updates the `identities` table
 * from external data sources. Runs periodically (configurable interval).
 */

import logger from "../utils/logger";
import pg from "../db/pg-query";
import {
  getFeedgenPool,
  isFeedgenConfigured,
  fetchOcMembersByRole,
} from "../auth/atproto-admin";
import { getGithubSupporterData } from "../auth/github-supporters";

// eslint-disable-next-line no-restricted-properties
const SYNC_INTERVAL_MS = Number(process.env.IDENTITY_SYNC_INTERVAL_MS) || 4 * 60 * 60 * 1000;
// eslint-disable-next-line no-restricted-properties
const PDS_EXPORT_URL = process.env.PDS_EXPORT_URL || "";
// eslint-disable-next-line no-restricted-properties
const PDS_EXPORT_PATH = process.env.PDS_EXPORT_PATH || "";
// eslint-disable-next-line no-restricted-properties
const FEEDGEN_MEMBER_LIST = process.env.FEEDGEN_MEMBER_LIST || "blacksky";

// ---------------------------------------------------------------------------
// Step 1: Sync PDS accounts (DID, email, handle)
// ---------------------------------------------------------------------------

async function syncPdsAccounts(now: number): Promise<void> {
  if (!PDS_EXPORT_URL && !PDS_EXPORT_PATH) {
    logger.info("identity-sync: PDS_EXPORT_URL/PDS_EXPORT_PATH not set, skipping PDS sync");
    return;
  }

  try {
    let rows: Array<{ did: string; handle: string; email: string }>;

    if (PDS_EXPORT_PATH) {
      // Read from local JSON file
      const fs = await import("node:fs/promises");
      const data = await fs.readFile(PDS_EXPORT_PATH, "utf-8");
      rows = JSON.parse(data);
    } else {
      const resp = await fetch(PDS_EXPORT_URL);
      if (!resp.ok) {
        logger.warn(`identity-sync: PDS export fetch failed: ${resp.status}`);
        return;
      }
      rows = (await resp.json()) as Array<{
        did: string;
        handle: string;
        email: string;
      }>;
    }

    logger.info(`identity-sync: PDS export returned ${rows.length} accounts`);

    // Batch upsert in chunks of 500
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const dids = chunk.map((r) => r.did);
      const emails = chunk.map((r) => r.email || null);
      const handles = chunk.map((r) => r.handle || null);

      await pg.queryP(
        `INSERT INTO identities (did, email, handle, source, created, modified)
         SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]),
                'pds', $4, $4
         ON CONFLICT (did) DO UPDATE SET
           email = COALESCE(identities.email, EXCLUDED.email),
           handle = COALESCE(EXCLUDED.handle, identities.handle),
           modified = $4`,
        [dids, emails, handles, now]
      );
    }

    logger.info(`identity-sync: PDS sync complete (${rows.length} accounts)`);
  } catch (err) {
    logger.error("identity-sync: PDS sync failed", err);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Sync membership from feedgen DB
// ---------------------------------------------------------------------------

async function syncMembership(now: number): Promise<void> {
  if (!isFeedgenConfigured()) {
    logger.info("identity-sync: FEEDGEN_DATABASE_URL not set, skipping membership sync");
    return;
  }

  try {
    const pool = getFeedgenPool();
    const result = await pool.query(
      "SELECT DISTINCT did FROM membership WHERE included = true AND list = $1",
      [FEEDGEN_MEMBER_LIST]
    );

    const memberDids = result.rows.map((r: { did: string }) => r.did);
    logger.info(`identity-sync: feedgen returned ${memberDids.length} members`);

    // Batch upsert in chunks
    const chunkSize = 1000;
    for (let i = 0; i < memberDids.length; i += chunkSize) {
      const chunk = memberDids.slice(i, i + chunkSize);

      await pg.queryP(
        `INSERT INTO identities (did, is_member, source, member_updated_at, created, modified)
         SELECT unnest($1::text[]), true, 'feedgen', $2, $2, $2
         ON CONFLICT (did) DO UPDATE SET
           is_member = true,
           member_updated_at = $2,
           modified = $2`,
        [chunk, now]
      );
    }

    // Clear lapsed members: anyone with is_member=true whose DID is NOT in the current set
    if (memberDids.length > 0) {
      await pg.queryP(
        `UPDATE identities
         SET is_member = false, member_updated_at = $2, modified = $2
         WHERE is_member = true
           AND did IS NOT NULL
           AND did != ALL($1::text[])`,
        [memberDids, now]
      );
    }

    logger.info(`identity-sync: membership sync complete (${memberDids.length} members)`);
  } catch (err) {
    logger.error("identity-sync: membership sync failed", err);
  }
}

// ---------------------------------------------------------------------------
// Step 3: Sync funders/team from fundraising platform
// ---------------------------------------------------------------------------

async function syncOpenCollective(now: number): Promise<void> {
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

    logger.info(
      `identity-sync: OC returned ${backers.size} funders, ${teamEmails.size} team`
    );

    // Upsert funders
    for (const email of backers) {
      await upsertByEmail(email, { is_funder: true, funder_updated_at: now }, "opencollective", now);
    }

    // Upsert team
    for (const email of teamEmails) {
      await upsertByEmail(email, { is_team: true, team_updated_at: now }, "opencollective", now);
    }

    // Clear stale funders: anyone marked is_funder whose email is not in current backers
    const allFunderEmails = Array.from(backers);
    if (allFunderEmails.length > 0) {
      await pg.queryP(
        `UPDATE identities
         SET is_funder = false, funder_updated_at = $2, modified = $2
         WHERE is_funder = true
           AND LOWER(email) != ALL($1::text[])
           AND (alt_email_1 IS NULL OR LOWER(alt_email_1) != ALL($1::text[]))
           AND (alt_email_2 IS NULL OR LOWER(alt_email_2) != ALL($1::text[]))`,
        [allFunderEmails, now]
      );
    }

    // Clear stale team
    const allTeamEmails = Array.from(teamEmails);
    if (allTeamEmails.length > 0) {
      await pg.queryP(
        `UPDATE identities
         SET is_team = false, team_updated_at = $2, modified = $2
         WHERE is_team = true
           AND LOWER(email) != ALL($1::text[])
           AND (alt_email_1 IS NULL OR LOWER(alt_email_1) != ALL($1::text[]))
           AND (alt_email_2 IS NULL OR LOWER(alt_email_2) != ALL($1::text[]))`,
        [allTeamEmails, now]
      );
    }

    logger.info("identity-sync: OC sync complete");
  } catch (err) {
    logger.error("identity-sync: OC sync failed", err);
  }
}

/**
 * Upsert an identity by email. Tries to match against email, alt_email_1,
 * alt_email_2 (case-insensitive). If no match, inserts a new row (no DID).
 */
async function upsertByEmail(
  email: string,
  updates: Record<string, unknown>,
  source: string,
  now: number
): Promise<void> {
  const lowerEmail = email.toLowerCase();

  // Try to find existing row by any email column
  const existing = (await pg.queryP(
    `SELECT id FROM identities
     WHERE LOWER(email) = $1
        OR LOWER(alt_email_1) = $1
        OR LOWER(alt_email_2) = $1
     LIMIT 1`,
    [lowerEmail]
  )) as Array<{ id: number }>;

  if (existing.length > 0) {
    // Update existing row
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = $${paramIdx}`);
      values.push(val);
      paramIdx++;
    }
    setClauses.push(`modified = $${paramIdx}`);
    values.push(now);
    paramIdx++;
    values.push(existing[0].id);

    await pg.queryP(
      `UPDATE identities SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
      values
    );
  } else {
    // Insert new email-only row
    await pg.queryP(
      `INSERT INTO identities (email, ${Object.keys(updates).join(", ")}, source, created, modified)
       VALUES ($1, ${Object.values(updates).map((_, i) => `$${i + 2}`).join(", ")}, $${Object.keys(updates).length + 2}, $${Object.keys(updates).length + 3}, $${Object.keys(updates).length + 3})`,
      [email, ...Object.values(updates), source, now]
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4: Sync OSS supporters from GitHub cache
// ---------------------------------------------------------------------------

async function syncGithubSupporters(now: number): Promise<void> {
  const ghData = getGithubSupporterData();
  if (!ghData) {
    logger.info("identity-sync: GitHub cache not ready, skipping OSS sync");
    return;
  }

  logger.info(
    `identity-sync: GitHub data: ${ghData.dids.size} DIDs, ${ghData.handles.size} handles, ${ghData.emails.size} emails`
  );

  // Upsert by DID
  for (const did of ghData.dids) {
    await pg.queryP(
      `INSERT INTO identities (did, is_oss_supporter, source, oss_updated_at, created, modified)
       VALUES ($1, true, 'github', $2, $2, $2)
       ON CONFLICT (did) DO UPDATE SET
         is_oss_supporter = true,
         oss_updated_at = $2,
         modified = $2`,
      [did, now]
    );
  }

  // Match by handle (update existing rows only)
  for (const handle of ghData.handles) {
    await pg.queryP(
      `UPDATE identities
       SET is_oss_supporter = true, oss_updated_at = $2, modified = $2
       WHERE LOWER(handle) = $1 AND (is_oss_supporter = false OR is_oss_supporter IS NULL)`,
      [handle.toLowerCase(), now]
    );
  }

  // Match by email (update existing rows only)
  for (const email of ghData.emails) {
    await pg.queryP(
      `UPDATE identities
       SET is_oss_supporter = true, oss_updated_at = $2, modified = $2
       WHERE (LOWER(email) = $1 OR LOWER(alt_email_1) = $1 OR LOWER(alt_email_2) = $1)
         AND (is_oss_supporter = false OR is_oss_supporter IS NULL)`,
      [email.toLowerCase(), now]
    );
  }

  logger.info("identity-sync: GitHub OSS sync complete");
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

async function syncIdentities(): Promise<void> {
  const startTime = Date.now();
  logger.info("identity-sync: starting...");

  try {
    const now = Date.now();

    await syncPdsAccounts(now);
    await syncMembership(now);
    await syncOpenCollective(now);
    await syncGithubSupporters(now);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`identity-sync: complete in ${elapsed}s`);
  } catch (err) {
    logger.error("identity-sync: failed", err);
  }
}

// ---------------------------------------------------------------------------
// Cron registration
// ---------------------------------------------------------------------------

/**
 * Manual trigger — exposed as POST /api/v3/admin/sync-identities
 */
export async function handle_POST_sync_identities(
  _req: unknown,
  res: { status: (code: number) => { json: (data: unknown) => void } }
): Promise<void> {
  try {
    await syncIdentities();
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error("identity-sync: manual trigger failed", err);
    res.status(500).json({ error: "sync failed" });
  }
}

export function startIdentitySyncCron(): void {
  logger.info(
    `identity-sync: cron registered (interval: ${SYNC_INTERVAL_MS / 1000 / 60} minutes)`
  );

  // Initial run after 30s delay (let other services start first)
  setTimeout(() => {
    syncIdentities().catch((err) =>
      logger.error("identity-sync: initial run failed", err)
    );
  }, 30_000);

  // Recurring
  setInterval(() => {
    syncIdentities().catch((err) =>
      logger.error("identity-sync: scheduled run failed", err)
    );
  }, SYNC_INTERVAL_MS);
}

/**
 * GitHub supporters cache — background job that builds lookup maps
 * for stargazers and contributors across all public blacksky-algorithms repos.
 *
 * Matches GitHub users to atproto identities via:
 * - Bluesky social account links (handle or DID)
 * - /profile/{handle_or_did} URLs on any domain
 * - Bare hostname URLs that are atproto handles
 * - Public email addresses
 * - Blog field as potential handle
 */

import logger from "../utils/logger";

// eslint-disable-next-line no-restricted-properties
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const ORG = "blacksky-algorithms";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_DELAY_MS = 100; // Be gentle with GitHub API

interface SupporterCache {
  dids: Set<string>;
  handles: Set<string>;
  emails: Set<string>;
  ready: boolean;
}

let cache: SupporterCache = {
  dids: new Set(),
  handles: new Set(),
  emails: new Set(),
  ready: false,
};
let cacheTimestamp = 0;
let refreshing = false;

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "assembly.blacksky.community",
  };
  if (GITHUB_TOKEN) {
    h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return h;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ghFetchPaginated(path: string): Promise<any[]> {
  const results: any[] = [];
  let page = 1;
  const headers = githubHeaders();

  while (true) {
    const url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 429) {
        logger.warn(`GitHub rate limited on ${path}, stopping pagination`);
        break;
      }
      logger.warn(`GitHub API error ${resp.status} on ${path}`);
      break;
    }

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
    await delay(FETCH_DELAY_MS);
  }

  return results;
}

/**
 * Extract atproto handle or DID from a URL.
 *
 * Handles:
 * - https://bsky.app/profile/handle.or.did
 * - https://any-domain/profile/handle.or.did
 * - https://handle.domain (bare hostname IS the handle)
 */
function extractAtprotoIdentity(
  url: string
): { type: "handle" | "did"; value: string } | null {
  if (!url) return null;

  try {
    // Normalize: add https if missing
    let normalized = url;
    if (!normalized.startsWith("http")) {
      normalized = `https://${normalized}`;
    }
    const parsed = new URL(normalized);

    // Check for /profile/{handle_or_did} path
    const profileMatch = parsed.pathname.match(/\/profile\/(.+?)(?:\/|$)/);
    if (profileMatch) {
      const identity = decodeURIComponent(profileMatch[1]);
      if (identity.startsWith("did:plc:") || identity.startsWith("did:web:")) {
        return { type: "did", value: identity };
      }
      if (isValidHandle(identity)) {
        return { type: "handle", value: identity.toLowerCase() };
      }
    }

    // Bare URL: hostname might be a handle (if no meaningful path)
    if (
      parsed.pathname === "/" ||
      parsed.pathname === ""
    ) {
      const hostname = parsed.hostname.toLowerCase();
      if (isValidHandle(hostname)) {
        return { type: "handle", value: hostname };
      }
    }
  } catch {
    // Not a valid URL, try as bare handle
    if (isValidHandle(url)) {
      return { type: "handle", value: url.toLowerCase() };
    }
  }

  return null;
}

/**
 * Basic handle validation: must look like a domain name.
 * At least one dot, only valid domain chars, no spaces.
 */
function isValidHandle(s: string): boolean {
  if (!s || s.length < 3 || s.length > 253) return false;
  if (!s.includes(".")) return false;
  if (s.includes(" ")) return false;
  // Must be valid domain-like: alphanumeric, dots, hyphens
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s);
}

async function fetchUserIdentities(username: string): Promise<{
  emails: string[];
  handles: string[];
  dids: string[];
}> {
  const emails: string[] = [];
  const handles: string[] = [];
  const dids: string[] = [];
  const headers = githubHeaders();

  try {
    // Fetch user profile
    const userResp = await fetch(`https://api.github.com/users/${username}`, {
      headers,
    });
    if (userResp.ok) {
      const user = await userResp.json();

      if (user.email) {
        emails.push(user.email.toLowerCase());
      }

      // Blog field might be a handle
      if (user.blog) {
        const id = extractAtprotoIdentity(user.blog);
        if (id) {
          if (id.type === "did") dids.push(id.value);
          else handles.push(id.value);
        }
      }
    }
    await delay(FETCH_DELAY_MS);

    // Fetch social accounts
    const socialsResp = await fetch(
      `https://api.github.com/users/${username}/social_accounts`,
      { headers }
    );
    if (socialsResp.ok) {
      const socials = await socialsResp.json();
      for (const s of socials) {
        const id = extractAtprotoIdentity(s.url);
        if (id) {
          if (id.type === "did") dids.push(id.value);
          else handles.push(id.value);
        }
      }
    }
    await delay(FETCH_DELAY_MS);
  } catch (err) {
    logger.debug(`Failed to fetch identities for ${username}`, err);
  }

  return { emails, handles, dids };
}

async function refreshCache(): Promise<void> {
  if (refreshing) return;
  refreshing = true;

  logger.info("Starting GitHub supporters cache refresh...");

  try {
    const newDids = new Set<string>();
    const newHandles = new Set<string>();
    const newEmails = new Set<string>();
    const allUsernames = new Set<string>();

    // 1. Get all public repos
    const repos = await ghFetchPaginated(`/orgs/${ORG}/repos?type=public`);
    logger.warn(`GitHub: Found ${repos.length} public repos`);

    if (repos.length === 0) {
      logger.warn("GitHub: No repos returned (likely rate limited), skipping cache refresh");
      return;
    }

    // 2. For each repo, get stargazers and contributors
    for (const repo of repos) {
      const repoName = repo.name;

      const [stargazers, contributors] = await Promise.all([
        ghFetchPaginated(`/repos/${ORG}/${repoName}/stargazers`),
        ghFetchPaginated(`/repos/${ORG}/${repoName}/contributors`),
      ]);

      for (const u of stargazers) {
        if (u.login) allUsernames.add(u.login);
      }
      for (const u of contributors) {
        if (u.login && u.type !== "Bot") allUsernames.add(u.login);
      }

      await delay(FETCH_DELAY_MS);
    }

    logger.info(
      `Found ${allUsernames.size} unique GitHub users across all repos`
    );

    // 3. Fetch identities for each user
    let processed = 0;
    for (const username of allUsernames) {
      const ids = await fetchUserIdentities(username);

      for (const d of ids.dids) newDids.add(d);
      for (const h of ids.handles) newHandles.add(h);
      for (const e of ids.emails) newEmails.add(e);

      processed++;
      if (processed % 100 === 0) {
        logger.info(
          `Processed ${processed}/${allUsernames.size} GitHub users`
        );
      }
    }

    if (allUsernames.size === 0) {
      logger.warn("GitHub: No users found, not updating cache");
      return;
    }

    cache = {
      dids: newDids,
      handles: newHandles,
      emails: newEmails,
      ready: true,
    };
    cacheTimestamp = Date.now();

    logger.warn(
      `GitHub supporters cache ready: ${newDids.size} DIDs, ${newHandles.size} handles, ${newEmails.size} emails from ${allUsernames.size} users`
    );
  } catch (err) {
    logger.error("Failed to refresh GitHub supporters cache", err);
  } finally {
    refreshing = false;
  }
}

/**
 * Check if a user is an OSS supporter by DID, handle, or email.
 */
export function isOssSupporter(
  did?: string,
  handle?: string,
  email?: string
): boolean {
  if (!cache.ready) return false;
  if (did && cache.dids.has(did)) return true;
  if (handle && cache.handles.has(handle.toLowerCase())) return true;
  if (email && cache.emails.has(email.toLowerCase())) return true;
  return false;
}

/**
 * Get the raw cache data for use by the identity sync cron.
 * Returns null if cache isn't ready yet.
 */
export function getGithubSupporterData(): {
  dids: Set<string>;
  handles: Set<string>;
  emails: Set<string>;
} | null {
  if (!cache.ready) return null;
  return { dids: cache.dids, handles: cache.handles, emails: cache.emails };
}

/**
 * Ensure cache is populated. Call on server startup or first request.
 */
export function ensureGithubCacheReady(): void {
  const now = Date.now();
  if (!cache.ready || now - cacheTimestamp > CACHE_TTL_MS) {
    // Fire and forget — don't block the caller
    refreshCache().catch((err) =>
      logger.error("Background GitHub cache refresh failed", err)
    );
  }
}

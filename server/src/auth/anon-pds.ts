/**
 * Server-side PDS session for anonymous/seed record writes.
 *
 * The assembly appview writes anonymous records (seed statements) to a
 * designated "anon" DID's repo. This is similar to how a PDS delegates
 * to a mod service DID.
 *
 * Env vars:
 * - ANON_DID: DID of the anon service account
 * - ANON_PDS: PDS URL for the anon account
 * - ANON_HANDLE: Handle for login
 * - ANON_APP_PASSWORD: App password for login
 */

// eslint-disable-next-line no-restricted-properties
const ANON_DID = process.env.ANON_DID || "";
// eslint-disable-next-line no-restricted-properties
const ANON_PDS = process.env.ANON_PDS || "";
// eslint-disable-next-line no-restricted-properties
const ANON_HANDLE = process.env.ANON_HANDLE || "";
// eslint-disable-next-line no-restricted-properties
const ANON_APP_PASSWORD = process.env.ANON_APP_PASSWORD || "";

import logger from "../utils/logger";

interface AnonSession {
  accessJwt: string;
  did: string;
}

let anonSession: AnonSession | null = null;

async function refreshAnonSession(): Promise<AnonSession | null> {
  if (!ANON_PDS || !ANON_HANDLE || !ANON_APP_PASSWORD) {
    logger.warn("Anon PDS not configured — seed statements won't publish to firehose");
    return null;
  }

  try {
    const resp = await fetch(`${ANON_PDS}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: ANON_HANDLE,
        password: ANON_APP_PASSWORD,
      }),
    });

    if (!resp.ok) {
      logger.error("Failed to create anon PDS session", { status: resp.status });
      return null;
    }

    const data = await resp.json();
    anonSession = {
      accessJwt: data.accessJwt,
      did: data.did,
    };

    logger.info("Anon PDS session established", { did: anonSession.did });
    return anonSession;
  } catch (err) {
    logger.error("Anon PDS session error", err);
    return null;
  }
}

async function getAnonSession(): Promise<AnonSession | null> {
  if (anonSession) return anonSession;
  return refreshAnonSession();
}

/**
 * Create an anonymous statement record in the anon DID's repo.
 */
export async function createAnonStatementRecord(params: {
  conversationUri: string;
  conversationCid: string;
  text: string;
}): Promise<{ uri: string; cid: string } | null> {
  const session = await getAnonSession();
  if (!session) return null;

  try {
    const resp = await fetch(
      `${ANON_PDS}/xrpc/com.atproto.repo.createRecord`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({
          repo: session.did,
          collection: "community.blacksky.assembly.statement",
          record: {
            $type: "community.blacksky.assembly.statement",
            conversation: {
              uri: params.conversationUri,
              cid: params.conversationCid,
            },
            text: params.text,
            anonymous: true,
            createdAt: new Date().toISOString(),
          },
        }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      // Session might be expired — refresh and retry once
      if (resp.status === 401) {
        anonSession = null;
        const newSession = await refreshAnonSession();
        if (!newSession) return null;

        const retry = await fetch(
          `${ANON_PDS}/xrpc/com.atproto.repo.createRecord`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${newSession.accessJwt}`,
            },
            body: JSON.stringify({
              repo: newSession.did,
              collection: "community.blacksky.assembly.statement",
              record: {
                $type: "community.blacksky.assembly.statement",
                conversation: {
                  uri: params.conversationUri,
                  cid: params.conversationCid,
                },
                text: params.text,
                anonymous: true,
                createdAt: new Date().toISOString(),
              },
            }),
          }
        );

        if (!retry.ok) {
          logger.error("Anon statement retry failed", { status: retry.status });
          return null;
        }

        const retryData = await retry.json();
        return { uri: retryData.uri, cid: retryData.cid };
      }

      logger.error("Failed to create anon statement", { status: resp.status, body });
      return null;
    }

    const data = await resp.json();
    return { uri: data.uri, cid: data.cid };
  } catch (err) {
    logger.error("Anon statement record error", err);
    return null;
  }
}

// eslint-disable-next-line no-restricted-properties
const ANON_DID = process.env.ANON_DID || "";
// eslint-disable-next-line no-restricted-properties
const ANON_PDS = process.env.ANON_PDS || "";
// eslint-disable-next-line no-restricted-properties
const ANON_HANDLE = process.env.ANON_HANDLE || "";
// eslint-disable-next-line no-restricted-properties
const ANON_APP_PASSWORD = process.env.ANON_APP_PASSWORD || "";

import logger from "../utils/logger";

const STATEMENT_COLLECTION = "community.blacksky.assembly.statement";
const REQUEST_TIMEOUT_MS = 10000;
const STALE_SESSION_ERRORS = ["ExpiredToken", "InvalidToken"];

interface AnonSession {
  accessJwt: string;
  did: string;
}

interface PdsResponse {
  ok: boolean;
  status: number;
  body: string;
  data: Record<string, unknown> | null;
}

interface StatementRecordParams {
  rkey?: string;
  conversationUri: string;
  conversationCid: string;
  text: string;
  createdAt: string;
}

let anonSession: AnonSession | null = null;
let pendingSession: Promise<AnonSession | null> | null = null;

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function pdsPost(
  nsid: string,
  payload: unknown,
  accessJwt?: string
): Promise<PdsResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(`Anon PDS ${nsid} timed out after ${REQUEST_TIMEOUT_MS} ms`)
      );
    }, REQUEST_TIMEOUT_MS);
  });

  const send = async (): Promise<PdsResponse> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (accessJwt) {
      headers.Authorization = `Bearer ${accessJwt}`;
    }
    const resp = await fetch(`${ANON_PDS}/xrpc/${nsid}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      body,
      data: parseJson(body),
    };
  };

  try {
    return await Promise.race([send(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAnonSession(): Promise<AnonSession | null> {
  if (!ANON_PDS || !ANON_HANDLE || !ANON_APP_PASSWORD) {
    logger.warn("Anon PDS not configured — seed statements won't publish to firehose");
    return null;
  }

  try {
    const resp = await pdsPost("com.atproto.server.createSession", {
      identifier: ANON_HANDLE,
      password: ANON_APP_PASSWORD,
    });

    if (!resp.ok) {
      logger.error("Failed to create anon PDS session", { status: resp.status });
      return null;
    }

    const accessJwt = resp.data?.accessJwt;
    const did = resp.data?.did;
    if (typeof accessJwt !== "string" || typeof did !== "string") {
      logger.error("Anon PDS session response is incomplete", {
        status: resp.status,
      });
      return null;
    }

    if (ANON_DID && did !== ANON_DID) {
      logger.warn("Anon PDS session DID differs from ANON_DID", {
        configured: ANON_DID,
        did,
      });
    }

    anonSession = { accessJwt, did };

    logger.info("Anon PDS session established", { did: anonSession.did });
    return anonSession;
  } catch (err) {
    logger.error("Anon PDS session error", err);
    return null;
  }
}

function getAnonSession(): Promise<AnonSession | null> {
  if (anonSession) return Promise.resolve(anonSession);
  if (!pendingSession) {
    pendingSession = refreshAnonSession().finally(() => {
      pendingSession = null;
    });
  }
  return pendingSession;
}

function isStaleSession(resp: PdsResponse): boolean {
  if (resp.status === 401) return true;
  const error = resp.data?.error;
  return (
    resp.status === 400 &&
    typeof error === "string" &&
    STALE_SESSION_ERRORS.includes(error)
  );
}

function sendStatementRecord(
  session: AnonSession,
  params: StatementRecordParams
): Promise<PdsResponse> {
  const { rkey } = params;
  return pdsPost(
    `com.atproto.repo.${rkey === undefined ? "createRecord" : "putRecord"}`,
    {
      repo: session.did,
      collection: STATEMENT_COLLECTION,
      ...(rkey === undefined ? {} : { rkey }),
      record: {
        $type: STATEMENT_COLLECTION,
        conversation: {
          uri: params.conversationUri,
          cid: params.conversationCid,
        },
        text: params.text,
        anonymous: true,
        createdAt: params.createdAt,
      },
    },
    session.accessJwt
  );
}

async function writeStatementRecord(
  params: StatementRecordParams
): Promise<{ uri: string; cid: string } | null> {
  try {
    let session = await getAnonSession();
    if (!session) return null;

    let resp = await sendStatementRecord(session, params);

    if (isStaleSession(resp)) {
      if (anonSession === session) {
        anonSession = null;
      }
      session = await getAnonSession();
      if (!session) return null;

      resp = await sendStatementRecord(session, params);
      if (!resp.ok) {
        logger.error("Anon statement retry failed", { status: resp.status });
        return null;
      }
    } else if (!resp.ok) {
      logger.error("Failed to create anon statement", {
        status: resp.status,
        body: resp.body,
      });
      return null;
    }

    const uri = resp.data?.uri;
    const cid = resp.data?.cid;
    if (typeof uri !== "string" || typeof cid !== "string") {
      logger.error("Anon statement response is incomplete", {
        status: resp.status,
      });
      return null;
    }
    return { uri, cid };
  } catch (err) {
    logger.error("Anon statement record error", err);
    return null;
  }
}

export function getAnonDid(): string | null {
  return anonSession?.did || ANON_DID || null;
}

export async function ensureAnonSession(): Promise<boolean> {
  return (await getAnonSession()) !== null;
}

export async function createAnonStatementRecord(params: {
  conversationUri: string;
  conversationCid: string;
  text: string;
}): Promise<{ uri: string; cid: string } | null> {
  return writeStatementRecord({
    conversationUri: params.conversationUri,
    conversationCid: params.conversationCid,
    text: params.text,
    createdAt: new Date().toISOString(),
  });
}

export async function putAnonStatementRecord(params: {
  rkey: string;
  conversationUri: string;
  conversationCid: string;
  text: string;
  createdAt: string;
}): Promise<{ uri: string; cid: string } | null> {
  return writeStatementRecord({
    rkey: params.rkey,
    conversationUri: params.conversationUri,
    conversationCid: params.conversationCid,
    text: params.text,
    createdAt: params.createdAt,
  });
}

import { createHash } from "crypto";
import { checkMembershipBatch } from "../auth/atproto-admin";
import {
  ensureAnonSession,
  getAnonDid,
  putAnonStatementRecord,
} from "../auth/anon-pds";
import { generateTokenP } from "../auth/generate-token";
import { detectLanguage } from "../comment";
import Config from "../config";
import pg, { TransactionQuery, withTransaction } from "../db/pg-query";
import { failJson } from "../utils/fail";
import logger from "../utils/logger";
import { isValidTid, nextTid } from "../utils/tid";

export const ATPROTO_CREATE_CONVERSATION_LXM =
  "community.blacksky.assembly.createConversation";

export const ATPROTO_CONVERSATION_LIMITS = {
  topicGraphemes: 200,
  topicBytes: 1000,
  statements: 10,
  statementGraphemes: 400,
  statementBytes: 2000,
  statementCodeUnits: 997,
};

export const CONVERSATION_COLLECTION =
  "community.blacksky.assembly.conversation";
export const STATEMENT_COLLECTION = "community.blacksky.assembly.statement";
const MAX_RAW_TEXT_LENGTH = 4000;
const MAX_RAW_STATEMENTS = 100;
const MAX_AT_URI_LENGTH = 1024;
const MAX_AT_CID_LENGTH = 200;
const AT_URI_PATTERN =
  /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._:~-]{1,512})$/;
// CIDv1 in base32 with the dag-cbor codec and a sha-256 digest, the only form
// a record CID takes. The last character carries two padding bits.
const RECORD_CID_PATTERN = /^bafyrei[a-h][a-z2-7]{50}[aeimquy4]$/;
const UNPAIRED_SURROGATE_PATTERN = /\p{Cs}/u;
const CREATE_LOCK_KEY = 873791985;
const LOCK_WAIT_MILLIS = 5000;
const LOCK_NOT_AVAILABLE = "55P03";
const MIN_LOCK_WAIT_MILLIS = 100;
const MAX_QUEUED_CREATIONS = 20;
const DAY_MILLIS = 24 * 60 * 60 * 1000;
const HOUR_MILLIS = 60 * 60 * 1000;
const ZINVITE_LENGTH = 10;
const REPORT_TOKEN_LENGTH = 20;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type AtprotoConversationErrorCode =
  | "polis_err_atproto_conversation_topic_empty"
  | "polis_err_atproto_conversation_topic_too_long"
  | "polis_err_atproto_conversation_statements_count"
  | "polis_err_atproto_conversation_statement_empty"
  | "polis_err_atproto_conversation_statement_too_long"
  | "polis_err_atproto_conversation_statement_duplicate"
  | "polis_err_atproto_conversation_text_invalid"
  | "polis_err_atproto_record_uri_invalid"
  | "polis_err_atproto_record_cid_invalid"
  | "polis_err_atproto_record_did_mismatch";

export class AtprotoConversationError extends Error {
  code: AtprotoConversationErrorCode;
  status: number;

  constructor(code: AtprotoConversationErrorCode, status = 400) {
    super(code);
    this.name = "AtprotoConversationError";
    this.code = code;
    this.status = status;
  }
}

export type AtprotoConversationInput = {
  topic: string;
  statements: string[];
  atUri: string;
  atCid: string;
};

type CreationState = {
  existing: { zid: number; content_hash: string } | null;
  didCount: number;
  globalCount: number;
};

type SettledOutcome =
  | { decision: "conflict" }
  | { decision: "quota"; cap: "did" | "global" }
  | { decision: "replay"; zid: number };

type CreationOutcome =
  | SettledOutcome
  | { decision: "unavailable" }
  | { decision: "busy" }
  | { decision: "token_reused" }
  | {
      decision: "create";
      zid: number;
      conversationId: string;
      reportId: string;
    };

type DetectedLanguage = { lang: string | null; confidence: number | null };

type Quotas = { dailyCapPerDid: number; hourlyCapGlobal: number };

type JsonResponse = {
  status: (code: number) => { json: (body: unknown) => void };
};

export function getAtprotoStatements(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) {
    return Promise.reject("polis_fail_parse_statements_not_array");
  }
  if (value.length > MAX_RAW_STATEMENTS) {
    return Promise.reject("polis_fail_parse_statements_too_many");
  }
  for (const statement of value) {
    if (typeof statement !== "string") {
      return Promise.reject("polis_fail_parse_statement_not_string");
    }
    if (statement.length > MAX_RAW_TEXT_LENGTH) {
      return Promise.reject("polis_fail_parse_statement_too_long");
    }
  }
  return Promise.resolve(value);
}

export function getAtprotoConversationRef(
  value: unknown
): Promise<{ at_uri: string; at_cid: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Promise.reject("polis_fail_parse_conversation_not_object");
  }
  const { at_uri, at_cid } = value as Record<string, unknown>;
  if (typeof at_uri !== "string" || typeof at_cid !== "string") {
    return Promise.reject("polis_fail_parse_conversation_ref_missing");
  }
  if (at_uri.length > MAX_AT_URI_LENGTH || at_cid.length > MAX_AT_CID_LENGTH) {
    return Promise.reject("polis_fail_parse_conversation_ref_too_long");
  }
  return Promise.resolve({ at_uri, at_cid });
}

function countGraphemes(text: string): number {
  let count = 0;
  const segments = graphemes.segment(text)[Symbol.iterator]();
  while (!segments.next().done) {
    count += 1;
  }
  return count;
}

function normaliseText(value: string): string {
  if (value.includes("\u0000") || UNPAIRED_SURROGATE_PATTERN.test(value)) {
    throw new AtprotoConversationError(
      "polis_err_atproto_conversation_text_invalid"
    );
  }
  return value.normalize("NFC").trim();
}

function validateTopic(value: unknown): string {
  if (typeof value !== "string") {
    throw new AtprotoConversationError(
      "polis_err_atproto_conversation_topic_empty"
    );
  }
  const topic = normaliseText(value);
  if (topic.length === 0) {
    throw new AtprotoConversationError(
      "polis_err_atproto_conversation_topic_empty"
    );
  }
  if (
    Buffer.byteLength(topic, "utf8") > ATPROTO_CONVERSATION_LIMITS.topicBytes ||
    countGraphemes(topic) > ATPROTO_CONVERSATION_LIMITS.topicGraphemes
  ) {
    throw new AtprotoConversationError(
      "polis_err_atproto_conversation_topic_too_long"
    );
  }
  return topic;
}

function validateStatements(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ATPROTO_CONVERSATION_LIMITS.statements
  ) {
    throw new AtprotoConversationError(
      "polis_err_atproto_conversation_statements_count"
    );
  }
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (typeof raw !== "string") {
      throw new AtprotoConversationError(
        "polis_err_atproto_conversation_statement_empty"
      );
    }
    const statement = normaliseText(raw);
    if (statement.length === 0) {
      throw new AtprotoConversationError(
        "polis_err_atproto_conversation_statement_empty"
      );
    }
    if (
      statement.length > ATPROTO_CONVERSATION_LIMITS.statementCodeUnits ||
      Buffer.byteLength(statement, "utf8") >
        ATPROTO_CONVERSATION_LIMITS.statementBytes ||
      countGraphemes(statement) > ATPROTO_CONVERSATION_LIMITS.statementGraphemes
    ) {
      throw new AtprotoConversationError(
        "polis_err_atproto_conversation_statement_too_long"
      );
    }
    const key = statement.toLowerCase().normalize("NFC");
    if (seen.has(key)) {
      throw new AtprotoConversationError(
        "polis_err_atproto_conversation_statement_duplicate"
      );
    }
    seen.add(key);
    return statement;
  });
}

export function parseAtprotoRecordUri(
  value: unknown,
  collection: string
): { uri: string; did: string } | null {
  const match =
    typeof value === "string" && value.length <= MAX_AT_URI_LENGTH
      ? AT_URI_PATTERN.exec(value)
      : null;
  if (
    !match ||
    match[2] !== collection ||
    match[3] === "." ||
    match[3] === ".."
  ) {
    return null;
  }
  return { uri: match[0], did: match[1] };
}

function validateRecordUri(value: unknown, did: string): string {
  const record = parseAtprotoRecordUri(value, CONVERSATION_COLLECTION);
  if (!record) {
    throw new AtprotoConversationError("polis_err_atproto_record_uri_invalid");
  }
  if (record.did !== did) {
    throw new AtprotoConversationError(
      "polis_err_atproto_record_did_mismatch",
      403
    );
  }
  return record.uri;
}

export function isAtprotoRecordCid(value: unknown): value is string {
  return typeof value === "string" && RECORD_CID_PATTERN.test(value);
}

export function validateAtprotoConversationInput(
  raw: { topic?: unknown; statements?: unknown; conversation?: unknown },
  did: string
): AtprotoConversationInput {
  const topic = validateTopic(raw.topic);
  const statements = validateStatements(raw.statements);
  const ref =
    typeof raw.conversation === "object" && raw.conversation !== null
      ? (raw.conversation as Record<string, unknown>)
      : {};
  const atUri = validateRecordUri(ref.at_uri, did);
  if (!isAtprotoRecordCid(ref.at_cid)) {
    throw new AtprotoConversationError("polis_err_atproto_record_cid_invalid");
  }
  return { topic, statements, atUri, atCid: ref.at_cid };
}

export function hashAtprotoConversationContent(
  topic: string,
  statements: string[]
): string {
  return createHash("sha256")
    .update(JSON.stringify({ topic, statements }), "utf8")
    .digest("hex");
}

export function requireAtprotoCreateEnabled(
  req: unknown,
  res: unknown,
  next: () => void
): void {
  if (!Config.getAtprotoCreateSettings().enabled) {
    failJson(res, 503, "polis_err_atproto_conversations_disabled");
    return;
  }
  next();
}

const poolQuery: TransactionQuery = (sql, params = []) =>
  pg.queryP(sql, params) as ReturnType<TransactionQuery>;

async function isEligible(did: string): Promise<boolean> {
  const { eligibility, allowlist } = Config.getAtprotoCreateSettings();
  if (eligibility === "any") {
    return true;
  }
  if (eligibility === "members") {
    return (await checkMembershipBatch([did])).has(did);
  }
  return allowlist.includes(did);
}

async function readCreationState(
  query: TransactionQuery,
  did: string,
  atUri: string
): Promise<CreationState> {
  const existing = await query(
    "SELECT zid, content_hash FROM atproto_conversation_creations WHERE did = $1 AND at_uri = $2;",
    [did, atUri]
  );
  const didCount = await query(
    "SELECT COUNT(*)::int AS n FROM atproto_conversation_creations WHERE did = $1 AND created > now_as_millis() - $2::bigint;",
    [did, DAY_MILLIS]
  );
  const globalCount = await query(
    "SELECT COUNT(*)::int AS n FROM atproto_conversation_creations WHERE created > now_as_millis() - $1::bigint;",
    [HOUR_MILLIS]
  );
  return {
    existing: existing[0] || null,
    didCount: didCount[0].n,
    globalCount: globalCount[0].n,
  };
}

function settle(
  state: CreationState,
  contentHash: string,
  quotas: Quotas
): SettledOutcome | null {
  if (state.existing) {
    return state.existing.content_hash === contentHash
      ? { decision: "replay", zid: state.existing.zid }
      : { decision: "conflict" };
  }
  if (state.didCount >= quotas.dailyCapPerDid) {
    return { decision: "quota", cap: "did" };
  }
  if (state.globalCount >= quotas.hourlyCapGlobal) {
    return { decision: "quota", cap: "global" };
  }
  return null;
}

async function detectLanguages(
  statements: string[]
): Promise<DetectedLanguage[]> {
  return Promise.all(
    statements.map(async (statement) => {
      const detections = await detectLanguage(statement);
      const detection = Array.isArray(detections) ? detections[0] : detections;
      return { lang: detection.language, confidence: detection.confidence };
    })
  );
}

async function findOrCreateOwner(
  query: TransactionQuery,
  did: string
): Promise<number> {
  const owners = await query(
    "SELECT c.owner AS uid FROM atproto_conversation_creations a JOIN conversations c ON c.zid = a.zid WHERE a.did = $1 ORDER BY a.created, a.zid LIMIT 1;",
    [did]
  );
  if (owners.length > 0) {
    return owners[0].uid;
  }
  const created = await query(
    "INSERT INTO users (created) VALUES (default) RETURNING uid;"
  );
  return created[0].uid;
}

async function createConversation(
  query: TransactionQuery,
  did: string,
  input: AtprotoConversationInput,
  contentHash: string,
  languages: DetectedLanguage[],
  publisherDid: string,
  tokenId: string
): Promise<{ zid: number; conversationId: string; reportId: string }> {
  const uid = await findOrCreateOwner(query, did);

  const conversations = await query(
    `INSERT INTO conversations
      (owner, org_id, topic, description, is_active, is_draft, is_public, is_anon,
       strict_moderation, profanity_filter, spam_filter,
       auth_needed_to_vote, auth_needed_to_write, auth_opt_allow_3rdparty,
       at_uri, at_cid)
      VALUES ($1, $1, $2, '', true, false, true, false, true, true, true, true, true, true, $3, $4)
      RETURNING zid;`,
    [uid, input.topic, input.atUri, input.atCid]
  );
  const zid: number = conversations[0].zid;

  const conversationId = (await generateTokenP(
    ZINVITE_LENGTH,
    false
  )) as string;
  await query(
    "INSERT INTO zinvites (zid, zinvite, created, uuid) VALUES ($1, $2, default, gen_random_uuid());",
    [zid, conversationId]
  );

  await query("INSERT INTO participants_extended (zid, uid) VALUES ($1, $2);", [
    zid,
    uid,
  ]);
  const participants = await query(
    "INSERT INTO participants (pid, zid, uid, created) VALUES (NULL, $1, $2, default) RETURNING pid;",
    [zid, uid]
  );
  const pid: number = participants[0].pid;

  for (const [index, statement] of input.statements.entries()) {
    await query(
      `INSERT INTO comments
        (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence, at_uri, at_cid)
        VALUES ($1, $2, $3, 1, true, 1, $4, false, true, default, null, $5, $6, $7, NULL);`,
      [
        pid,
        zid,
        statement,
        uid,
        languages[index].lang,
        languages[index].confidence,
        `at://${publisherDid}/${STATEMENT_COLLECTION}/${nextTid()}`,
      ]
    );
  }

  const reportId = `r${await generateTokenP(REPORT_TOKEN_LENGTH, false)}`;
  await query("INSERT INTO reports (zid, report_id) VALUES ($1, $2);", [
    zid,
    reportId,
  ]);

  await query(
    "INSERT INTO atproto_conversation_creations (zid, did, at_uri, content_hash, token_id) VALUES ($1, $2, $3, $4, $5);",
    [zid, did, input.atUri, contentHash, tokenId]
  );

  return { zid, conversationId, reportId };
}

function statementRkey(atUri: unknown): string | null {
  if (typeof atUri !== "string") {
    return null;
  }
  const rkey = atUri.slice(atUri.lastIndexOf("/") + 1);
  return isValidTid(rkey) ? rkey : null;
}

async function publishSeed(zid: number, tid: number): Promise<boolean> {
  const rows = await poolQuery(
    `SELECT c.txt, c.created, c.active, c.mod, c.at_uri, c.at_cid,
            v.is_active, v.at_uri AS conversation_uri, v.at_cid AS conversation_cid
       FROM comments c JOIN conversations v ON v.zid = c.zid
      WHERE c.zid = $1 AND c.tid = $2;`,
    [zid, tid]
  );
  const seed = rows[0];
  if (!seed || seed.at_cid) {
    return true;
  }
  if (!seed.active || seed.mod === -1 || !seed.is_active) {
    logger.info("atproto statement record skipped", { zid, tid });
    return true;
  }

  const rkey = statementRkey(seed.at_uri);
  const created = Number(seed.created ?? NaN);
  if (
    rkey === null ||
    !Number.isFinite(created) ||
    !seed.conversation_uri ||
    !seed.conversation_cid
  ) {
    logger.error("atproto statement record cannot be built", { zid, tid });
    return false;
  }

  const record = await putAnonStatementRecord({
    rkey,
    conversationUri: seed.conversation_uri,
    conversationCid: seed.conversation_cid,
    text: seed.txt,
    createdAt: new Date(created).toISOString(),
  });
  if (!record) {
    return false;
  }
  if (record.uri !== seed.at_uri) {
    logger.warn("atproto statement record written to another address", {
      zid,
      tid,
      expected: seed.at_uri,
      actual: record.uri,
    });
  }
  await poolQuery(
    "UPDATE comments SET at_uri = $1, at_cid = $2 WHERE zid = $3 AND tid = $4;",
    [record.uri, record.cid, zid, tid]
  );
  return true;
}

type StatementRecordRef = { at_uri: string; at_cid: string };

function isServiceAccountUri(atUri: unknown, publisherDid: string): boolean {
  return (
    typeof atUri === "string" &&
    atUri.startsWith(`at://${publisherDid}/${STATEMENT_COLLECTION}/`)
  );
}

// A statement without a record cannot be voted on from the app when the
// conversation needs sign-in, so the service account publishes one for it.
export async function ensureStatementRecord(
  zid: number,
  tid: number
): Promise<StatementRecordRef | null> {
  const rows = await poolQuery(
    `SELECT c.at_uri, c.at_cid, v.at_uri AS conversation_uri, v.at_cid AS conversation_cid
       FROM comments c JOIN conversations v ON v.zid = c.zid
      WHERE c.zid = $1 AND c.tid = $2;`,
    [zid, tid]
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (row.at_uri && row.at_cid) {
    return { at_uri: row.at_uri, at_cid: row.at_cid };
  }
  if (!row.conversation_uri || !row.conversation_cid) {
    return null;
  }
  const publisherDid = (await ensureAnonSession()) ? getAnonDid() : null;
  if (!publisherDid) {
    return null;
  }
  if (row.at_uri && !isServiceAccountUri(row.at_uri, publisherDid)) {
    return null;
  }
  if (!row.at_uri) {
    await poolQuery(
      "UPDATE comments SET at_uri = $1 WHERE zid = $2 AND tid = $3 AND at_uri IS NULL;",
      [`at://${publisherDid}/${STATEMENT_COLLECTION}/${nextTid()}`, zid, tid]
    );
  }
  if (!(await publishSeed(zid, tid))) {
    return null;
  }
  const after = await poolQuery(
    "SELECT at_uri, at_cid FROM comments WHERE zid = $1 AND tid = $2;",
    [zid, tid]
  );
  return after[0]?.at_uri && after[0]?.at_cid
    ? { at_uri: after[0].at_uri, at_cid: after[0].at_cid }
    : null;
}

export async function withStatementRecord<
  T extends { tid?: unknown; at_uri?: unknown; at_cid?: unknown }
>(
  zid: number,
  authNeededToVote: unknown,
  statement: T | null
): Promise<T | null> {
  if (
    !statement ||
    !authNeededToVote ||
    typeof statement.tid !== "number" ||
    (statement.at_uri && statement.at_cid)
  ) {
    return statement;
  }
  try {
    const ref = await ensureStatementRecord(zid, statement.tid);
    return ref ? { ...statement, ...ref } : statement;
  } catch (err) {
    logger.error("atproto statement record for a voter failed", err);
    return statement;
  }
}

async function publishPendingSeeds(zid: number): Promise<boolean> {
  const pendingSql =
    "SELECT tid FROM comments WHERE zid = $1 AND is_seed = true AND at_uri IS NOT NULL AND at_cid IS NULL ORDER BY tid;";
  try {
    const pending = await poolQuery(pendingSql, [zid]);
    for (const { tid } of pending) {
      if (!(await publishSeed(zid, tid))) {
        return false;
      }
    }
    const remaining = await poolQuery(pendingSql, [zid]);
    return remaining.length === 0;
  } catch (err) {
    logger.error("atproto statement records failed", err);
    return false;
  }
}

async function readPublicIds(
  zid: number
): Promise<{ conversationId: string; reportId: string } | null> {
  const rows = await poolQuery(
    `SELECT
      (SELECT zinvite FROM zinvites WHERE zid = $1 ORDER BY created, zinvite LIMIT 1) AS conversation_id,
      (SELECT report_id FROM reports WHERE zid = $1 ORDER BY created, rid LIMIT 1) AS report_id;`,
    [zid]
  );
  const { conversation_id, report_id } = rows[0];
  if (!conversation_id || !report_id) {
    return null;
  }
  return { conversationId: conversation_id, reportId: report_id };
}

let creationQueue: Promise<unknown> = Promise.resolve();
let queuedCreations = 0;

// An open transaction holds a pooled connection while it waits for the lock,
// so creations wait here and take one connection between them. The time spent
// here counts towards the time a creation may wait for the lock.
function inCreationQueue(
  work: (lockWaitMillis: number) => Promise<CreationOutcome>
): Promise<CreationOutcome> {
  if (queuedCreations >= MAX_QUEUED_CREATIONS) {
    return Promise.resolve({ decision: "busy" });
  }
  queuedCreations += 1;
  const queuedAt = Date.now();
  const outcome = creationQueue.then(
    (): CreationOutcome | Promise<CreationOutcome> => {
      const lockWaitMillis = LOCK_WAIT_MILLIS - (Date.now() - queuedAt);
      return lockWaitMillis < MIN_LOCK_WAIT_MILLIS
        ? { decision: "busy" }
        : work(lockWaitMillis);
    }
  );
  creationQueue = outcome.then(
    () => undefined,
    () => undefined
  );
  return outcome.finally(() => {
    queuedCreations -= 1;
  });
}

async function reserveConversation(
  did: string,
  input: AtprotoConversationInput,
  tokenId: string
): Promise<CreationOutcome> {
  const contentHash = hashAtprotoConversationContent(
    input.topic,
    input.statements
  );
  const quotas: Quotas = Config.getAtprotoCreateSettings();

  // Read without the lock first, so that a resent, conflicting or over-quota
  // request costs no language detection and never waits for the lock.
  const early = settle(
    await readCreationState(poolQuery, did, input.atUri),
    contentHash,
    quotas
  );
  if (early) {
    return early;
  }

  const publisherDid = (await ensureAnonSession()) ? getAnonDid() : null;
  if (!publisherDid) {
    return { decision: "unavailable" };
  }
  const languages = await detectLanguages(input.statements);

  return inCreationQueue((lockWaitMillis) =>
    lockAndCreate(
      did,
      input,
      contentHash,
      quotas,
      languages,
      publisherDid,
      lockWaitMillis,
      tokenId
    )
  );
}

function lockAndCreate(
  did: string,
  input: AtprotoConversationInput,
  contentHash: string,
  quotas: Quotas,
  languages: DetectedLanguage[],
  publisherDid: string,
  lockWaitMillis: number,
  tokenId: string
): Promise<CreationOutcome> {
  return withTransaction<CreationOutcome>(async (query) => {
    await query("SELECT set_config('lock_timeout', $1, true);", [
      String(lockWaitMillis),
    ]);
    await query("SELECT pg_advisory_xact_lock($1::bigint);", [CREATE_LOCK_KEY]);
    const settled = settle(
      await readCreationState(query, did, input.atUri),
      contentHash,
      quotas
    );
    if (settled) {
      return settled;
    }
    const reused = await query(
      "SELECT 1 FROM atproto_conversation_creations WHERE token_id = $1 LIMIT 1;",
      [tokenId]
    );
    if (reused.length > 0) {
      return { decision: "token_reused" };
    }
    const created = await createConversation(
      query,
      did,
      input,
      contentHash,
      languages,
      publisherDid,
      tokenId
    );
    return { decision: "create", ...created };
  });
}

async function createOrResume(
  did: string,
  input: AtprotoConversationInput,
  tokenId: string,
  res: JsonResponse
): Promise<void> {
  const outcome = await reserveConversation(did, input, tokenId);
  if (outcome.decision === "token_reused") {
    failJson(res, 401, "polis_err_atproto_auth_replayed", { did });
    return;
  }
  if (outcome.decision === "conflict") {
    failJson(res, 409, "polis_err_atproto_conversation_idempotency_mismatch", {
      did,
    });
    return;
  }
  if (outcome.decision === "quota") {
    failJson(res, 429, "polis_err_atproto_conversation_quota_exceeded", {
      did,
      cap: outcome.cap,
    });
    return;
  }
  if (outcome.decision === "unavailable") {
    failJson(res, 503, "polis_err_atproto_seed_publisher_unavailable", { did });
    return;
  }
  if (outcome.decision === "busy") {
    failJson(res, 503, "polis_err_atproto_conversation_busy", { did });
    return;
  }

  const created = outcome.decision === "create";
  const ids = created ? outcome : await readPublicIds(outcome.zid);
  if (!ids) {
    failJson(res, 410, "polis_err_atproto_conversation_removed", {
      did,
      zid: outcome.zid,
    });
    return;
  }
  if (created) {
    logger.info("atproto conversation created", {
      did,
      zid: outcome.zid,
      conversation_id: ids.conversationId,
    });
  }

  if (!(await publishPendingSeeds(outcome.zid))) {
    failJson(res, 503, "polis_err_atproto_statement_records_incomplete", {
      did,
      zid: outcome.zid,
    });
    return;
  }

  res.status(created ? 201 : 200).json({
    conversation_id: ids.conversationId,
    report_id: ids.reportId,
    created,
  });
}

export async function handle_POST_atproto_conversations(
  req: {
    p: {
      atproto_did?: unknown;
      atproto_token_id?: unknown;
      topic?: unknown;
      statements?: unknown;
      conversation?: unknown;
    };
  },
  res: JsonResponse
): Promise<void> {
  const did = req.p.atproto_did;
  const tokenId = req.p.atproto_token_id;
  if (
    typeof did !== "string" ||
    did.length === 0 ||
    typeof tokenId !== "string" ||
    tokenId.length === 0
  ) {
    failJson(res, 401, "polis_err_atproto_auth_missing");
    return;
  }

  try {
    const input = validateAtprotoConversationInput(req.p, did);
    if (!(await isEligible(did))) {
      failJson(res, 403, "polis_err_atproto_conversation_not_eligible", {
        did,
      });
      return;
    }
    await createOrResume(did, input, tokenId, res);
  } catch (err) {
    if (err instanceof AtprotoConversationError) {
      failJson(res, err.status, err.code, { did });
      return;
    }
    if ((err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) {
      failJson(res, 503, "polis_err_atproto_conversation_busy", { did });
      return;
    }
    failJson(res, 500, "polis_err_atproto_conversation_create_failed", err);
  }
}

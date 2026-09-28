import { getAnonDid } from "../auth/anon-pds";
import Config from "../config";
import pg from "../db/pg-query";
import { isModerator } from "../utils/common";
import { failJson } from "../utils/fail";
import logger from "../utils/logger";
import {
  CONVERSATION_COLLECTION,
  STATEMENT_COLLECTION,
  isAtprotoRecordCid,
  parseAtprotoRecordUri,
} from "./atproto-conversations";

const DID_PATTERN = /^did:[a-z]+:[A-Za-z0-9._:%-]+$/;

const CONVERSATION_STORE = {
  stored: "Stored conversation AT record",
  update:
    "UPDATE conversations SET at_uri = $2, at_cid = $3 WHERE zid = $1 AND at_uri IS NULL RETURNING zid;",
  select: "SELECT at_uri, at_cid FROM conversations WHERE zid = $1;",
};

const STATEMENT_STORE = {
  stored: "Stored statement AT record",
  update:
    "UPDATE comments SET at_uri = $3, at_cid = $4 WHERE zid = $1 AND tid = $2 AND at_uri IS NULL RETURNING tid;",
  select: "SELECT at_uri, at_cid FROM comments WHERE zid = $1 AND tid = $2;",
};

type RecordParams = {
  zid: number;
  uid?: number;
  pid?: number;
  xid?: unknown;
  admin_did?: unknown;
  jwt_conversation_mismatch?: boolean;
  at_uri?: unknown;
  at_cid?: unknown;
};

type RecordRef = { uri: string; cid: string; did: string };

type StoredRef = { at_uri: string | null; at_cid: string | null };

type StatementRow = { uid: number; pid: number; is_seed: boolean };

type LogContext = { zid: number; tid?: number; uid?: number };

function didOf(value: unknown): string | null {
  return typeof value === "string" && DID_PATTERN.test(value) ? value : null;
}

function readRecordRef(
  p: RecordParams,
  collection: string,
  res: unknown,
  context: LogContext
): RecordRef | null {
  const record = parseAtprotoRecordUri(p.at_uri, collection);
  if (!record) {
    failJson(res, 400, "polis_err_atproto_record_uri_invalid", context);
    return null;
  }
  if (!isAtprotoRecordCid(p.at_cid)) {
    failJson(res, 400, "polis_err_atproto_record_cid_invalid", context);
    return null;
  }
  return { uri: record.uri, cid: p.at_cid, did: record.did };
}

function refusesOtherRepo(
  p: RecordParams,
  ref: RecordRef,
  context: LogContext
): boolean {
  const callerDid = didOf(p.admin_did) ?? didOf(p.xid);
  if (callerDid === null || callerDid === ref.did) {
    return false;
  }
  if (Config.getAtprotoRecordSettings().enforceDidMatch) {
    return true;
  }
  logger.warn("polis_warn_atproto_record_did_mismatch", {
    ...context,
    caller_did: callerDid,
    record_did: ref.did,
  });
  return false;
}

async function storeOnce(
  res: any,
  store: typeof CONVERSATION_STORE,
  key: number[],
  ref: RecordRef,
  context: LogContext
): Promise<void> {
  const written = (await pg.queryP(store.update, [
    ...key,
    ref.uri,
    ref.cid,
  ])) as unknown[];
  if (written.length > 0) {
    logger.info(store.stored, { ...context, at_uri: ref.uri });
    res.status(200).json({ success: true });
    return;
  }
  // Read in a second statement: a request that lost the race against an
  // identical one must see the row the winner wrote.
  const current = (await pg.queryP(store.select, key)) as StoredRef[];
  if (current[0]?.at_uri !== ref.uri || current[0]?.at_cid !== ref.cid) {
    failJson(res, 409, "polis_err_atproto_record_already_set", context);
    return;
  }
  res.status(200).json({ success: true });
}

export async function handle_POST_conversation_record(
  req: { p: RecordParams },
  res: any
) {
  const { zid, uid } = req.p;
  const context = { zid, uid };

  try {
    if (!(await isModerator(zid, uid))) {
      failJson(
        res,
        403,
        "polis_err_atproto_conversation_record_permission",
        context
      );
      return;
    }
    const ref = readRecordRef(req.p, CONVERSATION_COLLECTION, res, context);
    if (!ref) {
      return;
    }
    if (refusesOtherRepo(req.p, ref, context)) {
      failJson(res, 403, "polis_err_atproto_record_did_mismatch", context);
      return;
    }
    await storeOnce(res, CONVERSATION_STORE, [zid], ref, context);
  } catch (err) {
    failJson(res, 500, "polis_err_store_conversation_record", err);
  }
}

export async function handle_POST_statement_record(
  req: { p: RecordParams & { tid: number } },
  res: any
) {
  const { zid, tid, uid, pid } = req.p;
  const context = { zid, tid, uid };

  try {
    const ref = readRecordRef(req.p, STATEMENT_COLLECTION, res, context);
    if (!ref) {
      return;
    }
    const statements = (await pg.queryP(
      "SELECT uid, pid, is_seed FROM comments WHERE zid = $1 AND tid = $2;",
      [zid, tid]
    )) as StatementRow[];
    const statement = statements[0];
    if (!statement) {
      failJson(res, 404, "polis_err_atproto_statement_not_found", context);
      return;
    }
    if (
      req.p.jwt_conversation_mismatch === true ||
      statement.is_seed ||
      statement.uid !== uid ||
      (pid !== undefined && statement.pid !== pid)
    ) {
      failJson(
        res,
        403,
        "polis_err_atproto_statement_record_permission",
        context
      );
      return;
    }
    if (ref.did === getAnonDid() || refusesOtherRepo(req.p, ref, context)) {
      failJson(res, 403, "polis_err_atproto_record_did_mismatch", context);
      return;
    }
    await storeOnce(res, STATEMENT_STORE, [zid, tid], ref, context);
  } catch (err) {
    failJson(res, 500, "polis_err_store_statement_record", err);
  }
}

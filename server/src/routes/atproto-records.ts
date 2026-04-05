/**
 * Endpoints for storing AT Protocol record URIs/CIDs after client-side record creation.
 * These enable strongRef backlinking between conversations, statements, and votes.
 */

import logger from "../utils/logger";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";

/**
 * POST /api/v3/atproto/conversation-record
 * Store the AT URI and CID for a conversation after creating the record in the owner's repo.
 */
export async function handle_POST_conversation_record(
  req: { p: { zid: number; at_uri: string; at_cid: string } },
  res: any
) {
  const { zid, at_uri, at_cid } = req.p;

  if (!zid || !at_uri || !at_cid) {
    failJson(res, 400, "polis_err_atproto_record_missing_params");
    return;
  }

  try {
    await pg.queryP(
      "UPDATE conversations SET at_uri = $1, at_cid = $2 WHERE zid = $3",
      [at_uri, at_cid, zid]
    );
    logger.info("Stored conversation AT record", { zid, at_uri });
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error("polis_err_store_conversation_record", err);
    failJson(res, 500, "polis_err_store_conversation_record");
  }
}

/**
 * POST /api/v3/atproto/statement-record
 * Store the AT URI and CID for a statement after creating the record in the participant's repo.
 */
export async function handle_POST_statement_record(
  req: { p: { zid: number; tid: number; at_uri: string; at_cid: string } },
  res: any
) {
  const { zid, tid, at_uri, at_cid } = req.p;

  if (!at_uri || !at_cid) {
    failJson(res, 400, "polis_err_atproto_record_missing_params");
    return;
  }

  try {
    await pg.queryP(
      "UPDATE comments SET at_uri = $1, at_cid = $2 WHERE zid = $3 AND tid = $4",
      [at_uri, at_cid, zid, tid]
    );
    logger.info("Stored statement AT record", { zid, tid, at_uri });
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error("polis_err_store_statement_record", err);
    failJson(res, 500, "polis_err_store_statement_record");
  }
}

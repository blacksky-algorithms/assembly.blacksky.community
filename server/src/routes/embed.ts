/**
 * Embed API endpoints for blacksky.community interactive embeds.
 *
 * These endpoints serve conversation data for inline voting in the
 * blacksky.community timeline. They support CORS from blacksky.community
 * and use the existing participation flow for authentication.
 */

import { getConversationInfo, getZidFromConversationId, createXidRecordByZid } from "../conversation";
import { getNextComment } from "../nextComment";
import { getComments } from "../comment";
import { createAnonUser } from "../auth/create-user";
import { getPidPromise } from "../user";
import logger from "../utils/logger";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";

/**
 * GET /api/v3/embed/conversation?conversation_id={id}
 *
 * Public endpoint — returns conversation metadata + first statement.
 * No auth required for reading.
 */
export async function handle_GET_embed_conversation(
  req: any,
  res: any
) {
  const { zid, conversation_id } = req.p;

  // Set permissive CORS for embed endpoint — this is a public read API
  const origin = req.headers?.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Credentials", "true");

  try {
    const conv = await getConversationInfo(zid);
    const nextComment = await getNextComment(zid, -1, [], undefined);

    res.status(200).json({
      conversation: {
        conversation_id,
        topic: conv.topic,
        description: conv.description,
        is_active: conv.is_active,
        auth_needed_to_vote: conv.auth_needed_to_vote,
        at_uri: conv.at_uri,
        at_cid: conv.at_cid,
      },
      nextComment: nextComment || null,
    });
  } catch (err) {
    logger.error("polis_err_embed_conversation", err);
    failJson(res, 500, "polis_err_embed_conversation");
  }
}

/**
 * POST /api/v3/embed/vote
 *
 * Verified vote endpoint. The client must create a vote record in their
 * repo FIRST, then submit the AT URI here. The server verifies the record
 * exists in the claimed DID's repo before accepting the vote.
 *
 * This prevents impersonation: only the DID owner can create records
 * in their repo (the PDS validates the signing key).
 *
 * Body: { conversation_id, tid, vote, vote_at_uri }
 */
export async function handle_POST_embed_vote(
  req: any,
  res: any
) {
  const { conversation_id, tid, vote, vote_at_uri } = req.p;

  // Set CORS
  const origin = req.headers?.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Credentials", "true");

  if (!conversation_id || tid === undefined || vote === undefined || !vote_at_uri) {
    failJson(res, 400, "polis_err_embed_vote_missing_params");
    return;
  }

  try {
    // 1. Parse the AT URI to extract the DID
    // Format: at://did:plc:xxx/community.blacksky.assembly.vote/tid
    const uriMatch = vote_at_uri.match(/^at:\/\/(did:[^/]+)\/community\.blacksky\.assembly\.vote\/(.+)$/);
    if (!uriMatch) {
      failJson(res, 400, "polis_err_embed_vote_invalid_uri");
      return;
    }
    const did = uriMatch[1];
    const rkey = uriMatch[2];

    // 2. Verify the record exists in the DID's repo by fetching it from their PDS
    // First resolve the DID to find the PDS
    let pdsEndpoint: string;
    try {
      let didDoc: any;
      if (did.startsWith("did:plc:")) {
        const plcResp = await fetch(`https://plc.directory/${did}`);
        if (!plcResp.ok) throw new Error("DID not found");
        didDoc = await plcResp.json();
      } else if (did.startsWith("did:web:")) {
        const domain = did.replace("did:web:", "").replace(/:/g, "/");
        const webResp = await fetch(`https://${domain}/.well-known/did.json`);
        if (!webResp.ok) throw new Error("DID doc not found");
        didDoc = await webResp.json();
      } else {
        failJson(res, 400, "polis_err_embed_vote_unsupported_did");
        return;
      }

      const pdsService = didDoc.service?.find(
        (s: any) => s.type === "AtprotoPersonalDataServer"
      );
      if (!pdsService?.serviceEndpoint) {
        failJson(res, 400, "polis_err_embed_vote_no_pds");
        return;
      }
      pdsEndpoint = pdsService.serviceEndpoint;
    } catch (err) {
      logger.error("Failed to resolve DID for vote verification", err);
      failJson(res, 400, "polis_err_embed_vote_did_resolution_failed");
      return;
    }

    // 3. Fetch the record from the PDS to verify it exists and matches
    const recordResp = await fetch(
      `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=community.blacksky.assembly.vote&rkey=${encodeURIComponent(rkey)}`
    );

    if (!recordResp.ok) {
      failJson(res, 403, "polis_err_embed_vote_record_not_found");
      return;
    }

    const record = await recordResp.json();
    const recordValue = record.value;

    // 4. Verify the record's vote value matches what was claimed
    if (recordValue.value !== vote) {
      failJson(res, 403, "polis_err_embed_vote_mismatch");
      return;
    }

    // 5. Now we know the DID owner actually created this vote record.
    // Resolve or create the participant and record the vote.
    const zid = await getZidFromConversationId(conversation_id);
    const conv = await getConversationInfo(zid);

    if (!conv.is_active) {
      failJson(res, 403, "polis_err_conversation_is_closed");
      return;
    }

    // Get or create xid record for this DID
    const xidRecords = (await pg.queryP(
      "SELECT uid FROM xids WHERE xid = $1 AND owner = (SELECT org_id FROM conversations WHERE zid = $2)",
      [did, zid]
    )) as any[];

    let uid: number;
    if (xidRecords.length > 0) {
      uid = xidRecords[0].uid;
    } else {
      uid = await createAnonUser();
      await createXidRecordByZid(zid, uid, did);
    }

    // Get or create participant
    let pid: number;
    const existingPid = await getPidPromise(zid, uid, true);
    if (existingPid === -1) {
      // Create participant
      const pidResult = (await pg.queryP(
        "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, now_as_millis()) RETURNING pid",
        [uid, zid]
      )) as any[];
      pid = pidResult[0].pid;
    } else {
      pid = existingPid;
    }

    // 6. Record the vote
    await pg.queryP(
      "INSERT INTO votes (pid, zid, tid, vote, weight_x_32767, created) VALUES ($1, $2, $3, $4, 0, default) RETURNING *",
      [pid, zid, tid, vote]
    );

    // 7. Get next comment for the voter
    const nextComment = await getNextComment(zid, pid, [], undefined);

    logger.info("Verified embed vote recorded", { did, zid, tid, vote, vote_at_uri });

    res.status(200).json({
      success: true,
      nextComment: nextComment || null,
      currentPid: pid,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      // Duplicate vote
      failJson(res, 409, "polis_err_vote_duplicate");
    } else {
      logger.error("polis_err_embed_vote", err);
      failJson(res, 500, "polis_err_embed_vote");
    }
  }
}

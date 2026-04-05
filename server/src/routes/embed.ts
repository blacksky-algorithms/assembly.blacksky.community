/**
 * Embed API endpoints for blacksky.community interactive embeds.
 *
 * These endpoints serve conversation data for inline voting in the
 * blacksky.community timeline. They support CORS from blacksky.community
 * and use the existing participation flow for authentication.
 */

import { getConversationInfo } from "../conversation";
import { getNextComment } from "../nextComment";
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

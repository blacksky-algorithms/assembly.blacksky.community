import crypto from "crypto";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import { isModerator } from "../utils/common";
import { failJson } from "../utils/fail";

function generateUuid(): string {
  return crypto.randomUUID();
}

// Define the response type
interface ConversationUuidResponse {
  conversation_uuid?: string;
  error?: string;
}

// Define the zinvite row type
interface ZinviteRow {
  uuid: string | null;
}

export async function handle_GET_conversationUuid(
  req: { p: { zid: number; uid?: number } },
  res: { json: (arg0: ConversationUuidResponse) => void }
) {
  const { zid, uid } = req.p;

  try {
    if (!(await isModerator(zid, uid))) {
      failJson(res, 403, "polis_err_conversation_uuid_permission");
      return;
    }

    // First, check if a UUID already exists for this conversation
    const queryResult = await pg.queryP_readOnly(
      "SELECT uuid FROM zinvites WHERE zid = $1",
      [zid]
    );
    const existingRows = queryResult as ZinviteRow[];

    if (existingRows.length === 0) {
      throw new Error(`No zinvite found for zid: ${zid}`);
    }

    let uuid = existingRows[0].uuid;

    // If no UUID exists, generate and store a new one
    if (!uuid) {
      uuid = generateUuid();
      await pg.queryP("UPDATE zinvites SET uuid = $1 WHERE zid = $2", [
        uuid,
        zid,
      ]);
    }

    res.json({
      conversation_uuid: uuid,
    });
  } catch (err) {
    // Log the error and send a 500 response
    logger.error(`Error retrieving/creating UUID for zid ${zid}:`, err);
    res.json({
      error: "Error retrieving or creating conversation UUID",
    });
  }
}

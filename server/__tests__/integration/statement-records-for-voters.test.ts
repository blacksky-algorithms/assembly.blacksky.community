import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";
import {
  ensureAnonSession,
  getAnonDid,
  putAnonStatementRecord,
} from "../../src/auth/anon-pds";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

jest.mock("../../src/auth/anon-pds", () => ({
  getAnonDid: jest.fn(),
  ensureAnonSession: jest.fn(),
  putAnonStatementRecord: jest.fn(),
  createAnonStatementRecord: jest.fn(),
}));

type PutParams = {
  rkey: string;
  conversationUri: string;
  conversationCid: string;
  text: string;
  createdAt: string;
};
type PutResult = { uri: string; cid: string } | null;

const mockedGetAnonDid = getAnonDid as jest.MockedFunction<typeof getAnonDid>;
const mockedEnsureAnonSession = ensureAnonSession as jest.MockedFunction<
  typeof ensureAnonSession
>;
const mockedPut = putAnonStatementRecord as unknown as jest.Mock<
  (params: PutParams) => Promise<PutResult>
>;

const runId = `${process.pid}_${Date.now()}`;
const SERVICE_DID = "did:plc:servicevoters000000000000";
const STATEMENT_COLLECTION = "community.blacksky.assembly.statement";
const CONVERSATION_URI = `at://did:plc:ownervoters00000000000000/community.blacksky.assembly.conversation/${runId}`;
const CONVERSATION_CID = `bafyconversation${runId}`;

type StatementRow = { at_uri: string | null; at_cid: string | null };

async function zidOf(conversationId: string): Promise<number> {
  const result = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  return result.rows[0].zid;
}

async function statementRow(zid: number, tid: number): Promise<StatementRow> {
  const result = await pool.query(
    "SELECT at_uri, at_cid FROM comments WHERE zid = $1 AND tid = $2",
    [zid, tid]
  );
  return result.rows[0];
}

async function addStatement(
  zid: number,
  text: string,
  ref: StatementRow = { at_uri: null, at_cid: null }
): Promise<number> {
  const users = await pool.query(
    "INSERT INTO users (created) VALUES (default) RETURNING uid"
  );
  const uid: number = users.rows[0].uid;
  const participants = await pool.query(
    "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, now_as_millis()) RETURNING pid",
    [uid, zid]
  );
  const comments = await pool.query(
    `INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, at_uri, at_cid)
     VALUES ($1, $2, $3, 1, true, 1, $4, false, false, default, null, $5, $6) RETURNING tid`,
    [participants.rows[0].pid, zid, text, uid, ref.at_uri, ref.at_cid]
  );
  return comments.rows[0].tid;
}

async function makeConversation(
  ownerAgent: Agent,
  topic: string,
  authNeededToVote: boolean
): Promise<{ conversationId: string; zid: number }> {
  const conversationId = await createConversation(ownerAgent, {
    topic,
    auth_needed_to_vote: authNeededToVote,
    auth_needed_to_write: authNeededToVote,
  });
  const zid = await zidOf(conversationId);
  await pool.query(
    "UPDATE conversations SET at_uri = $1, at_cid = $2 WHERE zid = $3",
    [CONVERSATION_URI, CONVERSATION_CID, zid]
  );
  return { conversationId, zid };
}

describe("statement records for voters in a sign-in conversation", () => {
  let ownerAgent: Agent;
  let publicAgent: Agent;
  let conversationId: string;
  let zid: number;

  beforeAll(async () => {
    const pooledUser = getPooledTestUser(1);
    ({ agent: ownerAgent } = await getJwtAuthenticatedAgent({
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    }));
    publicAgent = await newAgent();
    ({ conversationId, zid } = await makeConversation(
      ownerAgent,
      `Voter records ${runId}`,
      true
    ));
  });

  beforeEach(() => {
    mockedGetAnonDid.mockReset().mockReturnValue(SERVICE_DID);
    mockedEnsureAnonSession.mockReset().mockResolvedValue(true);
    mockedPut.mockReset().mockImplementation(async (params) => ({
      uri: `at://${SERVICE_DID}/${STATEMENT_COLLECTION}/${params.rkey}`,
      cid: `bafycid${params.rkey}`,
    }));
  });

  afterAll(async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
  });

  test("publishes a record for a statement without one before handing it to a voter", async () => {
    const text = `Statement without record ${runId}`;
    const tid = await addStatement(zid, text);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.tid).toBe(tid);
    const stored = await statementRow(zid, tid);
    expect(stored.at_uri).toMatch(
      new RegExp(`^at://${SERVICE_DID}/${STATEMENT_COLLECTION}/[2-7a-z]{13}$`)
    );
    expect(stored.at_cid).toBe(`bafycid${stored.at_uri!.split("/").pop()}`);
    expect(response.body.nextComment.at_uri).toBe(stored.at_uri);
    expect(response.body.nextComment.at_cid).toBe(stored.at_cid);
    expect(mockedPut.mock.calls).toEqual([
      [
        {
          rkey: stored.at_uri!.split("/").pop(),
          conversationUri: CONVERSATION_URI,
          conversationCid: CONVERSATION_CID,
          text,
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ],
    ]);
  });

  test("does not publish again for a statement that has its record", async () => {
    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.at_cid).toMatch(/^bafycid/);
    expect(mockedPut).toHaveBeenCalledTimes(0);
  });

  test("hands out the address through participationInit as well", async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
    const tid = await addStatement(zid, `Init statement ${runId}`);

    const response = await publicAgent.get(
      `/api/v3/participationInit?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.tid).toBe(tid);
    expect(response.body.nextComment.at_uri).toBe(
      (await statementRow(zid, tid)).at_uri
    );
    expect(response.body.nextComment.at_cid).toMatch(/^bafycid/);
    expect(mockedPut).toHaveBeenCalledTimes(1);
  });

  test("keeps the claimed address and publishes on the next request when the publisher fails", async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
    const tid = await addStatement(zid, `Retried statement ${runId}`);
    mockedPut.mockResolvedValueOnce(null);

    const first = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    const afterFirst = await statementRow(zid, tid);
    const second = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    const afterSecond = await statementRow(zid, tid);

    expect(first.status).toBe(200);
    expect(first.body.nextComment.at_cid ?? null).toBeNull();
    expect(afterFirst.at_uri).toMatch(new RegExp(`^at://${SERVICE_DID}/`));
    expect(afterFirst.at_cid).toBeNull();
    expect(second.status).toBe(200);
    expect(afterSecond.at_uri).toBe(afterFirst.at_uri);
    expect(second.body.nextComment.at_uri).toBe(afterFirst.at_uri);
    expect(second.body.nextComment.at_cid).toBe(afterSecond.at_cid);
    expect(afterSecond.at_cid).toMatch(/^bafycid/);
    expect(mockedPut).toHaveBeenCalledTimes(2);
  });

  test("leaves a statement alone when the service account is not available", async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
    const tid = await addStatement(zid, `Unpublished statement ${runId}`);
    mockedEnsureAnonSession.mockResolvedValue(false);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.tid).toBe(tid);
    expect(response.body.nextComment.at_uri ?? null).toBeNull();
    expect(await statementRow(zid, tid)).toEqual({
      at_uri: null,
      at_cid: null,
    });
    expect(mockedPut).toHaveBeenCalledTimes(0);
  });

  test("never touches a statement whose address is in another account", async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
    const own = {
      at_uri: `at://did:plc:participant0000000000000/${STATEMENT_COLLECTION}/3abcdefghijkl`,
      at_cid: `bafyown${runId}`,
    };
    const tid = await addStatement(zid, `Own record ${runId}`, own);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.tid).toBe(tid);
    expect(response.body.nextComment.at_uri).toBe(own.at_uri);
    expect(await statementRow(zid, tid)).toEqual(own);
    expect(mockedPut).toHaveBeenCalledTimes(0);
  });
  test("never publishes into an address that another account claimed", async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
    const claimed = {
      at_uri: `at://did:plc:participant0000000000000/${STATEMENT_COLLECTION}/3abcdefghijkl`,
      at_cid: null,
    };
    const tid = await addStatement(zid, `Claimed elsewhere ${runId}`, claimed);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.tid).toBe(tid);
    expect(await statementRow(zid, tid)).toEqual(claimed);
    expect(mockedPut).toHaveBeenCalledTimes(0);
  });
});

describe("statement records in a conversation open to votes without sign-in", () => {
  let conversationId: string;
  let zid: number;

  beforeAll(async () => {
    const pooledUser = getPooledTestUser(2);
    const { agent } = await getJwtAuthenticatedAgent({
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    });
    ({ conversationId, zid } = await makeConversation(
      agent,
      `Open voter records ${runId}`,
      false
    ));
    mockedGetAnonDid.mockReset().mockReturnValue(SERVICE_DID);
    mockedEnsureAnonSession.mockReset().mockResolvedValue(true);
    mockedPut.mockReset().mockResolvedValue({
      uri: `at://${SERVICE_DID}/${STATEMENT_COLLECTION}/3open`,
      cid: "bafyopen",
    });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM comments WHERE zid = $1", [zid]);
  });

  test("publishes nothing, because the app votes there without a record", async () => {
    const tid = await addStatement(zid, `Open statement ${runId}`);
    const publicAgent = await newAgent();

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.tid).toBe(tid);
    expect(response.body.nextComment.at_uri ?? null).toBeNull();
    expect(await statementRow(zid, tid)).toEqual({
      at_uri: null,
      at_cid: null,
    });
    expect(mockedPut).toHaveBeenCalledTimes(0);
  });
});

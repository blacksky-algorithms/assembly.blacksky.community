import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";
import pg from "../../src/db/pg-query";
import logger from "../../src/utils/logger";
import { getZinvite } from "../../src/utils/zinvite";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

const runId = `${process.pid}_${Date.now()}`;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const DEFAULT_IMAGE_URL =
  "https://blacksky-cdn.nyc3.cdn.digitaloceanspaces.com/peoples-assembly.png";

async function signInOwner(): Promise<Agent> {
  const pooledUser = getPooledTestUser(1);
  const { agent } = await getJwtAuthenticatedAgent({
    email: pooledUser.email,
    hname: pooledUser.name,
    password: pooledUser.password,
  });
  return agent;
}

async function zidOf(conversationId: string): Promise<number> {
  const result = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  return result.rows[0].zid;
}

async function reportIdsOf(zid: number): Promise<string[]> {
  const result = await pool.query(
    "SELECT report_id FROM reports WHERE zid = $1 ORDER BY rid",
    [zid]
  );
  return result.rows.map((row) => row.report_id);
}

function binaryBody(response: { body: unknown }): Buffer {
  expect(Buffer.isBuffer(response.body)).toBe(true);
  return response.body as Buffer;
}

describe("GET /api/v3/embed/conversation", () => {
  let ownerAgent: Agent;
  let publicAgent: Agent;
  let conversationId: string;
  let zid: number;
  const topic = `Embed report id ${runId}`;
  const statement = `Seed statement ${runId}`;
  const statementUri = `at://did:plc:embedtest${process.pid}/community.blacksky.assembly.statement/${runId}`;
  const statementCid = `bafyembedtest${runId}`;

  beforeAll(async () => {
    ownerAgent = await signInOwner();
    publicAgent = await newAgent();
    conversationId = await createConversation(ownerAgent, { topic });
    zid = await zidOf(conversationId);

    const users = await pool.query(
      "INSERT INTO users (created) VALUES (default) RETURNING uid"
    );
    const uid: number = users.rows[0].uid;
    const participants = await pool.query(
      "INSERT INTO participants (uid, zid, created) VALUES ($1, $2, now_as_millis()) RETURNING pid",
      [uid, zid]
    );
    await pool.query(
      `INSERT INTO comments (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, at_uri, at_cid)
       VALUES ($1, $2, $3, 1, true, 1, $4, false, true, default, null, $5, $6)`,
      [
        participants.rows[0].pid,
        zid,
        statement,
        uid,
        statementUri,
        statementCid,
      ]
    );
    await pool.query(
      "INSERT INTO atproto_conversation_creations (zid, did, at_uri, content_hash) VALUES ($1, $2, $3, $4)",
      [
        zid,
        `did:plc:embedtest${process.pid}`,
        `at://did:plc:embedtest${process.pid}/community.blacksky.assembly.conversation/${runId}`,
        `hash${runId}`,
      ]
    );
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM atproto_conversation_creations WHERE zid = $1",
      [zid]
    );
  });

  test("returns report_id null when the conversation has no report", async () => {
    expect(await reportIdsOf(zid)).toEqual([]);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.report_id).toBeNull();
    expect(response.body.conversation.conversation_id).toBe(conversationId);
    expect(response.body.conversation.topic).toBe(topic);
  });

  test("returns the seed statement with its record reference", async () => {
    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.nextComment.txt).toBe(statement);
    expect(response.body.nextComment.is_seed).toBe(true);
    expect(response.body.nextComment.at_uri).toBe(statementUri);
    expect(response.body.nextComment.at_cid).toBe(statementCid);
  });

  test("returns the report_id after a report is created", async () => {
    const created = await ownerAgent
      .post("/api/v3/reports")
      .send({ conversation_id: conversationId });
    expect(created.status).toBe(200);

    const reportIds = await reportIdsOf(zid);
    expect(reportIds).toHaveLength(1);
    expect(reportIds[0]).toMatch(/^r[0-9a-z]+$/);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.report_id).toBe(reportIds[0]);
  });

  test("returns the most recently created report", async () => {
    const firstReportIds = await reportIdsOf(zid);
    const created = await ownerAgent
      .post("/api/v3/reports")
      .send({ conversation_id: conversationId });
    expect(created.status).toBe(200);

    const reportIds = await reportIdsOf(zid);
    expect(reportIds).toHaveLength(2);
    expect(reportIds[0]).toBe(firstReportIds[0]);

    const afterSecond = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    expect(afterSecond.body.report_id).toBe(reportIds[1]);

    const backdatedReportId = `rbackdated${runId}`;
    await pool.query(
      "INSERT INTO reports (zid, report_id, created) VALUES ($1, $2, 1000)",
      [zid, backdatedReportId]
    );
    expect(await reportIdsOf(zid)).toEqual([
      reportIds[0],
      reportIds[1],
      backdatedReportId,
    ]);

    const afterBackdated = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    expect(afterBackdated.body.report_id).toBe(reportIds[1]);
  });

  test("still answers, without a report, when the report cannot be looked up", async () => {
    const failure = new Error("relation does not exist");
    const readOnly = pg.queryP_readOnly.bind(pg);
    const lookup = jest
      .spyOn(pg, "queryP_readOnly")
      .mockImplementation((sql: string, params?: unknown[]) =>
        sql.includes("atproto_conversation_creations")
          ? Promise.reject(failure)
          : readOnly(sql, params)
      );
    const logged = jest.spyOn(logger, "error").mockImplementation(() => logger);

    let response;
    try {
      response = await publicAgent.get(
        `/api/v3/embed/conversation?conversation_id=${conversationId}`
      );
    } finally {
      lookup.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(response.body.report_id).toBeNull();
    expect(response.body.conversation.conversation_id).toBe(conversationId);
    expect(response.body.conversation.topic).toBe(topic);
    expect(response.body.nextComment.txt).toBe(statement);
    expect(logged.mock.calls).toEqual([
      ["polis_err_embed_conversation_report_id", failure],
    ]);
    logged.mockRestore();
  });

  test("does not prefer a report without a creation time", async () => {
    const reportIds = await reportIdsOf(zid);
    expect(reportIds).toHaveLength(3);

    const undatedReportId = `rundated${runId}`;
    await pool.query(
      "INSERT INTO reports (zid, report_id, created) VALUES ($1, $2, NULL)",
      [zid, undatedReportId]
    );
    expect(await reportIdsOf(zid)).toEqual([...reportIds, undatedReportId]);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    expect(response.status).toBe(200);
    expect(response.body.report_id).toBe(reportIds[1]);
  });
});

describe("GET /api/v3/embed/conversation for a conversation made in the admin console", () => {
  test("does not give out its report", async () => {
    const ownerAgent = await signInOwner();
    const publicAgent = await newAgent();
    const conversationId = await createConversation(ownerAgent, {
      topic: `Admin console conversation ${runId}`,
    });
    const created = await ownerAgent
      .post("/api/v3/reports")
      .send({ conversation_id: conversationId });
    expect(created.status).toBe(200);
    expect(await reportIdsOf(await zidOf(conversationId))).toHaveLength(1);

    const response = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.conversation.conversation_id).toBe(conversationId);
    expect(response.body.report_id).toBeNull();
  });
});

describe("GET /api/v3/og-image/:conversation_id", () => {
  let publicAgent: Agent;
  let conversationId: string;

  beforeAll(async () => {
    const ownerAgent = await signInOwner();
    publicAgent = await newAgent();
    conversationId = await createConversation(ownerAgent, {
      topic: `Image under the API path ${runId}`,
    });
  });

  test("serves the image of /og-image with the caller's origin allowed", async () => {
    const original = await publicAgent
      .get(`/og-image/${conversationId}`)
      .set("Origin", "https://blacksky.community")
      .buffer(true);
    expect(original.status).toBe(200);
    expect(original.headers["content-type"]).toBe("image/png");
    expect(original.headers["access-control-allow-origin"]).toBeUndefined();
    expect(original.headers.vary.split(/,\s*/)).toContain("Origin");
    const originalImage = binaryBody(original);
    expect(originalImage.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    const response = await publicAgent
      .get(`/api/v3/og-image/${conversationId}`)
      .set("Origin", "https://blacksky.community")
      .buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("public, max-age=86400");
    expect(response.headers.vary.split(/,\s*/)).toContain("Origin");
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://blacksky.community"
    );
    expect(binaryBody(response).equals(originalImage)).toBe(true);
  });

  test("redirects to the default image for a malformed id", async () => {
    const response = await publicAgent
      .get("/api/v3/og-image/not.an.id")
      .redirects(0);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(DEFAULT_IMAGE_URL);
  });
});

describe("cached lookups after a conversation is taken down", () => {
  let publicAgent: Agent;
  let conversationId: string;
  let zid: number;
  let reportId: string;
  let image: Buffer;

  function advanceClock(milliseconds: number) {
    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + milliseconds);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeAll(async () => {
    const ownerAgent = await signInOwner();
    publicAgent = await newAgent();
    conversationId = await createConversation(ownerAgent, {
      topic: `Cache expiry ${runId}`,
    });
    zid = await zidOf(conversationId);
    const created = await ownerAgent
      .post("/api/v3/reports")
      .send({ conversation_id: conversationId });
    expect(created.status).toBe(200);
    reportId = (await reportIdsOf(zid))[0];
    await pool.query(
      "INSERT INTO atproto_conversation_creations (zid, did, at_uri, content_hash) VALUES ($1, $2, $3, $4)",
      [
        zid,
        `did:plc:cachetest${process.pid}`,
        `at://did:plc:cachetest${process.pid}/community.blacksky.assembly.conversation/${runId}`,
        `hash${runId}`,
      ]
    );
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM atproto_conversation_creations WHERE zid = $1",
      [zid]
    );
  });

  test("resolves every id while the conversation exists", async () => {
    const embed = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    expect(embed.status).toBe(200);
    expect(embed.body.report_id).toBe(reportId);

    const reports = await publicAgent.get(
      `/api/v3/reports?report_id=${reportId}`
    );
    expect(reports.status).toBe(200);
    expect(reports.body).toHaveLength(1);
    expect(reports.body[0].report_id).toBe(reportId);
    expect(reports.body[0].conversation_id).toBe(conversationId);

    const ogImage = await publicAgent
      .get(`/api/v3/og-image/${conversationId}`)
      .buffer(true);
    expect(ogImage.status).toBe(200);
    image = binaryBody(ogImage);
    expect(image.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    expect(await getZinvite(zid)).toBe(conversationId);
  });

  test("keeps serving cached entries for less than a minute after the rows are deleted", async () => {
    await pool.query("DELETE FROM reports WHERE zid = $1", [zid]);
    await pool.query("DELETE FROM zinvites WHERE zid = $1", [zid]);
    advanceClock(30 * 1000);

    const embed = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    expect(embed.status).toBe(200);
    expect(embed.body.report_id).toBeNull();

    const reports = await publicAgent.get(
      `/api/v3/reports?report_id=${reportId}`
    );
    expect(reports.status).toBe(200);
    expect(reports.body).toEqual([]);

    const ogImage = await publicAgent
      .get(`/api/v3/og-image/${conversationId}`)
      .buffer(true);
    expect(ogImage.status).toBe(200);
    expect(binaryBody(ogImage).equals(image)).toBe(true);

    expect(await getZinvite(zid)).toBe(conversationId);
  });

  test("stops resolving the ids once the entries are older than a minute", async () => {
    advanceClock(61 * 1000);

    const embed = await publicAgent.get(
      `/api/v3/embed/conversation?conversation_id=${conversationId}`
    );
    expect(embed.status).toBe(400);
    expect(embed.text).toContain(
      "polis_err_param_parse_failed_conversation_id"
    );

    const reports = await publicAgent.get(
      `/api/v3/reports?report_id=${reportId}`
    );
    expect(reports.status).toBe(400);
    expect(reports.text).toContain("polis_err_param_parse_failed_report_id");

    const ogImage = await publicAgent
      .get(`/api/v3/og-image/${conversationId}`)
      .redirects(0);
    expect(ogImage.status).toBe(302);
    expect(ogImage.headers.location).toBe(DEFAULT_IMAGE_URL);

    expect(await getZinvite(zid)).toBeUndefined();
  });
});

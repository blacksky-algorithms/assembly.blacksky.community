import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";

const mockSendTextEmail = jest.fn<(...args: string[]) => Promise<void>>();
jest.mock("../../src/email/senders", () => {
  const actual = jest.requireActual("../../src/email/senders") as Record<
    string,
    unknown
  >;
  return { ...actual, sendTextEmail: mockSendTextEmail };
});

import { createConversation } from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import {
  joinAsParticipant,
  signInPooledUser,
  zidOf,
} from "../setup/pooled-user-agent";
import { getPooledTestUser } from "../setup/test-user-helpers";

const runId = `${process.pid}${Date.now()}`;
const newcomerIndex = 18;
const newcomerEmail = getPooledTestUser(newcomerIndex).email;

describe("writes that need a moderator or the account itself", () => {
  let owner: { agent: Agent; uid: number };
  let other: { agent: Agent; uid: number };
  let participant: { agent: Agent; uid: number };
  let conversationId: string;
  let zid: number;
  let exportPath: string;

  async function userRow(
    uid: number
  ): Promise<{ email: string | null; hname: string | null }> {
    const result = await pool.query(
      "SELECT email, hname FROM users WHERE uid = $1",
      [uid]
    );
    return result.rows[0];
  }

  async function exportTasks(): Promise<number> {
    const result = await pool.query(
      "SELECT count(*)::int AS n FROM worker_tasks WHERE task_type = 'generate_export_data' AND (task_data->>'zid')::int = $1",
      [zid]
    );
    return result.rows[0].n;
  }

  async function invitedAddresses(): Promise<string[]> {
    const result = await pool.query(
      "SELECT xid FROM suzinvites WHERE zid = $1",
      [zid]
    );
    return result.rows.map((row: { xid: string }) => row.xid);
  }

  async function forgetNewcomer(): Promise<void> {
    await pool.query(
      "DELETE FROM oidc_user_mappings WHERE uid IN (SELECT uid FROM users WHERE email = $1)",
      [newcomerEmail]
    );
    await pool.query("UPDATE users SET email = NULL WHERE email = $1", [
      newcomerEmail,
    ]);
  }

  beforeAll(async () => {
    owner = await signInPooledUser(16);
    other = await signInPooledUser(17);
    conversationId = await createConversation(owner.agent, {
      topic: `open writes ${runId}`,
    });
    zid = await zidOf(conversationId);
    participant = await joinAsParticipant(conversationId);
    exportPath = `/api/v3/dataExport?conversation_id=${conversationId}&format=csv&unixTimestamp=1790000000`;
  });

  beforeEach(() => {
    mockSendTextEmail.mockReset();
    mockSendTextEmail.mockResolvedValue(undefined);
  });

  test("PUT /users does not store an email sent by a participant", async () => {
    const response = await participant.agent
      .put("/api/v3/users")
      .send({ email: `claimed-${runId}@example.test` });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("polis_err_put_user_no_fields");
    expect(await userRow(participant.uid)).toEqual({
      email: null,
      hname: null,
    });
  });

  test("PUT /users ignores an email sent together with a name", async () => {
    const response = await participant.agent
      .put("/api/v3/users")
      .send({ email: `named-${runId}@example.test`, hname: `Name ${runId}` });

    expect(response.status).toBe(200);
    expect(await userRow(participant.uid)).toEqual({
      email: null,
      hname: `Name ${runId}`,
    });
  });

  test("PUT /users does not store an email sent by a signed-in user", async () => {
    const before = await userRow(other.uid);
    const response = await other.agent
      .put("/api/v3/users")
      .send({ email: `moved-${runId}@example.test` });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("polis_err_put_user_no_fields");
    expect(await userRow(other.uid)).toEqual(before);
  });

  test("a first sign-in with an address a participant tried to claim gets its own account", async () => {
    await forgetNewcomer();
    const claim = await participant.agent
      .put("/api/v3/users")
      .send({ email: newcomerEmail, hname: `Name ${runId}` });
    const newcomer = await signInPooledUser(newcomerIndex);

    expect(claim.status).toBe(200);
    expect(newcomer.uid).not.toBe(participant.uid);
    expect((await userRow(participant.uid)).email).toBeNull();
    expect((await userRow(newcomer.uid)).email).toBe(newcomerEmail);
  });

  test("PUT /users still stores the caller's own name", async () => {
    const before = await userRow(other.uid);
    const response = await other.agent
      .put("/api/v3/users")
      .send({ hname: `Other ${runId}` });

    expect(response.status).toBe(200);
    expect(await userRow(other.uid)).toEqual({
      email: before.email,
      hname: `Other ${runId}`,
    });
  });

  test("GET /dataExport returns 403 for a participant and queues nothing", async () => {
    const response = await participant.agent.get(exportPath);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_data_export_permission");
    expect(await exportTasks()).toBe(0);
  });

  test("GET /dataExport returns 403 for a signed-in user who does not moderate the conversation", async () => {
    const response = await other.agent.get(exportPath);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_data_export_permission");
    expect(await exportTasks()).toBe(0);
  });

  test("GET /dataExport queues exactly one task for the owner", async () => {
    const response = await owner.agent.get(exportPath);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect(await exportTasks()).toBe(1);
  });

  test("POST /users/invite returns 403 for a participant and invites nobody", async () => {
    const response = await participant.agent
      .post("/api/v3/users/invite")
      .send({ conversation_id: conversationId, emails: "p@example.test" });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_sending_invite_permission");
    expect(await invitedAddresses()).toEqual([]);
    expect(mockSendTextEmail).toHaveBeenCalledTimes(0);
  });

  test("POST /users/invite returns 403 for a signed-in user who does not moderate the conversation", async () => {
    const response = await other.agent
      .post("/api/v3/users/invite")
      .send({ conversation_id: conversationId, emails: "o@example.test" });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_sending_invite_permission");
    expect(await invitedAddresses()).toEqual([]);
    expect(mockSendTextEmail).toHaveBeenCalledTimes(0);
  });

  test("POST /users/invite invites exactly one address for the owner", async () => {
    const response = await owner.agent
      .post("/api/v3/users/invite")
      .send({ conversation_id: conversationId, emails: "m@example.test" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "success" });
    expect(await invitedAddresses()).toEqual(["m@example.test"]);
    expect(mockSendTextEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTextEmail.mock.calls[0][1]).toBe("m@example.test");
  });
});

import { beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import { createConversation, newAgent } from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import {
  joinAsParticipant,
  signInPooledUser,
  zidOf,
} from "../setup/pooled-user-agent";

const runId = `${process.pid}${Date.now()}`;

describe("public ids of a conversation", () => {
  let ownerAgent: Agent;
  let otherUserAgent: Agent;
  let participantAgent: Agent;
  let conversationId: string;
  let zid: number;

  async function storedIds(): Promise<string[]> {
    const result = await pool.query(
      "SELECT zinvite FROM zinvites WHERE zid = $1",
      [zid]
    );
    return result.rows.map((row: { zinvite: string }) => row.zinvite).sort();
  }

  async function storedUuid(): Promise<string> {
    const result = await pool.query(
      "SELECT uuid FROM zinvites WHERE zinvite = $1",
      [conversationId]
    );
    return result.rows[0].uuid;
  }

  beforeAll(async () => {
    ownerAgent = (await signInPooledUser(14)).agent;
    otherUserAgent = (await signInPooledUser(15)).agent;
    conversationId = await createConversation(ownerAgent, {
      topic: `zinvites authorization ${runId}`,
    });
    zid = await zidOf(conversationId);
    participantAgent = (await joinAsParticipant(conversationId)).agent;
  });

  test("starts with one public id", async () => {
    expect(await storedIds()).toEqual([conversationId]);
  });

  test("POST returns 401 without a token", async () => {
    const agent = await newAgent();
    const response = await agent
      .post(`/api/v3/zinvites/${zid}`)
      .send({ conversation_id: conversationId });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "No authentication token found" });
    expect(await storedIds()).toEqual([conversationId]);
  });

  test("POST returns 403 for a participant of the conversation", async () => {
    const response = await participantAgent
      .post(`/api/v3/zinvites/${zid}`)
      .send({ conversation_id: conversationId });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_creating_zinvite_permission");
    expect(await storedIds()).toEqual([conversationId]);
  });

  test("POST returns 403 for a signed-in user who does not own the conversation", async () => {
    const response = await otherUserAgent
      .post(`/api/v3/zinvites/${zid}`)
      .send({ conversation_id: conversationId });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_creating_zinvite_permission");
    expect(await storedIds()).toEqual([conversationId]);
  });

  test("GET returns 403 for a participant of the conversation", async () => {
    const response = await participantAgent.get(
      `/api/v3/zinvites/${zid}?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_fetching_zinvite_permission");
    expect(response.body.codes).toBeUndefined();
  });

  test("GET returns 403 for a signed-in user who does not own the conversation", async () => {
    const response = await otherUserAgent.get(
      `/api/v3/zinvites/${zid}?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_fetching_zinvite_permission");
    expect(response.body.codes).toBeUndefined();
  });

  test("conversationUuid returns 401 without a token", async () => {
    const agent = await newAgent();
    const response = await agent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "No authentication token found" });
  });

  test("conversationUuid returns 403 for a participant of the conversation", async () => {
    const response = await participantAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_conversation_uuid_permission");
    expect(response.body.conversation_uuid).toBeUndefined();
  });

  test("conversationUuid returns 403 for a signed-in user who does not moderate the conversation", async () => {
    const response = await otherUserAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_conversation_uuid_permission");
    expect(response.body.conversation_uuid).toBeUndefined();
  });

  test("the owner reads the uuid", async () => {
    const response = await ownerAgent.get(
      `/api/v3/conversationUuid?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(typeof response.body.conversation_uuid).toBe("string");
    expect(response.body).toEqual({ conversation_uuid: await storedUuid() });
  });

  test("the owner lists and creates public ids", async () => {
    const listed = await ownerAgent.get(
      `/api/v3/zinvites/${zid}?conversation_id=${conversationId}`
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.codes.map((row: { zinvite: string }) => row.zinvite)
    ).toEqual([conversationId]);

    const created = await ownerAgent
      .post(`/api/v3/zinvites/${zid}`)
      .send({ conversation_id: conversationId });
    expect(created.status).toBe(200);
    expect(typeof created.body.zinvite).toBe("string");
    expect(await storedIds()).toEqual(
      [conversationId, created.body.zinvite].sort()
    );
  });
});

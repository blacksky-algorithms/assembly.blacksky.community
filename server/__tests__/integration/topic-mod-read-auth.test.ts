import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import type { Agent } from "supertest";

type Item = Record<string, unknown>;
type Query = { input: { TableName: string } };

const mockSend = jest.fn<(command: Query) => Promise<{ Items: Item[] }>>();
jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb") as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { createConversation, newAgent } from "../setup/api-test-helpers";
import {
  joinAsParticipant,
  signInPooledUser,
} from "../setup/pooled-user-agent";

const runId = `${process.pid}${Date.now()}`;
const statementText = `Statement awaiting moderation ${runId}`;
const topicName = `Topic ${runId}`;
const topicKey = "layer0_0";

const tables: Record<string, Item[]> = {
  Delphi_CommentClustersLLMTopicNames: [
    {
      topic_key: topicKey,
      topic_name: topicName,
      layer_id: "0",
      cluster_id: "0",
    },
  ],
  Delphi_TopicModerationStatus: [
    {
      topic_key: topicKey,
      moderation_status: "reject",
      moderator: "admin",
      moderated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  Delphi_CommentClusters: [
    {
      comment_id: 0,
      comment_text: statementText,
      cluster_id: 0,
      layer_id: 0,
    },
  ],
  Delphi_CommentClustersStructureKeywords: [
    {
      cluster_key: topicKey,
      layer_id: 0,
      cluster_id: 0,
      size: 1,
      topic_name: topicName,
    },
  ],
};

const readRoutes = [
  { name: "topics", path: "/api/v3/topicMod/topics" },
  {
    name: "comments of a topic",
    path: `/api/v3/topicMod/topics/${topicKey}/comments`,
  },
  { name: "stats", path: "/api/v3/topicMod/stats" },
  { name: "hierarchy", path: "/api/v3/topicMod/hierarchy" },
];

describe("GET /api/v3/topicMod read authorization", () => {
  let ownerAgent: Agent;
  let otherUserAgent: Agent;
  let participantAgent: Agent;
  let conversationId: string;

  beforeAll(async () => {
    ownerAgent = (await signInPooledUser(12)).agent;
    otherUserAgent = (await signInPooledUser(13)).agent;
    conversationId = await createConversation(ownerAgent, {
      topic: `topicMod read authorization ${runId}`,
    });
    participantAgent = (await joinAsParticipant(conversationId)).agent;
  });

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation(async (command) => ({
      Items: tables[command.input.TableName] || [],
    }));
  });

  test.each(readRoutes)(
    "$name returns 401 without a token",
    async ({ path }) => {
      const agent = await newAgent();
      const response = await agent.get(
        `${path}?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "No authentication token found" });
      expect(mockSend).toHaveBeenCalledTimes(0);
    }
  );

  test.each(readRoutes)(
    "$name returns 403 for a participant of the conversation",
    async ({ path }) => {
      const response = await participantAgent.get(
        `${path}?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "polis_err_topicmod_permission",
        message: "polis_err_topicmod_permission",
        status: 403,
      });
      expect(mockSend).toHaveBeenCalledTimes(0);
    }
  );

  test.each(readRoutes)(
    "$name returns 403 for a signed-in user who does not moderate the conversation",
    async ({ path }) => {
      const response = await otherUserAgent.get(
        `${path}?conversation_id=${conversationId}`
      );

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: "polis_err_topicmod_permission",
        message: "polis_err_topicmod_permission",
        status: 403,
      });
      expect(mockSend).toHaveBeenCalledTimes(0);
    }
  );

  test("the owner reads topics with their moderation status", async () => {
    const response = await ownerAgent.get(
      `/api/v3/topicMod/topics?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("success");
    expect(response.body.total_topics).toBe(1);
    expect(response.body.topics_by_layer["0"]).toHaveLength(1);
    expect(response.body.topics_by_layer["0"][0].topic_name).toBe(topicName);
    expect(response.body.topics_by_layer["0"][0].moderation.status).toBe(
      "reject"
    );
  });

  test("the owner reads the statements of a topic", async () => {
    const response = await ownerAgent.get(
      `/api/v3/topicMod/topics/${topicKey}/comments?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("success");
    expect(response.body.total_comments).toBe(1);
    expect(response.body.comments[0].comment_text).toBe(statementText);
  });

  test("the owner reads stats", async () => {
    const response = await ownerAgent.get(
      `/api/v3/topicMod/stats?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.stats).toEqual({
      total_topics: 1,
      pending: 0,
      accepted: 0,
      rejected: 1,
      meta: 0,
    });
  });

  test("the owner reads the hierarchy", async () => {
    const response = await ownerAgent.get(
      `/api/v3/topicMod/hierarchy?conversation_id=${conversationId}`
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("success");
    expect(response.body.totalClusters).toBe(1);
    expect(response.body.hierarchy.children[0].topic_name).toBe(topicName);
  });

  test("proximity stays readable without a token", async () => {
    const agent = await newAgent();
    const response = await agent.get(
      `/api/v3/topicMod/proximity?conversation_id=${conversationId}&layer_id=all`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "success",
      message: "No UMAP coordinates found",
      proximity_data: [],
    });
  });

  test("proximity does not return the internal error text when the lookup fails", async () => {
    mockSend.mockReset();
    mockSend.mockRejectedValue(new Error(`lookup failed ${runId}`));
    const agent = await newAgent();
    const response = await agent.get(
      `/api/v3/topicMod/proximity?conversation_id=${conversationId}&layer_id=all`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "error",
      message: "Error retrieving proximity data",
    });
  });
});

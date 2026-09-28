import { beforeAll, describe, expect, test } from "@jest/globals";
import {
  getJwtAuthenticatedAgent,
  newAgent,
  submitComment,
  submitVote,
} from "../setup/api-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";
import type { Agent } from "supertest";

const XID = "sign-in-required-xid";

describe("Conversation created without sign-in options", () => {
  let owner: Agent;
  let conversationId: string;
  let seedTid: number;

  beforeAll(async () => {
    const pooledUser = getPooledTestUser(1);
    const { agent } = await getJwtAuthenticatedAgent({
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    });
    owner = agent;

    const created = await owner.post("/api/v3/conversations").send({
      topic: "Sign-in required by default",
      description: "Created without sign-in options",
      is_active: true,
      is_draft: false,
      profanity_filter: false,
    });
    expect(created.status).toBe(200);
    conversationId = created.body.conversation_id;

    const seed = await owner.post("/api/v3/comments").send({
      conversation_id: conversationId,
      txt: "Seed statement",
      is_seed: true,
    });
    expect(seed.status).toBe(200);
    seedTid = seed.body.tid;
  });

  test("requires sign-in to vote and to write", async () => {
    const preload = await owner.get(
      `/api/v3/conversations/preload?conversation_id=${conversationId}`
    );

    expect(preload.status).toBe(200);
    expect(preload.body).toHaveProperty("auth_needed_to_vote", true);
    expect(preload.body).toHaveProperty("auth_needed_to_write", true);
  });

  test("rejects a vote from a participant who has not signed in", async () => {
    const participant = await newAgent();

    const vote = await submitVote(participant, {
      conversation_id: conversationId,
      tid: seedTid,
      vote: -1,
    });

    expect(vote.status).toBe(403);
    expect(vote.text).toContain("polis_err_post_votes_social_needed");
  });

  test("rejects a statement from a participant who has not signed in", async () => {
    const participant = await newAgent();

    const comment = await submitComment(participant, {
      conversation_id: conversationId,
      txt: "Statement from a participant who has not signed in",
    });

    expect(comment.status).toBe(403);
    expect(comment.text).toContain("polis_err_post_comment_social_needed");
  });

  test("rejects a vote from the signed-in owner when no xid is given", async () => {
    const vote = await submitVote(owner, {
      conversation_id: conversationId,
      tid: seedTid,
      vote: -1,
    });

    expect(vote.status).toBe(403);
    expect(vote.text).toContain("polis_err_post_votes_social_needed");
  });

  test("accepts a vote from a participant identified by xid", async () => {
    const participant = await newAgent();

    const vote = await submitVote(participant, {
      conversation_id: conversationId,
      tid: seedTid,
      vote: -1,
      xid: XID,
    });

    expect(vote.status).toBe(200);
    expect(vote.body).toHaveProperty("currentPid");
  });
});

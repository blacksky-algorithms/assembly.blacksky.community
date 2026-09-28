import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Agent } from "supertest";
import {
  createConversation,
  getJwtAuthenticatedAgent,
  newAgent,
} from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { getPooledTestUser } from "../setup/test-user-helpers";

const HOSTILE_TOPIC = "<img src=x onerror=alert(1)>";
const HOSTILE_DESCRIPTION = "<script>alert(2)</script> & 'quoted' \"text\"";
const HOSTILE_ID = "embedpages'><b>id";
const ESCAPED_TOPIC = "&lt;img src=x onerror=alert(1)&gt;";
const ESCAPED_DESCRIPTION =
  "&lt;script&gt;alert(2)&lt;/script&gt; &amp; &apos;quoted&apos; &quot;text&quot;";
const ESCAPED_ID = "embedpages&apos;&gt;&lt;b&gt;id";

function adminPage(id: string, title: string, description: string): string {
  return (
    `<a href='https://pol.is/${id}' target='_blank'>${title}</a>` +
    `<p><a href='https://pol.is/m${id}' target='_blank'>moderate</a></p>` +
    `<p>${description}</p>`
  );
}

function participantPage(id: string): string {
  return `<a href='https://pol.is/${id}' target='_blank'>${id}</a>`;
}

describe("embed pages", () => {
  let publicAgent: Agent;
  let hostileConversationId: string;
  let plainConversationId: string;

  beforeAll(async () => {
    const pooledUser = getPooledTestUser(1);
    const { agent: ownerAgent } = await getJwtAuthenticatedAgent({
      email: pooledUser.email,
      hname: pooledUser.name,
      password: pooledUser.password,
    });
    publicAgent = await newAgent();
    hostileConversationId = await createConversation(ownerAgent, {
      topic: HOSTILE_TOPIC,
      description: HOSTILE_DESCRIPTION,
    });
    plainConversationId = await createConversation(ownerAgent, {
      topic: "Plain topic",
      description: "Plain description",
    });
    await pool.query("DELETE FROM zinvites WHERE zinvite = $1", [HOSTILE_ID]);
    await pool.query(
      "INSERT INTO zinvites (zid, zinvite, created) SELECT zid, $1, created FROM zinvites WHERE zinvite = $2",
      [HOSTILE_ID, hostileConversationId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM zinvites WHERE zinvite = $1", [HOSTILE_ID]);
  });

  test("/iim shows the topic and the description as text", async () => {
    const hostile = await publicAgent.get(`/iim/${hostileConversationId}`);
    const plain = await publicAgent.get(`/iim/${plainConversationId}`);

    expect(hostile.status).toBe(200);
    expect(hostile.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(hostile.text).toBe(
      adminPage(hostileConversationId, ESCAPED_TOPIC, ESCAPED_DESCRIPTION)
    );
    expect(hostile.text).not.toContain("<img");
    expect(hostile.text).not.toContain("<script");
    expect(plain.status).toBe(200);
    expect(plain.text).toBe(
      adminPage(plainConversationId, "Plain topic", "Plain description")
    );
  });

  test("/iim shows the conversation id as text", async () => {
    const response = await publicAgent.get(
      `/iim/${encodeURIComponent(HOSTILE_ID)}`
    );

    expect(response.status).toBe(200);
    expect(response.text).toBe(
      adminPage(ESCAPED_ID, ESCAPED_TOPIC, ESCAPED_DESCRIPTION)
    );
    expect(response.text).not.toContain("<b>");
  });

  test("/iip shows the conversation id as text", async () => {
    const hostile = await publicAgent.get(
      `/iip/${encodeURIComponent(HOSTILE_ID)}`
    );
    const plain = await publicAgent.get(`/iip/${plainConversationId}`);

    expect(hostile.status).toBe(200);
    expect(hostile.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(hostile.text).toBe(participantPage(ESCAPED_ID));
    expect(hostile.text).not.toContain("<b>");
    expect(plain.status).toBe(200);
    expect(plain.text).toBe(participantPage(plainConversationId));
  });
});

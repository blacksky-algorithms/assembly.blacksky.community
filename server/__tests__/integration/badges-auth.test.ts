import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import type { Agent } from "supertest";
import { newAgent, setAgentJwt } from "../setup/api-test-helpers";
import { pool } from "../setup/db-test-helpers";
import { signInPooledUser } from "../setup/pooled-user-agent";

const mockTeamUids = new Set<number>();
jest.mock("../../src/utils/common", () => {
  const actual = jest.requireActual("../../src/utils/common") as Record<
    string,
    unknown
  >;
  return {
    __esModule: true,
    ...actual,
    isPolisDev: (uid: number) => mockTeamUids.has(uid),
  };
});

const runId = `${process.pid}${Date.now()}`;
const did = `did:plc:badgetarget${runId}`;
const grant = { did, badge: "blacksky_team", is_granted: true };
const deletePath = `/api/v3/admin/badges?did=${encodeURIComponent(
  did
)}&badge=blacksky_team`;

async function storedOverrides(): Promise<
  { badge: string; is_granted: boolean }[]
> {
  const result = await pool.query(
    "SELECT badge, is_granted FROM badge_overrides WHERE did = $1 ORDER BY badge",
    [did]
  );
  return result.rows;
}

describe("badge overrides authorization", () => {
  let teamAgent: Agent;
  let userAgent: Agent;

  beforeAll(async () => {
    const team = await signInPooledUser(10);
    const user = await signInPooledUser(11);
    mockTeamUids.add(team.uid);
    teamAgent = team.agent;
    userAgent = user.agent;
  });

  test("POST returns 401 without a token and stores nothing", async () => {
    const agent = await newAgent();
    const response = await agent.post("/api/v3/admin/badges").send(grant);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "No authentication token found" });
    expect(await storedOverrides()).toEqual([]);
  });

  test("POST returns 401 for a token of no known type", async () => {
    const agent = await newAgent();
    setAgentJwt(agent, "not-a-token");
    const response = await agent.post("/api/v3/admin/badges").send(grant);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Invalid token format");
    expect(await storedOverrides()).toEqual([]);
  });

  test("POST returns 403 for a signed-in user outside the team", async () => {
    const response = await userAgent.post("/api/v3/admin/badges").send(grant);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_badges_permission");
    expect(await storedOverrides()).toEqual([]);
  });

  test("POST stores the override for a team member", async () => {
    const response = await teamAgent.post("/api/v3/admin/badges").send(grant);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(grant);
    expect(await storedOverrides()).toEqual([
      { badge: "blacksky_team", is_granted: true },
    ]);
  });

  test("GET stays readable without a token", async () => {
    const agent = await newAgent();
    const response = await agent.get(
      `/api/v3/admin/badges?did=${encodeURIComponent(did)}`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      did,
      overrides: [{ badge: "blacksky_team", is_granted: true }],
    });
  });

  test("DELETE returns 401 without a token and keeps the override", async () => {
    const agent = await newAgent();
    const response = await agent.delete(deletePath);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "No authentication token found" });
    expect(await storedOverrides()).toHaveLength(1);
  });

  test("DELETE returns 403 for a signed-in user outside the team", async () => {
    const response = await userAgent.delete(deletePath);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("polis_err_badges_permission");
    expect(await storedOverrides()).toHaveLength(1);
  });

  test("DELETE removes the override for a team member", async () => {
    const response = await teamAgent.delete(deletePath);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      did,
      badge: "blacksky_team",
      removed: true,
    });
    expect(await storedOverrides()).toEqual([]);
  });
});

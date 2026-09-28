import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import type { Agent } from "supertest";
import Config from "../../src/config";
import { getApp } from "../app-loader";
import {
  PlcFetchMock,
  installPlcFetchMock,
  jsonResponse,
  randomDidPlc,
} from "../setup/atproto-test-helpers";
import { pool } from "../setup/db-test-helpers";

const HOUR_SECONDS = 60 * 60;
const runId = `${process.pid}x${Date.now()}`;
const originalKeyPaths = {
  jwtPrivateKeyPath: Config.jwtPrivateKeyPath,
  jwtPublicKeyPath: Config.jwtPublicKeyPath,
};
const owner = { did: randomDidPlc(), uid: 0 };

let agent: Agent;
let server: http.Server;
let network: PlcFetchMock;
let keyDir: string;
let serverKey: string;
let foreignKey: string;
let conversationId: string;
let zid: number;

function generateRsaKeys(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

function adminToken(key: string, issuedSecondsAgo = 0): string {
  const issued = Math.floor(Date.now() / 1000) - issuedSecondsAgo;
  return jwt.sign(
    {
      sub: owner.did,
      uid: owner.uid,
      type: "atproto_admin",
      iss: "assembly.blacksky.community",
      aud: "users",
      iat: issued,
      exp: issued + HOUR_SECONDS,
      proof: "atproto_service_auth",
    },
    key,
    { algorithm: "RS256" }
  );
}

function rejectedTokens(): [string, string][] {
  return [
    ["signed with another key", adminToken(foreignKey)],
    ["that has expired", adminToken(serverKey, 2 * HOUR_SECONDS)],
  ];
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await pool.query(sql, params)).rows[0].n);
}

beforeAll(async () => {
  network = installPlcFetchMock(
    {},
    {
      fallback: (async () =>
        jsonResponse(
          { error: "blocked in tests" },
          { status: 503 }
        )) as typeof fetch,
    }
  );
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "atproto-admin-token-"));
  const own = generateRsaKeys();
  serverKey = own.privateKey;
  foreignKey = generateRsaKeys().privateKey;
  fs.writeFileSync(path.join(keyDir, "private.pem"), own.privateKey);
  fs.writeFileSync(path.join(keyDir, "public.pem"), own.publicKey);
  Config.jwtPrivateKeyPath = path.join(keyDir, "private.pem");
  Config.jwtPublicKeyPath = path.join(keyDir, "public.pem");

  server = http.createServer(await getApp());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  agent = request.agent(`http://127.0.0.1:${port}`);

  const users = await pool.query(
    "INSERT INTO users (hname, username, is_owner) VALUES ($1, $1, true) RETURNING uid",
    [`admin-token-${runId}`]
  );
  owner.uid = users.rows[0].uid;
  const created = await agent
    .post("/api/v3/conversations")
    .set("Authorization", `Bearer ${adminToken(serverKey)}`)
    .send({ topic: `Admin token ${runId}`, description: "" });
  expect(created.status).toBe(200);
  conversationId = created.body.conversation_id;
  const zinvites = await pool.query(
    "SELECT zid FROM zinvites WHERE zinvite = $1",
    [conversationId]
  );
  expect(zinvites.rows).toHaveLength(1);
  zid = zinvites.rows[0].zid;
});

afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const participants = await client.query(
      "SELECT uid FROM participants WHERE zid = $1",
      [zid]
    );
    for (const table of [
      "comments",
      "zinvites",
      "participants_extended",
      "participants",
      "conversations",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE zid = $1`, [zid]);
    }
    await client.query("DELETE FROM users WHERE uid = ANY($1)", [
      [owner.uid, ...participants.rows.map((row) => row.uid)],
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.warn("atproto admin token test rows were not removed", err);
  } finally {
    client.release();
  }

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  network.restore();
  Object.assign(Config, originalKeyPaths);
  fs.rmSync(keyDir, { recursive: true, force: true });
});

describe("a rejected atproto admin token", () => {
  test("answers 401 on every route while a valid token is accepted", async () => {
    const accepted = await agent
      .get("/api/v3/conversations")
      .set("Authorization", `Bearer ${adminToken(serverKey)}`);

    expect(accepted.status).toBe(200);
    expect(
      accepted.body.map(
        (conversation: { conversation_id: string }) =>
          conversation.conversation_id
      )
    ).toEqual([conversationId]);
    for (const [label, token] of rejectedTokens()) {
      for (const route of [
        "/api/v3/conversations",
        "/api/v3/users",
        "/api/v3/conversations/recently_started",
      ]) {
        const rejected = await agent
          .get(route)
          .set("Authorization", `Bearer ${token}`);

        expect([label, route, rejected.status, rejected.body]).toEqual([
          label,
          route,
          401,
          { error: "Invalid admin token" },
        ]);
      }
    }
  });

  test("cannot store a statement as an anonymous participant", async () => {
    for (const [label, token] of rejectedTokens()) {
      const txt = `Statement sent with a token ${label} ${runId}`;

      const response = await agent
        .post("/api/v3/comments")
        .set("Authorization", `Bearer ${token}`)
        .send({ conversation_id: conversationId, txt, is_seed: true });

      expect([label, response.status, response.body]).toEqual([
        label,
        401,
        { error: "Invalid admin token" },
      ]);
      expect(
        await count("SELECT COUNT(*) AS n FROM comments WHERE txt = $1", [txt])
      ).toBe(0);
    }
    expect(
      await count("SELECT COUNT(*) AS n FROM comments WHERE zid = $1", [zid])
    ).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM participants WHERE zid = $1", [
        zid,
      ])
    ).toBe(0);
  });
});

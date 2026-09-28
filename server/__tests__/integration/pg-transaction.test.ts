import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import logger from "../../src/utils/logger";
import pg, { TransactionQuery, withTransaction } from "../../src/db/pg-query";
import { pool as observerPool } from "../setup/db-test-helpers";

const runId = `${process.pid}_${Date.now()}`;
const table = `pg_transaction_test_${runId}`;
const COMMENTS_LOCK_CLASS = 873791984;

let uid: number;
let zid: number;
let pid: number;

async function observe(sql: string, params: unknown[] = []): Promise<any[]> {
  const result = await observerPool.query(sql, params);
  return result.rows;
}

async function storedLabels(prefix: string): Promise<string[]> {
  const rows = await observe(
    `SELECT label FROM ${table} WHERE label LIKE $1 ORDER BY label`,
    [`${prefix}%`]
  );
  return rows.map((row) => row.label);
}

async function poolBackendPid(): Promise<number> {
  const rows = (await pg.queryP("SELECT pg_backend_pid() AS pid", [])) as {
    pid: number;
  }[];
  return rows[0].pid;
}

async function heldAdvisoryLocks(
  classId: number,
  objId: number
): Promise<number[]> {
  const rows = await observe(
    `SELECT pid FROM pg_locks
     WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [classId, objId]
  );
  return rows.map((row) => row.pid);
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

beforeAll(async () => {
  await observe(
    `CREATE TABLE ${table} (
       label TEXT PRIMARY KEY,
       pair TEXT,
       CONSTRAINT ${table}_pair_key UNIQUE (pair) DEFERRABLE INITIALLY DEFERRED
     )`
  );
  const users = await observe(
    "INSERT INTO users (hname) VALUES ($1) RETURNING uid",
    [`pg-transaction-test ${runId}`]
  );
  uid = users[0].uid;
  const conversations = await observe(
    "INSERT INTO conversations (owner, org_id, topic) VALUES ($1, $1, $2) RETURNING zid",
    [uid, `pg-transaction-test ${runId}`]
  );
  zid = conversations[0].zid;
  const participants = await observe(
    "INSERT INTO participants (zid, uid) VALUES ($1, $2) RETURNING pid",
    [zid, uid]
  );
  pid = participants[0].pid;
});

afterAll(async () => {
  await observe(`DROP TABLE IF EXISTS ${table}`);
  await observe("DELETE FROM comments WHERE zid = $1", [zid]);
  await observe("DELETE FROM participants WHERE zid = $1", [zid]);
  await observe("DELETE FROM conversations WHERE zid = $1", [zid]);
  await observe("DELETE FROM users WHERE uid = $1", [uid]);
});

describe("withTransaction", () => {
  test("is also available on the default export", () => {
    expect(pg.withTransaction).toBe(withTransaction);
  });

  test("commits the work and returns the callback's value", async () => {
    const value = await withTransaction(async (query) => {
      const rows = await query(
        `INSERT INTO ${table} (label) VALUES ($1) RETURNING label`,
        ["commit-a"]
      );
      await query(`INSERT INTO ${table} (label) VALUES ('commit-b')`);
      return { first: rows[0].label, answer: 42 };
    });

    expect(value).toEqual({ first: "commit-a", answer: 42 });
    expect(await storedLabels("commit-")).toEqual(["commit-a", "commit-b"]);
  });

  test("runs every statement on one client inside one transaction", async () => {
    const seen = await withTransaction(async (query) => {
      const before = await query(
        "SELECT pg_backend_pid() AS pid, txid_current()::text AS txid"
      );
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["single-a"]);
      const after = await query(
        "SELECT pg_backend_pid() AS pid, txid_current()::text AS txid"
      );
      const own = await query(
        `SELECT label FROM ${table} WHERE label = 'single-a'`
      );
      return {
        before: before[0],
        after: after[0],
        ownRows: own.length,
        visibleOutside: await storedLabels("single-"),
      };
    });

    expect(seen.after.pid).toBe(seen.before.pid);
    expect(seen.after.txid).toBe(seen.before.txid);
    expect(seen.ownRows).toBe(1);
    expect(seen.visibleOutside).toEqual([]);
    expect(await storedLabels("single-")).toEqual(["single-a"]);
  });

  test("rolls back and rethrows when the callback throws", async () => {
    const failure = new Error("callback failed");

    const attempt = withTransaction(async (query) => {
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["throw-a"]);
      throw failure;
    });

    await expect(attempt).rejects.toBe(failure);
    expect(await storedLabels("throw-")).toEqual([]);
  });

  test("rethrows a value that is not an Error unchanged", async () => {
    const attempt = withTransaction(async (query) => {
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["string-a"]);
      throw "polis_err_plain_string";
    });

    await expect(attempt).rejects.toBe("polis_err_plain_string");
    expect(await storedLabels("string-")).toEqual([]);
  });

  test("a failed statement rolls back everything before it", async () => {
    const attempt = withTransaction(async (query) => {
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["failed-a"]);
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["failed-b"]);
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["failed-a"]);
      return "unreachable";
    });

    await expect(attempt).rejects.toMatchObject({
      code: "23505",
      constraint: `${table}_pkey`,
    });
    expect(await storedLabels("failed-")).toEqual([]);
  });

  test("a failed statement fails the transaction even when the callback catches it", async () => {
    let caught: { code?: string } | undefined;

    const attempt = withTransaction(async (query) => {
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["caught-a"]);
      try {
        await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["caught-a"]);
      } catch (err) {
        caught = err as { code?: string };
      }
      return "swallowed";
    });

    await expect(attempt).rejects.toMatchObject({
      code: "23505",
      constraint: `${table}_pkey`,
    });
    expect(caught?.code).toBe("23505");
    expect(await storedLabels("caught-")).toEqual([]);
  });

  test("a failed statement the callback did not wait for fails the transaction", async () => {
    let loose: Promise<unknown> | undefined;

    const attempt = withTransaction(async (query) => {
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["loose-a"]);
      loose = query(`INSERT INTO ${table} (label) VALUES ($1)`, [
        "loose-a",
      ]).catch((err) => err);
      return "returned early";
    });

    await expect(attempt).rejects.toMatchObject({ code: "25P02" });
    expect(await loose).toMatchObject({
      code: "23505",
      constraint: `${table}_pkey`,
    });
    expect(await storedLabels("loose-")).toEqual([]);
  });

  test("a failure at commit rolls back, rethrows and destroys the client", async () => {
    let transactionPid = 0;

    const attempt = withTransaction(async (query) => {
      const rows = await query("SELECT pg_backend_pid() AS pid");
      transactionPid = rows[0].pid;
      await query(`INSERT INTO ${table} (label, pair) VALUES ($1, $2)`, [
        "deferred-a",
        "same",
      ]);
      await query(`INSERT INTO ${table} (label, pair) VALUES ($1, $2)`, [
        "deferred-b",
        "same",
      ]);
      return "returned";
    });

    await expect(attempt).rejects.toMatchObject({
      code: "23505",
      constraint: `${table}_pair_key`,
    });
    expect(await storedLabels("deferred-")).toEqual([]);
    expect(transactionPid).toBeGreaterThan(0);
    expect(await poolBackendPid()).not.toBe(transactionPid);
  });

  test("rethrows a failure to get a client without running the callback", async () => {
    const failure = new Error("no client available");
    const logged = jest.spyOn(logger, "error").mockImplementation(() => logger);
    const connect = jest.spyOn(
      Pool.prototype,
      "connect"
    ) as unknown as jest.Mock<() => Promise<PoolClient>>;
    connect.mockImplementationOnce(() => Promise.reject(failure));
    const callback = jest.fn(async () => "unreachable");

    try {
      await expect(withTransaction(callback)).rejects.toBe(failure);
      expect(callback).not.toHaveBeenCalled();
      expect(logged.mock.calls).toEqual([["pg_connect_pool_fail", failure]]);
    } finally {
      connect.mockRestore();
      logged.mockRestore();
    }
  });

  test("two concurrent transactions each use their own client", async () => {
    const bothStarted = gate();
    const bothLooked = gate();
    let started = 0;
    let looked = 0;

    const run = (label: string) =>
      withTransaction(async (query) => {
        const session = await query(
          "SELECT pg_backend_pid() AS pid, txid_current()::text AS txid"
        );
        await query(`INSERT INTO ${table} (label) VALUES ($1)`, [label]);
        started += 1;
        if (started === 2) {
          bothStarted.open();
        }
        await bothStarted.opened;
        const visible = await query(
          `SELECT label FROM ${table} WHERE label LIKE 'concurrent-%' ORDER BY label`
        );
        looked += 1;
        if (looked === 2) {
          bothLooked.open();
        }
        await bothLooked.opened;
        return {
          pid: session[0].pid,
          txid: session[0].txid,
          visible: visible.map((row) => row.label),
        };
      });

    const [first, second] = await Promise.all([
      run("concurrent-a"),
      run("concurrent-b"),
    ]);

    expect(first.pid).not.toBe(second.pid);
    expect(first.txid).not.toBe(second.txid);
    expect(first.visible).toEqual(["concurrent-a"]);
    expect(second.visible).toEqual(["concurrent-b"]);
    expect(await storedLabels("concurrent-")).toEqual([
      "concurrent-a",
      "concurrent-b",
    ]);
  });

  test("one failing transaction does not affect a concurrent one", async () => {
    const bothStarted = gate();
    let started = 0;
    const failure = new Error("only this transaction fails");

    const run = (label: string, fail: boolean) =>
      withTransaction(async (query) => {
        await query(`INSERT INTO ${table} (label) VALUES ($1)`, [label]);
        started += 1;
        if (started === 2) {
          bothStarted.open();
        }
        await bothStarted.opened;
        if (fail) {
          throw failure;
        }
        return label;
      });

    const results = await Promise.allSettled([
      run("mixed-a", true),
      run("mixed-b", false),
    ]);

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "mixed-b" },
    ]);
    expect(await storedLabels("mixed-")).toEqual(["mixed-b"]);
  });

  test("returns the client to the pool after a commit", async () => {
    const transactionPid = await withTransaction(async (query) => {
      const rows = await query("SELECT pg_backend_pid() AS pid");
      return rows[0].pid;
    });

    expect(await poolBackendPid()).toBe(transactionPid);
  });

  test("destroys the client after a failure so a session-level lock cannot leak", async () => {
    const lockClass = 1900018;
    const lockObject = process.pid;
    let transactionPid = 0;
    let heldInside: number[] = [];
    const failure = new Error("fail while holding a session-level lock");

    const attempt = withTransaction(async (query) => {
      const rows = await query(
        "SELECT pg_backend_pid() AS pid, pg_advisory_lock($1, $2)",
        [lockClass, lockObject]
      );
      transactionPid = rows[0].pid;
      heldInside = await heldAdvisoryLocks(lockClass, lockObject);
      throw failure;
    });

    await expect(attempt).rejects.toBe(failure);
    expect(heldInside).toEqual([transactionPid]);
    expect(await poolBackendPid()).not.toBe(transactionPid);

    let waiter: PoolClient | undefined;
    try {
      waiter = await observerPool.connect();
      await waiter.query("SET statement_timeout = 5000");
      const acquired = await waiter.query(
        "SELECT pg_advisory_lock($1, $2), pg_backend_pid() AS pid",
        [lockClass, lockObject]
      );
      expect(await heldAdvisoryLocks(lockClass, lockObject)).toEqual([
        acquired.rows[0].pid,
      ]);
      await waiter.query("SELECT pg_advisory_unlock($1, $2)", [
        lockClass,
        lockObject,
      ]);
    } finally {
      waiter?.release(true);
    }
  });

  test("a rejected comment insert does not leave the conversation locked", async () => {
    const text = `pg-transaction-test statement ${runId}`;
    await observe(
      "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4)",
      [zid, pid, uid, text]
    );

    const attempt = withTransaction(async (query) => {
      await query(
        "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4)",
        [zid, pid, uid, `${text} second`]
      );
      await query(
        "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4)",
        [zid, pid, uid, text]
      );
    });

    await expect(attempt).rejects.toMatchObject({
      code: "23505",
      constraint: "comments_zid_txt_key",
    });

    let writer: PoolClient | undefined;
    try {
      writer = await observerPool.connect();
      await writer.query("SET statement_timeout = 5000");
      const inserted = await writer.query(
        "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4) RETURNING tid",
        [zid, pid, uid, `${text} third`]
      );
      expect(inserted.rows).toEqual([{ tid: 1 }]);
    } finally {
      writer?.release(true);
    }

    expect(await heldAdvisoryLocks(COMMENTS_LOCK_CLASS, zid)).toEqual([]);
    expect(
      await observe(
        "SELECT tid, txt FROM comments WHERE zid = $1 ORDER BY tid",
        [zid]
      )
    ).toEqual([
      { tid: 0, txt: text },
      { tid: 1, txt: `${text} third` },
    ]);
  });

  test("a skipped conflicting insert does not leave the conversation locked", async () => {
    const text = `pg-transaction-test skipped ${runId}`;
    const before = await observe(
      "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4) RETURNING tid",
      [zid, pid, uid, text]
    );
    let heldInside: number[] = [];

    const seen = await withTransaction(async (query) => {
      const session = await query("SELECT pg_backend_pid() AS pid");
      const skipped = await query(
        "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING tid",
        [zid, pid, uid, text]
      );
      heldInside = await heldAdvisoryLocks(COMMENTS_LOCK_CLASS, zid);
      return { pid: session[0].pid, inserted: skipped.length };
    });

    expect(seen.inserted).toBe(0);
    expect(heldInside).toEqual([seen.pid]);
    expect(await heldAdvisoryLocks(COMMENTS_LOCK_CLASS, zid)).toEqual([]);
    expect(await poolBackendPid()).toBe(seen.pid);

    let writer: PoolClient | undefined;
    try {
      writer = await observerPool.connect();
      await writer.query("SET statement_timeout = 5000");
      const inserted = await writer.query(
        "INSERT INTO comments (zid, pid, uid, txt) VALUES ($1, $2, $3, $4) RETURNING tid",
        [zid, pid, uid, `${text} next`]
      );
      expect(inserted.rows).toEqual([{ tid: before[0].tid + 1 }]);
    } finally {
      writer?.release(true);
    }
  });

  test("refuses statements once the transaction has ended", async () => {
    let leaked: TransactionQuery | undefined;

    await withTransaction(async (query) => {
      leaked = query;
      await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["ended-a"]);
    });

    await expect(
      leaked!(`INSERT INTO ${table} (label) VALUES ($1)`, ["ended-b"])
    ).rejects.toThrow("polis_err_transaction_finished");
    expect(await storedLabels("ended-")).toEqual(["ended-a"]);
  });

  test("survives losing the connection in the middle of a transaction", async () => {
    const logged = jest.spyOn(logger, "error").mockImplementation(() => logger);
    let transactionPid = 0;

    try {
      const attempt = withTransaction(async (query) => {
        const rows = await query("SELECT pg_backend_pid() AS pid");
        transactionPid = rows[0].pid;
        await query(`INSERT INTO ${table} (label) VALUES ($1)`, ["lost-a"]);
        await query("SELECT pg_terminate_backend(pg_backend_pid())");
        return "unreachable";
      });

      await expect(attempt).rejects.toMatchObject({ code: "57P01" });
      expect(logged.mock.calls.map((call) => call[0])).toEqual([
        "pg_transaction_client_error",
        "pg_transaction_rollback_fail",
      ]);
    } finally {
      logged.mockRestore();
    }

    expect(await storedLabels("lost-")).toEqual([]);
    const nextPid = await poolBackendPid();
    expect(nextPid).toBeGreaterThan(0);
    expect(nextPid).not.toBe(transactionPid);
  });
});

import { describe, expect, jest, test } from "@jest/globals";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import logger from "../../src/utils/logger";
import pg from "../../src/db/pg-query";
import { pool as observerPool } from "../setup/db-test-helpers";

type Run = (sql: string, params: unknown[]) => Promise<unknown>;

const TERMINATED = "terminating connection due to administrator command";

async function backendPid(run: Run): Promise<number> {
  const rows = (await run("SELECT pg_backend_pid() AS pid", [])) as {
    pid: number;
  }[];
  return rows[0].pid;
}

// The test runner fails a test on an unhandled rejection, and waiting one turn
// keeps the test open until Node has reported it.
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function nextErrorLog() {
  let seen!: (args: unknown[]) => void;
  const first = new Promise<unknown[]>((resolve) => {
    seen = resolve;
  });
  const logged = jest.spyOn(logger, "error").mockImplementation(((
    ...args: unknown[]
  ) => {
    seen(args);
    return logger;
  }) as any);
  return { first, logged };
}

describe("pg-query against a lost connection", () => {
  test.each([
    ["primary", pg.queryP as Run],
    ["readonly", pg.queryP_readOnly as Run],
  ])(
    "the %s pool survives losing an idle connection",
    async (name, run) => {
      const { first, logged } = nextErrorLog();

      try {
        const idlePid = await backendPid(run);
        await observerPool.query("SELECT pg_terminate_backend($1)", [idlePid]);

        expect(await first).toEqual([
          "pg_pool_idle_client_error",
          { pool: name, error: TERMINATED, code: "57P01" },
        ]);
        const nextPid = await backendPid(run);
        expect(nextPid).toBeGreaterThan(0);
        expect(nextPid).not.toBe(idlePid);
        expect(logged.mock.calls).toHaveLength(1);
      } finally {
        logged.mockRestore();
      }
    },
    10000
  );

  test("survives the socket closing while a query is running", async () => {
    const { first, logged } = nextErrorLog();
    const connect = Pool.prototype.connect;
    let running!: (client: PoolClient) => void;
    const checkedOut = new Promise<PoolClient>((resolve) => {
      running = resolve;
    });
    const spy = jest.spyOn(Pool.prototype, "connect") as unknown as jest.Mock<
      (...args: any[]) => unknown
    >;
    spy.mockImplementationOnce(function (this: Pool, callback: any) {
      return (connect as any).call(
        this,
        (err: Error, client: PoolClient, release: unknown) => {
          callback(err, client, release);
          running(client);
        }
      );
    });
    const closed = new Error("socket closed");

    try {
      const outcome = pg.queryP("SELECT pg_sleep(5)", []);
      const client = (await checkedOut) as any;
      const lostPid = client.processID;
      client.connection.stream.destroy(closed);

      await expect(outcome).rejects.toBe(closed);
      expect(await first).toEqual([
        "pg_client_error",
        { error: "socket closed", code: undefined },
      ]);
      const nextPid = await backendPid(pg.queryP as Run);
      expect(nextPid).toBeGreaterThan(0);
      expect(nextPid).not.toBe(lostPid);
      expect(logged.mock.calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  }, 10000);
});

describe("pg-query against a failed query", () => {
  test("queryP reports the failure to the caller and nowhere else", async () => {
    const logged = jest.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      await expect(
        pg.queryP("SELECT * FROM pg_pool_errors_test_missing_table", [])
      ).rejects.toMatchObject({ code: "42P01" });
      await nextTurn();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("a callback caller is told of the failure and nothing else is", async () => {
    const logged = jest.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const failure = await new Promise<any>((resolve) => {
        pg.query_readOnly(
          "SELECT * FROM pg_pool_errors_test_missing_table",
          [],
          (err: unknown) => resolve(err)
        );
      });
      expect(failure).toMatchObject({ code: "42P01" });
      await nextTurn();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("the pool still answers after a failed query", async () => {
    await expect(
      pg.queryP("SELECT * FROM pg_pool_errors_test_missing_table", [])
    ).rejects.toMatchObject({ code: "42P01" });

    await expect(pg.queryP("SELECT 1 AS ok", [])).resolves.toEqual([{ ok: 1 }]);
  });
});

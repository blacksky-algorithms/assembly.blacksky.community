import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockPools: EventEmitter[] = [];

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: mockLogger,
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: {
    databaseURL: "postgres://user@pg-query-errors.invalid:5432/primary",
    readOnlyDatabaseURL: "postgres://user@pg-query-errors.invalid:5432/replica",
    databaseSSL: false,
    isDevMode: false,
  },
}));
jest.mock("pg", () => {
  const actual = jest.requireActual("pg") as typeof import("pg");
  class RecordedPool extends actual.Pool {
    constructor(config?: import("pg").PoolConfig) {
      super(config);
      mockPools.push(this);
    }
  }
  return { ...actual, Pool: RecordedPool };
});

import pg from "../../src/db/pg-query";

type QueryCallback = (err: Error | null, results?: { rows: unknown[] }) => void;

// The test runner fails a test on an unhandled rejection, and waiting one turn
// keeps the test open until Node has reported it.
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function checkOut(poolIndex: number) {
  const client = new EventEmitter() as EventEmitter & { query: jest.Mock };
  const pending: QueryCallback[] = [];
  client.query = jest.fn((...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      pending.push(last as QueryCallback);
      return undefined;
    }
    return args[0];
  });
  const release = jest.fn();
  const connect = jest
    .spyOn(mockPools[poolIndex] as any, "connect")
    .mockImplementation((...args: unknown[]) => {
      (args[0] as (e: unknown, c: unknown, r: unknown) => void)(
        undefined,
        client,
        release
      );
    });
  return { client, pending, release, connect };
}

beforeEach(() => {
  jest.restoreAllMocks();
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

describe("pg-query connection errors", () => {
  test.each([
    [0, "primary", "primary"],
    [1, "readonly", "replica"],
  ])(
    "an error on an idle client of pool %i is logged and not thrown",
    (poolIndex, name, database) => {
      const lost = Object.assign(new Error("idle client lost"), {
        code: "57P01",
        client: { host: "pg-query-errors.invalid", user: "user" },
      });

      expect(mockPools).toHaveLength(2);
      expect((mockPools[poolIndex] as any).options.database).toBe(database);
      expect(() => mockPools[poolIndex].emit("error", lost, {})).not.toThrow();

      expect(mockLogger.error.mock.calls).toEqual([
        [
          "pg_pool_idle_client_error",
          { pool: name, error: "idle client lost", code: "57P01" },
        ],
      ]);
    }
  );

  test("a connection lost while a query is running is logged and not thrown", async () => {
    const { client, pending, release } = checkOut(0);
    const lost = Object.assign(new Error("connection lost"), {
      code: "ECONNRESET",
    });

    const outcome = pg.queryP("SELECT 1", []);
    expect(pending).toHaveLength(1);
    expect(() => client.emit("error", lost)).not.toThrow();
    pending[0](lost);

    await expect(outcome).rejects.toBe(lost);
    await nextTurn();
    expect(mockLogger.error.mock.calls).toEqual([
      ["pg_client_error", { error: "connection lost", code: "ECONNRESET" }],
    ]);
    expect(release.mock.calls).toEqual([[lost]]);
    expect(client.listenerCount("error")).toBe(0);
  });

  test("a client is guarded while it is checked out and goes back without the listener", async () => {
    const { client, pending, release } = checkOut(1);
    const results = { rows: [{ ok: 1 }] };
    const callback = jest.fn();

    const returned = pg.query_readOnly("SELECT 1", [], callback);
    expect(client.listenerCount("error")).toBe(1);
    pending[0](null, results);

    expect(callback.mock.calls).toEqual([[null, results]]);
    await expect(returned).resolves.toBe(results.rows);
    expect(release.mock.calls).toEqual([[]]);
    expect(client.listenerCount("error")).toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("pg-query failed queries", () => {
  test("queryP rejects once and leaves no unhandled rejection behind", async () => {
    const { pending } = checkOut(0);
    const failure = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });

    const outcome = pg.queryP("SELECT 1", []);
    pending[0](failure);

    await expect(outcome).rejects.toBe(failure);
    await nextTurn();
  });

  test("a callback caller is told of the failure once and the returned promise still rejects", async () => {
    const { pending, release } = checkOut(0);
    const failure = new Error("relation does not exist");
    const callback = jest.fn();

    const returned = pg.query("SELECT 1", [], callback);
    pending[0](failure);
    await nextTurn();

    expect(callback.mock.calls).toEqual([[failure]]);
    await expect(returned).rejects.toBe(failure);
    expect(release.mock.calls).toEqual([[failure]]);
  });

  test("a callback caller that drops the returned promise leaves no unhandled rejection behind", async () => {
    const { pending } = checkOut(1);
    const failure = new Error("relation does not exist");
    const callback = jest.fn();

    pg.query_readOnly("SELECT 1", [], callback);
    pending[0](failure);

    expect(callback.mock.calls).toEqual([[failure]]);
    await nextTurn();
  });

  test("a failure to get a client reaches the caller and leaves no unhandled rejection behind", async () => {
    const failure = new Error("no client available");
    jest
      .spyOn(mockPools[0] as any, "connect")
      .mockImplementation((...args: unknown[]) => {
        (args[0] as (e: unknown, c: unknown, r: unknown) => void)(
          failure,
          undefined,
          () => undefined
        );
      });

    await expect(pg.queryP("SELECT 1", [])).rejects.toBe(failure);
    await nextTurn();
    expect(mockLogger.error.mock.calls).toEqual([
      ["pg_connect_pool_fail", failure],
    ]);
  });
});

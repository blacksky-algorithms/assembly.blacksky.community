import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: mockLogger,
}));
jest.mock("../../src/config", () => ({
  __esModule: true,
  default: { jwtPrivateKeyPath: null },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../src/utils/common", () => ({
  __esModule: true,
  isPolisDev: jest.fn(() => false),
}));
jest.mock("../../src/auth/create-user", () => ({
  __esModule: true,
  getOrCreateUserIDFromOidcSub: jest.fn(),
}));
jest.mock("../../src/auth/github-supporters", () => ({
  __esModule: true,
  isOssSupporter: jest.fn(() => false),
  ensureGithubCacheReady: jest.fn(),
}));

import { getFeedgenPool } from "../../src/auth/atproto-admin";

beforeEach(() => {
  Object.values(mockLogger).forEach((fn) => fn.mockClear());
});

describe("feedgen pool", () => {
  test("an error on an idle client is logged and not thrown", () => {
    const pool = getFeedgenPool();
    const lost = Object.assign(new Error("idle client lost"), {
      code: "57P01",
      client: { host: "feedgen-pool-errors.invalid", user: "user" },
    });

    expect(() => pool.emit("error", lost, {})).not.toThrow();

    expect(mockLogger.error.mock.calls).toEqual([
      [
        "feedgen_pool_idle_client_error",
        { error: "idle client lost", code: "57P01" },
      ],
    ]);
  });

  test("the pool is created once and keeps one listener", () => {
    const pool = getFeedgenPool();

    expect(getFeedgenPool()).toBe(pool);
    expect(pool.listenerCount("error")).toBe(1);
  });
});

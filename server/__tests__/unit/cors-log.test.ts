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
  default: {
    domainOverride: null,
    isDevMode: false,
    isTesting: false,
    nodeEnv: "production",
    useNetworkHost: false,
    whitelistItems: [],
    getServerHostname: () => "assembly.cors-log-test.invalid",
  },
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {},
}));

import { addCorsHeader, redirectIfNotHttps } from "../../src/utils/domain";

const TOKEN = "Bearer header.payload.signature";
const COOKIE = "session=secret-session-value";

function requestFrom(origin: string, headers: Record<string, string>) {
  const all: Record<string, string> = { origin, ...headers };
  return {
    method: "POST",
    path: "/api/v3/atproto/conversations",
    protocol: "https",
    url: "/api/v3/atproto/conversations",
    headers: all,
    get: (name: string) => all[name.toLowerCase()],
  };
}

function response() {
  return {
    header: jest.fn(),
    status: jest.fn(() => ({ json: jest.fn(), send: jest.fn() })),
    end: jest.fn(),
    writeHead: jest.fn(),
  };
}

function logged(): string {
  return JSON.stringify([
    mockLogger.debug.mock.calls,
    mockLogger.info.mock.calls,
    mockLogger.warn.mock.calls,
    mockLogger.error.mock.calls,
  ]);
}

describe("request headers in the log", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("a refused origin is logged without its credentials", () => {
    const next = jest.fn();
    const request = requestFrom("https://elsewhere.cors-log-test.invalid", {
      Authorization: TOKEN,
      cookie: COOKIE,
      "Proxy-Authorization": "Basic cHJveHk6c2VjcmV0",
      "content-type": "application/json",
    });

    addCorsHeader(request as never, response() as never, next);

    expect(next.mock.calls).toEqual([
      ["unauthorized domain: https://elsewhere.cors-log-test.invalid"],
    ]);
    expect(mockLogger.info.mock.calls).toEqual([
      [
        "CORS: domain not whitelisted",
        {
          origin: "https://elsewhere.cors-log-test.invalid",
          path: "/api/v3/atproto/conversations",
          headers: {
            origin: "https://elsewhere.cors-log-test.invalid",
            Authorization: "[redacted]",
            cookie: "[redacted]",
            "Proxy-Authorization": "[redacted]",
            "content-type": "application/json",
          },
        },
      ],
    ]);
    expect(logged()).not.toContain("header.payload.signature");
    expect(logged()).not.toContain("secret-session-value");
    expect(logged()).not.toContain("cHJveHk6c2VjcmV0");
    expect(request.headers.Authorization).toBe(TOKEN);
  });

  test("a request that is not https is logged without its credentials", () => {
    const request = requestFrom("https://elsewhere.cors-log-test.invalid", {
      authorization: TOKEN,
      host: "assembly.cors-log-test.invalid",
    });

    redirectIfNotHttps(request as never, response() as never, jest.fn());

    expect(mockLogger.debug.mock.calls).toEqual([
      [
        "redirecting to https",
        {
          headers: {
            origin: "https://elsewhere.cors-log-test.invalid",
            authorization: "[redacted]",
            host: "assembly.cors-log-test.invalid",
          },
        },
      ],
    ]);
    expect(logged()).not.toContain("header.payload.signature");
    expect(request.headers.authorization).toBe(TOKEN);
  });
});

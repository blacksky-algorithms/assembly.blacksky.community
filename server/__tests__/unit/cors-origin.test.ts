import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockConfig = {
  domainOverride: null as string | null,
  isDevMode: false,
  isTesting: false,
  nodeEnv: "production",
  useNetworkHost: false,
  whitelistItems: [] as string[],
  serverHostname: "assembly.blacksky.community",
  getServerHostname: () => mockConfig.serverHostname,
};

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
  default: mockConfig,
}));
jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {},
}));

import { addCorsHeader, isAllowedOrigin } from "../../src/utils/domain";

const ADMITTED = {
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers":
    "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
};

type Outcome = {
  nextCalls: unknown[][];
  headers: Record<string, string>;
  varies: string[];
  status: number | undefined;
  logged: unknown[][];
};

function verdicts(origins: string[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const origin of origins) {
    result[origin] = isAllowedOrigin(origin);
  }
  return result;
}

function send(
  headers: Record<string, string>,
  method: string,
  path: string
): Outcome {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value;
  }
  const outcome: Outcome = {
    nextCalls: [],
    headers: {},
    varies: [],
    status: undefined,
    logged: [],
  };
  const request = {
    method,
    path,
    protocol: "https",
    headers: lower,
    get: (name: string) => lower[name.toLowerCase()],
  };
  const response = {
    header: (name: string, value: string) => {
      outcome.headers[name] = value;
    },
    vary: (name: string) => {
      outcome.varies.push(name);
    },
    status: (code: number) => {
      outcome.status = code;
      return { json: jest.fn() };
    },
  };
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  addCorsHeader(request as never, response as never, (...args: unknown[]) => {
    outcome.nextCalls.push(args);
  });
  outcome.logged = [
    ...mockLogger.info.mock.calls,
    ...mockLogger.warn.mock.calls,
  ];
  return outcome;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.domainOverride = null;
  mockConfig.isDevMode = false;
  mockConfig.isTesting = false;
  mockConfig.nodeEnv = "production";
  mockConfig.whitelistItems = [];
  mockConfig.serverHostname = "assembly.blacksky.community";
});

describe("the origin allowlist", () => {
  test("lists first-party origins and none that only look like one", () => {
    expect(
      verdicts([
        "https://assembly.blacksky.community",
        "https://blacksky.community",
        "https://staging.blacksky.community",
        "https://blacksky.community.evil.example",
        "https://evilblacksky.community",
        "https://localhost.evil.example",
        "http://127.0.0.1.evil.example",
        "https://evil.example",
        "https://evil.example/?blacksky.community",
        "https://blacksky.community@evil.example",
        "https://blacksky.community/",
        "https://blacksky.community:443",
        "https://BLACKSKY.community",
        "http://blacksky.community",
        "http://localhost:19006",
        "http://127.0.0.1:19006",
        "null",
      ])
    ).toEqual({
      "https://assembly.blacksky.community": true,
      "https://blacksky.community": true,
      "https://staging.blacksky.community": true,
      "https://blacksky.community.evil.example": false,
      "https://evilblacksky.community": false,
      "https://localhost.evil.example": false,
      "http://127.0.0.1.evil.example": false,
      "https://evil.example": false,
      "https://evil.example/?blacksky.community": false,
      "https://blacksky.community@evil.example": false,
      "https://blacksky.community/": false,
      "https://blacksky.community:443": false,
      "https://BLACKSKY.community": false,
      "http://blacksky.community": false,
      "http://localhost:19006": false,
      "http://127.0.0.1:19006": false,
      null: false,
    });
  });

  test("lists the server hostname and its subdomains over https", () => {
    mockConfig.serverHostname = "polls.example";

    expect(
      verdicts([
        "https://polls.example",
        "https://embed.polls.example",
        "https://polls.example.evil.example",
        "https://notpolls.example",
        "http://polls.example",
      ])
    ).toEqual({
      "https://polls.example": true,
      "https://embed.polls.example": true,
      "https://polls.example.evil.example": false,
      "https://notpolls.example": false,
      "http://polls.example": false,
    });
  });

  test("treats a domain override as one more host and lists nothing else for it", () => {
    mockConfig.domainOverride = "Override.example";

    expect(
      verdicts([
        "https://override.example",
        "https://blacksky.community",
        "https://evil.example",
        "https://community.example",
        "null",
      ])
    ).toEqual({
      "https://override.example": true,
      "https://blacksky.community": true,
      "https://evil.example": false,
      "https://community.example": false,
      null: false,
    });
  });

  test("lists whitelist items, their subdomains and the loopback ports they name", () => {
    mockConfig.whitelistItems = [
      "partner.example",
      "localhost:19006",
      "127.0.0.1:19006",
    ];

    expect(
      verdicts([
        "https://partner.example",
        "https://embed.partner.example",
        "http://localhost:19006",
        "http://127.0.0.1:19006",
        "https://partner.example.evil.example",
        "https://notpartner.example",
        "http://partner.example",
        "http://localhost:3000",
        "http://127.0.0.1:8081",
      ])
    ).toEqual({
      "https://partner.example": true,
      "https://embed.partner.example": true,
      "http://localhost:19006": true,
      "http://127.0.0.1:19006": true,
      "https://partner.example.evil.example": false,
      "https://notpartner.example": false,
      "http://partner.example": false,
      "http://localhost:3000": false,
      "http://127.0.0.1:8081": false,
    });
  });

  test("lists loopback origins on any port in dev mode and none that only look like one", () => {
    mockConfig.isDevMode = true;

    expect(
      verdicts([
        "http://localhost:5010",
        "http://localhost",
        "http://127.0.0.1:4321",
        "http://localhost.evil.example",
        "http://127.0.0.1.evil.example",
      ])
    ).toEqual({
      "http://localhost:5010": true,
      "http://localhost": true,
      "http://127.0.0.1:4321": true,
      "http://localhost.evil.example": false,
      "http://127.0.0.1.evil.example": false,
    });
  });
});

describe("origins outside the allowlist", () => {
  test("are logged once and answered as before when a domain override is set", () => {
    mockConfig.domainOverride = "assembly.blacksky.community";

    expect({
      elsewhere: send(
        { Origin: "https://community.example", Authorization: "Bearer a.b.c" },
        "GET",
        "/api/v3/embed/conversation"
      ),
      opaque: send({ Origin: "null" }, "POST", "/api/v3/embed/vote"),
      preflight: send(
        {
          Origin: "https://community.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
        "OPTIONS",
        "/api/v3/embed/vote"
      ),
      firstParty: send(
        { Origin: "https://blacksky.community" },
        "GET",
        "/api/v3/embed/conversation"
      ),
      withoutOrigin: send(
        { Referer: "https://community.example/page" },
        "GET",
        "/api/v3/embed/conversation"
      ),
    }).toEqual({
      elsewhere: {
        nextCalls: [[]],
        headers: {
          "Access-Control-Allow-Origin": "https://community.example",
          ...ADMITTED,
        },
        varies: [],
        status: undefined,
        logged: [
          [
            "CORS: origin outside the allowlist",
            {
              origin: "https://community.example",
              path: "/api/v3/embed/conversation",
              method: "GET",
            },
          ],
        ],
      },
      opaque: {
        nextCalls: [[]],
        headers: { "Access-Control-Allow-Origin": "null", ...ADMITTED },
        varies: [],
        status: undefined,
        logged: [
          [
            "CORS: origin outside the allowlist",
            { origin: "null", path: "/api/v3/embed/vote", method: "POST" },
          ],
        ],
      },
      preflight: {
        nextCalls: [],
        headers: {
          "Access-Control-Allow-Origin": "https://community.example",
          ...ADMITTED,
        },
        varies: [],
        status: 204,
        logged: [
          [
            "CORS: origin outside the allowlist",
            {
              origin: "https://community.example",
              path: "/api/v3/embed/vote",
              method: "OPTIONS",
            },
          ],
        ],
      },
      firstParty: {
        nextCalls: [[]],
        headers: {
          "Access-Control-Allow-Origin": "https://blacksky.community",
          ...ADMITTED,
        },
        varies: [],
        status: undefined,
        logged: [],
      },
      withoutOrigin: {
        nextCalls: [[]],
        headers: {
          "Access-Control-Allow-Origin": "https://assembly.blacksky.community",
          ...ADMITTED,
        },
        varies: [],
        status: undefined,
        logged: [],
      },
    });
  });

  test("are logged once and answered as before when no domain override is set", () => {
    const refusedHeaders = {
      origin: "https://evil.example",
      authorization: "[redacted]",
    };

    expect({
      lookAlike: send(
        { Origin: "https://blacksky.community.evil.example" },
        "POST",
        "/api/v3/embed/vote"
      ),
      loopback: send(
        { Origin: "http://localhost:19006" },
        "GET",
        "/api/v3/embed/conversation"
      ),
      refused: send(
        { Origin: "https://evil.example", Authorization: "Bearer a.b.c" },
        "POST",
        "/api/v3/embed/vote"
      ),
    }).toEqual({
      lookAlike: {
        nextCalls: [[]],
        headers: {
          "Access-Control-Allow-Origin":
            "https://blacksky.community.evil.example",
          ...ADMITTED,
        },
        varies: [],
        status: undefined,
        logged: [
          [
            "CORS: origin outside the allowlist",
            {
              origin: "https://blacksky.community.evil.example",
              path: "/api/v3/embed/vote",
              method: "POST",
            },
          ],
        ],
      },
      loopback: {
        nextCalls: [[]],
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:19006",
          ...ADMITTED,
        },
        varies: [],
        status: undefined,
        logged: [
          [
            "CORS: origin outside the allowlist",
            {
              origin: "http://localhost:19006",
              path: "/api/v3/embed/conversation",
              method: "GET",
            },
          ],
        ],
      },
      refused: {
        nextCalls: [["unauthorized domain: https://evil.example"]],
        headers: {},
        varies: [],
        status: undefined,
        logged: [
          [
            "CORS: domain not whitelisted",
            {
              origin: "https://evil.example",
              path: "/api/v3/embed/vote",
              headers: refusedHeaders,
            },
          ],
        ],
      },
    });
  });

  test("are logged as a warning, which the default log level prints", () => {
    mockConfig.domainOverride = "assembly.blacksky.community";

    send(
      { Origin: "https://community.example" },
      "GET",
      "/api/v3/embed/conversation"
    );

    expect({
      warnings: mockLogger.warn.mock.calls,
      infos: mockLogger.info.mock.calls,
    }).toEqual({
      warnings: [
        [
          "CORS: origin outside the allowlist",
          {
            origin: "https://community.example",
            path: "/api/v3/embed/conversation",
            method: "GET",
          },
        ],
      ],
      infos: [],
    });
  });

  test("are logged outside test mode only", () => {
    mockConfig.domainOverride = "assembly.blacksky.community";
    const request = { Origin: "https://community.example" };
    const answered = {
      nextCalls: [[]],
      headers: {
        "Access-Control-Allow-Origin": "https://community.example",
        ...ADMITTED,
      },
      varies: [],
      status: undefined,
    };
    const line = [
      "CORS: origin outside the allowlist",
      {
        origin: "https://community.example",
        path: "/api/v3/embed/conversation",
        method: "GET",
      },
    ];

    const production = send(request, "GET", "/api/v3/embed/conversation");
    mockConfig.isTesting = true;
    const testing = send(request, "GET", "/api/v3/embed/conversation");
    mockConfig.isTesting = false;
    mockConfig.nodeEnv = "test";
    const testEnvironment = send(request, "GET", "/api/v3/embed/conversation");

    expect({ production, testing, testEnvironment }).toEqual({
      production: { ...answered, logged: [line] },
      testing: { ...answered, logged: [] },
      testEnvironment: { ...answered, logged: [] },
    });
  });
});

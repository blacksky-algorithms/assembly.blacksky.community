import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

type AnonPds = typeof import("../../src/auth/anon-pds");
type Writer = "createAnonStatementRecord" | "putAnonStatementRecord";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: mockLogger,
}));

const PDS = "https://pds.anon-pds-test.invalid";
const SERVICE_DID = "did:plc:anonpdstestservice";
const CONFIGURED = {
  ANON_DID: SERVICE_DID,
  ANON_PDS: PDS,
  ANON_HANDLE: "service.anon-pds-test.invalid",
  ANON_APP_PASSWORD: "app-password-for-tests",
};
const NOT_CONFIGURED = {
  ANON_DID: "",
  ANON_PDS: "",
  ANON_HANDLE: "",
  ANON_APP_PASSWORD: "",
};
const ENV_NAMES = Object.keys(CONFIGURED);
const NOW = "2026-03-04T05:06:07.089Z";
const COLLECTION = "community.blacksky.assembly.statement";
const CREATE_SESSION = `${PDS}/xrpc/com.atproto.server.createSession`;
const CREATE_RECORD = `${PDS}/xrpc/com.atproto.repo.createRecord`;
const PUT_RECORD = `${PDS}/xrpc/com.atproto.repo.putRecord`;

const STATEMENT = {
  conversationUri:
    "at://did:plc:anonpdstestcreator/community.blacksky.assembly.conversation/3kconv",
  conversationCid: "bafyreiconversationcid",
  text: "Statement text",
};
const PUT_STATEMENT = {
  ...STATEMENT,
  rkey: "3kstatementrkey",
  createdAt: "2026-02-01T10:20:30.456Z",
};
const RECORD = {
  uri: `at://${SERVICE_DID}/${COLLECTION}/3kstatementrkey`,
  cid: "bafyreistatementcid",
};

const savedEnv: Record<string, string | undefined> = {};
const realFetch = global.fetch;
let fetchMock: jest.Mock<typeof fetch>;

function loadAnonPds(env: Record<string, string>): AnonPds {
  Object.assign(process.env, env);
  let loaded: AnonPds | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<AnonPds>("../../src/auth/anon-pds");
  });
  return loaded!;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function session(accessJwt: string, did = SERVICE_DID): Response {
  return json(200, { accessJwt, refreshJwt: `refresh-${accessJwt}`, did });
}

function never(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function stalled(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>(), { status });
}

function requests() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method,
    headers: init?.headers,
    body: JSON.parse(init?.body as string),
  }));
}

function signalOf(call: number): AbortSignal {
  return fetchMock.mock.calls[call][1]?.signal as AbortSignal;
}

function expectedWrite(writer: Writer, accessJwt: string) {
  const put = writer === "putAnonStatementRecord";
  return {
    url: put ? PUT_RECORD : CREATE_RECORD,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessJwt}`,
    },
    body: {
      repo: SERVICE_DID,
      collection: COLLECTION,
      ...(put ? { rkey: PUT_STATEMENT.rkey } : {}),
      record: {
        $type: COLLECTION,
        conversation: {
          uri: STATEMENT.conversationUri,
          cid: STATEMENT.conversationCid,
        },
        text: STATEMENT.text,
        anonymous: true,
        createdAt: put ? PUT_STATEMENT.createdAt : NOW,
      },
    },
  };
}

const EXPECTED_LOGIN = {
  url: CREATE_SESSION,
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: {
    identifier: CONFIGURED.ANON_HANDLE,
    password: CONFIGURED.ANON_APP_PASSWORD,
  },
};

function write(anon: AnonPds, writer: Writer) {
  return writer === "putAnonStatementRecord"
    ? anon.putAnonStatementRecord(PUT_STATEMENT)
    : anon.createAnonStatementRecord(STATEMENT);
}

const WRITERS: Writer[] = [
  "createAnonStatementRecord",
  "putAnonStatementRecord",
];
const STALE_RESPONSES: [string, number, unknown][] = [
  ["400 ExpiredToken", 400, { error: "ExpiredToken", message: "expired" }],
  ["400 InvalidToken", 400, { error: "InvalidToken", message: "invalid" }],
  ["401", 401, { error: "AuthenticationRequired" }],
];
const STALE_CASES = WRITERS.flatMap((writer) =>
  STALE_RESPONSES.map(
    ([name, status, body]) => [writer, name, status, body] as const
  )
);

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
  }
  jest.useFakeTimers({
    now: new Date(NOW),
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
    ],
  });
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  fetchMock = jest.fn<typeof fetch>();
  global.fetch = fetchMock;
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

describe("anon-pds statement records", () => {
  test("createAnonStatementRecord logs in and sends createRecord without an rkey", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD));

    const result = await anon.createAnonStatementRecord(STATEMENT);

    expect(result).toEqual(RECORD);
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      expectedWrite("createAnonStatementRecord", "jwt-1"),
    ]);
    expect(requests()[1].body).not.toHaveProperty("rkey");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("putAnonStatementRecord sends putRecord with the given rkey, createdAt and anonymous: true", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD));

    const result = await anon.putAnonStatementRecord(PUT_STATEMENT);

    expect(result).toEqual(RECORD);
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      {
        url: PUT_RECORD,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer jwt-1",
        },
        body: {
          repo: SERVICE_DID,
          collection: COLLECTION,
          rkey: "3kstatementrkey",
          record: {
            $type: COLLECTION,
            conversation: {
              uri: STATEMENT.conversationUri,
              cid: STATEMENT.conversationCid,
            },
            text: "Statement text",
            anonymous: true,
            createdAt: "2026-02-01T10:20:30.456Z",
          },
        },
      },
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("the session is reused for later writes", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD))
      .mockResolvedValueOnce(json(200, RECORD));

    await anon.putAnonStatementRecord(PUT_STATEMENT);
    await anon.createAnonStatementRecord(STATEMENT);

    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      expectedWrite("putAnonStatementRecord", "jwt-1"),
      expectedWrite("createAnonStatementRecord", "jwt-1"),
    ]);
  });

  test("concurrent writes share one login", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD))
      .mockResolvedValueOnce(json(200, RECORD));

    const results = await Promise.all([
      anon.putAnonStatementRecord(PUT_STATEMENT),
      anon.putAnonStatementRecord(PUT_STATEMENT),
    ]);

    expect(results).toEqual([RECORD, RECORD]);
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      expectedWrite("putAnonStatementRecord", "jwt-1"),
      expectedWrite("putAnonStatementRecord", "jwt-1"),
    ]);
  });

  test("two writes that meet an expired session together share one new login", async () => {
    const anon = loadAnonPds(CONFIGURED);
    const expired = { error: "ExpiredToken", message: "expired" };
    fetchMock.mockResolvedValueOnce(session("jwt-1"));
    expect(await anon.ensureAnonSession()).toBe(true);
    fetchMock
      .mockResolvedValueOnce(json(400, expired))
      .mockResolvedValueOnce(json(400, expired))
      .mockResolvedValueOnce(session("jwt-2"))
      .mockResolvedValueOnce(json(200, RECORD))
      .mockResolvedValueOnce(json(200, RECORD));

    const results = await Promise.all([
      anon.putAnonStatementRecord(PUT_STATEMENT),
      anon.putAnonStatementRecord(PUT_STATEMENT),
    ]);

    expect(results).toEqual([RECORD, RECORD]);
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      expectedWrite("putAnonStatementRecord", "jwt-1"),
      expectedWrite("putAnonStatementRecord", "jwt-1"),
      EXPECTED_LOGIN,
      expectedWrite("putAnonStatementRecord", "jwt-2"),
      expectedWrite("putAnonStatementRecord", "jwt-2"),
    ]);
  });

  test("a late expired answer reuses the session another write already renewed", async () => {
    const anon = loadAnonPds(CONFIGURED);
    const expired = { error: "ExpiredToken", message: "expired" };
    let answerLate!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => {
      answerLate = resolve;
    });
    fetchMock.mockResolvedValueOnce(session("jwt-1"));
    expect(await anon.ensureAnonSession()).toBe(true);
    fetchMock
      .mockResolvedValueOnce(json(400, expired))
      .mockReturnValueOnce(late)
      .mockResolvedValueOnce(session("jwt-2"))
      .mockResolvedValueOnce(json(200, RECORD))
      .mockResolvedValueOnce(json(200, RECORD));

    const first = anon.createAnonStatementRecord(STATEMENT);
    const second = anon.putAnonStatementRecord(PUT_STATEMENT);

    expect(await first).toEqual(RECORD);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    answerLate(json(400, expired));

    expect(await second).toEqual(RECORD);
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      expectedWrite("createAnonStatementRecord", "jwt-1"),
      expectedWrite("putAnonStatementRecord", "jwt-1"),
      EXPECTED_LOGIN,
      expectedWrite("createAnonStatementRecord", "jwt-2"),
      expectedWrite("putAnonStatementRecord", "jwt-2"),
    ]);
  });

  test.each(STALE_CASES)(
    "%s: a %s answer triggers one new login and one retry and returns the record",
    async (writer, name, status, body) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock.mockResolvedValueOnce(session("jwt-1"));
      expect(await anon.ensureAnonSession()).toBe(true);
      fetchMock
        .mockResolvedValueOnce(json(status, body))
        .mockResolvedValueOnce(session("jwt-2"))
        .mockResolvedValueOnce(json(200, RECORD));

      const result = await write(anon, writer);

      expect(result).toEqual(RECORD);
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-2"),
      ]);
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test.each(STALE_CASES)(
    "%s: the session from the new login after a %s answer is kept",
    async (writer, name, status, body) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockResolvedValueOnce(json(status, body))
        .mockResolvedValueOnce(session("jwt-2"))
        .mockResolvedValueOnce(json(200, RECORD))
        .mockResolvedValueOnce(json(200, RECORD));

      await write(anon, writer);
      const second = await write(anon, writer);

      expect(second).toEqual(RECORD);
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-2"),
        expectedWrite(writer, "jwt-2"),
      ]);
    }
  );

  test.each(WRITERS)(
    "%s: a 400 with another error does not retry and keeps the session",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      const rejection = { error: "InvalidRequest", message: "bad record" };
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockResolvedValueOnce(json(400, rejection))
        .mockResolvedValueOnce(json(200, RECORD));

      const first = await write(anon, writer);

      expect(first).toBeNull();
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
      ]);
      expect(mockLogger.error.mock.calls).toEqual([
        [
          "Failed to create anon statement",
          { status: 400, body: JSON.stringify(rejection) },
        ],
      ]);

      const second = await write(anon, writer);

      expect(second).toEqual(RECORD);
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
        expectedWrite(writer, "jwt-1"),
      ]);
    }
  );

  test.each(WRITERS)(
    "%s: a 400 whose body is not JSON does not retry",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockResolvedValueOnce(new Response("ExpiredToken", { status: 400 }));

      const result = await write(anon, writer);

      expect(result).toBeNull();
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
      ]);
      expect(mockLogger.error.mock.calls).toEqual([
        [
          "Failed to create anon statement",
          { status: 400, body: "ExpiredToken" },
        ],
      ]);
    }
  );

  test.each(WRITERS)("%s: a 500 does not retry", async (writer) => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(500, { error: "InternalServerError" }));

    const result = await write(anon, writer);

    expect(result).toBeNull();
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      expectedWrite(writer, "jwt-1"),
    ]);
  });

  test.each(STALE_CASES)(
    "%s: a second %s answer returns null without a third attempt",
    async (writer, name, status, body) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockResolvedValueOnce(json(status, body))
        .mockResolvedValueOnce(session("jwt-2"))
        .mockResolvedValueOnce(json(status, body));

      const result = await write(anon, writer);

      expect(result).toBeNull();
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-2"),
      ]);
      expect(mockLogger.error.mock.calls).toEqual([
        ["Anon statement retry failed", { status }],
      ]);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test.each(WRITERS)(
    "%s: returns null when the new login is refused",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockResolvedValueOnce(json(400, { error: "ExpiredToken" }))
        .mockResolvedValueOnce(json(401, { error: "AuthenticationRequired" }));

      const result = await write(anon, writer);

      expect(result).toBeNull();
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
        EXPECTED_LOGIN,
      ]);
      expect(mockLogger.error.mock.calls).toEqual([
        ["Failed to create anon PDS session", { status: 401 }],
      ]);
    }
  );

  test.each(WRITERS)(
    "%s: returns null when the answer has no uri and cid",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockResolvedValueOnce(json(200, { uri: RECORD.uri }));

      const result = await write(anon, writer);

      expect(result).toBeNull();
      expect(mockLogger.error.mock.calls).toEqual([
        ["Anon statement response is incomplete", { status: 200 }],
      ]);
    }
  );

  test.each(WRITERS)(
    "%s: returns null when the request fails to connect",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      const failure = new TypeError("fetch failed");
      fetchMock
        .mockResolvedValueOnce(session("jwt-1"))
        .mockRejectedValueOnce(failure);

      const result = await write(anon, writer);

      expect(result).toBeNull();
      expect(mockLogger.error.mock.calls).toEqual([
        ["Anon statement record error", failure],
      ]);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test.each(WRITERS)(
    "%s: returns null and makes no request when nothing is configured",
    async (writer) => {
      const anon = loadAnonPds(NOT_CONFIGURED);

      const result = await write(anon, writer);

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe("anon-pds request timeout", () => {
  test.each(WRITERS)(
    "%s: a write that gets no answer is aborted after 10 seconds and returns null",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock.mockResolvedValueOnce(session("jwt-1"));
      expect(await anon.ensureAnonSession()).toBe(true);
      fetchMock.mockImplementationOnce(never);
      let settled = false;

      const pending = write(anon, writer).then((result) => {
        settled = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(9999);

      expect(signalOf(1).aborted).toBe(false);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);

      expect(signalOf(1).aborted).toBe(true);
      expect(await pending).toBeNull();
      expect(requests()).toEqual([
        EXPECTED_LOGIN,
        expectedWrite(writer, "jwt-1"),
      ]);
      const method =
        writer === "putAnonStatementRecord" ? "putRecord" : "createRecord";
      expect(mockLogger.error.mock.calls).toEqual([
        [
          "Anon statement record error",
          new Error(
            `Anon PDS com.atproto.repo.${method} timed out after 10000 ms`
          ),
        ],
      ]);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test("a login that gets no answer is aborted after 10 seconds", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock.mockImplementationOnce(never);
    let settled = false;

    const pending = anon.ensureAnonSession().then((result) => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(9999);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signalOf(0).aborted).toBe(false);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);

    expect(signalOf(0).aborted).toBe(true);
    expect(await pending).toBe(false);
    expect(mockLogger.error.mock.calls).toEqual([
      [
        "Anon PDS session error",
        new Error(
          "Anon PDS com.atproto.server.createSession timed out after 10000 ms"
        ),
      ],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(WRITERS)(
    "%s: an answer whose body never arrives is abandoned after 10 seconds and returns null",
    async (writer) => {
      const anon = loadAnonPds(CONFIGURED);
      fetchMock.mockResolvedValueOnce(session("jwt-1"));
      expect(await anon.ensureAnonSession()).toBe(true);
      fetchMock.mockResolvedValueOnce(stalled(200));
      let settled = false;

      const pending = write(anon, writer).then((result) => {
        settled = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(9999);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(1);
      expect(signalOf(1).aborted).toBe(false);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);

      expect(signalOf(1).aborted).toBe(true);
      expect(await pending).toBeNull();
      const method =
        writer === "putAnonStatementRecord" ? "putRecord" : "createRecord";
      expect(mockLogger.error.mock.calls).toEqual([
        [
          "Anon statement record error",
          new Error(
            `Anon PDS com.atproto.repo.${method} timed out after 10000 ms`
          ),
        ],
      ]);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  test("a login answer whose body never arrives is abandoned after 10 seconds", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock.mockResolvedValueOnce(stalled(200));
    let settled = false;

    const pending = anon.ensureAnonSession().then((result) => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(9999);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);

    expect(signalOf(0).aborted).toBe(true);
    expect(await pending).toBe(false);
    expect(anon.getAnonDid()).toBe(SERVICE_DID);
    expect(mockLogger.error.mock.calls).toEqual([
      [
        "Anon PDS session error",
        new Error(
          "Anon PDS com.atproto.server.createSession timed out after 10000 ms"
        ),
      ],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a write after a timed out login logs in again", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock.mockImplementationOnce(never);

    const first = anon.putAnonStatementRecord(PUT_STATEMENT);
    await jest.advanceTimersByTimeAsync(10000);

    expect(await first).toBeNull();

    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD));

    expect(await anon.putAnonStatementRecord(PUT_STATEMENT)).toEqual(RECORD);
    expect(requests()).toEqual([
      EXPECTED_LOGIN,
      EXPECTED_LOGIN,
      expectedWrite("putAnonStatementRecord", "jwt-1"),
    ]);
  });

  test("no request follows a redirect", async () => {
    const pds = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD));

    await pds.putAnonStatementRecord(PUT_STATEMENT);

    expect(fetchMock.mock.calls.map(([, init]) => init?.redirect)).toEqual([
      "error",
      "error",
    ]);
  });

  test("every request carries its own abort signal", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock
      .mockResolvedValueOnce(session("jwt-1"))
      .mockResolvedValueOnce(json(200, RECORD));

    await anon.putAnonStatementRecord(PUT_STATEMENT);

    expect(signalOf(0)).toBeInstanceOf(AbortSignal);
    expect(signalOf(1)).toBeInstanceOf(AbortSignal);
    expect(signalOf(1)).not.toBe(signalOf(0));
    expect(signalOf(0).aborted).toBe(false);
    expect(signalOf(1).aborted).toBe(false);
  });
});

describe("anon-pds session", () => {
  test("ensureAnonSession is false and getAnonDid is null when nothing is configured", async () => {
    const anon = loadAnonPds(NOT_CONFIGURED);

    expect(anon.getAnonDid()).toBeNull();
    expect(await anon.ensureAnonSession()).toBe(false);
    expect(anon.getAnonDid()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each(["ANON_PDS", "ANON_HANDLE", "ANON_APP_PASSWORD"])(
    "ensureAnonSession is false when %s is missing",
    async (missing) => {
      const anon = loadAnonPds({ ...CONFIGURED, [missing]: "" });

      expect(await anon.ensureAnonSession()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  test("ensureAnonSession logs in once and is true afterwards", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock.mockResolvedValueOnce(session("jwt-1"));

    expect(await anon.ensureAnonSession()).toBe(true);
    expect(await anon.ensureAnonSession()).toBe(true);
    expect(requests()).toEqual([EXPECTED_LOGIN]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("ensureAnonSession is false when the login is refused", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock.mockResolvedValueOnce(
      json(401, { error: "AuthenticationRequired" })
    );

    expect(await anon.ensureAnonSession()).toBe(false);
    expect(requests()).toEqual([EXPECTED_LOGIN]);
    expect(mockLogger.error.mock.calls).toEqual([
      ["Failed to create anon PDS session", { status: 401 }],
    ]);
  });

  test("ensureAnonSession is false when the login answer has no token", async () => {
    const anon = loadAnonPds(CONFIGURED);
    fetchMock.mockResolvedValueOnce(json(200, { did: SERVICE_DID }));

    expect(await anon.ensureAnonSession()).toBe(false);
    expect(anon.getAnonDid()).toBe(SERVICE_DID);
    expect(mockLogger.error.mock.calls).toEqual([
      ["Anon PDS session response is incomplete", { status: 200 }],
    ]);
  });

  test("getAnonDid is the configured DID before a login", () => {
    const anon = loadAnonPds(CONFIGURED);

    expect(anon.getAnonDid()).toBe(SERVICE_DID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("getAnonDid is the DID of the session once one exists", async () => {
    const anon = loadAnonPds(CONFIGURED);
    const sessionDid = "did:plc:anonpdstestsession";
    fetchMock
      .mockResolvedValueOnce(session("jwt-1", sessionDid))
      .mockResolvedValueOnce(json(200, RECORD));

    expect(await anon.ensureAnonSession()).toBe(true);
    expect(anon.getAnonDid()).toBe(sessionDid);
    expect(mockLogger.warn.mock.calls).toEqual([
      [
        "Anon PDS session DID differs from ANON_DID",
        { configured: SERVICE_DID, did: sessionDid },
      ],
    ]);

    await anon.putAnonStatementRecord(PUT_STATEMENT);

    expect(requests()[1].body.repo).toBe(sessionDid);
  });

  test("getAnonDid is the DID of the session when no DID is configured", async () => {
    const anon = loadAnonPds({ ...CONFIGURED, ANON_DID: "" });
    fetchMock.mockResolvedValueOnce(session("jwt-1"));

    expect(anon.getAnonDid()).toBeNull();
    expect(await anon.ensureAnonSession()).toBe(true);
    expect(anon.getAnonDid()).toBe(SERVICE_DID);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

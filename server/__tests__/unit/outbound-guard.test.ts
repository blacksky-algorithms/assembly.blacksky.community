import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import {
  OutboundRequestError,
  guardedFetch,
} from "../../src/auth/outbound-guard";
import logger from "../../src/utils/logger";
import {
  PlcFetchMock,
  PlcResponder,
  TEST_PUBLIC_ADDRESS,
  installPlcFetchMock,
  jsonResponse,
} from "../setup/atproto-test-helpers";

const HOST = "pds.test.invalid";
const RECORD_URL = `https://${HOST}/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aabc`;
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 3000;

type Outcome =
  | { response: { status: number; body: string } }
  | { error: unknown }
  | undefined;

async function rejection(
  promise: Promise<unknown>
): Promise<OutboundRequestError> {
  try {
    await promise;
  } catch (err) {
    return err as OutboundRequestError;
  }
  throw new Error("expected the promise to reject");
}

function expectError(
  err: OutboundRequestError,
  code: string,
  message: string
): void {
  expect(err).toBeInstanceOf(OutboundRequestError);
  expect({ code: err.code, message: err.message }).toEqual({ code, message });
}

describe("outbound guard", () => {
  let outbound: PlcFetchMock;

  function serve(
    url: string,
    responder: PlcResponder = () => jsonResponse({ served: url })
  ): string {
    const target = new URL(url);
    outbound.setUrlResponder(target.href, responder);
    outbound.setAddresses(target.hostname.replace(/\.$/, ""), [
      TEST_PUBLIC_ADDRESS,
    ]);
    return target.href;
  }

  function requestedUrls(): string[] {
    return outbound.requests.map((request) => request.url);
  }

  beforeEach(() => {
    outbound = installPlcFetchMock();
  });

  afterEach(() => {
    jest.useRealTimers();
    outbound.restore();
    jest.restoreAllMocks();
  });

  describe("request", () => {
    test("returns the status and body of a public https host", async () => {
      serve(RECORD_URL, () => jsonResponse({ uri: "at://example" }));

      const response = await guardedFetch(RECORD_URL);

      expect(response).toEqual({
        status: 200,
        body: JSON.stringify({ uri: "at://example" }),
      });
      expect(outbound.lookups).toEqual([HOST]);
      expect(requestedUrls()).toEqual([RECORD_URL]);
    });

    test("returns the body of a response that is not 200", async () => {
      serve(RECORD_URL, () =>
        jsonResponse({ error: "RecordNotFound" }, { status: 400 })
      );

      const response = await guardedFetch(RECORD_URL);

      expect(response).toEqual({
        status: 400,
        body: JSON.stringify({ error: "RecordNotFound" }),
      });
    });

    test("returns an empty body for a response without one", async () => {
      serve(RECORD_URL, () => new Response(null, { status: 204 }));

      const response = await guardedFetch(RECORD_URL);

      expect(response).toEqual({ status: 204, body: "" });
    });

    test("asks for JSON, refuses redirects and passes a signal", async () => {
      serve(RECORD_URL);

      await guardedFetch(RECORD_URL);

      expect(outbound.requests).toHaveLength(1);
      const { init } = outbound.requests[0];
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ accept: "application/json" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
    });

    test("asks for the content type the caller names", async () => {
      serve(RECORD_URL);

      await guardedFetch(RECORD_URL, { accept: "application/did+ld+json" });

      expect(outbound.requests[0].init.headers).toEqual({
        accept: "application/did+ld+json",
      });
    });
  });

  describe("URL form", () => {
    test.each([
      ["an http URL", `http://${HOST}/`, "scheme is not https"],
      ["a websocket URL", `wss://${HOST}/`, "scheme is not https"],
      ["a file URL", "file:///etc/hosts", "scheme is not https"],
      ["a data URL", "data:application/json,{}", "scheme is not https"],
      ["a name without a scheme", HOST, "not a valid URL"],
      ["a path", "/xrpc/com.atproto.repo.getRecord", "not a valid URL"],
      ["an empty string", "", "not a valid URL"],
      ["a user name", `https://user@${HOST}/`, "URL carries credentials"],
      [
        "a user name and a password",
        `https://user:secret@${HOST}/`,
        "URL carries credentials",
      ],
      [
        "a password without a user name",
        `https://:secret@${HOST}/`,
        "URL carries credentials",
      ],
      [
        "another host in front of the at sign",
        `https://public.test.invalid@${HOST}/`,
        "URL carries credentials",
      ],
      ["a port", `https://${HOST}:8443/`, "URL names a port"],
      ["the port of http", `https://${HOST}:80/`, "URL names a port"],
      [
        "a public IPv4 address",
        `https://${TEST_PUBLIC_ADDRESS}/`,
        "host is an IP address",
      ],
      [
        "a loopback IPv4 address",
        "https://127.0.0.1/",
        "host is an IP address",
      ],
      [
        "an IPv4 address written as one number",
        "https://2130706433/",
        "host is an IP address",
      ],
      [
        "an IPv4 address written in hexadecimal",
        "https://0x7f.0.0.1/",
        "host is an IP address",
      ],
      [
        "an IPv4 address written with two parts",
        "https://127.1/",
        "host is an IP address",
      ],
      [
        "a public IPv6 address",
        "https://[2606:4700:4700::1111]/",
        "host is an IP address",
      ],
      ["the IPv6 loopback", "https://[::1]/", "host is an IP address"],
      [
        "an IPv4-mapped IPv6 address",
        "https://[::ffff:127.0.0.1]/",
        "host is an IP address",
      ],
      [
        "localhost",
        "https://localhost/",
        "host name is reserved for local use",
      ],
      [
        "localhost in upper case",
        "https://LOCALHOST/",
        "host name is reserved for local use",
      ],
      [
        "localhost with a trailing dot",
        "https://localhost./",
        "host name is reserved for local use",
      ],
      [
        "a name under localhost",
        "https://app.localhost/",
        "host name is reserved for local use",
      ],
      [
        "a name ending in .local",
        "https://printer.local/",
        "host name is reserved for local use",
      ],
      [
        "a name ending in .internal",
        "https://metadata.google.internal/",
        "host name is reserved for local use",
      ],
      [
        "a name ending in .internal with a trailing dot",
        "https://db.internal./",
        "host name is reserved for local use",
      ],
    ])("refuses %s without a lookup", async (name, url, message) => {
      if (URL.canParse(url)) {
        serve(url);
      }

      const err = await rejection(guardedFetch(url));

      expectError(err, "refused", message);
      expect(outbound.lookups).toEqual([]);
      expect(outbound.requests).toEqual([]);
    });

    test.each([
      ["an http URL", `http://${HOST}:8443/`, "scheme is not https"],
      [
        "credentials",
        `https://user:secret@${HOST}:8443/`,
        "URL carries credentials",
      ],
      [
        "an IPv4 address",
        `https://${TEST_PUBLIC_ADDRESS}:8443/`,
        "host is an IP address",
      ],
      ["an IPv6 address", "https://[::1]:8443/", "host is an IP address"],
      [
        "localhost",
        "https://localhost:8443/",
        "host name is reserved for local use",
      ],
      [
        "a name ending in .internal",
        "https://db.internal:8443/",
        "host name is reserved for local use",
      ],
    ])("refuses %s when a port is allowed", async (name, url, message) => {
      serve(url);

      const err = await rejection(guardedFetch(url, { allowPort: true }));

      expectError(err, "refused", message);
      expect(outbound.lookups).toEqual([]);
      expect(outbound.requests).toEqual([]);
    });

    test("requests a URL with a port when the caller allows one", async () => {
      const url = serve(`https://${HOST}:8443/xrpc/_health`);

      const response = await guardedFetch(url, { allowPort: true });

      expect(response.status).toBe(200);
      expect(outbound.lookups).toEqual([HOST]);
      expect(requestedUrls()).toEqual([`https://${HOST}:8443/xrpc/_health`]);
    });

    test("does not take port 443 for a port", async () => {
      serve(`https://${HOST}/xrpc/_health`);

      const response = await guardedFetch(`https://${HOST}:443/xrpc/_health`);

      expect(response.status).toBe(200);
      expect(requestedUrls()).toEqual([`https://${HOST}/xrpc/_health`]);
    });

    test("looks up a name with a trailing dot without the dot", async () => {
      const url = serve(`https://${HOST}./xrpc/_health`);

      const response = await guardedFetch(url);

      expect(response.status).toBe(200);
      expect(outbound.lookups).toEqual([HOST]);
    });

    test("accepts a name that only contains a reserved word", async () => {
      const url = serve("https://internal.local.localhost.test.invalid/");

      const response = await guardedFetch(url);

      expect(response.status).toBe(200);
    });
  });

  describe("addresses", () => {
    test.each([
      ["unspecified", "0.0.0.0"],
      ["unspecified", "0.255.255.255"],
      ["unspecified", "::"],
      ["unspecified", "::ffff:0.0.0.0"],
      ["loopback", "127.0.0.1"],
      ["loopback", "127.255.255.255"],
      ["loopback", "::1"],
      ["loopback", "0:0:0:0:0:0:0:1"],
      ["loopback", "::ffff:127.0.0.1"],
      ["loopback", "::ffff:7f00:1"],
      ["private", "10.0.0.0"],
      ["private", "10.255.255.255"],
      ["private", "172.16.0.0"],
      ["private", "172.31.255.255"],
      ["private", "192.168.0.0"],
      ["private", "192.168.255.255"],
      ["private", "::ffff:10.0.0.1"],
      ["private", "::ffff:172.16.0.1"],
      ["private", "::ffff:192.168.1.1"],
      ["private", "::ffff:c0a8:101"],
      ["link-local", "169.254.0.0"],
      ["link-local", "169.254.169.254"],
      ["link-local", "169.254.255.255"],
      ["link-local", "::ffff:169.254.169.254"],
      ["link-local", "fe80::"],
      ["link-local", "fe80::1"],
      ["link-local", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["carrier-grade NAT", "100.64.0.0"],
      ["carrier-grade NAT", "100.127.255.255"],
      ["carrier-grade NAT", "::ffff:100.64.0.1"],
      ["unique-local", "fc00::"],
      ["unique-local", "fd12:3456:789a::1"],
      ["unique-local", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["multicast", "224.0.0.1"],
      ["multicast", "239.255.255.255"],
      ["multicast", "ff02::1"],
      ["reserved", "192.0.0.1"],
      ["reserved", "192.0.2.1"],
      ["reserved", "198.18.0.0"],
      ["reserved", "198.19.255.255"],
      ["reserved", "198.51.100.1"],
      ["reserved", "203.0.113.1"],
      ["reserved", "240.0.0.0"],
      ["reserved", "255.255.255.255"],
      ["reserved", "::127.0.0.1"],
      ["reserved", "64:ff9b::a00:1"],
      ["reserved", "64:ff9b:1::a00:1"],
      ["reserved", "100::1"],
      ["reserved", "2001::1"],
      ["reserved", "2001:db8::1"],
      ["reserved", "2002:a00:1::1"],
      ["reserved", "fec0::1"],
      ["malformed", "pds.test.invalid"],
      ["malformed", ""],
    ])(
      "refuses a host that resolves to the %s address %s",
      async (kind, address) => {
        serve(RECORD_URL);
        outbound.setAddresses(HOST, [address]);

        const err = await rejection(guardedFetch(RECORD_URL));

        expectError(err, "refused", `host resolves to a ${kind} address`);
        expect(outbound.lookups).toEqual([HOST]);
        expect(outbound.requests).toEqual([]);
      }
    );

    test.each([
      "1.0.0.0",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.0.1.0",
      "192.0.3.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "::ffff:93.184.215.14",
      "2001:200::1",
      "2001:db9::1",
      "2003::1",
      "2606:4700:4700::1111",
    ])("requests a host that resolves to %s", async (address) => {
      serve(RECORD_URL);
      outbound.setAddresses(HOST, [address]);

      const response = await guardedFetch(RECORD_URL);

      expect(response.status).toBe(200);
      expect(requestedUrls()).toEqual([RECORD_URL]);
    });

    test.each([
      ["the last", [TEST_PUBLIC_ADDRESS, "2606:4700:4700::1111", "10.0.0.5"]],
      ["the first", ["10.0.0.5", TEST_PUBLIC_ADDRESS, "2606:4700:4700::1111"]],
      ["one in the middle", [TEST_PUBLIC_ADDRESS, "10.0.0.5", "8.8.8.8"]],
    ])(
      "refuses a host when %s of its addresses is private",
      async (name, addresses) => {
        serve(RECORD_URL);
        outbound.setAddresses(HOST, addresses);

        const err = await rejection(guardedFetch(RECORD_URL));

        expectError(err, "refused", "host resolves to a private address");
        expect(outbound.requests).toEqual([]);
      }
    );

    test("requests a host whose addresses are all public", async () => {
      serve(RECORD_URL);
      outbound.setAddresses(HOST, [
        TEST_PUBLIC_ADDRESS,
        "2606:4700:4700::1111",
      ]);

      const response = await guardedFetch(RECORD_URL);

      expect(response.status).toBe(200);
      expect(outbound.lookups).toEqual([HOST]);
    });

    test("fails for a host name that does not exist", async () => {
      const err = await rejection(
        guardedFetch("https://missing.test.invalid/")
      );

      expectError(err, "failed", "host name lookup failed (ENOTFOUND)");
      expect(outbound.lookups).toEqual(["missing.test.invalid"]);
      expect(outbound.requests).toEqual([]);
    });

    test("fails for a host name without addresses", async () => {
      serve(RECORD_URL);
      outbound.setAddresses(HOST, []);

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "failed", "host name has no address");
      expect(outbound.requests).toEqual([]);
    });
  });

  describe("redirects", () => {
    test.each([301, 302, 303, 307, 308])(
      "fails on a %i redirect and does not request its target",
      async (status) => {
        const target = serve("https://other.test.invalid/record");
        serve(
          RECORD_URL,
          () => new Response(null, { status, headers: { location: target } })
        );

        const err = await rejection(guardedFetch(RECORD_URL));

        expectError(err, "failed", "network error (TypeError)");
        expect(requestedUrls()).toEqual([RECORD_URL]);
        expect(outbound.lookups).toEqual([HOST]);
      }
    );
  });

  describe("failures", () => {
    test("reports a network error", async () => {
      serve(RECORD_URL, () => {
        throw new TypeError("fetch failed");
      });

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "failed", "network error (TypeError)");
    });

    test("reports a failure that is not an error object", async () => {
      serve(RECORD_URL, () => {
        throw "connection lost";
      });

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "failed", "network error (unknown error)");
    });
  });

  describe("body size", () => {
    test("accepts a body of exactly 64 KB", async () => {
      const body = "x".repeat(MAX_BODY_BYTES);
      serve(RECORD_URL, () => new Response(body));

      const response = await guardedFetch(RECORD_URL);

      expect(Buffer.byteLength(response.body, "utf8")).toBe(65536);
    });

    test("refuses a body one byte over 64 KB", async () => {
      const body = "x".repeat(MAX_BODY_BYTES + 1);
      serve(RECORD_URL, () => new Response(body));

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "too_large", "response body is too large");
    });

    test("refuses an oversized body of a response that is not 200", async () => {
      const body = "x".repeat(MAX_BODY_BYTES + 1);
      serve(RECORD_URL, () => new Response(body, { status: 404 }));

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "too_large", "response body is too large");
    });

    test("stops reading a streamed body once it passes 64 KB", async () => {
      const chunk = new Uint8Array(16 * 1024).fill(0x20);
      let chunksServed = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksServed += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      serve(RECORD_URL, () => new Response(stream));

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "too_large", "response body is too large");
      expect(cancelled).toBe(true);
      expect(chunksServed).toBeLessThanOrEqual(6);
    });

    test("refuses a declared length over 64 KB whatever the body holds", async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("{}", "utf8"));
        },
        cancel() {
          cancelled = true;
        },
      });
      serve(
        RECORD_URL,
        () => new Response(stream, { headers: { "content-length": "65537" } })
      );

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "too_large", "response body is too large");
      expect(cancelled).toBe(true);
    });

    test("refuses a declared length over 64 KB when the body cannot be discarded", async () => {
      const debug = jest
        .spyOn(logger, "debug")
        .mockImplementation(() => logger);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("{}", "utf8"));
        },
      });
      const held = new Response(stream, {
        headers: { "content-length": "65537" },
      });
      held.body.getReader();
      serve(RECORD_URL, () => held);

      const err = await rejection(guardedFetch(RECORD_URL));

      expectError(err, "too_large", "response body is too large");
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0][0]).toBe(
        "outbound request: could not discard response body"
      );
    });

    test("accepts a declared length of exactly 64 KB", async () => {
      const body = "x".repeat(MAX_BODY_BYTES);
      serve(
        RECORD_URL,
        () => new Response(body, { headers: { "content-length": "65536" } })
      );

      const response = await guardedFetch(RECORD_URL);

      expect(response.body).toBe(body);
    });
  });

  describe("time limit", () => {
    let outcome: Outcome;

    function start(): void {
      outcome = undefined;
      guardedFetch(RECORD_URL).then(
        (response) => {
          outcome = { response };
        },
        (error) => {
          outcome = { error };
        }
      );
    }

    async function expectTimeoutAtThreeSeconds(): Promise<void> {
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(outcome).toBeUndefined();

      await jest.advanceTimersByTimeAsync(1);

      expect(outcome).toBeDefined();
      const { error } = outcome as { error: OutboundRequestError };
      expectError(error, "failed", "timed out");
    }

    beforeEach(() => {
      jest.useFakeTimers({
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
    });

    test("gives up when the host does not answer within 3 seconds", async () => {
      let signal: AbortSignal | undefined;
      serve(RECORD_URL, (init) => {
        signal = init.signal;
        return new Promise<Response>(() => undefined);
      });

      start();

      await expectTimeoutAtThreeSeconds();
      expect(signal.aborted).toBe(true);
      expect(requestedUrls()).toEqual([RECORD_URL]);
    });

    test("gives up when the name lookup does not answer within 3 seconds", async () => {
      serve(RECORD_URL);
      let answer: (addresses: string[]) => void = () => undefined;
      outbound.setResolver(
        HOST,
        () =>
          new Promise<string[]>((resolve) => {
            answer = resolve;
          })
      );

      start();

      await expectTimeoutAtThreeSeconds();
      expect(outbound.requests).toEqual([]);

      answer([TEST_PUBLIC_ADDRESS]);
      await jest.advanceTimersByTimeAsync(0);

      expect(outbound.requests).toEqual([]);
    });

    test("gives up when the body does not arrive within 3 seconds", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('{"uri":', "utf8"));
        },
      });
      serve(RECORD_URL, () => new Response(stream));

      start();

      await expectTimeoutAtThreeSeconds();
    });

    test("counts the lookup and the request against the same 3 seconds", async () => {
      let answer: (addresses: string[]) => void = () => undefined;
      outbound.setResolver(
        HOST,
        () =>
          new Promise<string[]>((resolve) => {
            answer = resolve;
          })
      );
      outbound.setUrlResponder(
        RECORD_URL,
        () => new Promise<Response>(() => undefined)
      );

      start();
      await jest.advanceTimersByTimeAsync(2000);
      answer([TEST_PUBLIC_ADDRESS]);
      await jest.advanceTimersByTimeAsync(999);

      expect(requestedUrls()).toEqual([RECORD_URL]);
      expect(outcome).toBeUndefined();

      await jest.advanceTimersByTimeAsync(1);

      const { error } = outcome as { error: OutboundRequestError };
      expectError(error, "failed", "timed out");
    });

    test("leaves no timer behind after an answer", async () => {
      serve(RECORD_URL);

      start();
      await jest.advanceTimersByTimeAsync(0);

      expect(outcome).toEqual({
        response: { status: 200, body: JSON.stringify({ served: RECORD_URL }) },
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    test("leaves no timer behind after a refusal", async () => {
      serve(RECORD_URL);
      outbound.setAddresses(HOST, ["127.0.0.1"]);

      start();
      await jest.advanceTimersByTimeAsync(0);

      const { error } = outcome as { error: OutboundRequestError };
      expectError(error, "refused", "host resolves to a loopback address");
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

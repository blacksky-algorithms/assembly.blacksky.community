import dns from "node:dns";
import net from "node:net";
import logger from "../utils/logger";

export type OutboundErrorCode = "refused" | "failed" | "too_large";

export class OutboundRequestError extends Error {
  code: OutboundErrorCode;

  constructor(code: OutboundErrorCode, message: string) {
    super(message);
    this.name = "OutboundRequestError";
    this.code = code;
  }
}

export type OutboundResponse = { status: number; body: string };

export const OUTBOUND_TIMEOUT_MS = 3000;
export const OUTBOUND_MAX_BODY_BYTES = 64 * 1024;

const LOCAL_NAME = "localhost";
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

// The first kind that matches names the refusal, so a range that contains
// another one has to come after it.
const REFUSED_RANGES: Array<[string, Array<[string, number]>]> = [
  [
    "unspecified",
    [
      ["0.0.0.0", 8],
      ["::", 128],
    ],
  ],
  [
    "loopback",
    [
      ["127.0.0.0", 8],
      ["::1", 128],
    ],
  ],
  [
    "private",
    [
      ["10.0.0.0", 8],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
    ],
  ],
  [
    "link-local",
    [
      ["169.254.0.0", 16],
      ["fe80::", 10],
    ],
  ],
  ["carrier-grade NAT", [["100.64.0.0", 10]]],
  ["unique-local", [["fc00::", 7]]],
  [
    "multicast",
    [
      ["224.0.0.0", 4],
      ["ff00::", 8],
    ],
  ],
  [
    "reserved",
    [
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["240.0.0.0", 4],
      ["::", 96],
      ["64:ff9b::", 96],
      ["64:ff9b:1::", 48],
      ["100::", 64],
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["fec0::", 10],
    ],
  ],
];

const REFUSED_ADDRESSES = REFUSED_RANGES.map(([kind, ranges]) => {
  const list = new net.BlockList();
  for (const [prefix, bits] of ranges) {
    list.addSubnet(prefix, bits, net.isIPv6(prefix) ? "ipv6" : "ipv4");
  }
  return { kind, list };
});

function refused(message: string): OutboundRequestError {
  return new OutboundRequestError("refused", message);
}

function failed(message: string): OutboundRequestError {
  return new OutboundRequestError("failed", message);
}

function describeFailure(err: unknown): string {
  const { code, name } = Object(err) as { code?: unknown; name?: unknown };
  const label = [code, name].find((value) => typeof value === "string");
  return typeof label === "string" ? label : "unknown error";
}

function hostOf(url: URL): string {
  return url.hostname.replace(/\.$/, "");
}

function checkUrl(rawUrl: string, allowPort: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw refused("not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw refused("scheme is not https");
  }
  if (url.username !== "" || url.password !== "") {
    throw refused("URL carries credentials");
  }
  if (url.port !== "" && !allowPort) {
    throw refused("URL names a port");
  }
  const host = hostOf(url);
  if (host.startsWith("[") || net.isIP(host) !== 0) {
    throw refused("host is an IP address");
  }
  if (
    host === LOCAL_NAME ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw refused("host name is reserved for local use");
  }
  return url;
}

function refusedAddressKind(address: string): string | null {
  const family = net.isIP(address);
  if (family === 0) return "malformed";
  const type = family === 6 ? "ipv6" : "ipv4";
  const found = REFUSED_ADDRESSES.find(({ list }) => list.check(address, type));
  return found ? found.kind : null;
}

async function checkAddresses(host: string): Promise<void> {
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch (err) {
    throw failed(`host name lookup failed (${describeFailure(err)})`);
  }
  if (addresses.length === 0) {
    throw failed("host name has no address");
  }
  for (const { address } of addresses) {
    const kind = refusedAddressKind(address);
    if (kind !== null) {
      throw refused(`host resolves to a ${kind} address`);
    }
  }
}

export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (err) {
    logger.debug("outbound request: could not discard response body", err);
  }
}

export async function readBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > OUTBOUND_MAX_BODY_BYTES
  ) {
    await discardBody(response);
    throw new OutboundRequestError("too_large", "response body is too large");
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > OUTBOUND_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new OutboundRequestError("too_large", "response body is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function request(
  url: URL,
  accept: string,
  signal: AbortSignal
): Promise<OutboundResponse> {
  await checkAddresses(hostOf(url));
  signal.throwIfAborted();
  const response = await fetch(url.href, {
    headers: { accept },
    redirect: "error",
    signal,
  });
  return { status: response.status, body: await readBody(response) };
}

export async function guardedFetch(
  rawUrl: string,
  opts: { allowPort?: boolean; accept?: string } = {}
): Promise<OutboundResponse> {
  const url = checkUrl(rawUrl, opts.allowPort === true);
  const controller = new AbortController();
  const expired = new Promise<never>((resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true }
    );
  });
  const timer = setTimeout(
    () => controller.abort(failed("timed out")),
    OUTBOUND_TIMEOUT_MS
  );
  try {
    return await Promise.race([
      expired,
      request(url, opts.accept ?? "application/json", controller.signal),
    ]);
  } catch (err) {
    if (err instanceof OutboundRequestError) throw err;
    throw failed(`network error (${describeFailure(err)})`);
  } finally {
    clearTimeout(timer);
  }
}

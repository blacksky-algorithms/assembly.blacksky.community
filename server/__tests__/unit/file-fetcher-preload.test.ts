import http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import {
  makeFileFetcher,
  serializeForInlineScript,
} from "../../src/utils/file-fetcher";

const hostileData = {
  conversation: {
    topic: "</ScRiPt><script>alert(1)</script>",
    description: "<!-- a < b -->",
  },
};

const hostileDataSerialized =
  '{"conversation":{"topic":"\\u003c/ScRiPt>\\u003cscript>alert(1)\\u003c/script>",' +
  '"description":"\\u003c!-- a \\u003c b -->"}}';

describe("serializeForInlineScript", () => {
  test("escapes a mixed-case closing script tag", () => {
    const serialized = serializeForInlineScript("</ScRiPt>");

    expect(serialized).toBe('"\\u003c/ScRiPt>"');
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toBe("</ScRiPt>");
  });

  test("escapes an HTML comment opener", () => {
    const serialized = serializeForInlineScript("<!--");

    expect(serialized).toBe('"\\u003c!--"');
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toBe("<!--");
  });

  test("escapes every occurrence inside nested values", () => {
    const serialized = serializeForInlineScript(hostileData);

    expect(serialized).toBe(hostileDataSerialized);
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized)).toEqual(hostileData);
  });

  test("produces a JavaScript expression with the original value", () => {
    const serialized = serializeForInlineScript(hostileData);
    const evaluated = vm.runInNewContext(`JSON.stringify(${serialized})`);

    expect(JSON.parse(evaluated)).toEqual(hostileData);
  });

  test("leaves text without the character unchanged", () => {
    const data = { topic: 'Rent > wages & "quotes" \\ backslash' };

    expect(serializeForInlineScript(data)).toBe(JSON.stringify(data));
  });

  test("serializes undefined as null", () => {
    expect(serializeForInlineScript(undefined)).toBe("null");
  });
});

describe("makeFileFetcher preload injection", () => {
  function pageWith(preload: string): string {
    return (
      "<html><head><script>\n" +
      `      window.preload = ${preload};\n` +
      "    </script></head><body></body></html>"
    );
  }

  const template = pageWith('"REPLACE_THIS_WITH_PRELOAD_DATA"');
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url !== "/index.html") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(template);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function fetchPage(
    preloadData: Parameters<typeof makeFileFetcher>[4]
  ): Promise<string> {
    const fetchFile = makeFileFetcher(
      "127.0.0.1",
      port,
      "/index.html",
      { "Content-Type": "text/html" },
      preloadData
    );

    const req = Object.assign(new PassThrough(), {
      headers: { host: "assembly.test" },
      path: "/1abcdefgh",
    });
    const res = Object.assign(new PassThrough(), { set: () => undefined });
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve, reject) => {
      res.on("end", resolve);
      res.on("error", reject);
    });

    fetchFile(req, res);
    req.end();
    await finished;

    return Buffer.concat(chunks).toString("utf8");
  }

  test("injects the preload data with every < escaped", async () => {
    expect(await fetchPage(hostileData)).toBe(pageWith(hostileDataSerialized));
  });

  test("injects replacement patterns in the data as plain text", async () => {
    const data = { conversation: { topic: "$& $' $` $1 $$" } };

    expect(await fetchPage(data)).toBe(
      pageWith('{"conversation":{"topic":"$& $\' $` $1 $$"}}')
    );
  });
});

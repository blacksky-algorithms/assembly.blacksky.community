import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import app from "../../app";
import { ATPROTO_LOGIN_LXM } from "../../src/auth/atproto-admin";
import Config from "../../src/config";
import logger from "../../src/utils/logger";

jest.mock("../../app", () => ({
  __esModule: true,
  default: { listen: jest.fn() },
}));

jest.mock("../../src/auth/github-supporters", () => ({
  isOssSupporter: jest.fn(),
  ensureGithubCacheReady: jest.fn(),
}));

const MODE_LOG = "atproto admin login proof mode";
const METADATA_PATH = path.join(
  __dirname,
  "../../../client-participation-alpha/public/oauth-client-metadata.json"
);

let previous: string | undefined;

function setProof(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.ATPROTO_LOGIN_PROOF;
  } else {
    process.env.ATPROTO_LOGIN_PROOF = value;
  }
}

beforeAll(() => {
  previous = process.env.ATPROTO_LOGIN_PROOF;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  setProof(previous);
});

describe("atproto login settings", () => {
  test.each<[string, string | undefined]>([
    ["unset", undefined],
    ["empty", ""],
    ["required", "required"],
    ["Optional", "Optional"],
    ["OPTIONAL", "OPTIONAL"],
    ["optional followed by a space", "optional "],
    ["optional after a space", " optional"],
    ["optional in quotes", '"optional"'],
    ["true", "true"],
  ])("requires proof when the setting is %s", (label, value) => {
    setProof(value);

    expect(Config.getAtprotoLoginSettings()).toEqual({ proof: "required" });
  });

  test("makes proof optional only for the literal value and reads it on every call", () => {
    setProof("optional");
    const optional = Config.getAtprotoLoginSettings();
    setProof("required");
    const required = Config.getAtprotoLoginSettings();

    expect(optional).toEqual({ proof: "optional" });
    expect(required).toEqual({ proof: "required" });
  });

  test.each<[string, string | undefined]>([
    ["optional", "optional"],
    ["required", undefined],
  ])(
    "the server logs the mode %s once when it starts, as a warning",
    (mode, value) => {
      setProof(value);
      const warnings = jest
        .spyOn(logger, "warn")
        .mockImplementation(() => logger);
      const listen = app.listen as unknown as jest.Mock;
      listen.mockClear();

      jest.isolateModules(() => {
        jest.doMock("../../src/utils/logger", () => ({
          __esModule: true,
          default: logger,
        }));
        require("../../index");
      });

      expect(listen).toHaveBeenCalledTimes(1);
      expect(
        warnings.mock.calls.filter(([first]) => String(first).includes("login"))
      ).toEqual([[MODE_LOG, { mode }]]);
    }
  );

  test("the OAuth client metadata declares the scope for the login method", () => {
    const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, "utf8"));

    expect(ATPROTO_LOGIN_LXM).toBe("community.blacksky.assembly.createSession");
    expect(
      metadata.scope
        .split(" ")
        .filter((scope: string) => scope.includes(ATPROTO_LOGIN_LXM))
    ).toEqual([`rpc:${ATPROTO_LOGIN_LXM}?aud=*`]);
  });
});

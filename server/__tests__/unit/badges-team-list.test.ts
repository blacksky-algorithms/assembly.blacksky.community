import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockQueryP = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: { queryP: mockQueryP },
}));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: mockLogger,
}));
jest.mock("../../src/conversation", () => ({
  __esModule: true,
  getConversationInfo: jest.fn(),
}));
jest.mock("../../src/auth/github-supporters", () => ({
  __esModule: true,
  isOssSupporter: jest.fn(),
  ensureGithubCacheReady: jest.fn(),
}));
jest.mock("akismet", () => ({
  __esModule: true,
  default: { client: () => ({ verifyKey: jest.fn(), checkSpam: jest.fn() }) },
}));

type Handler = (
  req: { p: Record<string, unknown> },
  res: unknown
) => Promise<void>;
type Loaded = {
  isPolisDev: (uid?: unknown) => boolean;
  handle_POST_badges: Handler;
  handle_DELETE_badges: Handler;
};

const did = "did:plc:badgetarget";
const badge = "blacksky_team";
const callers = [7, "7", 8, undefined];

async function loadWithTeamList(adminUIDs?: string): Promise<Loaded> {
  const previous = process.env.ADMIN_UIDS;
  if (adminUIDs === undefined) {
    delete process.env.ADMIN_UIDS;
  } else {
    process.env.ADMIN_UIDS = adminUIDs;
  }
  let loaded: Loaded | undefined;
  try {
    await jest.isolateModulesAsync(async () => {
      const common = await import("../../src/utils/common");
      const admin = await import("../../src/auth/atproto-admin");
      loaded = {
        isPolisDev: common.isPolisDev,
        handle_POST_badges: admin.handle_POST_badges as Handler,
        handle_DELETE_badges: admin.handle_DELETE_badges as Handler,
      };
    });
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_UIDS;
    } else {
      process.env.ADMIN_UIDS = previous;
    }
  }
  if (!loaded) {
    throw new Error("modules did not load");
  }
  return loaded;
}

async function statusOf(
  handler: Handler,
  p: Record<string, unknown>
): Promise<number> {
  const status = jest.fn<(code: number) => { json: () => void }>(() => ({
    json: jest.fn(),
  }));
  await handler({ p }, { status });
  expect(status).toHaveBeenCalledTimes(1);
  return status.mock.calls[0][0];
}

describe("badge writes against the team list in ADMIN_UIDS", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryP.mockResolvedValue([]);
  });

  test("a list of numbers admits only those numbers to POST", async () => {
    const { isPolisDev, handle_POST_badges } = await loadWithTeamList("[7]");
    const statuses: number[] = [];
    for (const uid of callers) {
      statuses.push(
        await statusOf(handle_POST_badges, {
          uid,
          did,
          badge,
          is_granted: true,
        })
      );
    }

    expect(callers.map((uid) => isPolisDev(uid))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(statuses).toEqual([200, 403, 403, 403]);
    expect(mockQueryP).toHaveBeenCalledTimes(1);
    expect(mockQueryP.mock.calls[0][1]).toEqual([did, badge, true]);
  });

  test("a list of numbers admits only those numbers to DELETE", async () => {
    const { handle_DELETE_badges } = await loadWithTeamList("[7]");
    const statuses: number[] = [];
    for (const uid of callers) {
      statuses.push(await statusOf(handle_DELETE_badges, { uid, did, badge }));
    }

    expect(statuses).toEqual([200, 403, 403, 403]);
    expect(mockQueryP).toHaveBeenCalledTimes(1);
    expect(mockQueryP.mock.calls[0][1]).toEqual([did, badge]);
  });

  test("a list written as strings admits no numeric uid", async () => {
    const loaded = await loadWithTeamList('["7"]');

    expect(loaded.isPolisDev(7)).toBe(false);
    expect(
      await statusOf(loaded.handle_POST_badges, {
        uid: 7,
        did,
        badge,
        is_granted: true,
      })
    ).toBe(403);
    expect(
      await statusOf(loaded.handle_DELETE_badges, { uid: 7, did, badge })
    ).toBe(403);
    expect(mockQueryP).toHaveBeenCalledTimes(0);
  });

  test("an unset list admits nobody", async () => {
    const loaded = await loadWithTeamList();

    expect(loaded.isPolisDev(7)).toBe(false);
    expect(
      await statusOf(loaded.handle_POST_badges, {
        uid: 7,
        did,
        badge,
        is_granted: true,
      })
    ).toBe(403);
    expect(
      await statusOf(loaded.handle_DELETE_badges, { uid: 7, did, badge })
    ).toBe(403);
    expect(mockQueryP).toHaveBeenCalledTimes(0);
  });

  test("the log names the uid that changed a badge", async () => {
    const loaded = await loadWithTeamList("[7]");
    await statusOf(loaded.handle_POST_badges, {
      uid: 7,
      did,
      badge,
      is_granted: false,
    });
    await statusOf(loaded.handle_DELETE_badges, { uid: 7, did, badge });

    expect(mockLogger.info.mock.calls).toEqual([
      ["Badge override set", { did, badge, is_granted: false, uid: 7 }],
      ["Badge override removed", { did, badge, uid: 7 }],
    ]);
  });
});

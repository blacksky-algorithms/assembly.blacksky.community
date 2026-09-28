import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

jest.mock("../../src/db/pg-query", () => ({
  __esModule: true,
  default: {
    queryP_readOnly: jest.fn(),
  },
}));
jest.mock("../../src/utils/logger");

import pg from "../../src/db/pg-query";
import { getPca } from "../../src/utils/pca";

const queryP_readOnly = pg.queryP_readOnly as jest.MockedFunction<
  (query: string, params?: unknown[]) => Promise<unknown[]>
>;

const NOW = Date.UTC(2026, 0, 1);

describe("getPca for a conversation that has no math results", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    queryP_readOnly.mockReset();
    queryP_readOnly.mockImplementation((query: string) =>
      Promise.resolve(
        query.includes("from comments") ? [{ tid: 0 }, { tid: 1 }] : []
      )
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("returns the same empty result on a repeated read as on the first read", async () => {
    const zid = 987001;

    const first = await getPca(zid);
    const second = await getPca(zid);

    expect(first?.asPOJO.math_tick).toBe(0);
    expect(first?.asPOJO.tids).toEqual([0, 1]);
    expect(second?.asPOJO.math_tick).toBe(0);
    expect(second?.asPOJO.tids).toEqual([0, 1]);
    expect(queryP_readOnly).toHaveBeenCalledTimes(2);
  });

  test("still reports nothing newer to a caller that already has tick 0", async () => {
    const zid = 987002;

    await getPca(zid);
    const result = await getPca(zid, 0);

    expect(result).toBeUndefined();
    expect(queryP_readOnly).toHaveBeenCalledTimes(2);
  });
});

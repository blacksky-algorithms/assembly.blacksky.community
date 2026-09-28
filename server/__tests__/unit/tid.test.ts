import { describe, expect, jest, test } from "@jest/globals";
import {
  createTidGenerator,
  encodeTid,
  isValidTid,
  nextTid,
} from "../../src/utils/tid";

const MAX_TIMESTAMP_MICROS = (1n << 53n) - 1n;
const ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

function decodeTid(tid: string): { timestampMicros: string; clockId: number } {
  let value = 0n;
  for (const char of tid) {
    value = value * 32n + BigInt(ALPHABET.indexOf(char));
  }
  return {
    timestampMicros: (value >> 10n).toString(),
    clockId: Number(value & 1023n),
  };
}

describe("encodeTid", () => {
  test.each([
    [0n, 0, "2222222222222"],
    [0n, 1, "2222222222223"],
    [0n, 32, "2222222222232"],
    [1n, 0, "2222222222322"],
    [1688137381887007n, 6, "3jzfcijpj2z2a"],
    [1700000000000000n, 0, "3ke6kg3wk2222"],
    [1700000000000000n, 1023, "3ke6kg3wk22zz"],
    [1700000000000001n, 5, "3ke6kg3wk2327"],
    [1758000000123000n, 77, "3lywl4sfk5s4h"],
    [2251799813685247n, 1023, "3zzzzzzzzzzzz"],
    [MAX_TIMESTAMP_MICROS, 1023, "bzzzzzzzzzzzz"],
  ])("encodes %s with clock id %s as %s", (timestamp, clockId, expected) => {
    expect(encodeTid(timestamp, clockId)).toBe(expected);
  });

  test.each([
    [-1n, 0, "TID timestamp out of range"],
    [MAX_TIMESTAMP_MICROS + 1n, 0, "TID timestamp out of range"],
    [0n, -1, "TID clock id out of range"],
    [0n, 1024, "TID clock id out of range"],
    [0n, 1.5, "TID clock id out of range"],
  ])("rejects timestamp %s with clock id %s", (timestamp, clockId, message) => {
    expect(() => encodeTid(timestamp, clockId)).toThrow(
      new RangeError(message)
    );
  });
});

describe("isValidTid", () => {
  test.each([
    "2222222222222",
    "3jzfcijpj2z2a",
    "7777777777777",
    "3zzzzzzzzzzzz",
    "jzzzzzzzzzzzz",
  ])("accepts %s", (tid) => {
    expect(isValidTid(tid)).toBe(true);
  });

  test.each([
    ["twelve characters", "222222222222"],
    ["fourteen characters", "22222222222222"],
    ["an upper case character", "3jzfcijpj2z2A"],
    ["the digit 0", "3jzfcijpj2z20"],
    ["the digit 1", "3jzfcijpj2z21"],
    ["the digit 8", "3jzfcijpj2z28"],
    ["a dash", "3jzf-cijpj2z2"],
    ["a first character above j", "kjzfcijpj2z2a"],
    ["a first character z", "zzzzzzzzzzzzz"],
    ["a trailing newline", "3jzfcijpj2z2a\n"],
    ["an empty string", ""],
  ])("rejects %s", (label, tid) => {
    expect(isValidTid(tid)).toBe(false);
  });

  test.each([[undefined], [null], [1234567890123], [["3jzfcijpj2z2a"]]])(
    "rejects the non-string %p",
    (value) => {
      expect(isValidTid(value)).toBe(false);
    }
  );
});

describe("createTidGenerator", () => {
  test("uses the clock when it moves forward", () => {
    const clock = [1700000000000000n, 1700000000000001n, 1700000000500000n];
    const generate = createTidGenerator({
      nowMicros: () => clock.shift() as bigint,
      clockId: 5,
    });

    expect([generate(), generate(), generate()]).toEqual([
      "3ke6kg3wk2227",
      "3ke6kg3wk2327",
      "3ke6kg4fsd227",
    ]);
  });

  test("adds one microsecond when the clock stands still", () => {
    const generate = createTidGenerator({
      nowMicros: () => 1700000000000000n,
      clockId: 0,
    });

    expect([generate(), generate(), generate()]).toEqual([
      "3ke6kg3wk2222",
      "3ke6kg3wk2322",
      "3ke6kg3wk2422",
    ]);
  });

  test("keeps increasing when the clock moves backwards", () => {
    const clock = [1700000000000010n, 1700000000000003n, 1700000000000004n];
    const generate = createTidGenerator({
      nowMicros: () => clock.shift() as bigint,
      clockId: 0,
    });

    expect([generate(), generate(), generate()].map(decodeTid)).toEqual([
      { timestampMicros: "1700000000000010", clockId: 0 },
      { timestampMicros: "1700000000000011", clockId: 0 },
      { timestampMicros: "1700000000000012", clockId: 0 },
    ]);
  });

  test("starts at the first clock value, including zero", () => {
    const generate = createTidGenerator({ nowMicros: () => 0n, clockId: 0 });

    expect([generate(), generate()]).toEqual([
      "2222222222222",
      "2222222222322",
    ]);
  });

  test("sorts as text in the order of generation", () => {
    const generate = createTidGenerator({
      nowMicros: () => 1700000000000000n,
      clockId: 1023,
    });
    const tids = Array.from({ length: 2000 }, () => generate());

    expect([...tids].sort()).toEqual(tids);
    expect(new Set(tids).size).toBe(2000);
    expect(decodeTid(tids[1999])).toEqual({
      timestampMicros: "1700000000001999",
      clockId: 1023,
    });
  });

  test("picks a clock id between 0 and 1023 and keeps it", () => {
    const generate = createTidGenerator({ nowMicros: () => 1n });
    const first = decodeTid(generate());
    const second = decodeTid(generate());

    expect(Number.isInteger(first.clockId)).toBe(true);
    expect(first.clockId).toBeGreaterThanOrEqual(0);
    expect(first.clockId).toBeLessThanOrEqual(1023);
    expect(second.clockId).toBe(first.clockId);
    expect(first.timestampMicros).toBe("1");
    expect(second.timestampMicros).toBe("2");
  });

  test("takes microseconds from the system clock by default", () => {
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(1758000000123);
    try {
      const generate = createTidGenerator({ clockId: 77 });

      expect(generate()).toBe("3lywl4sfk5s4h");
      expect(decodeTid(generate())).toEqual({
        timestampMicros: "1758000000123001",
        clockId: 77,
      });
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe("nextTid", () => {
  test("returns valid, strictly increasing record keys", () => {
    const tids = Array.from({ length: 500 }, () => nextTid());

    for (const tid of tids) {
      expect(isValidTid(tid)).toBe(true);
    }
    for (let i = 1; i < tids.length; i++) {
      expect(tids[i] > tids[i - 1]).toBe(true);
      expect(
        BigInt(decodeTid(tids[i]).timestampMicros) >
          BigInt(decodeTid(tids[i - 1]).timestampMicros)
      ).toBe(true);
    }
    expect(new Set(tids.map((tid) => decodeTid(tid).clockId)).size).toBe(1);
  });

  test("reads the system clock in microseconds", async () => {
    const dateNow = jest.spyOn(Date, "now").mockReturnValue(1758000000123);
    try {
      await jest.isolateModulesAsync(async () => {
        const fresh = await import("../../src/utils/tid");
        const first = decodeTid(fresh.nextTid());
        const second = decodeTid(fresh.nextTid());

        expect(first.timestampMicros).toBe("1758000000123000");
        expect(second.timestampMicros).toBe("1758000000123001");
        expect(second.clockId).toBe(first.clockId);
      });
    } finally {
      dateNow.mockRestore();
    }
  });
});

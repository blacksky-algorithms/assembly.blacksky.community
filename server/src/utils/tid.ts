import { randomInt } from "crypto";

const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
const TID_LENGTH = 13;
const TID_PATTERN =
  /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const CLOCK_ID_BITS = 10n;
const CLOCK_ID_COUNT = 1024;
const MAX_TIMESTAMP_MICROS = (1n << 53n) - 1n;

export type TidGenerator = () => string;

export function encodeTid(timestampMicros: bigint, clockId: number): string {
  if (timestampMicros < 0n || timestampMicros > MAX_TIMESTAMP_MICROS) {
    throw new RangeError("TID timestamp out of range");
  }
  if (!Number.isInteger(clockId) || clockId < 0 || clockId >= CLOCK_ID_COUNT) {
    throw new RangeError("TID clock id out of range");
  }
  let value = (timestampMicros << CLOCK_ID_BITS) | BigInt(clockId);
  const chars = new Array<string>(TID_LENGTH);
  for (let i = TID_LENGTH - 1; i >= 0; i--) {
    chars[i] = TID_ALPHABET[Number(value & 31n)];
    value >>= 5n;
  }
  return chars.join("");
}

export function isValidTid(value: unknown): value is string {
  return typeof value === "string" && TID_PATTERN.test(value);
}

export function createTidGenerator(
  opts: { nowMicros?: () => bigint; clockId?: number } = {}
): TidGenerator {
  const nowMicros = opts.nowMicros ?? (() => BigInt(Date.now()) * 1000n);
  const clockId = opts.clockId ?? randomInt(CLOCK_ID_COUNT);
  let last = -1n;
  return () => {
    const now = nowMicros();
    last = now > last ? now : last + 1n;
    return encodeTid(last, clockId);
  };
}

export const nextTid: TidGenerator = createTidGenerator();

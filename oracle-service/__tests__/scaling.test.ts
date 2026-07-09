import {
  PRICE_SCALE,
  WAD,
  assertUint16,
  assertUint64,
  usdRatioWad,
  usdToScaled,
} from "../src/scaling.js";

describe("usdToScaled", () => {
  it("scales whole and fractional USD prices by 1e10", () => {
    expect(usdToScaled(1)).toBe(PRICE_SCALE);
    expect(usdToScaled(2500)).toBe(2500n * PRICE_SCALE);
    expect(usdToScaled(0.5)).toBe(PRICE_SCALE / 2n);
    expect(usdToScaled("3000.25")).toBe(30002500000000n);
  });

  it("handles small prices down to the 1e-10 precision floor", () => {
    expect(usdToScaled(0.0000001)).toBe(1000n);
    expect(usdToScaled("0.0000000001")).toBe(1n);
  });

  it("rounds half-up beyond 10 fractional digits", () => {
    // 11th fractional digit is 5 -> round the 10-digit value up.
    expect(usdToScaled("0.00000000005")).toBe(1n);
    // 11th digit is 4 -> round down (to zero) -> rejected as non-positive.
    expect(() => usdToScaled("0.00000000004")).toThrow();
  });

  it("rejects non-positive, non-finite, and malformed values", () => {
    expect(() => usdToScaled(0)).toThrow();
    expect(() => usdToScaled(-1)).toThrow();
    expect(() => usdToScaled(Number.NaN)).toThrow();
    expect(() => usdToScaled(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => usdToScaled("abc")).toThrow();
    expect(() => usdToScaled("-5")).toThrow();
  });

  it("rejects values that overflow uint64 after scaling", () => {
    // 2^64 / 1e10 ≈ 1.8e9 USD is the ceiling.
    expect(() => usdToScaled("2000000000")).toThrow(/uint64/);
  });
});

describe("assertUint64", () => {
  it("passes values within range", () => {
    expect(assertUint64(0n, "x")).toBe(0n);
    expect(assertUint64(2n ** 64n - 1n, "x")).toBe(2n ** 64n - 1n);
  });

  it("rejects negative and over-range values", () => {
    expect(() => assertUint64(-1n, "x")).toThrow();
    expect(() => assertUint64(2n ** 64n, "x")).toThrow();
  });
});

describe("assertUint16", () => {
  it("passes values within range", () => {
    expect(assertUint16(0n, "x")).toBe(0n);
    expect(assertUint16(65_535n, "x")).toBe(65_535n);
  });

  it("rejects negative and over-range values", () => {
    expect(() => assertUint16(-1n, "x")).toThrow();
    expect(() => assertUint16(65_536n, "x")).toThrow(/uint16/);
  });
});

describe("usdRatioWad", () => {
  it("computes ctcPerAttest = attestUsd / ctcUsd in 1e18 fixed point", () => {
    // 1 ATTEST = 10,000,000 CTC: attest $5,000,000 / ctc $0.50.
    expect(usdRatioWad(5_000_000, 0.5)).toBe(10n ** 25n);
    expect(usdRatioWad(1, 1)).toBe(WAD);
    // Sub-unit ratios keep precision: 0.5 / 2 = 0.25.
    expect(usdRatioWad(0.5, 2)).toBe(WAD / 4n);
  });

  it("carries the full 1e10 input precision", () => {
    expect(usdRatioWad("1.0000000001", 1)).toBe(1_000_000_000_100_000_000n);
  });

  it("rejects non-positive legs and zero ratios", () => {
    expect(() => usdRatioWad(0, 1)).toThrow();
    expect(() => usdRatioWad(1, 0)).toThrow();
    // Numerator so small the wad ratio truncates to zero.
    expect(() => usdRatioWad("0.0000000001", "1800000000")).toThrow(/zero/);
  });
});

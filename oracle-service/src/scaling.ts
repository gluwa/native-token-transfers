/// The PenguinBridgeExecutionQuoter stores USD prices as `uint64` scaled by 1e10
/// (`sourcePrice` and `PricingData.dstPrice`). This module converts a floating-point
/// USD price into that fixed-point representation deterministically — going through a
/// decimal string rather than `price * 1e10` so we don't inherit IEEE-754 rounding
/// error from the multiplication.

/// Number of fractional digits the contract encodes (1e10).
export const PRICE_DECIMALS = 10;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
const UINT64_MAX = 2n ** 64n - 1n;

/// Scale a non-negative decimal string by `decimals` digits, rounding half-up on any
/// excess precision. Throws on malformed input.
function scaleDecimalString(raw: string, decimals: number): bigint {
  const s = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) {
    throw new RangeError(`not a non-negative decimal: ${raw}`);
  }
  const intPart = match[1]!;
  let frac = match[2] ?? "";
  let roundUp = false;
  if (frac.length > decimals) {
    roundUp = frac.charCodeAt(decimals) - 48 >= 5;
    frac = frac.slice(0, decimals);
  } else {
    frac = frac.padEnd(decimals, "0");
  }
  let scaled = BigInt(intPart + frac);
  if (roundUp) scaled += 1n;
  return scaled;
}

/// Convert a positive USD price (number or numeric string) into the contract's
/// 1e10-scaled `uint64`. Rejects non-finite, non-positive, and out-of-range values.
export function usdToScaled(price: number | string): bigint {
  let asString: string;
  if (typeof price === "number") {
    if (!Number.isFinite(price)) {
      throw new RangeError(`price must be finite, got ${price}`);
    }
    // toFixed avoids exponential notation and pins to exactly PRICE_DECIMALS digits,
    // so scaleDecimalString sees no excess precision to round.
    asString = price.toFixed(PRICE_DECIMALS);
  } else {
    asString = price;
  }

  const scaled = scaleDecimalString(asString, PRICE_DECIMALS);
  if (scaled <= 0n) {
    throw new RangeError(`price must be positive, got ${price}`);
  }
  if (scaled > UINT64_MAX) {
    throw new RangeError(
      `price ${price} scaled by 1e${PRICE_DECIMALS} exceeds uint64`
    );
  }
  return scaled;
}

/// Assert a wei-denominated value (gas price, base fee) fits the contract's `uint64`.
export function assertUint64(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new RangeError(`${label} must be non-negative, got ${value}`);
  }
  if (value > UINT64_MAX) {
    throw new RangeError(`${label} ${value} exceeds uint64`);
  }
  return value;
}

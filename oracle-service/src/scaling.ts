/// The PenguinBridgeExecutionQuoter stores USD prices as `uint64` scaled by 1e10
/// (`sourcePrice` and `PricingData.dstPrice`). This module converts a floating-point
/// USD price into that fixed-point representation deterministically — going through a
/// decimal string rather than `price * 1e10` so we don't inherit IEEE-754 rounding
/// error from the multiplication.

/// Number of fractional digits the contract encodes (1e10).
export const PRICE_DECIMALS = 10;
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

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

/// Assert a value fits the EVM's `uint64` range.
export function assertUint64(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new RangeError(`${label} must be non-negative, got ${value}`);
  }
  if (value > UINT64_MAX) {
    throw new RangeError(`${label} ${value} exceeds uint64`);
  }
  return value;
}

/// Assert a value fits the EVM's `uint256` range.
export function assertUint256(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new RangeError(`${label} must be non-negative, got ${value}`);
  }
  if (value > UINT256_MAX) {
    throw new RangeError(`${label} ${value} exceeds uint256`);
  }
  return value;
}

const UINT16_MAX = 2n ** 16n - 1n;

/// Assert a value fits the contract's `uint16` (PricingData.priceBuffer).
export function assertUint16(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new RangeError(`${label} must be non-negative, got ${value}`);
  }
  if (value > UINT16_MAX) {
    throw new RangeError(`${label} ${value} exceeds uint16`);
  }
  return value;
}

/// 18-decimal fixed point ("wad"), the scale TWAPReader.update() expects.
export const WAD = 10n ** 18n;

/// Ratio of two positive USD prices as an 18-decimal fixed-point value — used for
/// ctcPerAttest = attestUsd / ctcUsd. Both legs go through the same 1e10 scaling as
/// the contract prices, so the ratio carries their full precision.
export function usdRatioWad(
  numeratorUsd: number | string,
  denominatorUsd: number | string
): bigint {
  const num = usdToScaled(numeratorUsd);
  const den = usdToScaled(denominatorUsd);
  const ratio = (num * WAD) / den;
  if (ratio <= 0n) {
    throw new RangeError(
      `ratio ${numeratorUsd}/${denominatorUsd} scaled to wad is zero`
    );
  }
  return ratio;
}

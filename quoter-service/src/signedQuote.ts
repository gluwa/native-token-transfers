import {
  SigningKey,
  keccak256,
  concat,
  getAddress,
  getBytes,
  hexlify,
  toBeHex,
  isHexString,
} from "ethers";

// Address validation in `encodeQuoteBody` uses isHexString rather than getAddress
// because the caller (config.ts) already validated the address via the Wallet
// constructor at boot. We only need a cheap length check on the hot path.

/// "PQ01" — must match SpecialRelayer.SIGNED_QUOTE_PREFIX.
export const SIGNED_QUOTE_PREFIX = "0x50513031";
export const SIGNED_QUOTE_BODY_LENGTH = 132;
export const SIGNATURE_LENGTH = 65;
export const SIGNED_QUOTE_LENGTH = SIGNED_QUOTE_BODY_LENGTH + SIGNATURE_LENGTH;

export interface QuoteBody {
  /// 20-byte EVM address recovered from the signature; must be registered in
  /// PenguinBridgeExecutionQuoter.authorizedQuoters.
  quoterAddress: string;
  /// bytes32 universal address that receives the fee on the source chain.
  payeeAddress: string;
  /// Wormhole chain id of the source chain (matches SpecialRelayer.sourceChainId).
  srcChain: number;
  /// Wormhole chain id of the destination.
  dstChain: number;
  /// Unix seconds after which SpecialRelayer rejects the quote.
  expiryTime: bigint;
  /// Destination-side gas limit the caller requested. Bound into the signature so
  /// the caller can verify the gasLimit used to derive requiredPayment, and so the
  /// off-chain relayer bot has a signed source of truth for the gas to use on
  /// destination.
  gasLimit: bigint;
  /// Required source-chain payment in wei.
  requiredPayment: bigint;
}

export interface SignedQuote extends QuoteBody {
  signedQuoteBytes: string;
}

const UINT16_MAX = 0xffff;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/// Pack the quote body into the exact 132-byte layout SpecialRelayer expects.
/// The layout (matching SpecialRelayer._parseSignedQuote) is:
///   bytes4   prefix
///   address  quoterAddress     (offset 4,   20 bytes)
///   bytes32  payeeAddress      (offset 24,  32 bytes)
///   uint16   srcChain          (offset 56,   2 bytes)
///   uint16   dstChain          (offset 58,   2 bytes)
///   uint64   expiryTime        (offset 60,   8 bytes)
///   uint256  gasLimit          (offset 68,  32 bytes)
///   uint256  requiredPayment   (offset 100, 32 bytes)
export function encodeQuoteBody(body: QuoteBody): Uint8Array {
  if (body.srcChain < 0 || body.srcChain > UINT16_MAX) {
    throw new RangeError(`srcChain ${body.srcChain} out of uint16 range`);
  }
  if (body.dstChain < 0 || body.dstChain > UINT16_MAX) {
    throw new RangeError(`dstChain ${body.dstChain} out of uint16 range`);
  }
  if (body.expiryTime < 0n || body.expiryTime > UINT64_MAX) {
    throw new RangeError(`expiryTime ${body.expiryTime} out of uint64 range`);
  }
  if (body.gasLimit < 0n || body.gasLimit > UINT256_MAX) {
    throw new RangeError(`gasLimit ${body.gasLimit} out of uint256 range`);
  }
  if (body.requiredPayment < 0n || body.requiredPayment > UINT256_MAX) {
    throw new RangeError(
      `requiredPayment ${body.requiredPayment} out of uint256 range`
    );
  }
  if (!isHexString(body.payeeAddress, 32)) {
    throw new TypeError(
      `payeeAddress must be a 32-byte hex string, got ${body.payeeAddress}`
    );
  }
  if (!isHexString(body.quoterAddress, 20)) {
    throw new TypeError(
      `quoterAddress must be a 20-byte hex string, got ${body.quoterAddress}`
    );
  }

  const out = new Uint8Array(SIGNED_QUOTE_BODY_LENGTH);
  out.set(getBytes(SIGNED_QUOTE_PREFIX), 0);
  out.set(getBytes(body.quoterAddress), 4);
  out.set(getBytes(body.payeeAddress), 24);
  const view = new DataView(out.buffer);
  view.setUint16(56, body.srcChain, false);
  view.setUint16(58, body.dstChain, false);
  // DataView lacks setBigUint64 in older Node ESM lib targets in some setups;
  // we have ES2022 here, so it is available.
  view.setBigUint64(60, body.expiryTime, false);
  out.set(getBytes(toBeHex(body.gasLimit, 32)), 68);
  out.set(getBytes(toBeHex(body.requiredPayment, 32)), 100);
  return out;
}

/// Sign the 132-byte body with the quoter key and return the concatenated 197-byte
/// signedQuoteBytes. The signature covers keccak256(body) directly — no EIP-191 prefix,
/// matching SpecialRelayer._recoverQuoteSigner.
export function signQuote(
  body: QuoteBody,
  signingKey: SigningKey
): SignedQuote {
  const encoded = encodeQuoteBody(body);
  const digest = keccak256(encoded);
  const sig = signingKey.sign(digest);
  // SpecialRelayer reads (r, s, v) in that order from the trailing 65 bytes.
  const signature = concat([sig.r, sig.s, new Uint8Array([sig.v])]);
  return { ...body, signedQuoteBytes: hexlify(concat([encoded, signature])) };
}

/// Inverse of encodeQuoteBody — useful for tests and for clients that want to inspect
/// a signedQuoteBytes blob without round-tripping through the contract.
export function decodeSignedQuote(signedQuoteBytes: string): SignedQuote {
  const bytes = getBytes(signedQuoteBytes);
  if (bytes.length !== SIGNED_QUOTE_LENGTH) {
    throw new RangeError(
      `signedQuoteBytes length ${bytes.length} != ${SIGNED_QUOTE_LENGTH}`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const quoterAddress = getAddress(hexlify(bytes.slice(4, 24)));
  const payeeAddress = hexlify(bytes.slice(24, 56));
  const srcChain = view.getUint16(56, false);
  const dstChain = view.getUint16(58, false);
  const expiryTime = view.getBigUint64(60, false);
  const gasLimit = BigInt(hexlify(bytes.slice(68, 100)));
  const requiredPayment = BigInt(hexlify(bytes.slice(100, 132)));
  return {
    quoterAddress,
    payeeAddress,
    srcChain,
    dstChain,
    expiryTime,
    gasLimit,
    requiredPayment,
    signedQuoteBytes: hexlify(bytes),
  };
}

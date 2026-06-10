import { concat, getBytes, hexlify, keccak256, zeroPadValue } from "ethers";

import type { ChainId, Hex } from "../types.js";

/// A Wormhole VAA wraps a guardian-signed message. The destination WormholeTransceiver's
/// receiveMessage(vaa) runs parseAndVerifyVM and keys replay protection on the *double*
/// keccak of the body (`vm.hash = keccak256(keccak256(body))`). Reproducing that hash
/// exactly is the single most error-prone detail in the bot — a single keccak silently
/// makes isVAAConsumed always return false. Verified against devnet/tools/relayer.ts:150
/// and WormholeTransceiver._verifyMessage.

/// Byte offsets within the VAA body:
///   0  timestamp        uint32 BE
///   4  nonce            uint32 BE
///   8  emitterChainId   uint16 BE
///   10 emitterAddress   32 bytes
///   42 sequence         uint64 BE
///   50 consistencyLevel uint8
///   51 payload          variable
const BODY_PREFIX_LENGTH = 51;

const VAA_VERSION = 1;
const SIGNATURE_LENGTH = 66; // guardianIndex(1) + r(32) + s(32) + v(1)
const HEADER_PREFIX_LENGTH = 6; // version(1) + guardianSetIndex(4) + numSignatures(1)

const UINT32_MAX = 0xffff_ffff;
const UINT16_MAX = 0xffff;
const UINT64_MAX = (1n << 64n) - 1n;

export interface VaaBodyFields {
  /// uint32. Devnet self-signed VAAs use 0; the transceiver does not check it.
  timestamp: number;
  /// uint32. From the source LogMessagePublished event.
  nonce: number;
  emitterChainId: ChainId;
  /// bytes32 universal address of the emitter (the source WormholeTransceiver).
  emitterAddress: Hex;
  sequence: bigint;
  /// uint8. From the source LogMessagePublished event.
  consistencyLevel: number;
  /// The Wormhole message payload (== ExecutionRequested.requestBytes).
  payload: Hex;
}

export interface ParsedVaa extends VaaBodyFields {
  version: number;
  guardianSetIndex: number;
  numSignatures: number;
  /// The vm.hash used by isVAAConsumed: keccak256(keccak256(body)).
  hash: Hex;
}

export interface GuardianSignature {
  r: Hex;
  s: Hex;
  /// Recovery id normalized to 0 or 1 (NOT 27/28) — Wormhole VAA signature format.
  v: number;
}

/// Left-pad a 20-byte EVM address to a 32-byte Wormhole universal address.
export function toUniversalAddress(evmAddress: string): Hex {
  return zeroPadValue(evmAddress, 32);
}

export function encodeVaaBody(fields: VaaBodyFields): Uint8Array {
  if (fields.timestamp < 0 || fields.timestamp > UINT32_MAX) {
    throw new RangeError(`timestamp ${fields.timestamp} out of uint32 range`);
  }
  if (fields.nonce < 0 || fields.nonce > UINT32_MAX) {
    throw new RangeError(`nonce ${fields.nonce} out of uint32 range`);
  }
  if (fields.emitterChainId < 0 || fields.emitterChainId > UINT16_MAX) {
    throw new RangeError(
      `emitterChainId ${fields.emitterChainId} out of uint16 range`
    );
  }
  if (fields.sequence < 0n || fields.sequence > UINT64_MAX) {
    throw new RangeError(`sequence ${fields.sequence} out of uint64 range`);
  }
  if (fields.consistencyLevel < 0 || fields.consistencyLevel > 0xff) {
    throw new RangeError(
      `consistencyLevel ${fields.consistencyLevel} out of uint8 range`
    );
  }
  const emitter = getBytes(fields.emitterAddress);
  if (emitter.length !== 32) {
    throw new TypeError(
      `emitterAddress must be 32 bytes, got ${emitter.length}`
    );
  }
  const payload = getBytes(fields.payload);

  const out = new Uint8Array(BODY_PREFIX_LENGTH + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, fields.timestamp, false);
  view.setUint32(4, fields.nonce, false);
  view.setUint16(8, fields.emitterChainId, false);
  out.set(emitter, 10);
  view.setBigUint64(42, fields.sequence, false);
  view.setUint8(50, fields.consistencyLevel);
  out.set(payload, BODY_PREFIX_LENGTH);
  return out;
}

/// vm.hash = keccak256(keccak256(body)) — the key isVAAConsumed checks.
export function vaaBodyDoubleHash(body: Uint8Array): Hex {
  return keccak256(getBytes(keccak256(body)));
}

/// Build a fully-signed single-guardian VAA. `signDigest` signs the 32-byte vm.hash and
/// returns the recovery id as 0/1. Used by the dev-guardian VAA fetcher in tests/devnet.
export function packSignedVaa(
  fields: VaaBodyFields,
  guardianSetIndex: number,
  signDigest: (digest: Hex) => GuardianSignature,
  guardianIndex = 0
): { vaa: Hex; hash: Hex } {
  if (guardianSetIndex < 0 || guardianSetIndex > UINT32_MAX) {
    throw new RangeError(
      `guardianSetIndex ${guardianSetIndex} out of uint32 range`
    );
  }
  const body = encodeVaaBody(fields);
  const hash = vaaBodyDoubleHash(body);
  const { r, s, v } = signDigest(hash);

  const header = new Uint8Array(HEADER_PREFIX_LENGTH);
  const headerView = new DataView(header.buffer);
  headerView.setUint8(0, VAA_VERSION);
  headerView.setUint32(1, guardianSetIndex, false);
  headerView.setUint8(5, 1); // numSignatures

  const sig = new Uint8Array(SIGNATURE_LENGTH);
  sig[0] = guardianIndex;
  sig.set(getBytes(r), 1);
  sig.set(getBytes(s), 33);
  sig[65] = v;

  return { vaa: hexlify(concat([header, sig, body])), hash };
}

/// Parse a fully-signed VAA into its body fields + vm.hash. Used for the Wormholescan
/// path where we receive already-signed bytes and only need the hash (for the
/// isVAAConsumed pre-flight) and the parsed fields (for sanity checks).
export function parseSignedVaa(vaa: Uint8Array | Hex): ParsedVaa {
  const bytes = typeof vaa === "string" ? getBytes(vaa) : vaa;
  if (bytes.length < HEADER_PREFIX_LENGTH) {
    throw new RangeError(`VAA too short: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  // We only know how to parse v1 VAAs (the header/signature/body layout above). A future
  // Wormhole version would have a different layout, so reject rather than mis-parse it.
  if (version !== VAA_VERSION) {
    throw new RangeError(
      `unsupported VAA version ${version} (only v${VAA_VERSION} is supported)`
    );
  }
  const guardianSetIndex = view.getUint32(1, false);
  const numSignatures = view.getUint8(5);

  const bodyStart = HEADER_PREFIX_LENGTH + numSignatures * SIGNATURE_LENGTH;
  if (bytes.length < bodyStart + BODY_PREFIX_LENGTH) {
    throw new RangeError(
      `VAA too short for ${numSignatures} signatures + body: ${bytes.length} bytes`
    );
  }
  const body = bytes.subarray(bodyStart);
  const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const timestamp = bodyView.getUint32(0, false);
  const nonce = bodyView.getUint32(4, false);
  const emitterChainId = bodyView.getUint16(8, false);
  const emitterAddress = hexlify(body.subarray(10, 42));
  const sequence = bodyView.getBigUint64(42, false);
  const consistencyLevel = bodyView.getUint8(50);
  const payload = hexlify(body.subarray(BODY_PREFIX_LENGTH));

  return {
    version,
    guardianSetIndex,
    numSignatures,
    timestamp,
    nonce,
    emitterChainId,
    emitterAddress,
    sequence,
    consistencyLevel,
    payload,
    hash: vaaBodyDoubleHash(body),
  };
}

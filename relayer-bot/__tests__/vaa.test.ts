import {
  computeAddress,
  getBytes,
  hexlify,
  keccak256,
  recoverAddress,
  SigningKey,
} from "ethers";

import {
  type VaaBodyFields,
  encodeVaaBody,
  packSignedVaa,
  parseSignedVaa,
  toUniversalAddress,
  vaaBodyDoubleHash,
} from "../src/relay/vaa.js";

// ── Reference body encoder mirroring devnet/tools/relayer.ts packVAA (the proven devnet
// implementation). If our DataView-based encoder ever drifts from this, the destination
// transceiver's parseAndVerifyVM / isVAAConsumed would silently reject or mis-key. ──
function beU16(n: number): Buffer {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff]);
}
function beU32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function beU64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
function refBody(f: VaaBodyFields): Buffer {
  return Buffer.concat([
    beU32(f.timestamp),
    beU32(f.nonce),
    beU16(f.emitterChainId),
    Buffer.from(f.emitterAddress.replace(/^0x/, ""), "hex"),
    beU64(f.sequence),
    Buffer.from([f.consistencyLevel & 0xff]),
    Buffer.from(f.payload.replace(/^0x/, ""), "hex"),
  ]);
}

const FIELDS: VaaBodyFields = {
  timestamp: 0,
  nonce: 7,
  emitterChainId: 2,
  emitterAddress: toUniversalAddress("0x" + "ab".repeat(20)),
  sequence: 123456789n,
  consistencyLevel: 200,
  payload: "0x9945ff10" + "11".repeat(40),
};

describe("encodeVaaBody", () => {
  it("matches the reference (relayer.ts) byte layout exactly", () => {
    const got = Buffer.from(encodeVaaBody(FIELDS));
    expect(got.equals(refBody(FIELDS))).toBe(true);
  });

  it("places fields at the documented offsets", () => {
    const body = encodeVaaBody(FIELDS);
    const view = new DataView(body.buffer);
    expect(view.getUint32(0, false)).toBe(0); // timestamp
    expect(view.getUint32(4, false)).toBe(7); // nonce
    expect(view.getUint16(8, false)).toBe(2); // emitterChainId
    expect(hexlify(body.subarray(10, 42))).toBe(FIELDS.emitterAddress);
    expect(view.getBigUint64(42, false)).toBe(123456789n);
    expect(view.getUint8(50)).toBe(200);
    expect(hexlify(body.subarray(51))).toBe(FIELDS.payload);
  });

  it("rejects an emitter address that is not 32 bytes", () => {
    expect(() =>
      encodeVaaBody({ ...FIELDS, emitterAddress: "0x" + "ab".repeat(20) })
    ).toThrow(/32 bytes/);
  });
});

describe("vaaBodyDoubleHash", () => {
  it("is keccak256(keccak256(body)) — the isVAAConsumed key, NOT a single keccak", () => {
    const body = encodeVaaBody(FIELDS);
    const single = keccak256(body);
    const expected = keccak256(getBytes(single));
    expect(vaaBodyDoubleHash(body)).toBe(expected);
    // Guard against a regression to single-keccak.
    expect(vaaBodyDoubleHash(body)).not.toBe(single);
  });

  it("matches the reference double-hash", () => {
    const ref = refBody(FIELDS);
    const expected = keccak256(getBytes(keccak256(ref)));
    expect(vaaBodyDoubleHash(encodeVaaBody(FIELDS))).toBe(expected);
  });
});

describe("packSignedVaa / parseSignedVaa", () => {
  const guardianKey = "0x" + "01".repeat(32);
  const key = new SigningKey(guardianKey);

  const sign = (digest: string) => {
    const sig = key.sign(digest);
    return { r: sig.r, s: sig.s, v: sig.yParity };
  };

  it("round-trips body fields and reproduces the hash", () => {
    const { vaa, hash } = packSignedVaa(FIELDS, 3, sign);
    const parsed = parseSignedVaa(getBytes(vaa));
    expect(parsed.version).toBe(1);
    expect(parsed.guardianSetIndex).toBe(3);
    expect(parsed.numSignatures).toBe(1);
    expect(parsed.emitterChainId).toBe(FIELDS.emitterChainId);
    expect(parsed.emitterAddress).toBe(FIELDS.emitterAddress);
    expect(parsed.sequence).toBe(FIELDS.sequence);
    expect(parsed.consistencyLevel).toBe(FIELDS.consistencyLevel);
    expect(parsed.payload.toLowerCase()).toBe(FIELDS.payload.toLowerCase());
    expect(parsed.hash).toBe(hash);
    expect(parsed.hash).toBe(vaaBodyDoubleHash(encodeVaaBody(FIELDS)));
  });

  it("produces a signature over the double-hash that recovers the guardian", () => {
    const { vaa, hash } = packSignedVaa(FIELDS, 0, sign);
    const bytes = getBytes(vaa);
    // header(6) + [guardianIndex(1) r(32) s(32) v(1)]
    expect(bytes[6]).toBe(0); // guardian index
    const r = hexlify(bytes.slice(7, 39));
    const s = hexlify(bytes.slice(39, 71));
    const v = bytes[71]!;
    expect(v === 0 || v === 1).toBe(true);
    const recovered = recoverAddress(hash, { r, s, yParity: v as 0 | 1 });
    expect(recovered).toBe(computeAddress(key.publicKey));
  });

  it("handles an empty payload and max uint64 sequence", () => {
    const fields: VaaBodyFields = {
      ...FIELDS,
      payload: "0x",
      sequence: (1n << 64n) - 1n,
    };
    const { vaa } = packSignedVaa(fields, 0, sign);
    const parsed = parseSignedVaa(getBytes(vaa));
    expect(parsed.payload).toBe("0x");
    expect(parsed.sequence).toBe((1n << 64n) - 1n);
  });

  it("rejects an unsupported VAA version rather than mis-parsing it", () => {
    const { vaa } = packSignedVaa(FIELDS, 0, sign);
    const bytes = getBytes(vaa);
    bytes[0] = 2; // bump the version byte to an unsupported value
    expect(() => parseSignedVaa(bytes)).toThrow(/unsupported VAA version 2/);
  });
});

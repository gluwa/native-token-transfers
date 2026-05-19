import { SigningKey, Wallet, keccak256, getBytes, recoverAddress, Signature } from "ethers";
import {
  SIGNED_QUOTE_BODY_LENGTH,
  SIGNED_QUOTE_LENGTH,
  SIGNED_QUOTE_PREFIX,
  decodeSignedQuote,
  encodeQuoteBody,
  signQuote,
} from "../src/signedQuote.js";

// Same fixture used by the on-chain SpecialRelayer foundry tests so the
// signature this service produces is byte-identical to what the contract verifies.
const QUOTER_PRIVATE_KEY = "0x" + (0xa11cen).toString(16).padStart(64, "0");

function fixtureBody() {
  return {
    quoterAddress: new Wallet(QUOTER_PRIVATE_KEY).address,
    // bytes32(uint256(uint160(0xFEE1))) — matches the foundry SpecialRelayer test fixture.
    payeeAddress: "0x" + "0".repeat(60) + "fee1",
    srcChain: 2,
    dstChain: 5,
    expiryTime: 1_700_000_000n,
    requiredPayment: 250_000_000_000_000_000n, // 0.25 ether
  };
}

describe("encodeQuoteBody", () => {
  it("packs fields at the exact offsets SpecialRelayer reads", () => {
    const body = fixtureBody();
    const encoded = encodeQuoteBody(body);

    expect(encoded.length).toBe(SIGNED_QUOTE_BODY_LENGTH);

    const hex = "0x" + Buffer.from(encoded).toString("hex");
    // bytes4 prefix
    expect(hex.slice(0, 10).toLowerCase()).toBe(SIGNED_QUOTE_PREFIX.toLowerCase());
    // address quoter at offset 4
    expect("0x" + hex.slice(10, 50)).toBe(body.quoterAddress.toLowerCase());
    // bytes32 payee at offset 24
    expect("0x" + hex.slice(50, 114)).toBe(body.payeeAddress.toLowerCase());
    // uint16 srcChain at offset 56
    expect(parseInt(hex.slice(114, 118), 16)).toBe(body.srcChain);
    // uint16 dstChain at offset 58
    expect(parseInt(hex.slice(118, 122), 16)).toBe(body.dstChain);
    // uint64 expiryTime at offset 60
    expect(BigInt("0x" + hex.slice(122, 138))).toBe(body.expiryTime);
    // uint256 requiredPayment at offset 68
    expect(BigInt("0x" + hex.slice(138, 202))).toBe(body.requiredPayment);
  });

  it("rejects out-of-range fields", () => {
    expect(() => encodeQuoteBody({ ...fixtureBody(), srcChain: 0x10000 })).toThrow();
    expect(() => encodeQuoteBody({ ...fixtureBody(), dstChain: -1 })).toThrow();
    expect(() => encodeQuoteBody({ ...fixtureBody(), expiryTime: 1n << 64n })).toThrow();
    expect(() => encodeQuoteBody({ ...fixtureBody(), requiredPayment: 1n << 256n })).toThrow();
    expect(() => encodeQuoteBody({ ...fixtureBody(), payeeAddress: "0xdead" })).toThrow();
  });
});

describe("signQuote", () => {
  const signingKey = new SigningKey(QUOTER_PRIVATE_KEY);
  const expectedSigner = new Wallet(QUOTER_PRIVATE_KEY).address;

  it("produces a 165-byte payload (body || r || s || v)", () => {
    const signed = signQuote(fixtureBody(), signingKey);
    const bytes = getBytes(signed.signedQuoteBytes);
    expect(bytes.length).toBe(SIGNED_QUOTE_LENGTH);
  });

  it("signs the raw keccak256(body) digest — no EIP-191 prefix — so SpecialRelayer can recover the signer", () => {
    const body = fixtureBody();
    const signed = signQuote(body, signingKey);
    const bytes = getBytes(signed.signedQuoteBytes);
    const bodyHex = "0x" + Buffer.from(bytes.slice(0, SIGNED_QUOTE_BODY_LENGTH)).toString("hex");
    const sigBytes = bytes.slice(SIGNED_QUOTE_BODY_LENGTH);
    const r = "0x" + Buffer.from(sigBytes.slice(0, 32)).toString("hex");
    const s = "0x" + Buffer.from(sigBytes.slice(32, 64)).toString("hex");
    const v = sigBytes[64];

    const digest = keccak256(bodyHex);
    const recovered = recoverAddress(digest, Signature.from({ r, s, v }));
    expect(recovered).toBe(expectedSigner);
  });

  it("emits canonical low-s signatures so the contract's ecrecover accepts them", () => {
    const signed = signQuote(fixtureBody(), signingKey);
    const bytes = getBytes(signed.signedQuoteBytes);
    const s = BigInt(
      "0x" +
        Buffer.from(bytes.slice(SIGNED_QUOTE_BODY_LENGTH + 32, SIGNED_QUOTE_BODY_LENGTH + 64)).toString("hex"),
    );
    // secp256k1n / 2
    const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
    expect(s <= HALF_N).toBe(true);
  });
});

describe("decodeSignedQuote", () => {
  it("round-trips a signed quote", () => {
    const signingKey = new SigningKey(QUOTER_PRIVATE_KEY);
    const original = fixtureBody();
    const signed = signQuote(original, signingKey);
    const decoded = decodeSignedQuote(signed.signedQuoteBytes);

    expect(decoded.quoterAddress).toBe(original.quoterAddress);
    expect(decoded.payeeAddress).toBe(original.payeeAddress);
    expect(decoded.srcChain).toBe(original.srcChain);
    expect(decoded.dstChain).toBe(original.dstChain);
    expect(decoded.expiryTime).toBe(original.expiryTime);
    expect(decoded.requiredPayment).toBe(original.requiredPayment);
  });

  it("rejects payloads that are not exactly 165 bytes", () => {
    expect(() => decodeSignedQuote("0x1234")).toThrow();
    // 100-byte body without signature
    expect(() => decodeSignedQuote("0x" + "ab".repeat(100))).toThrow();
    // 166 bytes (one too many)
    expect(() => decodeSignedQuote("0x" + "ab".repeat(166))).toThrow();
  });

  it("rejects non-hex input", () => {
    expect(() => decodeSignedQuote("not hex")).toThrow();
  });
});

// Golden vector — deterministic because secp256k1 signing uses RFC 6979 nonces.
// If this fails, the byte layout, hash construction, or signature encoding changed.
// On a legitimate change, regenerate by re-running the encoder against the fixture.
const GOLDEN_PRIVATE_KEY = "0x" + (0xa11cen).toString(16).padStart(64, "0");
const GOLDEN_BODY = {
  quoterAddress: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
  payeeAddress: "0x" + "0".repeat(60) + "fee1",
  srcChain: 2,
  dstChain: 5,
  expiryTime: 1_700_000_000n,
  requiredPayment: 250_000_000_000_000_000n,
};
const GOLDEN_BODY_HEX =
  "0x50513031" +
  "e05fcc23807536bee418f142d19fa0d21bb0cff7" +
  "000000000000000000000000000000000000000000000000000000000000fee1" +
  "0002" +
  "0005" +
  "000000006553f100" +
  "00000000000000000000000000000000000000000000000003782dace9d90000";
const GOLDEN_SIGNED_HEX =
  GOLDEN_BODY_HEX +
  "04774197c677638d95b7a6d69ac9950ebd4553e8304580f287251ce393c3b5bf" +
  "15f74b276bd9871ad024db0a4fa49bf377835f6018f94e6154729970c53a4df9" +
  "1b";

describe("golden vector", () => {
  it("encodes the fixture body to the exact reference bytes", () => {
    const encoded = encodeQuoteBody(GOLDEN_BODY);
    expect("0x" + Buffer.from(encoded).toString("hex")).toBe(GOLDEN_BODY_HEX);
  });

  it("signs the fixture body to a stable signedQuoteBytes (deterministic)", () => {
    const signed = signQuote(GOLDEN_BODY, new SigningKey(GOLDEN_PRIVATE_KEY));
    expect(signed.signedQuoteBytes.toLowerCase()).toBe(GOLDEN_SIGNED_HEX);
  });

  it("decodes the reference signedQuoteBytes back to the fixture body", () => {
    const decoded = decodeSignedQuote(GOLDEN_SIGNED_HEX);
    expect(decoded.quoterAddress).toBe(GOLDEN_BODY.quoterAddress);
    expect(decoded.payeeAddress).toBe(GOLDEN_BODY.payeeAddress);
    expect(decoded.srcChain).toBe(GOLDEN_BODY.srcChain);
    expect(decoded.dstChain).toBe(GOLDEN_BODY.dstChain);
    expect(decoded.expiryTime).toBe(GOLDEN_BODY.expiryTime);
    expect(decoded.requiredPayment).toBe(GOLDEN_BODY.requiredPayment);
  });
});

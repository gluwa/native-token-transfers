import {
  type Provider,
  SigningKey,
  getAddress,
  getBytes,
  zeroPadValue,
} from "ethers";

import { coreInterface } from "../src/abi.js";
import type { VaaId } from "../src/relay/interfaces.js";
import { packSignedVaa, parseSignedVaa } from "../src/relay/vaa.js";
import {
  DevGuardianVaaFetcher,
  WormholescanVaaFetcher,
} from "../src/relay/vaaFetcher.js";

const EMITTER_EVM = getAddress("0x" + "22".repeat(20));
const EMITTER_UNIVERSAL = zeroPadValue(EMITTER_EVM, 32);

/// A well-formed signed VAA for the given id — the fetcher now parses and validates the
/// response, so stubs must serve real bytes.
function signedVaaFor(id: VaaId): Uint8Array {
  const key = new SigningKey("0x" + "01".repeat(32));
  const { vaa } = packSignedVaa(
    {
      timestamp: 0,
      nonce: 1,
      emitterChainId: id.emitterChain,
      emitterAddress: id.emitterAddress,
      sequence: id.sequence,
      consistencyLevel: 1,
      payload: "0x9945ff10",
    },
    0,
    (digest) => {
      const sig = key.sign(digest);
      return { r: sig.r, s: sig.s, v: sig.yParity };
    }
  );
  return getBytes(vaa);
}

interface StubResponse {
  status: number;
  ok?: boolean;
  body?: unknown;
}
function stubFetch(responses: StubResponse[]): {
  impl: (url: string) => Promise<{
    status: number;
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  return {
    urls,
    impl: async (url: string) => {
      urls.push(url);
      const r = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return {
        status: r.status,
        ok: r.ok ?? (r.status >= 200 && r.status < 300),
        json: async () => r.body ?? {},
      };
    },
  };
}

describe("WormholescanVaaFetcher", () => {
  const id: VaaId = {
    emitterChain: 2,
    emitterAddress: EMITTER_UNIVERSAL,
    sequence: 4242n,
  };

  it("builds the signed_vaa URL and base64-decodes vaaBytes", async () => {
    const raw = signedVaaFor(id);
    const b64 = Buffer.from(raw).toString("base64");
    const { impl, urls } = stubFetch([
      { status: 200, body: { vaaBytes: b64 } },
    ]);
    const fetcher = new WormholescanVaaFetcher({
      baseUrl: "https://api.wormholescan.io/",
      fetchImpl: impl,
    });
    const got = await fetcher.fetchVaa(id);
    expect(got).toEqual(raw);
    // The emitter in the URL is the full 32-byte universal address (no 0x): the 20-byte
    // EVM transceiver left-padded to bytes32.
    const expectedEmitter = "00".repeat(12) + "22".repeat(20);
    expect(urls[0]).toBe(
      `https://api.wormholescan.io/v1/signed_vaa/2/${expectedEmitter}/4242`
    );
  });

  it("returns null on 404 (VAA not yet available)", async () => {
    const { impl } = stubFetch([{ status: 404 }]);
    const fetcher = new WormholescanVaaFetcher({
      baseUrl: "https://api.wormholescan.io",
      fetchImpl: impl,
    });
    expect(await fetcher.fetchVaa(id)).toBeNull();
  });

  it("retries 5xx and eventually succeeds", async () => {
    const raw = signedVaaFor(id);
    const b64 = Buffer.from(raw).toString("base64");
    const { impl, urls } = stubFetch([
      { status: 503 },
      { status: 200, body: { vaaBytes: b64 } },
    ]);
    const fetcher = new WormholescanVaaFetcher({
      baseUrl: "https://api.wormholescan.io",
      fetchImpl: impl,
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });
    expect(await fetcher.fetchVaa(id)).toEqual(raw);
    expect(urls).toHaveLength(2);
  });

  it("rejects a VAA that doesn't match the requested emitter/sequence", async () => {
    // Wormholescan returns a valid VAA — but for a different sequence.
    const wrong = signedVaaFor({ ...id, sequence: 9999n });
    const b64 = Buffer.from(wrong).toString("base64");
    const { impl } = stubFetch([{ status: 200, body: { vaaBytes: b64 } }]);
    const fetcher = new WormholescanVaaFetcher({
      baseUrl: "https://api.wormholescan.io",
      fetchImpl: impl,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });
    await expect(fetcher.fetchVaa(id)).rejects.toThrow(/different VAA/);
  });

  it("throws on a persistent 5xx", async () => {
    const { impl } = stubFetch([{ status: 502 }]);
    const fetcher = new WormholescanVaaFetcher({
      baseUrl: "https://api.wormholescan.io",
      fetchImpl: impl,
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
      sleep: () => Promise.resolve(),
    });
    await expect(fetcher.fetchVaa(id)).rejects.toThrow(/502/);
  });
});

describe("DevGuardianVaaFetcher", () => {
  const guardianKey = "0x" + "01".repeat(32);
  const CORE = getAddress("0x" + "11".repeat(20));
  const PAYLOAD = "0x9945ff10" + "ab".repeat(40);

  function providerWithCoreLog(): Provider {
    const { data, topics } = coreInterface.encodeEventLog(
      "LogMessagePublished",
      [EMITTER_EVM, 77n, 3, PAYLOAD, 15]
    );
    return {
      getTransactionReceipt: async () => ({
        logs: [{ address: CORE, topics: [...topics], data }],
      }),
    } as unknown as Provider;
  }

  it("self-signs a VAA reconstructed from the source LogMessagePublished", async () => {
    const fetcher = new DevGuardianVaaFetcher({
      sourceProviderFor: () => providerWithCoreLog(),
      coreAddressFor: () => CORE,
      guardianKey,
      guardianSetIndexOverride: 5,
    });
    const id: VaaId = {
      emitterChain: 2,
      emitterAddress: EMITTER_UNIVERSAL,
      sequence: 77n,
      sourceTxHash: "0x" + "cd".repeat(32),
    };
    const vaa = await fetcher.fetchVaa(id);
    expect(vaa).not.toBeNull();
    const parsed = parseSignedVaa(vaa!);
    expect(parsed.guardianSetIndex).toBe(5);
    expect(parsed.emitterChainId).toBe(2);
    expect(parsed.emitterAddress).toBe(EMITTER_UNIVERSAL);
    expect(parsed.sequence).toBe(77n);
    expect(parsed.consistencyLevel).toBe(15);
    expect(parsed.payload.toLowerCase()).toBe(PAYLOAD.toLowerCase());
  });

  it("requires sourceTxHash", async () => {
    const fetcher = new DevGuardianVaaFetcher({
      sourceProviderFor: () => providerWithCoreLog(),
      coreAddressFor: () => CORE,
      guardianKey,
    });
    await expect(
      fetcher.fetchVaa({
        emitterChain: 2,
        emitterAddress: EMITTER_UNIVERSAL,
        sequence: 77n,
      })
    ).rejects.toThrow(/sourceTxHash/);
  });
});

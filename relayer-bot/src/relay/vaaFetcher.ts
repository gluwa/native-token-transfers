import {
  Contract,
  type Provider,
  SigningKey,
  getAddress,
  getBytes,
} from "ethers";

import {
  CORE_ABI,
  LOG_MESSAGE_PUBLISHED_TOPIC,
  coreInterface,
} from "../abi.js";
import { DEFAULT_RETRY, type RetryOptions, withRetry } from "../retry.js";
import type { ChainId } from "../types.js";
import type { VaaId } from "./interfaces.js";
import { type GuardianSignature, packSignedVaa } from "./vaa.js";

/// Resolves the guardian-signed VAA bytes for a Wormhole message. Returns null when the
/// VAA is not yet available (the caller decides whether to keep polling vs. time out).
export interface VaaFetcher {
  fetchVaa(id: VaaId): Promise<Uint8Array | null>;
}

/// Minimal shape of a fetch Response we depend on — keeps the test seam tiny.
interface FetchResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}
type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface WormholescanVaaFetcherOptions {
  /// e.g. https://api.wormholescan.io (mainnet) or https://api.testnet.wormholescan.io.
  baseUrl: string;
  retry?: Partial<RetryOptions>;
  /// Test seam — inject a stub fetch.
  fetchImpl?: FetchLike;
  /// Test seam — replace setTimeout-based sleep so retry tests don't wait.
  sleep?: (ms: number) => Promise<void>;
}

function emitterHexNoPrefix(emitterAddress: string): string {
  return emitterAddress.replace(/^0x/, "").toLowerCase();
}

/// Default fetcher for testnet/mainnet. Polls the Wormholescan signed_vaa endpoint:
///   GET {baseUrl}/v1/signed_vaa/{chainId}/{emitterHex}/{sequence} -> { vaaBytes: base64 }
/// 404 means "not observed/signed yet" → null (poll later); 5xx / network errors are
/// transient and retried; other 4xx are surfaced as errors.
export class WormholescanVaaFetcher implements VaaFetcher {
  private readonly baseUrl: string;
  private readonly retry: RetryOptions;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: WormholescanVaaFetcherOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    const injected = opts.fetchImpl;
    if (injected) {
      this.fetchImpl = injected;
    } else {
      // Bind the global fetch (Node 20+). Narrow it to FetchLike.
      this.fetchImpl = (url: string) =>
        fetch(url) as unknown as Promise<FetchResponseLike>;
    }
    this.sleep = opts.sleep;
  }

  async fetchVaa(id: VaaId): Promise<Uint8Array | null> {
    const url =
      `${this.baseUrl}/v1/signed_vaa/${id.emitterChain}/` +
      `${emitterHexNoPrefix(id.emitterAddress)}/${id.sequence.toString()}`;

    const doFetch = async (): Promise<Uint8Array | null> => {
      let res: FetchResponseLike;
      try {
        res = await this.fetchImpl(url);
      } catch (err) {
        throw Object.assign(
          new Error(`wormholescan request failed: ${String(err)}`),
          { code: "SERVER_ERROR" }
        );
      }
      if (res.status === 404) return null;
      if (res.status >= 500) {
        throw Object.assign(new Error(`wormholescan HTTP ${res.status}`), {
          code: "SERVER_ERROR",
        });
      }
      if (!res.ok) {
        throw new Error(`wormholescan HTTP ${res.status} for ${url}`);
      }
      const body = (await res.json()) as { vaaBytes?: string };
      if (!body.vaaBytes) {
        throw new Error("wormholescan response missing vaaBytes");
      }
      return new Uint8Array(Buffer.from(body.vaaBytes, "base64"));
    };

    return withRetry(doFetch, this.retry, this.sleep);
  }
}

export interface DevGuardianVaaFetcherOptions {
  /// Source-chain provider for a Wormhole chain id (to read LogMessagePublished + GSI).
  sourceProviderFor: (chainId: ChainId) => Provider;
  /// Wormhole Core bridge address for a Wormhole chain id.
  coreAddressFor: (chainId: ChainId) => string;
  /// Dev guardian private key (the single guardian in a local devnet).
  guardianKey: string;
  /// Override the guardian set index (otherwise read from Core).
  guardianSetIndexOverride?: number;
  retry?: Partial<RetryOptions>;
  sleep?: (ms: number) => Promise<void>;
}

/// Self-signs a VAA with a dev guardian key — for local/anvil tests and devnet only. It
/// reconstructs the body from the source LogMessagePublished log (found via the source tx)
/// and signs the double-keccak digest, mirroring devnet/tools/relayer.ts.
export class DevGuardianVaaFetcher implements VaaFetcher {
  private readonly signingKey: SigningKey;
  private readonly retry: RetryOptions;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(private readonly opts: DevGuardianVaaFetcherOptions) {
    this.signingKey = new SigningKey(opts.guardianKey);
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.sleep = opts.sleep;
  }

  async fetchVaa(id: VaaId): Promise<Uint8Array | null> {
    if (!id.sourceTxHash) {
      throw new Error(
        "DevGuardianVaaFetcher requires VaaId.sourceTxHash to locate the published message"
      );
    }
    const provider = this.opts.sourceProviderFor(id.emitterChain);
    const coreAddress = this.opts.coreAddressFor(id.emitterChain).toLowerCase();

    const receipt = await withRetry(
      () => provider.getTransactionReceipt(id.sourceTxHash as string),
      this.retry,
      this.sleep
    );
    if (receipt === null) return null;

    const emitterEvm = getAddress(
      "0x" + id.emitterAddress.slice(-40)
    ).toLowerCase();

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== coreAddress) continue;
      if (log.topics[0] !== LOG_MESSAGE_PUBLISHED_TOPIC) continue;
      const parsed = coreInterface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!parsed) continue;
      if ((parsed.args["sequence"] as bigint) !== id.sequence) continue;
      if ((parsed.args["sender"] as string).toLowerCase() !== emitterEvm) {
        continue;
      }

      const gsi =
        this.opts.guardianSetIndexOverride ??
        Number(
          (await withRetry(
            () =>
              new Contract(
                this.opts.coreAddressFor(id.emitterChain),
                CORE_ABI,
                provider
              )["getCurrentGuardianSetIndex"]!() as Promise<bigint>,
            this.retry,
            this.sleep
          )) as bigint
        );

      const { vaa } = packSignedVaa(
        {
          timestamp: 0,
          nonce: Number(parsed.args["nonce"] as bigint),
          emitterChainId: id.emitterChain,
          emitterAddress: id.emitterAddress,
          sequence: id.sequence,
          consistencyLevel: Number(parsed.args["consistencyLevel"] as bigint),
          payload: parsed.args["payload"] as string,
        },
        gsi,
        (digest) => this.sign(digest)
      );
      return getBytes(vaa);
    }
    // Message not found in this tx yet (shouldn't happen post-confirmation) → poll later.
    return null;
  }

  private sign(digest: string): GuardianSignature {
    const sig = this.signingKey.sign(digest);
    return { r: sig.r, s: sig.s, v: sig.yParity };
  }
}

import {
  Contract,
  JsonRpcProvider,
  Network,
  type SigningKey,
  Wallet,
  getAddress,
} from "ethers";

import type { ChainConfig, PricingMode } from "./config.js";
import { DEFAULT_RETRY, type RetryOptions, withRetry } from "./retry.js";

/// Mirrors PenguinBridgeExecutionQuoter.PricingData. All fields are uint64.
export interface PricingData {
  dstPrice: bigint;
  dstGasPrice: bigint;
  priceBuffer: bigint;
  baseFee: bigint;
}

export interface ChainPriceUpdate {
  chainId: number;
  pricing: PricingData;
}

/// Writes prices to the on-chain quoter. Implemented by RpcOracleWriter; stubbed in
/// runner tests.
export interface OracleWriter {
  /// Verify the signer is the contract's registered oracleService.
  assertAuthorized(oracleAddress: string): Promise<void>;
  /// Read the contract's active pricing mode (the SMC-1681 `pricingMode()` getter,
  /// 0 = twap, 1 = penguinswap). Returns undefined when the deployed contract predates
  /// the getter, so callers fall back to the configured mode. Throws on transient RPC
  /// failure (after retry) so a tick is skipped rather than priced under a guessed mode.
  pricingMode(): Promise<PricingMode | undefined>;
  /// Push the source price and per-chain pricing in one batchPriceUpdate tx. Returns
  /// the transaction hash. NOT internally retried — a transient send failure skips the
  /// tick and the next interval overwrites prices anyway, so we never risk a double
  /// submission.
  pushPrices(sourcePrice: bigint, updates: ChainPriceUpdate[]): Promise<string>;
  dispose?(): void;
}

/// Reads current gas price from destination chains.
export interface GasPriceReader {
  gasPrice(chainId: number): Promise<bigint>;
  dispose?(): void;
}

/// Minimal ABI — only what the oracle calls. Full interface in
/// IPenguinBridgeExecutionQuoter.sol / PenguinBridgeExecutionQuoter.sol.
export const QUOTER_WRITE_ABI = [
  "function oracleService() view returns (address)",
  "function pricingMode() view returns (uint8)",
  "function batchPriceUpdate(uint64 newSourcePrice, uint16[] chainIds, tuple(uint64 dstPrice, uint64 dstGasPrice, uint64 priceBuffer, uint64 baseFee)[] prices)",
];

export class OracleNotAuthorizedError extends Error {
  constructor(
    public readonly oracleAddress: string,
    public readonly registered: string,
    public readonly contractAddress: string
  ) {
    super(
      `signer ${oracleAddress} is not PenguinBridgeExecutionQuoter(${contractAddress})` +
        `.oracleService (registered: ${registered}) — call setOracleService() or rotate the key`
    );
    this.name = "OracleNotAuthorizedError";
  }
}

export interface RpcOracleWriterOptions {
  rpcUrl: string;
  contractAddress: string;
  signingKey: SigningKey;
  retry?: Partial<RetryOptions>;
  /// Receipt-wait ceiling for pushPrices, in ms. Defaults to 120s.
  txWaitTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /// Treat the network as static (skip chainId auto-detection) — for tests against
  /// mock RPC servers.
  staticNetwork?: boolean;
}

export class RpcOracleWriter implements OracleWriter {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly contract: Contract;
  private readonly retry: RetryOptions;
  private readonly txWaitTimeoutMs: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: RpcOracleWriterOptions) {
    this.provider = opts.staticNetwork
      ? new JsonRpcProvider(opts.rpcUrl, Network.from(31337), {
          staticNetwork: true,
        })
      : new JsonRpcProvider(opts.rpcUrl);
    this.wallet = new Wallet(opts.signingKey, this.provider);
    this.contract = new Contract(
      getAddress(opts.contractAddress),
      QUOTER_WRITE_ABI,
      this.wallet
    );
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.txWaitTimeoutMs = opts.txWaitTimeoutMs ?? 120_000;
    this.sleep = opts.sleep;
  }

  dispose(): void {
    this.provider.destroy();
  }

  async assertAuthorized(oracleAddress: string): Promise<void> {
    const addr = getAddress(oracleAddress);
    const registered = (await withRetry(
      () => this.contract["oracleService"]!() as Promise<string>,
      this.retry,
      this.sleep
    )) as string;
    if (getAddress(registered) !== addr) {
      throw new OracleNotAuthorizedError(
        addr,
        getAddress(registered),
        getAddress(this.contract.target as string)
      );
    }
  }

  async pricingMode(): Promise<PricingMode | undefined> {
    let raw: bigint;
    try {
      raw = (await withRetry(
        () => this.contract["pricingMode"]!() as Promise<bigint>,
        this.retry,
        this.sleep
      )) as bigint;
    } catch (err) {
      // Only a revert (CALL_EXCEPTION) or undecodable empty return (BAD_DATA) means
      // the deployed contract predates the SMC-1681 getter — fall back to the
      // configured mode. Anything else (transient or unknown) propagates so the tick
      // is skipped rather than priced under a guessed mode.
      const code = (err as { code?: unknown }).code;
      if (code === "CALL_EXCEPTION" || code === "BAD_DATA") {
        return undefined;
      }
      throw err;
    }
    if (raw === 0n) return "twap";
    if (raw === 1n) return "penguinswap";
    throw new Error(`contract returned unknown pricingMode ${raw}`);
  }

  async pushPrices(
    sourcePrice: bigint,
    updates: ChainPriceUpdate[]
  ): Promise<string> {
    const chainIds = updates.map((u) => u.chainId);
    const prices = updates.map((u) => u.pricing);
    // Nonce from "latest", not the default "pending": if a previous tick's tx is
    // stuck in the mempool, this tick reuses its nonce and replaces it (at current
    // gas) instead of queueing behind it forever. A replacement rejected as
    // underpriced just fails this tick; later ticks keep trying as gas moves.
    const nonce = await this.wallet.getNonce("latest");
    const tx = (await this.contract["batchPriceUpdate"]!(
      sourcePrice,
      chainIds,
      prices,
      { nonce }
    )) as {
      hash: string;
      wait: (confirms?: number, timeout?: number) => Promise<unknown>;
    };
    // Bounded wait: a stuck transaction (underpriced, source chain stalled) rejects
    // with code TIMEOUT instead of hanging the push loop forever; the tick is logged
    // as skipped and the next interval replaces it.
    await tx.wait(1, this.txWaitTimeoutMs);
    return tx.hash;
  }
}

/// Reads gas price from each configured destination chain over its own provider,
/// created lazily and cached by chainId.
export class RpcGasPriceReader implements GasPriceReader {
  private readonly rpcByChain = new Map<number, string>();
  private readonly providers = new Map<number, JsonRpcProvider>();
  private readonly retry: RetryOptions;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(
    chains: ChainConfig[],
    opts: {
      retry?: Partial<RetryOptions>;
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ) {
    for (const c of chains) {
      this.rpcByChain.set(c.chainId, c.rpcUrl);
    }
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.sleep = opts.sleep;
  }

  private providerFor(chainId: number): JsonRpcProvider {
    let p = this.providers.get(chainId);
    if (!p) {
      const url = this.rpcByChain.get(chainId);
      if (!url) throw new Error(`no RPC configured for chainId ${chainId}`);
      p = new JsonRpcProvider(url);
      this.providers.set(chainId, p);
    }
    return p;
  }

  async gasPrice(chainId: number): Promise<bigint> {
    const provider = this.providerFor(chainId);
    return withRetry(
      async () => {
        const fee = await provider.getFeeData();
        if (fee.gasPrice == null) {
          throw new Error(`no gasPrice returned for chainId ${chainId}`);
        }
        return fee.gasPrice;
      },
      this.retry,
      this.sleep
    );
  }

  dispose(): void {
    for (const p of this.providers.values()) p.destroy();
  }
}

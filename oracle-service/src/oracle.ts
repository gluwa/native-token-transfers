import {
  Contract,
  JsonRpcProvider,
  Network,
  type SigningKey,
  Wallet,
  ZeroAddress,
  getAddress,
} from "ethers";

import type { ChainConfig, PricingMode } from "./config.js";
import { DEFAULT_RETRY, type RetryOptions, withRetry } from "./retry.js";

/// Mirrors USCRelayingQuoter's IUSCRelayingQuoter.PricingData — field order matters for
/// ABI encoding. `baseFee` is in CTC wei; `dstPrice`/`srcPrice` are USD ×1e10;
/// `priceBuffer` is a uint16 in parts per 100,000 (BPS_DENOMINATOR = 100_000).
export interface PricingData {
  baseFee: bigint;
  dstGasPrice: bigint;
  dstPrice: bigint;
  srcPrice: bigint;
  priceBuffer: bigint;
}

export interface ChainPriceUpdate {
  chainId: number;
  pricing: PricingData;
}

/// Writes prices to the on-chain quoter. Implemented by RpcOracleWriter; stubbed in
/// runner tests.
export interface OracleWriter {
  /// Verify the signer is the quoter's registered oracleService.
  assertAuthorized(oracleAddress: string): Promise<void>;
  /// Verify the quoter's TWAPReader is configured (non-zero) and the signer is ITS
  /// registered oracleService — the TWAPReader gates update() behind its own oracle
  /// address, set independently of the quoter's.
  assertTwapReaderAuthorized(oracleAddress: string): Promise<void>;
  /// Read the quoter's current pricing mode via the `pricingMode()` getter
  /// (0 = twap, 1 = penguinswap). Throws if the read fails — a transient RPC error
  /// (after retry), or a contract that doesn't expose the getter at all (which means it
  /// isn't the required quoter). Callers surface the error: skip the tick at runtime,
  /// abort at startup.
  pricingMode(): Promise<PricingMode>;
  /// True when PenguinSwap has a configured ATTEST→CTC path. An empty path makes the
  /// quoter fall back to TWAPReader even while pricingMode() is PENGUIN_SWAP.
  hasAttestCtcPool(): Promise<boolean>;
  /// Push the CTC/USD anchor and per-chain pricing in one batchPriceUpdate tx. Returns
  /// the transaction hash. NOT internally retried — a transient send failure skips the
  /// tick and the next interval overwrites prices anyway, so we never risk a double
  /// submission.
  pushPrices(sourcePrice: bigint, updates: ChainPriceUpdate[]): Promise<string>;
  /// Push a spot ctcPerAttest observation (CTC wei per ATTEST wei, 1e18 fixed point)
  /// into the quoter's TWAPReader. TWAP mode only; the reader address is re-read from
  /// the quoter each call so an owner-side setTWAPReader() rotation takes effect
  /// without a restart.
  pushTwapSample(ctcPerAttest: bigint): Promise<string>;
  dispose?(): void;
}

/// Reads current gas price from destination chains.
export interface GasPriceReader {
  gasPrice(chainId: number): Promise<bigint>;
  dispose?(): void;
}

/// Minimal ABI — only what the oracle calls. Full interface in the usc-write-ability
/// repo: contracts/abstract/IUSCRelayingQuoter.sol / contracts/USCRelayingQuoter.sol.
export const QUOTER_WRITE_ABI = [
  "function oracleService() view returns (address)",
  "function pricingMode() view returns (uint8)",
  "function attestCtcPath(uint256) view returns (address)",
  "function twapReader() view returns (address)",
  "function batchPriceUpdate(uint64 newSourcePrice, uint16[] chainIds, tuple(uint256 baseFee, uint256 dstGasPrice, uint256 dstPrice, uint256 srcPrice, uint16 priceBuffer)[] prices)",
];

/// Minimal ABI of the quoter's TWAPReader (contracts/TWAPReader.sol).
export const TWAP_READER_ABI = [
  "function oracleService() view returns (address)",
  "function update(uint256 spotPrice)",
];

export class OracleNotAuthorizedError extends Error {
  constructor(
    public readonly oracleAddress: string,
    public readonly registered: string,
    public readonly contractAddress: string,
    contractName = "USCRelayingQuoter"
  ) {
    super(
      `signer ${oracleAddress} is not ${contractName}(${contractAddress})` +
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
  /// Receipt-wait ceiling for sends, in ms. Defaults to 120s.
  txWaitTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /// Treat the network as static (skip chainId auto-detection) — for tests against
  /// mock RPC servers.
  staticNetwork?: boolean;
}

/// Fee fields of a sent tx, kept until it's confirmed mined so a later send that
/// reuses its nonce can bump the replacement above it.
interface SentTxFees {
  nonce: number;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
  gasLimit: bigint;
}

/// Nodes only accept a same-nonce replacement priced ≥~10% above the original (geth's
/// default). 12.5% adds margin without materially overpaying.
const bumpFee = (v: bigint): bigint => (v * 1125n) / 1000n + 1n;

const maxBigint = (a: bigint, b: bigint): bigint => (a > b ? a : b);

export class RpcOracleWriter implements OracleWriter {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly contract: Contract;
  private readonly retry: RetryOptions;
  private readonly txWaitTimeoutMs: number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  /// The last send not yet confirmed mined; cleared once its receipt lands. At most
  /// one tx is in flight at a time (every send waits for its receipt), so a single
  /// slot suffices — if a tick's tx is still pending when the next send computes the
  /// same "latest" nonce, that send replaces it (bumped) regardless of which method
  /// the stuck tx was calling.
  private lastSent: SentTxFees | undefined;
  /// Highest nonce we've confirmed mined. Guards against a stale
  /// eth_getTransactionCount("latest") — a just-mined tx not yet reflected by the
  /// node (or a lagging node behind a load balancer) — which would make back-to-back
  /// sends within a tick reuse a consumed nonce.
  private lastMinedNonce: number | undefined;
  /// TWAPReader contract cached by address (the quoter owner can rotate it).
  private twapReaderCache: Contract | undefined;

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

  async assertTwapReaderAuthorized(oracleAddress: string): Promise<void> {
    const addr = getAddress(oracleAddress);
    const reader = await this.twapReader();
    const registered = (await withRetry(
      () => reader["oracleService"]!() as Promise<string>,
      this.retry,
      this.sleep
    )) as string;
    if (getAddress(registered) !== addr) {
      throw new OracleNotAuthorizedError(
        addr,
        getAddress(registered),
        getAddress(reader.target as string),
        "TWAPReader"
      );
    }
  }

  async pricingMode(): Promise<PricingMode> {
    let raw: bigint;
    try {
      raw = (await withRetry(
        () => this.contract["pricingMode"]!() as Promise<bigint>,
        this.retry,
        this.sleep
      )) as bigint;
    } catch (err) {
      // A revert (CALL_EXCEPTION) or undecodable empty return (BAD_DATA) means the
      // contract doesn't expose pricingMode() — i.e. it isn't the required quoter.
      // Surface that clearly; other errors (transient, already retried) propagate as-is.
      const code = (err as { code?: unknown }).code;
      if (code === "CALL_EXCEPTION" || code === "BAD_DATA") {
        throw new Error(
          `USCRelayingQuoter(${String(this.contract.target)}).pricingMode() is not callable — ` +
            `the deployed contract must expose the pricing-mode getter`
        );
      }
      throw err;
    }
    if (raw === 0n) return "twap";
    if (raw === 1n) return "penguinswap";
    throw new Error(`contract returned unknown pricingMode ${raw}`);
  }

  async hasAttestCtcPool(): Promise<boolean> {
    try {
      const firstPool = (await withRetry(
        () => this.contract["attestCtcPath"]!(0) as Promise<string>,
        this.retry,
        this.sleep
      )) as string;
      return getAddress(firstPool) !== ZeroAddress;
    } catch (err) {
      // Solidity's generated getter reverts when index 0 is out of bounds, which is
      // exactly how the current quoter exposes an empty dynamic pool path.
      if ((err as { code?: unknown }).code === "CALL_EXCEPTION") return false;
      throw err;
    }
  }

  async pushPrices(
    sourcePrice: bigint,
    updates: ChainPriceUpdate[]
  ): Promise<string> {
    const chainIds = updates.map((u) => u.chainId);
    const prices = updates.map((u) => u.pricing);
    return this.send(this.contract, "batchPriceUpdate", [
      sourcePrice,
      chainIds,
      prices,
    ]);
  }

  async pushTwapSample(ctcPerAttest: bigint): Promise<string> {
    const reader = await this.twapReader();
    return this.send(reader, "update", [ctcPerAttest]);
  }

  /// Resolve the quoter's current TWAPReader as a writable contract, re-reading the
  /// address each call (retried) and re-using the cached instance while it's unchanged.
  private async twapReader(): Promise<Contract> {
    const addrRaw = (await withRetry(
      () => this.contract["twapReader"]!() as Promise<string>,
      this.retry,
      this.sleep
    )) as string;
    const addr = getAddress(addrRaw);
    if (addr === ZeroAddress) {
      throw new Error(
        `USCRelayingQuoter(${String(this.contract.target)}).twapReader() is unset — ` +
          `TWAP mode needs a TWAPReader (owner must call setTWAPReader())`
      );
    }
    if (
      !this.twapReaderCache ||
      getAddress(this.twapReaderCache.target as string) !== addr
    ) {
      this.twapReaderCache = new Contract(addr, TWAP_READER_ABI, this.wallet);
    }
    return this.twapReaderCache;
  }

  /// Send `contract.method(args)`, replacing our own stuck tx when one occupies the
  /// next nonce, and waiting (bounded) for the receipt.
  private async send(
    contract: Contract,
    method: string,
    args: unknown[]
  ): Promise<string> {
    // Nonce from "latest", not the default "pending": if a previous send's tx is
    // stuck in the mempool, this send reuses its nonce and replaces it instead of
    // queueing behind it forever. Floored at one past our last confirmed-mined nonce
    // so a node that hasn't caught up can't hand back a consumed one.
    // Use a raw RPC call instead of Signer.getNonce(). JsonRpcProvider caches some
    // reads briefly; immediately after another process (or an operator command) uses
    // this oracle key, that cache can return the already-consumed nonce even after the
    // external transaction's receipt has landed.
    const rawNonce = (await this.provider.send("eth_getTransactionCount", [
      this.wallet.address,
      "latest",
    ])) as string;
    let nonce = Number(BigInt(rawNonce));
    if (!Number.isSafeInteger(nonce)) {
      throw new RangeError(
        `account nonce ${rawNonce} exceeds JavaScript safe integer range`
      );
    }
    const rawPendingNonce = (await this.provider.send(
      "eth_getTransactionCount",
      [this.wallet.address, "pending"]
    )) as string;
    const pendingNonce = Number(BigInt(rawPendingNonce));
    if (!Number.isSafeInteger(pendingNonce)) {
      throw new RangeError(
        `pending account nonce ${rawPendingNonce} exceeds JavaScript safe integer range`
      );
    }
    // A fresh serverless instance cannot know the fees of an already-pending tx. Do
    // not reuse its nonce blindly: that may produce an underpriced replacement or
    // replace an operator transaction. Wait for the unknown tx to mine or drop.
    if (!this.lastSent && pendingNonce > nonce) {
      throw new Error(
        `oracle account has ${pendingNonce - nonce} unknown pending transaction(s); ` +
          `waiting rather than replacing a transaction whose fees are unavailable after restart`
      );
    }
    if (this.lastMinedNonce !== undefined && nonce <= this.lastMinedNonce) {
      nonce = this.lastMinedNonce + 1;
    }
    const overrides: {
      nonce: number;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
      gasLimit?: bigint;
    } = { nonce };
    const last = this.lastSent;
    if (last && last.nonce === nonce) {
      // Replacing our own stuck tx. If market gas hasn't moved, resending at current
      // fees would be rejected as underpriced every tick — bump ≥12.5% over the stuck
      // tx's fees, taking current market fees instead when those are already higher.
      const fee = await this.provider.getFeeData();
      if (last.maxFeePerGas != null) {
        overrides.maxPriorityFeePerGas = maxBigint(
          fee.maxPriorityFeePerGas ?? 0n,
          bumpFee(last.maxPriorityFeePerGas ?? 0n)
        );
        overrides.maxFeePerGas = maxBigint(
          maxBigint(fee.maxFeePerGas ?? 0n, bumpFee(last.maxFeePerGas)),
          overrides.maxPriorityFeePerGas
        );
      } else if (last.gasPrice != null) {
        overrides.gasPrice = maxBigint(
          fee.gasPrice ?? 0n,
          bumpFee(last.gasPrice)
        );
      }
      // Gas limit must be estimated against "latest" explicitly: the node's default
      // estimate runs on PENDING state, where the stuck tx has already executed, so
      // the storage it writes is counted warm/nonzero. The replacement executes
      // INSTEAD of the stuck tx (cold zero slots) — an estimate off pending state
      // undershoots and the replacement mines as an OutOfGas revert.
      const est = (await this.provider.send("eth_estimateGas", [
        {
          from: this.wallet.address,
          to: contract.target,
          data: contract.interface.encodeFunctionData(method, args),
        },
        "latest",
      ])) as string;
      overrides.gasLimit = maxBigint(BigInt(est), last.gasLimit);
    }
    const tx = (await contract[method]!(...args, overrides)) as {
      hash: string;
      maxFeePerGas: bigint | null;
      maxPriorityFeePerGas: bigint | null;
      gasPrice: bigint | null;
      gasLimit: bigint;
      wait: (confirms?: number, timeout?: number) => Promise<unknown>;
    };
    this.lastSent = {
      nonce,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gasPrice: tx.gasPrice,
      gasLimit: tx.gasLimit,
    };
    // Bounded wait: a stuck transaction (underpriced, source chain stalled) rejects
    // with code TIMEOUT instead of hanging the push loop forever; the tick is logged
    // as skipped and the next send replaces it (bumped, above).
    await tx.wait(1, this.txWaitTimeoutMs);
    this.lastSent = undefined; // mined — nothing pending to replace
    this.lastMinedNonce = nonce;
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

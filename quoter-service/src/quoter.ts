import {
  Contract,
  JsonRpcProvider,
  Network,
  ZeroAddress,
  getAddress,
  isHexString,
  zeroPadValue,
} from "ethers";

import { DEFAULT_RETRY, type RetryOptions, withRetry } from "./retry.js";

/// Minimal ABI for the on-chain price source. The full interface lives in
/// IPenguinBridgeExecutionQuoter.sol; we only need the two functions actually called
/// off-chain.
export const QUOTER_ABI = [
  "function requestQuote(uint16 dstChain, bytes32 dstAddr, address refundAddr, bytes requestBytes, bytes relayInstructions) view returns (uint256)",
  "function isAuthorizedQuoter(address quoter) view returns (bool)",
];

export interface QuoteRequest {
  dstChain: number;
  /// bytes32 universal address of the destination NTT Manager. Accepts a 20-byte EVM
  /// address as a convenience; it is left-padded to 32 bytes.
  dstAddr: string;
  /// Optional EVM address; accepted for WormholeSDK ABI compatibility but unused on-chain.
  refundAddr?: string;
  /// Value to forward on the destination chain, in destination native wei.
  msgValue: bigint;
  /// Gas limit for the destination-side execution.
  gasLimit: bigint;
}

export interface OnChainQuoter {
  fetchRequiredPayment(req: QuoteRequest): Promise<bigint>;
  assertAuthorized(quoterAddress: string): Promise<void>;
  /// Releases any provider-level resources (open sockets, retry timers).
  /// Optional because in-process tests may swap in stubs that don't need teardown.
  dispose?(): void;
}

export interface RpcOnChainQuoterOptions {
  rpcUrl: string;
  contractAddress: string;
  retry?: Partial<RetryOptions>;
  /// Test seam — replace setTimeout-based sleep so retry tests don't actually wait.
  sleep?: (ms: number) => Promise<void>;
  /// If true, treat the network as static (no auto-detection retries). Useful in tests
  /// against mock RPC servers that don't implement eth_chainId or get torn down mid-test.
  staticNetwork?: boolean;
}

function normalizeDstAddr(raw: string): string {
  if (isHexString(raw, 32)) return raw.toLowerCase();
  if (isHexString(raw, 20)) return zeroPadValue(raw, 32).toLowerCase();
  throw new TypeError(`dstAddr must be 20- or 32-byte hex string, got ${raw}`);
}

function encodeUint256(value: bigint): string {
  if (value < 0n) {
    throw new RangeError(`expected non-negative uint256, got ${value}`);
  }
  // The on-chain contract decodes requestBytes / relayInstructions as a single uint256
  // each via assembly calldataload, so abi.encode(uint256) is exactly 32 bytes.
  const hex = value.toString(16).padStart(64, "0");
  return `0x${hex}`;
}

export class QuoterNotAuthorizedError extends Error {
  constructor(public readonly quoterAddress: string, public readonly contractAddress: string) {
    super(
      `quoter ${quoterAddress} is not in PenguinBridgeExecutionQuoter(${contractAddress})` +
        `.authorizedQuoters — register it via addQuoter() or rotate the signing key`,
    );
    this.name = "QuoterNotAuthorizedError";
  }
}

export class RpcOnChainQuoter implements OnChainQuoter {
  private readonly provider: JsonRpcProvider;
  private readonly contract: Contract;
  private readonly retry: RetryOptions;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: RpcOnChainQuoterOptions) {
    this.provider = opts.staticNetwork
      ? new JsonRpcProvider(opts.rpcUrl, Network.from(31337), { staticNetwork: true })
      : new JsonRpcProvider(opts.rpcUrl);
    this.contract = new Contract(getAddress(opts.contractAddress), QUOTER_ABI, this.provider);
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.sleep = opts.sleep;
  }

  dispose(): void {
    this.provider.destroy();
  }

  async fetchRequiredPayment(req: QuoteRequest): Promise<bigint> {
    const dstAddr = normalizeDstAddr(req.dstAddr);
    const refundAddr = req.refundAddr ? getAddress(req.refundAddr) : ZeroAddress;
    const requestBytes = encodeUint256(req.msgValue);
    const relayInstructions = encodeUint256(req.gasLimit);
    return withRetry(
      () =>
        this.contract.requestQuote(
          req.dstChain,
          dstAddr,
          refundAddr,
          requestBytes,
          relayInstructions,
        ) as Promise<bigint>,
      this.retry,
      this.sleep,
    );
  }

  /// Verify the configured quoter address is registered on-chain. Called once at startup
  /// so the service refuses to start (rather than silently issuing quotes that the
  /// SpecialRelayer will reject) when the key isn't authorized.
  async assertAuthorized(quoterAddress: string): Promise<void> {
    const addr = getAddress(quoterAddress);
    const ok = (await withRetry(
      () => this.contract.isAuthorizedQuoter(addr) as Promise<boolean>,
      this.retry,
      this.sleep,
    )) as boolean;
    if (!ok) {
      const contractAddress = (await this.contract.getAddress()) as string;
      throw new QuoterNotAuthorizedError(addr, contractAddress);
    }
  }
}

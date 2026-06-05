import type { Signer } from "ethers";

import type { ChainId, Hex } from "../types.js";

/// Identifies a Wormhole message for VAA lookup. emitterAddress is the bytes32 universal
/// address of the SOURCE WormholeTransceiver that called publishMessage.
export interface VaaId {
  emitterChain: ChainId;
  emitterAddress: Hex;
  sequence: bigint;
  /// Source tx hash — used by the dev-guardian fetcher to find the LogMessagePublished
  /// log; ignored by the Wormholescan fetcher.
  sourceTxHash?: Hex;
}

/// JSON-safe relay payload persisted in transactions.payload (JSONB) and carried on the
/// queue. bigints are decimal strings so they survive JSON round-trips.
export interface RelayPayload {
  emitterChain: ChainId;
  emitterAddress: Hex;
  sequence: string;
  sourceTxHash: Hex;
  dstChain: ChainId;
  /// bytes32 universal address of the destination WormholeTransceiver (the event dstAddr).
  dstAddr: Hex;
  /// uint256 gas limit committed in the signed quote (decimal string).
  gasLimit: string;
  /// The Wormhole message payload (== ExecutionRequested.requestBytes).
  requestBytes: Hex;
}

/// An ExecutionRequested event after correlation: everything needed to fetch the VAA and
/// deliver, with no further source-chain reads required.
export interface DecodedEvent {
  sourceChainId: ChainId;
  destinationChainId: ChainId;
  relayerAddress: string;
  eventTxHash: Hex;
  blockNumber: number;
  logIndex: number;
  payload: RelayPayload;
}

/// Implemented by the relay core (RpcEventSource); consumed by the listener role. Decodes
/// + correlates ExecutionRequested logs for a block window on one chain.
export interface EventSource {
  scan(opts: {
    chainId: ChainId;
    relayerAddress: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<DecodedEvent[]>;
  /// Finalized head for the chain (already net of confirmations).
  latestBlock(chainId: ChainId): Promise<bigint>;
  dispose?(): void;
}

export interface PrepareRequest {
  destinationChainId: ChainId;
  payload: RelayPayload;
  /// 0 on the first attempt; >0 on retries (raises the gas-limit and fee bump).
  retryAttempt: number;
}

/// Everything prepare() resolves before a wallet is leased — so the wallet lock + DB
/// transaction are held only for the broadcast, not the (possibly slow) VAA fetch + reads.
export interface PreparedDelivery {
  /// Destination WormholeTransceiver address.
  to: string;
  /// Encoded receiveMessage(vaa) calldata.
  callData: Hex;
  /// Double-keccak VAA body hash (the isVAAConsumed key).
  vaaHash: Hex;
  /// Gas limit = max(signed quote + buffer, eth_estimateGas + buffer) (+ retry bump).
  gasLimit: bigint;
  /// EIP-1559 or legacy fee fields, bumped per attempt.
  feeOverrides: Record<string, bigint>;
}

export type PrepareResult =
  | { kind: "ready"; prepared: PreparedDelivery }
  | { kind: "already-consumed" };

export interface BroadcastRequest {
  prepared: PreparedDelivery;
  /// Wallet leased from the pool, connected to the destination provider.
  signer: Signer;
  /// Reserved nonce (fresh send) or the prior nonce (replacement-by-fee resubmit).
  nonce: number;
}

/// Implemented by the relay core (RpcDeliveryModule); consumed by the worker role.
/// prepare() does the wallet-free work (VAA fetch, validation, isVAAConsumed, gas
/// estimation, fee) so the wallet lock is held only for broadcast().
export interface DestinationDeliveryModule {
  prepare(req: PrepareRequest): Promise<PrepareResult>;
  broadcast(req: BroadcastRequest): Promise<Hex>;
  dispose?(): void;
}

/// Used by the cron role to reconcile submitted txs.
export interface ReceiptProvider {
  getReceipt(
    chainId: ChainId,
    txHash: Hex
  ): Promise<{ status: 0 | 1; blockNumber: number } | null>;
  dispose?(): void;
}

/// ── Classified delivery failures ─────────────────────────────────────────────────────
/// The worker maps these to queue/DB actions:
///   DeferDeliveryError     → nack with backoff, do NOT spend the retry budget (the VAA
///                            isn't observable yet, or gas is above the ceiling). Job age
///                            vs. vaaTimeoutMs eventually escalates to a dead-letter.
///   RetriableDeliveryError → markFailed (retry_count++) then requeue with a gas bump, or
///                            dead-letter once the budget is exhausted (e.g. low gas limit).
///   PermanentDeliveryError → dead-letter immediately; retrying cannot help (misconfigured
///                            peer, malformed VAA, non-EVM destination).
export class DeferDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferDeliveryError";
  }
}
export class RetriableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetriableDeliveryError";
  }
}
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}

/// Reconstruct a typed VaaId from a persisted RelayPayload.
export function vaaIdFromPayload(payload: RelayPayload): VaaId {
  return {
    emitterChain: payload.emitterChain,
    emitterAddress: payload.emitterAddress,
    sequence: BigInt(payload.sequence),
    sourceTxHash: payload.sourceTxHash,
  };
}

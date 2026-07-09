import { AbiCoder, type Provider, getAddress } from "ethers";

import { LOG_MESSAGE_PUBLISHED_TOPIC, coreInterface } from "../abi.js";
import { type RetryOptions, withRetry } from "../retry.js";
import type { ChainId, Hex } from "../types.js";
import type { DecodedEvent, RelayPayload } from "./interfaces.js";
import { toUniversalAddress } from "./vaa.js";

/// A decoded ExecutionRequested log, before correlation with the Core message.
export interface ParsedExecutionRequested {
  sourceChainId: ChainId;
  relayerAddress: string;
  dstChain: ChainId;
  dstAddr: Hex;
  requestBytes: Hex;
  relayInstructions: Hex;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
}

/// Permanent: the source tx has no Core message matching this event. Should never happen
/// with the current contracts (requestBytes is byte-for-byte the published payload); if it
/// does, the event/contract invariant has changed and the event can't be relayed as-is.
export class CorrelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrelationError";
  }
}

/// Transient: the source receipt isn't visible on this RPC yet. Tagged SERVER_ERROR so
/// withRetry treats it as retryable. Resolves on a later scan tick.
export class ReceiptNotReadyError extends Error {
  readonly code = "SERVER_ERROR";
  constructor(txHash: string) {
    super(`transaction receipt not available yet for ${txHash}`);
    this.name = "ReceiptNotReadyError";
  }
}

const abi = AbiCoder.defaultAbiCoder();

/// Correlate an ExecutionRequested event with the Wormhole Core LogMessagePublished from
/// the SAME source transaction, by matching requestBytes against the published payload.
/// Returns a fully-decoded event carrying the VaaId inputs and gas limit — no further
/// source reads are needed downstream.
export async function correlate(opts: {
  event: ParsedExecutionRequested;
  sourceProvider: Provider;
  coreAddress: string;
  /// When set, only LogMessagePublished entries whose sender is this address (the source
  /// chain's WormholeTransceiver) are considered. publishMessage is permissionless, so a
  /// payload-only match could attribute an attacker's same-payload message (emitted in the
  /// same tx) and carry the wrong emitter/sequence into the VAA fetch.
  expectedEmitter?: string;
  retry: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DecodedEvent> {
  const { event, sourceProvider, coreAddress, expectedEmitter, retry, sleep } =
    opts;

  const receipt = await withRetry(
    () => sourceProvider.getTransactionReceipt(event.txHash),
    retry,
    sleep
  );
  if (receipt === null) {
    throw new ReceiptNotReadyError(event.txHash);
  }

  const wantPayload = event.requestBytes.toLowerCase();
  const core = coreAddress.toLowerCase();
  const wantSender = expectedEmitter?.toLowerCase();

  let match: { sender: string; sequence: bigint; payload: Hex } | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== core) continue;
    if (log.topics[0] !== LOG_MESSAGE_PUBLISHED_TOPIC) continue;
    const parsed = coreInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed) continue;
    const payload = (parsed.args["payload"] as string).toLowerCase();
    if (payload !== wantPayload) continue;
    const sender = parsed.args["sender"] as string;
    if (wantSender && sender.toLowerCase() !== wantSender) continue;
    // First match wins. A single tx publishing two messages with identical payloads but
    // different sequences from the SAME emitter is not expressible by the SpecialRelayer
    // flow (one event ↔ one published message), so this is unambiguous in practice.
    match = {
      sender,
      sequence: parsed.args["sequence"] as bigint,
      payload: parsed.args["payload"] as string,
    };
    break;
  }

  if (!match) {
    throw new CorrelationError(
      `no LogMessagePublished in tx ${event.txHash} matches requestBytes ` +
        `(core=${coreAddress}` +
        (wantSender ? `, expected emitter=${expectedEmitter}` : "") +
        `); contract invariant requestBytes==payload may have changed`
    );
  }

  let gasLimit: bigint;
  try {
    gasLimit = abi.decode(["uint256"], event.relayInstructions)[0] as bigint;
  } catch {
    throw new CorrelationError(
      `relayInstructions is not abi.encode(uint256) in tx ${event.txHash}`
    );
  }

  const payload: RelayPayload = {
    emitterChain: event.sourceChainId,
    emitterAddress: toUniversalAddress(getAddress(match.sender)),
    sequence: match.sequence.toString(),
    sourceTxHash: event.txHash,
    dstChain: event.dstChain,
    dstAddr: event.dstAddr,
    gasLimit: gasLimit.toString(),
    requestBytes: event.requestBytes,
  };

  return {
    sourceChainId: event.sourceChainId,
    destinationChainId: event.dstChain,
    relayerAddress: event.relayerAddress,
    eventTxHash: event.txHash,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    payload,
  };
}

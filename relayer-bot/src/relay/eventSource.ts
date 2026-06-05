import { type Provider } from "ethers";

import { EXECUTION_REQUESTED_TOPIC, specialRelayerInterface } from "../abi.js";
import type { ChainRegistry } from "../chains.js";
import { type Logger, createLogger } from "../logger.js";
import { type RetryOptions, withRetry } from "../retry.js";
import type { ChainId } from "../types.js";
import {
  CorrelationError,
  type ParsedExecutionRequested,
  correlate,
} from "./correlator.js";
import type { DecodedEvent, EventSource } from "./interfaces.js";

export interface RpcEventSourceOptions {
  registry: ChainRegistry;
  providers: Map<ChainId, Provider>;
  retry: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/// EventSource backed by JSON-RPC getLogs. Scans a block window for ExecutionRequested,
/// then correlates each with the source LogMessagePublished to produce a fully-decoded
/// event. Production listeners use this (range-scan + persisted cursor) rather than
/// websocket subscriptions, which drop silently and don't survive restarts.
export class RpcEventSource implements EventSource {
  private readonly registry: ChainRegistry;
  private readonly providers: Map<ChainId, Provider>;
  private readonly retry: RetryOptions;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly logger: Logger;

  constructor(opts: RpcEventSourceOptions) {
    this.registry = opts.registry;
    this.providers = opts.providers;
    this.retry = opts.retry;
    this.sleep = opts.sleep;
    this.logger = opts.logger ?? createLogger({ module: "eventSource" });
  }

  private providerFor(chainId: ChainId): Provider {
    const p = this.providers.get(chainId);
    if (!p) throw new Error(`no provider for chain id ${chainId}`);
    return p;
  }

  async latestBlock(chainId: ChainId): Promise<bigint> {
    const chain = this.registry.require(chainId);
    const head = await withRetry(
      () => this.providerFor(chainId).getBlockNumber(),
      this.retry,
      this.sleep
    );
    const finalized = head - chain.confirmations;
    return finalized > 0 ? BigInt(finalized) : 0n;
  }

  async scan(opts: {
    chainId: ChainId;
    relayerAddress: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<DecodedEvent[]> {
    const { chainId, relayerAddress, fromBlock, toBlock } = opts;
    if (fromBlock > toBlock) return [];

    const chain = this.registry.require(chainId);
    if (!chain.coreBridgeAddress) {
      throw new Error(
        `chain ${chainId} has no coreBridgeAddress; cannot correlate VAAs`
      );
    }
    const provider = this.providerFor(chainId);

    const logs = await withRetry(
      () =>
        provider.getLogs({
          address: relayerAddress,
          topics: [EXECUTION_REQUESTED_TOPIC],
          fromBlock: Number(fromBlock),
          toBlock: Number(toBlock),
        }),
      this.retry,
      this.sleep
    );

    const out: DecodedEvent[] = [];
    for (const log of logs) {
      const decoded = specialRelayerInterface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!decoded) continue;
      const parsed: ParsedExecutionRequested = {
        sourceChainId: chainId,
        relayerAddress,
        dstChain: Number(decoded.args["dstChain"] as bigint),
        dstAddr: decoded.args["dstAddr"] as string,
        requestBytes: decoded.args["requestBytes"] as string,
        relayInstructions: decoded.args["relayInstructions"] as string,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
      };
      try {
        out.push(
          await correlate({
            event: parsed,
            sourceProvider: provider,
            coreAddress: chain.coreBridgeAddress,
            retry: this.retry,
            sleep: this.sleep,
          })
        );
      } catch (err) {
        if (err instanceof CorrelationError) {
          // Permanent: don't wedge the whole chain's listener on one anomalous event.
          // Skip it (the on-chain VAA still exists for manual recovery) and alert loudly.
          this.logger.error("eventSource.correlation_failed", {
            chain_id: chainId,
            event_tx_hash: parsed.txHash,
            error: err.message,
          });
          continue;
        }
        // Transient (e.g. receipt not yet visible): fail the tick so it retries without
        // advancing the cursor.
        throw err;
      }
    }
    out.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber - b.blockNumber
    );
    return out;
  }

  dispose(): void {
    for (const p of this.providers.values()) {
      (p as { destroy?: () => void }).destroy?.();
    }
  }
}

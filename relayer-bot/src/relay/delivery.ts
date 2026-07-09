import { type Provider, getAddress, hexlify } from "ethers";

import {
  decodeTransceiverError,
  wormholeTransceiverInterface,
} from "../abi.js";
import type { ChainRegistry } from "../chains.js";
import type { DeliveryConfig } from "../config.js";
import { type RetryOptions, isTransientRpcError, withRetry } from "../retry.js";
import type { ChainId, Hex } from "../types.js";
import {
  type BroadcastRequest,
  DeferDeliveryError,
  type DestinationDeliveryModule,
  PermanentDeliveryError,
  type PrepareRequest,
  type PrepareResult,
  RetriableDeliveryError,
  vaaIdFromPayload,
} from "./interfaces.js";
import { parseSignedVaa } from "./vaa.js";
import type { VaaFetcher } from "./vaaFetcher.js";

export interface RpcDeliveryModuleOptions {
  registry: ChainRegistry;
  providers: Map<ChainId, Provider>;
  vaaFetcher: VaaFetcher;
  delivery: DeliveryConfig;
  retry: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

const iface = wormholeTransceiverInterface;

/// Pull the raw revert bytes out of an ethers v6 CALL_EXCEPTION.
function extractRevertData(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e["data"] === "string") return e["data"];
  const info = e["info"] as { error?: { data?: unknown } } | undefined;
  if (info?.error && typeof info.error.data === "string")
    return info.error.data;
  const inner = e["error"] as { data?: unknown } | undefined;
  if (inner && typeof inner.data === "string") return inner.data;
  return undefined;
}

function bump(value: bigint, bumpBps: number, attempt: number): bigint {
  if (attempt <= 0 || bumpBps === 0) return value;
  return (value * BigInt(10000 + bumpBps * attempt)) / 10000n;
}

/// Delivers a Wormhole NTT message to its destination via
/// WormholeTransceiver.receiveMessage(vaa), split into two phases so the wallet lock is
/// held only for the broadcast:
///   prepare()   — wallet-free: fetch VAA, validate, isVAAConsumed pre-flight, estimate
///                 gas, compute fees. Classifies reverts.
///   broadcast() — inside the wallet lock: just send the tx with the leased signer + nonce.
/// Neither waits for confirmations — the cron confirms/fails via the on-chain receipt.
export class RpcDeliveryModule implements DestinationDeliveryModule {
  private readonly registry: ChainRegistry;
  private readonly providers: Map<ChainId, Provider>;
  private readonly vaaFetcher: VaaFetcher;
  private readonly delivery: DeliveryConfig;
  private readonly retry: RetryOptions;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: RpcDeliveryModuleOptions) {
    this.registry = opts.registry;
    this.providers = opts.providers;
    this.vaaFetcher = opts.vaaFetcher;
    this.delivery = opts.delivery;
    this.retry = opts.retry;
    this.sleep = opts.sleep;
  }

  private providerFor(chainId: ChainId): Provider {
    const p = this.providers.get(chainId);
    if (!p) {
      throw new PermanentDeliveryError(`no provider for chain ${chainId}`);
    }
    return p;
  }

  async prepare(req: PrepareRequest): Promise<PrepareResult> {
    const { payload, retryAttempt } = req;
    const provider = this.providerFor(req.destinationChainId);

    // 1. Resolve the VAA. null = not observable yet → defer (don't spend retry budget).
    const vaaId = vaaIdFromPayload(payload);
    const vaaBytes = await this.vaaFetcher.fetchVaa(vaaId);
    if (vaaBytes === null) {
      throw new DeferDeliveryError(
        `VAA not yet available for ${payload.emitterChain}/${payload.sequence}`
      );
    }

    // 2. Parse + sanity-check against what the source event told us.
    const parsed = parseSignedVaa(vaaBytes);
    if (parsed.sequence !== vaaId.sequence) {
      throw new PermanentDeliveryError(
        `fetched VAA sequence ${parsed.sequence} != expected ${vaaId.sequence}`
      );
    }
    if (parsed.payload.toLowerCase() !== payload.requestBytes.toLowerCase()) {
      throw new PermanentDeliveryError(
        "fetched VAA payload does not match the event requestBytes"
      );
    }
    const vaaHash = parsed.hash;
    const vaaHex = hexlify(vaaBytes);

    // 3. Resolve the destination transceiver from the event's dstAddr.
    const upper12 = payload.dstAddr.slice(2, 26);
    if (!/^0+$/.test(upper12)) {
      throw new PermanentDeliveryError(
        `dstAddr ${payload.dstAddr} is not a 20-byte EVM address (non-zero upper bytes)`
      );
    }
    let to: string;
    try {
      to = getAddress("0x" + payload.dstAddr.slice(-40));
    } catch {
      throw new PermanentDeliveryError(
        `dstAddr ${payload.dstAddr} is not a valid address`
      );
    }
    const chain = this.registry.require(req.destinationChainId);
    if (chain.expectedTransceiver && chain.expectedTransceiver !== to) {
      throw new PermanentDeliveryError(
        `dstAddr ${to} != configured expectedTransceiver ${chain.expectedTransceiver} ` +
          `on chain ${req.destinationChainId}`
      );
    }

    // 4. Idempotency pre-flight on the double-keccak body hash.
    if (await this.isVAAConsumed(provider, to, vaaHash)) {
      return { kind: "already-consumed" };
    }

    // 5. estimateGas doubles as the pre-broadcast revert check (reverts identically to a
    //    staticCall) and gives the real gas requirement.
    const callData = iface.encodeFunctionData("receiveMessage", [vaaHex]);
    let estimate: bigint;
    try {
      estimate = await withRetry(
        () => provider.estimateGas({ to, data: callData }),
        this.retry,
        this.sleep
      );
    } catch (err) {
      const outcome = this.classifyRevert(err);
      if (outcome === "consumed") return { kind: "already-consumed" };
      throw outcome;
    }

    // 6. Gas limit = max(signed quote + buffer (+retry), estimate + buffer).
    const baseGas = BigInt(payload.gasLimit);
    const bufferBps = BigInt(this.delivery.gasLimitBufferBps);
    let quotedGas = baseGas + (baseGas * bufferBps) / 10000n;
    if (retryAttempt > 0) {
      quotedGas +=
        (baseGas * BigInt(this.delivery.retryAdditionalGasPct)) / 100n;
    }
    const estWithBuffer = estimate + (estimate * bufferBps) / 10000n;
    const gasLimit = quotedGas > estWithBuffer ? quotedGas : estWithBuffer;

    const feeOverrides = await this.computeFeeOverrides(provider, retryAttempt);

    return {
      kind: "ready",
      prepared: { to, callData, vaaHash, gasLimit, feeOverrides },
    };
  }

  async broadcast(req: BroadcastRequest): Promise<Hex> {
    const { prepared, signer, nonce } = req;
    try {
      const tx = await signer.sendTransaction({
        to: prepared.to,
        data: prepared.callData,
        nonce,
        gasLimit: prepared.gasLimit,
        ...prepared.feeOverrides,
      });
      return tx.hash;
    } catch (err) {
      if (isTransientRpcError(err)) {
        throw new DeferDeliveryError(
          `transient RPC error broadcasting delivery: ${String(err)}`
        );
      }
      const msg = String(
        err instanceof Error ? err.message : err
      ).toLowerCase();
      // The prior tx at this nonce already landed (replacement target mined, or a dup).
      // Defer: the cron reconciles via that tx's receipt, and the next prepare's
      // isVAAConsumed check resolves it to confirmed.
      if (msg.includes("nonce too low") || msg.includes("already known")) {
        throw new DeferDeliveryError(`nonce already used: ${msg}`);
      }
      // Replacement fee wasn't a high enough bump — retry with a larger attempt.
      if (msg.includes("replacement") && msg.includes("underpriced")) {
        throw new RetriableDeliveryError("replacement transaction underpriced");
      }
      const outcome = this.classifyRevert(err);
      if (outcome === "consumed") {
        // Consumed between prepare and broadcast — defer; next prepare confirms it.
        throw new DeferDeliveryError("VAA consumed during broadcast");
      }
      throw outcome;
    }
  }

  private async isVAAConsumed(
    provider: Provider,
    to: string,
    vaaHash: Hex
  ): Promise<boolean> {
    const data = iface.encodeFunctionData("isVAAConsumed", [vaaHash]);
    const raw = await withRetry(
      () => provider.call({ to, data }),
      this.retry,
      this.sleep
    );
    return iface.decodeFunctionResult("isVAAConsumed", raw)[0] as boolean;
  }

  private async computeFeeOverrides(
    provider: Provider,
    attempt: number
  ): Promise<Record<string, bigint>> {
    const fee = await withRetry(
      () => provider.getFeeData(),
      this.retry,
      this.sleep
    );
    const { maxGasPriceWei, gasPriceBumpBps } = this.delivery;

    if (fee.maxFeePerGas != null) {
      const maxFeePerGas = bump(fee.maxFeePerGas, gasPriceBumpBps, attempt);
      const maxPriorityFeePerGas = bump(
        fee.maxPriorityFeePerGas ?? 0n,
        gasPriceBumpBps,
        attempt
      );
      if (maxGasPriceWei > 0n && maxFeePerGas > maxGasPriceWei) {
        throw new DeferDeliveryError(
          `maxFeePerGas ${maxFeePerGas} above ceiling ${maxGasPriceWei}`
        );
      }
      return { maxFeePerGas, maxPriorityFeePerGas };
    }
    if (fee.gasPrice != null) {
      const gasPrice = bump(fee.gasPrice, gasPriceBumpBps, attempt);
      if (maxGasPriceWei > 0n && gasPrice > maxGasPriceWei) {
        throw new DeferDeliveryError(
          `gasPrice ${gasPrice} above ceiling ${maxGasPriceWei}`
        );
      }
      return { gasPrice };
    }
    // Neither EIP-1559 nor legacy gas data came back. Don't broadcast a tx with no fee
    // fields (the node would reject it, or it could be mined at an unintended price);
    // treat it as a transient RPC problem and let the retry budget handle it.
    throw new RetriableDeliveryError(
      "fee data unavailable: provider returned neither maxFeePerGas nor gasPrice"
    );
  }

  /// Maps a revert to the sentinel "consumed" (idempotent success) or a classified error.
  /// This runs pre-broadcast (estimateGas / eth_call), where there is no receipt to read
  /// gasUsed from, so we can't attribute a default revert to gas — we treat an undecodable
  /// revert as Retriable and let the on-chain receipt (cron) make the gas-vs-deterministic
  /// call once the tx has actually mined.
  private classifyRevert(
    err: unknown
  ):
    | "consumed"
    | DeferDeliveryError
    | RetriableDeliveryError
    | PermanentDeliveryError {
    const name = decodeTransceiverError(extractRevertData(err));
    switch (name) {
      case "TransferAlreadyCompleted":
        return "consumed";
      case "InvalidWormholePeer":
      case "PeerNotRegistered":
      case "UnexpectedAdditionalMessages":
        return new PermanentDeliveryError(
          `destination rejected delivery: ${name}`
        );
      case "InvalidVaa":
        return new DeferDeliveryError("destination reports InvalidVaa");
      default:
        return new RetriableDeliveryError(
          `delivery reverted with an unrecognized error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
    }
  }

  dispose(): void {}
}

import type { Provider } from "ethers";

import { type RetryOptions, withRetry } from "../retry.js";
import type { ChainId, Hex } from "../types.js";
import type { ReceiptInfo, ReceiptProvider } from "./interfaces.js";

export interface RpcReceiptProviderOptions {
  providers: Map<ChainId, Provider>;
  retry: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

/// ReceiptProvider backed by JSON-RPC. Returns null when the tx isn't mined yet so the
/// cron can distinguish "still pending" from "reverted".
export class RpcReceiptProvider implements ReceiptProvider {
  constructor(private readonly opts: RpcReceiptProviderOptions) {}

  async getReceipt(chainId: ChainId, txHash: Hex): Promise<ReceiptInfo | null> {
    const provider = this.opts.providers.get(chainId);
    if (!provider) throw new Error(`no provider for chain ${chainId}`);
    const receipt = await withRetry(
      () => provider.getTransactionReceipt(txHash),
      this.opts.retry,
      this.opts.sleep
    );
    if (receipt === null) return null;
    const status = receipt.status === 1 ? 1 : 0;
    // Only a revert needs the gas-limit comparison; fetch the tx (one extra call) just then,
    // so the common confirmed/pending path stays a single RPC round-trip.
    let gasLimit: bigint | undefined;
    if (status === 0) {
      const tx = await withRetry(
        () => provider.getTransaction(txHash),
        this.opts.retry,
        this.opts.sleep
      );
      gasLimit = tx?.gasLimit;
    }
    return {
      status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      gasLimit,
    };
  }

  async isTxKnown(chainId: ChainId, txHash: Hex): Promise<boolean> {
    const provider = this.opts.providers.get(chainId);
    if (!provider) throw new Error(`no provider for chain ${chainId}`);
    // getTransaction returns the tx whether it's mined or still pending in the mempool, and
    // null once the node has no record of it (never accepted, or evicted) — i.e. dropped.
    const tx = await withRetry(
      () => provider.getTransaction(txHash),
      this.opts.retry,
      this.opts.sleep
    );
    return tx !== null;
  }
}

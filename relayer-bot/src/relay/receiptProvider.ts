import type { Provider } from "ethers";

import { type RetryOptions, withRetry } from "../retry.js";
import type { ChainId, Hex } from "../types.js";
import type { ReceiptProvider } from "./interfaces.js";

export interface RpcReceiptProviderOptions {
  providers: Map<ChainId, Provider>;
  retry: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

/// ReceiptProvider backed by JSON-RPC. Returns null when the tx isn't mined yet so the
/// cron can distinguish "still pending" from "reverted".
export class RpcReceiptProvider implements ReceiptProvider {
  constructor(private readonly opts: RpcReceiptProviderOptions) {}

  async getReceipt(
    chainId: ChainId,
    txHash: Hex
  ): Promise<{ status: 0 | 1; blockNumber: number } | null> {
    const provider = this.opts.providers.get(chainId);
    if (!provider) throw new Error(`no provider for chain ${chainId}`);
    const receipt = await withRetry(
      () => provider.getTransactionReceipt(txHash),
      this.opts.retry,
      this.opts.sleep
    );
    if (receipt === null) return null;
    return {
      status: receipt.status === 1 ? 1 : 0,
      blockNumber: receipt.blockNumber,
    };
  }
}

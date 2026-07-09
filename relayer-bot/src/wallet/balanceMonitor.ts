import { type Provider, formatEther } from "ethers";

import type { Alerter } from "../alerts/alerter.js";
import type { Logger } from "../logger.js";
import type { ChainId } from "../types.js";

export interface BalanceMonitorOptions {
  addresses: string[];
  providers: Map<ChainId, Provider>;
  minBalanceWei: bigint;
  alerter: Alerter;
  logger: Logger;
}

/// Checks each relayer wallet's native-token balance on each chain and alerts when one
/// falls below the configured threshold. Alert-only — low balance does not block sends.
/// Style-referenced from gluwa/Contract-Utilities' wallet-balance-monitor (not a dep).
export async function checkBalances(
  opts: BalanceMonitorOptions
): Promise<void> {
  for (const [chainId, provider] of opts.providers) {
    for (const address of opts.addresses) {
      let balance: bigint;
      try {
        balance = await provider.getBalance(address);
      } catch (err) {
        opts.logger.warn("wallet.balance_check_failed", {
          wallet_used: address,
          chain_id: chainId,
          error: String(err),
        });
        continue;
      }
      if (balance < opts.minBalanceWei) {
        opts.logger.warn("wallet.low_balance", {
          wallet_used: address,
          chain_id: chainId,
          balance_eth: formatEther(balance),
          min_eth: formatEther(opts.minBalanceWei),
        });
        await opts.alerter.alert("wallet.low_balance", {
          wallet: address,
          chain_id: chainId,
          balance_eth: formatEther(balance),
          min_eth: formatEther(opts.minBalanceWei),
        });
      }
    }
  }
}

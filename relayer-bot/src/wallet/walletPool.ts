import { type Provider, type Signer, Wallet } from "ethers";

import { advisoryKey, tryAcquireWalletLock } from "../db/advisoryLock.js";
import type { Database, Tx } from "../db/pool.js";
import type { Logger } from "../logger.js";
import type { ChainId } from "../types.js";
import type { SecretStore } from "./secretStore.js";

/// A wallet leased for one delivery: the signer (connected to the destination provider) and
/// the nonce to use.
export interface Lease {
  address: string;
  nonce: number;
  signer: Signer;
}

/// Thrown when every wallet is currently locked by another in-flight reservation. The
/// worker catches this and backs off WITHOUT spending the message's retry budget.
export class AllWalletsBusyError extends Error {
  constructor() {
    super("all relayer wallets are currently leased");
    this.name = "AllWalletsBusyError";
  }
}

export class UnknownWalletError extends Error {
  constructor(address: string) {
    super(`wallet ${address} is not in the pool`);
    this.name = "UnknownWalletError";
  }
}

export interface WalletPool {
  /// Reserve a free wallet + nonce for `chainId` under the wallet lock, and durably record
  /// the reservation via `record` (which runs in the SAME transaction — typically a
  /// markSubmitting write) so the nonce is committed BEFORE the caller broadcasts. The lock
  /// is released on commit; broadcasting happens lock-free afterward. Throws
  /// AllWalletsBusyError if no wallet is free.
  reserve(
    chainId: ChainId,
    record: (tx: Tx, lease: { address: string; nonce: number }) => Promise<void>
  ): Promise<Lease>;
  /// Get a signer for a SPECIFIC wallet, without locking or reserving — for resubmitting a
  /// previously-reserved nonce (replacement / crash recovery). Throws UnknownWalletError if
  /// the wallet isn't in the pool.
  signerFor(address: string, chainId: ChainId): Signer;
  addresses(): string[];
}

export interface CreatePgLockWalletPoolOptions {
  db: Database;
  secretStore: SecretStore;
  walletNames: string[];
  providers: Map<ChainId, Provider>;
  logger: Logger;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

class PgLockWalletPool implements WalletPool {
  constructor(
    private readonly db: Database,
    private readonly wallets: Wallet[],
    private readonly providers: Map<ChainId, Provider>,
    private readonly logger: Logger
  ) {}

  addresses(): string[] {
    return this.wallets.map((w) => w.address);
  }

  private providerFor(chainId: ChainId): Provider {
    const p = this.providers.get(chainId);
    if (!p) throw new Error(`no provider for destination chain ${chainId}`);
    return p;
  }

  async reserve(
    chainId: ChainId,
    record: (tx: Tx, lease: { address: string; nonce: number }) => Promise<void>
  ): Promise<Lease> {
    const provider = this.providerFor(chainId);
    const candidates = shuffled(this.wallets);
    // Fetch chain nonces BEFORE opening the transaction: the reservation transaction pins
    // a pool connection (and the wallet advisory lock) for its whole duration, and an RPC
    // call inside it can hold both for the provider timeout. A slightly stale chain nonce
    // is safe — the committed rows (dbNext) are the authoritative ratchet; the chain nonce
    // is only a floor and the gap-fill probe.
    const chainNonces = new Map<string, number>();
    await Promise.all(
      candidates.map(async (w) => {
        chainNonces.set(
          w.address,
          await provider.getTransactionCount(w.address, "pending")
        );
      })
    );
    return this.db.transaction(async (tx) => {
      for (const wallet of candidates) {
        const key = advisoryKey(`${wallet.address}:${chainId}`);
        if (!(await tryAcquireWalletLock(tx, key))) continue;

        const nonce = await this.reserveNonce(
          tx,
          wallet.address,
          chainId,
          chainNonces.get(wallet.address) as number
        );
        // Commit the intent (markSubmitting) in the SAME transaction as the reservation.
        await record(tx, { address: wallet.address, nonce });
        this.logger.info("wallet.reserved", {
          wallet_used: wallet.address,
          chain_id: chainId,
          nonce,
        });
        return {
          address: wallet.address,
          nonce,
          signer: wallet.connect(provider),
        };
      }
      throw new AllWalletsBusyError();
    });
  }

  signerFor(address: string, chainId: ChainId): Signer {
    const provider = this.providerFor(chainId);
    const wallet = this.wallets.find(
      (w) => w.address.toLowerCase() === address.toLowerCase()
    );
    if (!wallet) throw new UnknownWalletError(address);
    return wallet.connect(provider);
  }

  /// Next nonce = max(highest nonce we've COMMITTED for this wallet+chain + 1, the chain's
  /// pending nonce). Counting `submitting` (not just submitted/confirmed) is what makes the
  /// intent log work: a reserved-but-not-yet-broadcast nonce is never handed out twice.
  ///
  /// Gap-fill: when the chain nonce is BELOW dbNext and no live row holds it, that nonce
  /// was reserved but never reached the chain (its row was terminalized — see the
  /// nonce-clearing in markConfirmed/markDeadLetter) while a higher nonce was already
  /// committed. Nothing else will ever send it, and every committed tx above it is
  /// unminable until it lands — so hand it to this delivery to plug the gap.
  private async reserveNonce(
    tx: Tx,
    address: string,
    chainId: ChainId,
    chainNonce: number
  ): Promise<number> {
    const res = await tx.query<{ max: string | null }>(
      `SELECT max(nonce_used)::text AS max FROM transactions
         WHERE wallet_used = $1 AND destination_chain_id = $2
           AND status IN ('submitting', 'submitted', 'confirmed')`,
      [address, chainId]
    );
    const dbMax = res.rows[0]?.max;
    const dbNext =
      dbMax === null || dbMax === undefined ? 0 : Number(dbMax) + 1;
    if (chainNonce < dbNext) {
      const live = await tx.query<{ n: string }>(
        `SELECT 1 AS n FROM transactions
           WHERE wallet_used = $1 AND destination_chain_id = $2 AND nonce_used = $3
             AND status IN ('submitting', 'submitted', 'confirmed')
           LIMIT 1`,
        [address, chainId, chainNonce]
      );
      if (live.rows.length === 0) {
        this.logger.warn("wallet.nonce_gap_fill", {
          wallet_used: address,
          chain_id: chainId,
          nonce: chainNonce,
          db_next: dbNext,
        });
        return chainNonce;
      }
    }
    return Math.max(dbNext, chainNonce);
  }
}

export async function createPgLockWalletPool(
  opts: CreatePgLockWalletPoolOptions
): Promise<WalletPool> {
  if (opts.walletNames.length === 0) {
    throw new Error("wallet pool requires at least one wallet secret name");
  }
  const wallets: Wallet[] = [];
  for (const name of opts.walletNames) {
    const key = await opts.secretStore.getSecret(name);
    wallets.push(new Wallet(key));
  }
  opts.logger.info("wallet.pool_initialized", { count: wallets.length });
  return new PgLockWalletPool(opts.db, wallets, opts.providers, opts.logger);
}

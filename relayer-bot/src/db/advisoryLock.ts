import { keccak256, toUtf8Bytes } from "ethers";
import type { Pool } from "pg";

import type { Tx } from "./pool.js";

/// Derive a stable signed 64-bit advisory-lock key from a name (e.g. a wallet address).
/// Postgres advisory lock keys are int8; we hash the name and fold it into that range.
export function advisoryKey(name: string): bigint {
  const hash = keccak256(toUtf8Bytes(name));
  // Take the top 8 bytes and interpret as a signed int64.
  return BigInt.asIntN(64, BigInt(hash.slice(0, 18)));
}

/// Try to acquire a transaction-scoped advisory lock. Released automatically when the
/// surrounding transaction commits or rolls back — no TTL, no leaked locks if the worker
/// crashes mid-send. Returns false if another transaction holds it.
export async function tryAcquireWalletLock(
  tx: Tx,
  key: bigint
): Promise<boolean> {
  const res = await tx.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1) AS ok",
    [key.toString()]
  );
  return res.rows[0]?.ok === true;
}

/// Run `fn` while holding a session-scoped advisory lock on a dedicated connection (the
/// cron leader lock / worker partition locks). If another instance holds it, `fn` is
/// skipped and `false` is returned. The lock spans `fn` (which may do RPC + pool queries).
///
/// Two failure modes are handled explicitly:
///  - The lock session can DIE while `fn` runs (pg restart, LB idle reaping) — Postgres
///    then frees the lock and another instance can acquire it while our `fn` is still
///    running. `fn` receives a `lockLost` probe so long-running holders (the partition
///    drain loop) can notice and stand down instead of running as a second owner.
///  - If the UNLOCK query fails, the session may still hold the lock; returning this
///    connection to the pool would leak the lock indefinitely (the key would be
///    unacquirable until the pooled backend happens to die). Destroy the connection
///    instead so Postgres frees the lock with it.
export async function withLeaderLock(
  pool: Pool,
  key: number | bigint,
  fn: (lockLost?: () => boolean) => Promise<void>
): Promise<boolean> {
  const keyParam = typeof key === "bigint" ? key.toString() : key;
  const client = await pool.connect();
  let lost = false;
  const onConnLost = (): void => {
    lost = true;
  };
  client.on("error", onConnLost);
  client.on("end", onConnLost);
  let destroyReason: Error | undefined;
  const toError = (err: unknown): Error =>
    err instanceof Error ? err : new Error(String(err));
  try {
    let acquired = false;
    try {
      const res = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [
        keyParam,
      ]);
      acquired = (res.rows[0] as { ok?: boolean } | undefined)?.ok === true;
    } catch (err) {
      // The lock query itself failed — connection state is unknown; don't recycle it.
      destroyReason = toError(err);
      throw err;
    }
    if (!acquired) {
      return false;
    }
    try {
      await fn(() => lost);
      return true;
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [keyParam]);
      } catch (err) {
        destroyReason = toError(err);
      }
    }
  } finally {
    client.removeListener("error", onConnLost);
    client.removeListener("end", onConnLost);
    client.release(destroyReason);
  }
}

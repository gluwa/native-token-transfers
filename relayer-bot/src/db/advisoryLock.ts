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
/// cron leader lock). If another instance holds it, `fn` is skipped and `false` is
/// returned. The lock spans `fn` (which may do RPC + pool queries) and is released after.
export async function withLeaderLock(
  pool: Pool,
  key: number | bigint,
  fn: () => Promise<void>
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [
      typeof key === "bigint" ? key.toString() : key,
    ]);
    if ((res.rows[0] as { ok?: boolean } | undefined)?.ok !== true) {
      return false;
    }
    try {
      await fn();
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [
        typeof key === "bigint" ? key.toString() : key,
      ]);
    }
  } finally {
    client.release();
  }
}

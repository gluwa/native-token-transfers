import type { ChainId } from "../types.js";
import type { Queryable } from "./pool.js";

export const BlockTrackerRepo = {
  /// Read the last scanned block for (chain, relayer), inserting a genesis row if none
  /// exists. Returns the current cursor.
  async readOrInit(
    db: Queryable,
    chainId: ChainId,
    relayerAddress: string,
    genesisBlock: bigint
  ): Promise<bigint> {
    await db.query(
      `INSERT INTO block_tracker (chain_id, relayer_address, last_scanned_block)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain_id, relayer_address) DO NOTHING`,
      [chainId, relayerAddress, genesisBlock.toString()]
    );
    const res = await db.query<{ last_scanned_block: string }>(
      `SELECT last_scanned_block FROM block_tracker
       WHERE chain_id = $1 AND relayer_address = $2`,
      [chainId, relayerAddress]
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error(
        `block_tracker row missing after upsert for ${chainId}/${relayerAddress}`
      );
    }
    return BigInt(row.last_scanned_block);
  },

  /// Advance the cursor monotonically (never moves backward). Returns true if advanced.
  async advance(
    db: Queryable,
    chainId: ChainId,
    relayerAddress: string,
    newBlock: bigint
  ): Promise<boolean> {
    const res = await db.query(
      `UPDATE block_tracker
         SET last_scanned_block = $3, updated_at = now()
       WHERE chain_id = $1 AND relayer_address = $2 AND last_scanned_block < $3`,
      [chainId, relayerAddress, newBlock.toString()]
    );
    return (res.rowCount ?? 0) > 0;
  },
};

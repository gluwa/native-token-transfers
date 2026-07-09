import { Pool } from "pg";

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
}

/// A handle inside a transaction. All queries run on the same dedicated connection, so
/// transaction-scoped advisory locks acquired here are released automatically on
/// commit/rollback.
export type Tx = Queryable;

export interface Database extends Queryable {
  /// Runs fn inside a transaction on a single dedicated connection. Commits on success,
  /// rolls back on throw.
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/// Wraps a pg.Pool (or a pg-compatible pool, e.g. pg-mem in tests) in the Database
/// interface. This is the swap seam: repos depend on Database, not on pg directly.
export function createPgDatabase(pool: Pool): Database {
  const run = async <R>(
    q: Pool["query"],
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>> => {
    const res = await q(sql, params as unknown[]);
    return { rows: res.rows as R[], rowCount: res.rowCount };
  };

  return {
    query: (sql, params) => run(pool.query.bind(pool), sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      const tx: Tx = {
        query: (sql, params) => run(client.query.bind(client), sql, params),
      };
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

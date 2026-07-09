import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Pool } from "pg";

/// Session-level advisory lock key so concurrent boots don't run migrations in parallel.
const MIGRATION_LOCK_KEY = 776_130_001;

/// Minimal forward-only migration runner. Applies *.sql files in `dir` in lexical order
/// that haven't been recorded in schema_migrations, each in its own transaction, under an
/// advisory lock. Returns the versions newly applied. No framework dependency — matches
/// the repo's lightweight style.
export async function runMigrations(
  pool: Pool,
  dir: string
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      const appliedRes = await client.query(
        "SELECT version FROM schema_migrations"
      );
      const applied = new Set(
        appliedRes.rows.map((r) => (r as { version: string }).version)
      );
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      const ran: string[] = [];
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(dir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (version) VALUES ($1)",
            [file]
          );
          await client.query("COMMIT");
          ran.push(file);
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(
            `migration ${file} failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      return ran;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

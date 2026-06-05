import { type Provider, Wallet } from "ethers";

import type { Database, Tx } from "../src/db/pool.js";
import { createLogger } from "../src/logger.js";
import type { ChainId } from "../src/types.js";
import { EnvSecretStore } from "../src/wallet/secretStore.js";
import {
  AllWalletsBusyError,
  UnknownWalletError,
  createPgLockWalletPool,
} from "../src/wallet/walletPool.js";

const KEY_A = "0x" + "11".repeat(32);
const KEY_B = "0x" + "22".repeat(32);
const ADDR_A = new Wallet(KEY_A).address;
const ADDR_B = new Wallet(KEY_B).address;
const logger = createLogger({}, { write: () => {} });

function env(): NodeJS.ProcessEnv {
  return { RELAYER_WALLET_w1: KEY_A, RELAYER_WALLET_w2: KEY_B };
}

interface FakeDbOpts {
  lockResults: boolean[]; // per advisory-lock attempt, in order
  dbMax?: string | null;
}
function fakeDb(opts: FakeDbOpts): Database {
  let lockIdx = 0;
  const tx: Tx = {
    query: async <R>(sql: string) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        const ok = opts.lockResults[lockIdx++] ?? false;
        return { rows: [{ ok } as unknown as R], rowCount: 1 };
      }
      if (sql.includes("max(nonce_used)")) {
        return {
          rows: [{ max: opts.dbMax ?? null } as unknown as R],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    query: tx.query,
    transaction: async (fn) => fn(tx),
    close: async () => {},
  };
}

function providers(chainNonce: number): Map<ChainId, Provider> {
  const provider = {
    getTransactionCount: async () => chainNonce,
  } as unknown as Provider;
  return new Map([[6, provider]]);
}

async function makePool(db: Database, provs: Map<ChainId, Provider>) {
  return createPgLockWalletPool({
    db,
    secretStore: new EnvSecretStore(env()),
    walletNames: ["w1", "w2"],
    providers: provs,
    logger,
  });
}

const noop = async () => {};

describe("PgLockWalletPool.reserve", () => {
  it("leases a wallet + nonce and runs the record callback in the same tx", async () => {
    const pool = await makePool(
      fakeDb({ lockResults: [true], dbMax: "2" }),
      providers(10)
    );
    let recorded: { address: string; nonce: number } | undefined;
    const lease = await pool.reserve(6, async (_tx, l) => {
      recorded = l;
    });
    // dbNext = 3, chainNonce = 10 → 10
    expect(lease.nonce).toBe(10);
    expect([ADDR_A, ADDR_B]).toContain(lease.address);
    expect(await lease.signer.getAddress()).toBe(lease.address);
    expect(recorded).toEqual({ address: lease.address, nonce: 10 });
  });

  it("uses dbMax+1 when ahead of the chain nonce", async () => {
    const pool = await makePool(
      fakeDb({ lockResults: [true], dbMax: "8" }),
      providers(3)
    );
    const lease = await pool.reserve(6, noop);
    expect(lease.nonce).toBe(9); // max(8+1, 3)
  });

  it("starts at the chain nonce when no DB history", async () => {
    const pool = await makePool(
      fakeDb({ lockResults: [true], dbMax: null }),
      providers(4)
    );
    const lease = await pool.reserve(6, noop);
    expect(lease.nonce).toBe(4); // max(0, 4)
  });

  it("throws AllWalletsBusyError when every wallet is locked", async () => {
    const pool = await makePool(
      fakeDb({ lockResults: [false, false] }),
      providers(1)
    );
    await expect(pool.reserve(6, noop)).rejects.toBeInstanceOf(
      AllWalletsBusyError
    );
  });

  it("throws when no provider exists for the destination chain", async () => {
    const pool = await makePool(fakeDb({ lockResults: [true] }), providers(1));
    await expect(pool.reserve(999, noop)).rejects.toThrow(/no provider/);
  });
});

describe("PgLockWalletPool.signerFor", () => {
  it("returns a signer for a known wallet (no lock, no reservation)", async () => {
    const pool = await makePool(fakeDb({ lockResults: [] }), providers(1));
    const signer = pool.signerFor(ADDR_A, 6);
    expect(await signer.getAddress()).toBe(ADDR_A);
  });

  it("throws UnknownWalletError for a wallet not in the pool", async () => {
    const pool = await makePool(fakeDb({ lockResults: [] }), providers(1));
    expect(() => pool.signerFor("0x" + "99".repeat(20), 6)).toThrow(
      UnknownWalletError
    );
  });

  it("throws when no provider exists for the chain", async () => {
    const pool = await makePool(fakeDb({ lockResults: [] }), providers(1));
    expect(() => pool.signerFor(ADDR_A, 999)).toThrow(/no provider/);
  });
});

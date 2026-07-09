import { getAddress, zeroPadValue } from "ethers";

import type { ChainConfig } from "../src/chains.js";
import { type RelayerBotConfig, loadConfig } from "../src/config.js";
import { type Database } from "../src/db/pool.js";
import { TransactionsRepo } from "../src/db/transactions.js";
import { createLogger } from "../src/logger.js";
import { NoopAlerter } from "../src/alerts/alerter.js";
import { InMemoryQueue } from "../src/queue/inMemory.js";
import type {
  BroadcastRequest,
  DecodedEvent,
  DestinationDeliveryModule,
  EventSource,
  PrepareRequest,
} from "../src/relay/interfaces.js";
import { scanChainOnce } from "../src/roles/listener.js";
import { handleDelivery } from "../src/roles/worker.js";
import {
  AllWalletsBusyError,
  type WalletPool,
} from "../src/wallet/walletPool.js";
import { setupPgMem } from "./helpers/pgmem.js";

// End-to-end composition of the listener → queue → worker pipeline against the real DB
// (pg-mem) and queue (in-memory) layers, with the on-chain boundaries faked. Proves the
// roles wire together through persistence + the message queue across a full relay
// lifecycle (event → pending → submitted). Cron reconciliation is covered in cron.test.ts;
// the on-chain VAA/delivery internals in delivery.test.ts / vaa.test.ts.

const RELAYER = getAddress("0x" + "33".repeat(20));
const CORE = getAddress("0x" + "11".repeat(20));
const WALLET = getAddress("0x" + "ab".repeat(20));
const logger = createLogger({}, { write: () => {} });

const PREPARED = {
  to: getAddress("0x" + "44".repeat(20)),
  callData: "0xabcdef",
  vaaHash: "0x" + "cd".repeat(32),
  gasLimit: 330_000n,
  feeOverrides: {},
};

const CHAIN: ChainConfig = {
  chainId: 2,
  name: "src",
  rpcUrl: "http://x",
  specialRelayerAddress: RELAYER,
  coreBridgeAddress: CORE,
  confirmations: 0,
  genesisBlock: 0n,
};

function config(): RelayerBotConfig {
  return loadConfig(
    {
      RELAYER_CHAINS: JSON.stringify([
        {
          chainId: 2,
          rpcUrl: "http://x",
          specialRelayerAddress: RELAYER,
          coreBridgeAddress: CORE,
        },
        { chainId: 6, rpcUrl: "http://y" },
      ]),
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
      WALLETS: "w1",
      RELAYER_USE_DEV_SECRETS: "true",
    },
    "worker"
  );
}

function event(txHash: string): DecodedEvent {
  return {
    sourceChainId: 2,
    destinationChainId: 6,
    relayerAddress: RELAYER,
    eventTxHash: txHash,
    blockNumber: 50,
    logIndex: 0,
    payload: {
      emitterChain: 2,
      emitterAddress: zeroPadValue("0x" + "22".repeat(20), 32),
      sequence: "42",
      sourceTxHash: txHash,
      dstChain: 6,
      dstAddr: zeroPadValue("0x" + "44".repeat(20), 32),
      gasLimit: "300000",
      requestBytes: "0x9945ff10",
    },
  };
}

function fakeEventSource(events: DecodedEvent[]): EventSource {
  return { latestBlock: async () => 100n, scan: async () => events };
}

function fakeWalletPool(db: Database): WalletPool {
  return {
    addresses: () => [WALLET],
    reserve: async (_c, record) =>
      db.transaction(async (tx) => {
        await record(tx, { address: WALLET, nonce: 1 });
        return { address: WALLET, nonce: 1, signer: {} as never };
      }),
    signerFor: () => ({}) as never,
  };
}

function fakeDelivery(opts: {
  onPrepare?: (req: PrepareRequest) => void;
  onBroadcast?: (req: BroadcastRequest) => void;
}): DestinationDeliveryModule {
  return {
    prepare: async (req) => {
      opts.onPrepare?.(req);
      return { kind: "ready", prepared: PREPARED };
    },
    broadcast: async (req) => {
      opts.onBroadcast?.(req);
      return "0x" + "de".repeat(32);
    },
  };
}

describe("relay pipeline (listener → queue → worker)", () => {
  it("carries a transfer from source event to a submitted destination delivery", async () => {
    const { db, close } = setupPgMem();
    const queue = new InMemoryQueue();
    const cfg = config();
    try {
      await scanChainOnce(
        {
          config: cfg,
          db,
          queue,
          eventSource: fakeEventSource([event("0xaa")]),
          logger,
          alerter: new NoopAlerter(),
        },
        CHAIN
      );
      expect(
        (await TransactionsRepo.findBySourceEvent(db, 2, "0xaa"))?.status
      ).toBe("pending");

      const prepares: PrepareRequest[] = [];
      const broadcasts: BroadcastRequest[] = [];
      const delivery = fakeDelivery({
        onPrepare: (r) => prepares.push(r),
        onBroadcast: (r) => broadcasts.push(r),
      });
      const [d] = await queue.consume(2, { max: 5, blockMs: 0 });
      await handleDelivery(
        {
          config: cfg,
          db,
          queue,
          walletPool: fakeWalletPool(db),
          delivery,
          logger,
          alerter: new NoopAlerter(),
        },
        d!
      );

      expect(prepares[0]!.destinationChainId).toBe(6);
      expect(prepares[0]!.payload.gasLimit).toBe("300000");
      expect(broadcasts[0]!.nonce).toBe(1);

      const after = await TransactionsRepo.findBySourceEvent(db, 2, "0xaa");
      expect(after?.status).toBe("submitted");
      expect(after?.relayTxHash).toBe("0x" + "de".repeat(32));
      expect(after?.walletUsed).toBe(WALLET);
      expect(queue.size()).toBe(0);
    } finally {
      await close();
    }
  });

  it("never double-delivers when the same event is processed twice", async () => {
    const { db, close } = setupPgMem();
    const queue = new InMemoryQueue();
    const cfg = config();
    try {
      let broadcasts = 0;
      const delivery = fakeDelivery({
        onBroadcast: () => void (broadcasts += 1),
      });
      const deps = {
        config: cfg,
        db,
        queue,
        walletPool: fakeWalletPool(db),
        delivery,
        logger,
        alerter: new NoopAlerter(),
      };

      await scanChainOnce(
        {
          config: cfg,
          db,
          queue,
          eventSource: fakeEventSource([event("0xbb")]),
          logger,
          alerter: new NoopAlerter(),
        },
        CHAIN
      );
      const [d1] = await queue.consume(2, { max: 5, blockMs: 0 });
      await handleDelivery(deps, d1!);

      await queue.publish({
        transaction_hash: "0xbb",
        chain_id: 2,
        relayer_address: RELAYER,
        transaction_data: event("0xbb").payload,
        retry_count: 0,
      });
      const [d2] = await queue.consume(2, { max: 5, blockMs: 0 });
      await handleDelivery(deps, d2!);

      expect(broadcasts).toBe(1); // idempotency guard skipped the second
    } finally {
      await close();
    }
  });

  it("AllWalletsBusyError is exported for the worker's back-off path", () => {
    expect(new AllWalletsBusyError()).toBeInstanceOf(Error);
  });
});

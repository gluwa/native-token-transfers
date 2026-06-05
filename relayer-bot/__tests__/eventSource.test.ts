import { AbiCoder, type Provider, getAddress, zeroPadValue } from "ethers";

import { coreInterface, specialRelayerInterface } from "../src/abi.js";
import { makeChainRegistry } from "../src/chains.js";
import { RpcEventSource } from "../src/relay/eventSource.js";
import type { ChainId } from "../src/types.js";

const RELAYER = getAddress("0x" + "33".repeat(20));
const CORE = getAddress("0x" + "11".repeat(20));
const SENDER = getAddress("0x" + "22".repeat(20));
const DST_ADDR = zeroPadValue("0x" + "44".repeat(20), 32);
const TX = "0x" + "ab".repeat(32);
const abi = AbiCoder.defaultAbiCoder();
const NO_RETRY = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };

const PAYLOAD = "0x9945ff10" + "ee".repeat(40);

function execLog(payload: string) {
  const { data, topics } = specialRelayerInterface.encodeEventLog(
    "ExecutionRequested",
    [6, DST_ADDR, payload, abi.encode(["uint256"], [300000n])]
  );
  return {
    address: RELAYER,
    topics: [...topics],
    data,
    transactionHash: TX,
    blockNumber: 96,
    index: 0,
  };
}

function coreReceipt(payload: string, sequence = 42n) {
  const { data, topics } = coreInterface.encodeEventLog("LogMessagePublished", [
    SENDER,
    sequence,
    9,
    payload,
    200,
  ]);
  return { logs: [{ address: CORE, topics: [...topics], data }] };
}

function fakeProvider(opts: {
  blockNumber?: number;
  logs?: unknown[];
  receipt?: unknown;
}): Provider {
  return {
    getBlockNumber: async () => opts.blockNumber ?? 100,
    getLogs: async () => opts.logs ?? [],
    getTransactionReceipt: async () =>
      opts.receipt === undefined ? null : opts.receipt,
  } as unknown as Provider;
}

function registry() {
  return makeChainRegistry([
    {
      chainId: 2,
      name: "ethereum",
      rpcUrl: "http://x",
      specialRelayerAddress: RELAYER,
      coreBridgeAddress: CORE,
      confirmations: 5,
      genesisBlock: 0n,
    },
  ]);
}

function makeSource(provider: Provider): RpcEventSource {
  const providers = new Map<ChainId, Provider>([[2, provider]]);
  return new RpcEventSource({
    registry: registry(),
    providers,
    retry: NO_RETRY,
  });
}

describe("RpcEventSource.latestBlock", () => {
  it("subtracts confirmations from the head", async () => {
    const src = makeSource(fakeProvider({ blockNumber: 100 }));
    expect(await src.latestBlock(2)).toBe(95n);
  });

  it("clamps to zero when head < confirmations", async () => {
    const src = makeSource(fakeProvider({ blockNumber: 3 }));
    expect(await src.latestBlock(2)).toBe(0n);
  });
});

describe("RpcEventSource.scan", () => {
  it("decodes and correlates an ExecutionRequested event", async () => {
    const src = makeSource(
      fakeProvider({ logs: [execLog(PAYLOAD)], receipt: coreReceipt(PAYLOAD) })
    );
    const events = await src.scan({
      chainId: 2,
      relayerAddress: RELAYER,
      fromBlock: 90n,
      toBlock: 96n,
    });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.sourceChainId).toBe(2);
    expect(e.destinationChainId).toBe(6);
    expect(e.eventTxHash).toBe(TX);
    expect(e.payload.sequence).toBe("42");
    expect(e.payload.gasLimit).toBe("300000");
    expect(e.payload.dstAddr).toBe(DST_ADDR);
    expect(e.payload.emitterAddress).toBe(zeroPadValue(SENDER, 32));
  });

  it("returns [] when fromBlock > toBlock", async () => {
    const src = makeSource(fakeProvider({}));
    expect(
      await src.scan({
        chainId: 2,
        relayerAddress: RELAYER,
        fromBlock: 100n,
        toBlock: 90n,
      })
    ).toEqual([]);
  });

  it("skips an event whose payload never matches (permanent correlation failure)", async () => {
    const src = makeSource(
      fakeProvider({
        logs: [execLog(PAYLOAD)],
        receipt: coreReceipt("0x9945ff10" + "00".repeat(40)), // different payload
      })
    );
    const events = await src.scan({
      chainId: 2,
      relayerAddress: RELAYER,
      fromBlock: 90n,
      toBlock: 96n,
    });
    expect(events).toEqual([]);
  });

  it("rethrows when the source receipt is not yet available (transient)", async () => {
    const src = makeSource(
      fakeProvider({ logs: [execLog(PAYLOAD)], receipt: undefined })
    );
    await expect(
      src.scan({
        chainId: 2,
        relayerAddress: RELAYER,
        fromBlock: 90n,
        toBlock: 96n,
      })
    ).rejects.toThrow(/receipt not available/);
  });
});

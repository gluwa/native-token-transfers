import { AbiCoder, type Provider, getAddress, zeroPadValue } from "ethers";

import { coreInterface } from "../src/abi.js";
import {
  CorrelationError,
  ReceiptNotReadyError,
  type ParsedExecutionRequested,
  correlate,
} from "../src/relay/correlator.js";

const CORE = getAddress("0x" + "11".repeat(20));
const SENDER = getAddress("0x" + "22".repeat(20)); // source transceiver
const NO_RETRY = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
const abi = AbiCoder.defaultAbiCoder();

interface FakeLog {
  address: string;
  topics: string[];
  data: string;
}

function coreLog(opts: {
  sender: string;
  sequence: bigint;
  nonce: number;
  payload: string;
  consistencyLevel: number;
  address?: string;
}): FakeLog {
  const { data, topics } = coreInterface.encodeEventLog("LogMessagePublished", [
    opts.sender,
    opts.sequence,
    opts.nonce,
    opts.payload,
    opts.consistencyLevel,
  ]);
  return { address: opts.address ?? CORE, topics: [...topics], data };
}

function providerWithLogs(logs: FakeLog[] | null): Provider {
  return {
    getTransactionReceipt: async () => (logs === null ? null : { logs }),
  } as unknown as Provider;
}

function baseEvent(payload: string): ParsedExecutionRequested {
  return {
    sourceChainId: 2,
    relayerAddress: getAddress("0x" + "33".repeat(20)),
    dstChain: 6,
    dstAddr: zeroPadValue("0x" + "44".repeat(20), 32),
    requestBytes: payload,
    relayInstructions: abi.encode(["uint256"], [300000n]),
    txHash: "0x" + "ab".repeat(32),
    blockNumber: 100,
    logIndex: 3,
  };
}

describe("correlate", () => {
  it("matches the Core log whose payload equals requestBytes", async () => {
    const payload = "0x9945ff10" + "ee".repeat(40);
    const provider = providerWithLogs([
      // a decoy with a different payload
      coreLog({
        sender: SENDER,
        sequence: 41n,
        nonce: 1,
        payload: "0x9945ff10" + "00".repeat(40),
        consistencyLevel: 1,
      }),
      // the real one
      coreLog({
        sender: SENDER,
        sequence: 42n,
        nonce: 9,
        payload,
        consistencyLevel: 200,
      }),
    ]);
    const decoded = await correlate({
      event: baseEvent(payload),
      sourceProvider: provider,
      coreAddress: CORE,
      retry: NO_RETRY,
    });
    expect(decoded.destinationChainId).toBe(6);
    expect(decoded.payload.emitterChain).toBe(2);
    expect(decoded.payload.emitterAddress).toBe(zeroPadValue(SENDER, 32));
    expect(decoded.payload.sequence).toBe("42");
    expect(decoded.payload.gasLimit).toBe("300000");
    expect(decoded.payload.requestBytes).toBe(payload);
    expect(decoded.payload.sourceTxHash).toBe(baseEvent(payload).txHash);
  });

  it("ignores LogMessagePublished from non-Core addresses", async () => {
    const payload = "0x9945ff10" + "cd".repeat(40);
    const provider = providerWithLogs([
      coreLog({
        sender: SENDER,
        sequence: 1n,
        nonce: 0,
        payload,
        consistencyLevel: 1,
        address: getAddress("0x" + "99".repeat(20)), // not the core bridge
      }),
    ]);
    await expect(
      correlate({
        event: baseEvent(payload),
        sourceProvider: provider,
        coreAddress: CORE,
        retry: NO_RETRY,
      })
    ).rejects.toBeInstanceOf(CorrelationError);
  });

  it("skips a same-payload log from the wrong sender when expectedEmitter is set", async () => {
    const payload = "0x9945ff10" + "aa".repeat(40);
    const attacker = getAddress("0x" + "66".repeat(20));
    const provider = providerWithLogs([
      // publishMessage is permissionless: an attacker emits an identical payload in the
      // same tx, with a different sequence, hoping to be attributed as the emitter.
      coreLog({
        sender: attacker,
        sequence: 7n,
        nonce: 0,
        payload,
        consistencyLevel: 1,
      }),
      coreLog({
        sender: SENDER,
        sequence: 8n,
        nonce: 1,
        payload,
        consistencyLevel: 1,
      }),
    ]);
    const decoded = await correlate({
      event: baseEvent(payload),
      sourceProvider: provider,
      coreAddress: CORE,
      expectedEmitter: SENDER,
      retry: NO_RETRY,
    });
    // The attacker's log (first in the receipt) must NOT win the first-match scan.
    expect(decoded.payload.emitterAddress).toBe(zeroPadValue(SENDER, 32));
    expect(decoded.payload.sequence).toBe("8");
  });

  it("fails correlation when only wrong-sender logs match and expectedEmitter is set", async () => {
    const payload = "0x9945ff10" + "bb".repeat(40);
    const provider = providerWithLogs([
      coreLog({
        sender: getAddress("0x" + "66".repeat(20)),
        sequence: 7n,
        nonce: 0,
        payload,
        consistencyLevel: 1,
      }),
    ]);
    await expect(
      correlate({
        event: baseEvent(payload),
        sourceProvider: provider,
        coreAddress: CORE,
        expectedEmitter: SENDER,
        retry: NO_RETRY,
      })
    ).rejects.toBeInstanceOf(CorrelationError);
  });

  it("throws CorrelationError when no payload matches", async () => {
    const provider = providerWithLogs([
      coreLog({
        sender: SENDER,
        sequence: 1n,
        nonce: 0,
        payload: "0x9945ff10" + "00".repeat(40),
        consistencyLevel: 1,
      }),
    ]);
    await expect(
      correlate({
        event: baseEvent("0x9945ff10" + "ff".repeat(40)),
        sourceProvider: provider,
        coreAddress: CORE,
        retry: NO_RETRY,
      })
    ).rejects.toBeInstanceOf(CorrelationError);
  });

  it("throws ReceiptNotReadyError when the receipt is not yet available", async () => {
    await expect(
      correlate({
        event: baseEvent("0x9945ff10"),
        sourceProvider: providerWithLogs(null),
        coreAddress: CORE,
        retry: NO_RETRY,
      })
    ).rejects.toBeInstanceOf(ReceiptNotReadyError);
  });

  it("throws CorrelationError when relayInstructions is not abi.encode(uint256)", async () => {
    const payload = "0x9945ff10" + "12".repeat(40);
    const event = { ...baseEvent(payload), relayInstructions: "0x1234" };
    const provider = providerWithLogs([
      coreLog({
        sender: SENDER,
        sequence: 5n,
        nonce: 0,
        payload,
        consistencyLevel: 1,
      }),
    ]);
    await expect(
      correlate({
        event,
        sourceProvider: provider,
        coreAddress: CORE,
        retry: NO_RETRY,
      })
    ).rejects.toBeInstanceOf(CorrelationError);
  });
});

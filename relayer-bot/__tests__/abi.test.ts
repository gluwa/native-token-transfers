import { id, zeroPadValue } from "ethers";

import {
  EXECUTION_REQUESTED_TOPIC,
  LOG_MESSAGE_PUBLISHED_TOPIC,
  decodeTransceiverError,
  specialRelayerInterface,
  transceiverErrorInterface,
} from "../src/abi.js";

describe("event topic hashes", () => {
  it("EXECUTION_REQUESTED_TOPIC matches the canonical signature hash", () => {
    expect(EXECUTION_REQUESTED_TOPIC).toBe(
      id("ExecutionRequested(uint16,bytes32,bytes,bytes)")
    );
  });

  it("LOG_MESSAGE_PUBLISHED_TOPIC matches the canonical signature hash", () => {
    expect(LOG_MESSAGE_PUBLISHED_TOPIC).toBe(
      id("LogMessagePublished(address,uint64,uint32,bytes,uint8)")
    );
  });
});

describe("ExecutionRequested decoding", () => {
  it("round-trips an encoded log", () => {
    const dstChain = 6;
    const dstAddr = zeroPadValue("0x" + "ab".repeat(20), 32);
    const requestBytes = "0x9945ff10" + "00".repeat(28);
    const relayInstructions = "0x" + (300000).toString(16).padStart(64, "0");

    const { data, topics } = specialRelayerInterface.encodeEventLog(
      "ExecutionRequested",
      [dstChain, dstAddr, requestBytes, relayInstructions]
    );
    const parsed = specialRelayerInterface.parseLog({ data, topics })!;
    expect(parsed.name).toBe("ExecutionRequested");
    expect(Number(parsed.args["dstChain"])).toBe(dstChain);
    expect((parsed.args["dstAddr"] as string).toLowerCase()).toBe(
      dstAddr.toLowerCase()
    );
    expect((parsed.args["requestBytes"] as string).toLowerCase()).toBe(
      requestBytes.toLowerCase()
    );
    expect(BigInt(parsed.args["relayInstructions"] as string)).toBeDefined();
  });
});

describe("decodeTransceiverError", () => {
  it("decodes a known custom error to its name", () => {
    const data = transceiverErrorInterface.encodeErrorResult(
      "TransferAlreadyCompleted",
      ["0x" + "cd".repeat(32)]
    );
    expect(decodeTransceiverError(data)).toBe("TransferAlreadyCompleted");

    const invalidVaa = transceiverErrorInterface.encodeErrorResult(
      "InvalidVaa",
      ["bad signature"]
    );
    expect(decodeTransceiverError(invalidVaa)).toBe("InvalidVaa");
  });

  it("returns null for non-error data", () => {
    expect(decodeTransceiverError("0x")).toBeNull();
    expect(decodeTransceiverError(undefined)).toBeNull();
    expect(decodeTransceiverError("0xdeadbeef")).toBeNull();
  });
});

import {
  type Provider,
  type Signer,
  SigningKey,
  type TransactionRequest,
  getAddress,
  getBytes,
  zeroPadValue,
} from "ethers";

import {
  transceiverErrorInterface,
  wormholeTransceiverInterface,
} from "../src/abi.js";
import { makeChainRegistry } from "../src/chains.js";
import type { DeliveryConfig } from "../src/config.js";
import { RpcDeliveryModule } from "../src/relay/delivery.js";
import {
  DeferDeliveryError,
  PermanentDeliveryError,
  type PreparedDelivery,
  type RelayPayload,
  RetriableDeliveryError,
} from "../src/relay/interfaces.js";
import { packSignedVaa, toUniversalAddress } from "../src/relay/vaa.js";
import type { VaaFetcher } from "../src/relay/vaaFetcher.js";
import type { ChainId } from "../src/types.js";

const TRANSCEIVER = getAddress("0x" + "44".repeat(20));
const EMITTER = toUniversalAddress("0x" + "22".repeat(20));
const REQUEST_BYTES = "0x9945ff10" + "ee".repeat(40);
const NO_RETRY = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
const iface = wormholeTransceiverInterface;
const SEL_CONSUMED = iface.getFunction("isVAAConsumed")!.selector;
const GUARDIAN = "0x" + "01".repeat(32);

function buildVaa(opts: { sequence: bigint; payload: string }): Uint8Array {
  const { vaa } = packSignedVaa(
    {
      timestamp: 0,
      nonce: 0,
      emitterChainId: 2,
      emitterAddress: EMITTER,
      sequence: opts.sequence,
      consistencyLevel: 1,
      payload: opts.payload,
    },
    0,
    (digest) => {
      const sig = new SigningKey(GUARDIAN).sign(digest);
      return { r: sig.r, s: sig.s, v: sig.yParity };
    }
  );
  return getBytes(vaa);
}

function stubFetcher(vaa: Uint8Array | null): VaaFetcher {
  return { fetchVaa: async () => vaa };
}

function payload(overrides: Partial<RelayPayload> = {}): RelayPayload {
  return {
    emitterChain: 2,
    emitterAddress: EMITTER,
    sequence: "42",
    sourceTxHash: "0x" + "ab".repeat(32),
    dstChain: 6,
    dstAddr: zeroPadValue(TRANSCEIVER, 32),
    gasLimit: "300000",
    requestBytes: REQUEST_BYTES,
    ...overrides,
  };
}

interface FakeProviderOpts {
  consumed?: boolean;
  estimateGasError?: unknown;
  estimateGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint | null;
}
function fakeProvider(opts: FakeProviderOpts = {}): Provider {
  return {
    call: async (tx: TransactionRequest) => {
      const data = (tx.data as string) ?? "0x";
      if (data.startsWith(SEL_CONSUMED)) {
        return iface.encodeFunctionResult("isVAAConsumed", [
          opts.consumed ?? false,
        ]);
      }
      throw new Error(`unexpected call ${data.slice(0, 10)}`);
    },
    estimateGas: async () => {
      if (opts.estimateGasError) throw opts.estimateGasError;
      return opts.estimateGas ?? 100_000n;
    },
    getFeeData: async () => ({
      maxFeePerGas: opts.maxFeePerGas ?? 100n,
      maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? 2n,
      gasPrice: opts.gasPrice ?? 100n,
    }),
  } as unknown as Provider;
}

function fakeSigner(): {
  signer: Signer;
  sent: TransactionRequest[];
  setError: (e: unknown) => void;
} {
  const sent: TransactionRequest[] = [];
  let error: unknown;
  const signer = {
    sendTransaction: async (tx: TransactionRequest) => {
      if (error) throw error;
      sent.push(tx);
      return { hash: "0x" + "de".repeat(32) };
    },
  } as unknown as Signer;
  return { signer, sent, setError: (e) => (error = e) };
}

function revert(errorName: string, args: unknown[]) {
  return Object.assign(new Error("execution reverted"), {
    code: "CALL_EXCEPTION",
    data: transceiverErrorInterface.encodeErrorResult(errorName, args),
  });
}

function makeModule(
  fetcher: VaaFetcher,
  provider: Provider,
  deliveryCfg?: Partial<DeliveryConfig>
): RpcDeliveryModule {
  const registry = makeChainRegistry([
    {
      chainId: 6,
      name: "dst",
      rpcUrl: "http://x",
      confirmations: 1,
      genesisBlock: 0n,
    },
  ]);
  return new RpcDeliveryModule({
    registry,
    providers: new Map<ChainId, Provider>([[6, provider]]),
    vaaFetcher: fetcher,
    delivery: {
      gasLimitBufferBps: 1000,
      retryAdditionalGasPct: 10,
      gasPriceBumpBps: 1500,
      maxGasPriceWei: 0n,
      ...deliveryCfg,
    },
    retry: NO_RETRY,
  });
}

const okVaa = () => buildVaa({ sequence: 42n, payload: REQUEST_BYTES });
const prepareReq = (
  overrides: Partial<RelayPayload> = {},
  retryAttempt = 0
) => ({
  destinationChainId: 6,
  payload: payload(overrides),
  retryAttempt,
});

describe("RpcDeliveryModule.prepare — guards", () => {
  it("defers when the VAA is not yet available", async () => {
    const mod = makeModule(stubFetcher(null), fakeProvider());
    await expect(mod.prepare(prepareReq())).rejects.toBeInstanceOf(
      DeferDeliveryError
    );
  });

  it("permanently fails on a VAA sequence mismatch", async () => {
    const mod = makeModule(
      stubFetcher(buildVaa({ sequence: 99n, payload: REQUEST_BYTES })),
      fakeProvider()
    );
    await expect(mod.prepare(prepareReq())).rejects.toBeInstanceOf(
      PermanentDeliveryError
    );
  });

  it("permanently fails on a non-EVM dstAddr", async () => {
    const mod = makeModule(stubFetcher(okVaa()), fakeProvider());
    const nonEvm = "0x" + "11" + "00".repeat(31);
    await expect(
      mod.prepare(prepareReq({ dstAddr: nonEvm }))
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
  });
});

describe("RpcDeliveryModule.prepare — idempotency & reverts", () => {
  it("returns already-consumed when isVAAConsumed is true", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({ consumed: true })
    );
    expect(await mod.prepare(prepareReq())).toEqual({
      kind: "already-consumed",
    });
  });

  it("returns already-consumed on a TransferAlreadyCompleted estimateGas revert", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({
        estimateGasError: revert("TransferAlreadyCompleted", [
          "0x" + "cd".repeat(32),
        ]),
      })
    );
    expect(await mod.prepare(prepareReq())).toEqual({
      kind: "already-consumed",
    });
  });

  it("permanently fails on InvalidWormholePeer", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({
        estimateGasError: revert("InvalidWormholePeer", [2, EMITTER]),
      })
    );
    await expect(mod.prepare(prepareReq())).rejects.toBeInstanceOf(
      PermanentDeliveryError
    );
  });

  it("defers on InvalidVaa", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({ estimateGasError: revert("InvalidVaa", ["bad sig"]) })
    );
    await expect(mod.prepare(prepareReq())).rejects.toBeInstanceOf(
      DeferDeliveryError
    );
  });

  it("treats an unknown estimateGas revert as retriable", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({
        estimateGasError: Object.assign(new Error("out of gas"), {
          code: "CALL_EXCEPTION",
          data: "0x",
        }),
      })
    );
    await expect(mod.prepare(prepareReq())).rejects.toBeInstanceOf(
      RetriableDeliveryError
    );
  });
});

describe("RpcDeliveryModule.prepare — gas & fees", () => {
  it("uses the quoted gas + buffer when it exceeds the estimate", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({ estimateGas: 100_000n })
    );
    const res = await mod.prepare(prepareReq());
    expect(res.kind).toBe("ready");
    if (res.kind !== "ready") return;
    expect(res.prepared.gasLimit).toBe(330_000n); // 300000 + 10%
    expect(res.prepared.feeOverrides["maxFeePerGas"]).toBe(100n);
  });

  it("uses the estimate + buffer when it exceeds the quote", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({ estimateGas: 500_000n })
    );
    const res = await mod.prepare(prepareReq());
    if (res.kind !== "ready") throw new Error("expected ready");
    expect(res.prepared.gasLimit).toBe(550_000n); // 500000 + 10%
  });

  it("adds the retry gas + fee bump on retryAttempt > 0", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({ estimateGas: 100_000n })
    );
    const res = await mod.prepare(prepareReq({}, 1));
    if (res.kind !== "ready") throw new Error("expected ready");
    // 300000 + 10% buffer (30000) + 10% retry (30000) = 360000
    expect(res.prepared.gasLimit).toBe(360_000n);
    // 100 * (10000 + 1500) / 10000 = 115
    expect(res.prepared.feeOverrides["maxFeePerGas"]).toBe(115n);
  });

  it("defers when the bumped fee exceeds the ceiling", async () => {
    const mod = makeModule(
      stubFetcher(okVaa()),
      fakeProvider({ maxFeePerGas: 100n }),
      {
        maxGasPriceWei: 50n,
      }
    );
    await expect(mod.prepare(prepareReq())).rejects.toBeInstanceOf(
      DeferDeliveryError
    );
  });
});

describe("RpcDeliveryModule.broadcast", () => {
  const prepared: PreparedDelivery = {
    to: TRANSCEIVER,
    callData: "0xabcdef",
    vaaHash: "0x" + "cd".repeat(32),
    gasLimit: 330_000n,
    feeOverrides: { maxFeePerGas: 100n, maxPriorityFeePerGas: 2n },
  };

  it("sends with the prepared gas/fee + reserved nonce and returns the hash", async () => {
    const mod = makeModule(stubFetcher(okVaa()), fakeProvider());
    const { signer, sent } = fakeSigner();
    const hash = await mod.broadcast({ prepared, signer, nonce: 7 });
    expect(hash).toBe("0x" + "de".repeat(32));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(TRANSCEIVER);
    expect(sent[0]!.nonce).toBe(7);
    expect(sent[0]!.gasLimit).toBe(330_000n);
    expect(sent[0]!.maxFeePerGas).toBe(100n);
  });

  it("defers on nonce-too-low (prior tx already landed)", async () => {
    const mod = makeModule(stubFetcher(okVaa()), fakeProvider());
    const { signer, setError } = fakeSigner();
    setError(new Error("nonce too low"));
    await expect(
      mod.broadcast({ prepared, signer, nonce: 7 })
    ).rejects.toBeInstanceOf(DeferDeliveryError);
  });

  it("retries on replacement-underpriced", async () => {
    const mod = makeModule(stubFetcher(okVaa()), fakeProvider());
    const { signer, setError } = fakeSigner();
    setError(new Error("replacement transaction underpriced"));
    await expect(
      mod.broadcast({ prepared, signer, nonce: 7 })
    ).rejects.toBeInstanceOf(RetriableDeliveryError);
  });

  it("defers on a transient RPC error", async () => {
    const mod = makeModule(stubFetcher(okVaa()), fakeProvider());
    const { signer, setError } = fakeSigner();
    setError(Object.assign(new Error("network"), { code: "SERVER_ERROR" }));
    await expect(
      mod.broadcast({ prepared, signer, nonce: 7 })
    ).rejects.toBeInstanceOf(DeferDeliveryError);
  });
});

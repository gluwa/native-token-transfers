import type { OracleServiceConfig, PricingMode } from "../src/config.js";
import type {
  ChainPriceUpdate,
  GasPriceReader,
  OracleWriter,
} from "../src/oracle.js";
import type { PriceSource } from "../src/priceSource.js";
import { TwapAggregator } from "../src/priceSource.js";
import { readActiveMode, runTick, startRunner } from "../src/runner.js";
import { usdRatioWad, usdToScaled } from "../src/scaling.js";

function makeConfig(opts?: {
  ctcTokenId?: string;
  attestTokenId?: string;
}): OracleServiceConfig {
  return {
    ctcTokenId: opts?.ctcTokenId ?? "creditcoin-2",
    attestTokenId: opts?.attestTokenId,
    pushIntervalMs: 60_000,
    chains: [
      {
        chainId: 2,
        rpcUrl: "http://eth",
        coingeckoId: "ethereum",
        priceBuffer: 500n,
        baseFee: 1000n,
      },
    ],
    // remaining fields are unused by runTick
  } as unknown as OracleServiceConfig;
}

function priceSourceStub(prices: Record<string, number>): PriceSource & {
  requested: string[][];
} {
  const requested: string[][] = [];
  return {
    requested,
    fetchUsdPrices: async (ids: string[]) => {
      requested.push(ids);
      const out = new Map<string, number>();
      for (const id of ids) {
        if (!(id in prices)) {
          throw new Error(`missing price for ${id}`);
        }
        out.set(id, prices[id]!);
      }
      return out;
    },
  };
}

function gasReaderStub(byChain: Record<number, bigint>): GasPriceReader {
  return { gasPrice: async (chainId: number) => byChain[chainId]! };
}

/// `pricingMode` mimics the contract getter: it returns the current mode, or throws to
/// simulate an RPC error / a contract that doesn't expose the getter.
function writerSpy(
  pricingMode: () => Promise<PricingMode> = async () => "penguinswap"
): OracleWriter & {
  calls: Array<{ sourcePrice: bigint; updates: ChainPriceUpdate[] }>;
  twapSamples: bigint[];
} {
  const calls: Array<{ sourcePrice: bigint; updates: ChainPriceUpdate[] }> = [];
  const twapSamples: bigint[] = [];
  return {
    calls,
    twapSamples,
    assertAuthorized: async () => undefined,
    assertTwapReaderAuthorized: async () => undefined,
    pricingMode,
    pushPrices: async (sourcePrice, updates) => {
      calls.push({ sourcePrice, updates });
      return "0xhash";
    },
    pushTwapSample: async (ctcPerAttest) => {
      twapSamples.push(ctcPerAttest);
      return "0xtwaphash";
    },
  };
}

// Zero window -> average == latest spot, deterministic.
const spotTwap = (): TwapAggregator => new TwapAggregator(0, () => 0);

describe("runTick", () => {
  it("penguinswap mode writes CTC/USD as sourcePrice + srcPrice and native/USD as dstPrice, no TWAPReader push", async () => {
    const writer = writerSpy(async () => "penguinswap");
    const result = await runTick({
      config: makeConfig(),
      priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 20_000_000_000n }),
      writer,
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.twapSamples).toHaveLength(0);
    expect(result.sourcePrice).toBe(usdToScaled(0.5));
    expect(result.mode).toBe("penguinswap");
    expect(result.twapTxHash).toBeUndefined();
    expect(result.ctcPerAttest).toBeUndefined();
    const u = result.updates[0]!;
    expect(u.chainId).toBe(2);
    expect(u.pricing).toEqual({
      baseFee: 1000n,
      dstGasPrice: 20_000_000_000n,
      dstPrice: usdToScaled(3000),
      srcPrice: usdToScaled(0.5),
      priceBuffer: 500n,
    });
  });

  it("twap mode still anchors CTC/USD and additionally pushes ctcPerAttest to the TWAPReader", async () => {
    const writer = writerSpy(async () => "twap");
    const result = await runTick({
      config: makeConfig({ attestTokenId: "attestcoin" }),
      priceSource: priceSourceStub({
        "creditcoin-2": 0.5,
        attestcoin: 5_000_000,
        ethereum: 3000,
      }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });
    expect(result.mode).toBe("twap");
    // sourcePrice is the CTC anchor in BOTH modes.
    expect(result.sourcePrice).toBe(usdToScaled(0.5));
    expect(result.updates[0]!.pricing.srcPrice).toBe(usdToScaled(0.5));
    // ctcPerAttest = attestUsd / ctcUsd, 1e18 fp: 5e6 / 0.5 = 1e7 -> 1e25.
    expect(result.ctcPerAttest).toBe(usdRatioWad(5_000_000, 0.5));
    expect(result.ctcPerAttest).toBe(10n ** 25n);
    expect(writer.twapSamples).toEqual([10n ** 25n]);
    expect(result.twapTxHash).toBe("0xtwaphash");
  });

  it("pushes a spot ratio to TWAPReader instead of time-weighting the price twice", async () => {
    let clock = 0;
    const twap = new TwapAggregator(10_000, () => clock);
    // Seed enough older observations that the off-chain rolling averages differ from
    // the next spot fetch. TWAPReader owns the ATTEST/CTC averaging window on-chain.
    twap.record("creditcoin-2", 1);
    twap.record("attestcoin", 10);
    clock = 100;
    twap.record("creditcoin-2", 1);
    twap.record("attestcoin", 20);
    clock = 200;

    const writer = writerSpy(async () => "twap");
    const result = await runTick({
      config: makeConfig({ attestTokenId: "attestcoin" }),
      priceSource: priceSourceStub({
        "creditcoin-2": 1,
        attestcoin: 50,
        ethereum: 3000,
      }),
      twap,
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });

    // The off-chain averages would produce 35/1. The reader must receive the newly
    // fetched 50/1 spot ratio so its own cumulative-price logic averages it once.
    expect(twap.average("attestcoin")).toBe(35);
    expect(result.ctcPerAttest).toBe(usdRatioWad(50, 1));
    expect(writer.twapSamples).toEqual([usdRatioWad(50, 1)]);
  });

  it("re-reads the contract mode each tick, so an on-chain toggle is picked up", async () => {
    let mode: PricingMode = "penguinswap";
    const writer = writerSpy(async () => mode);
    const config = makeConfig({ attestTokenId: "attestcoin" });
    const priceSource = priceSourceStub({
      "creditcoin-2": 0.5,
      attestcoin: 7,
      ethereum: 3000,
    });
    const twap = spotTwap();

    const first = await runTick({
      config,
      priceSource,
      twap,
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });
    expect(first.mode).toBe("penguinswap");
    expect(writer.twapSamples).toHaveLength(0);
    // penguinswap-mode ticks don't fetch the ATTEST leg.
    expect(priceSource.requested[0]).not.toContain("attestcoin");

    mode = "twap"; // toggled on-chain (by the oracleService key)
    const second = await runTick({
      config,
      priceSource,
      twap,
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });
    expect(second.mode).toBe("twap");
    expect(second.sourcePrice).toBe(usdToScaled(0.5)); // anchor unchanged by mode
    expect(writer.twapSamples).toEqual([usdRatioWad(7, 0.5)]);
    expect(priceSource.requested[1]).toContain("attestcoin");
  });

  it("skips the tick when the contract mode read fails", async () => {
    const writer = writerSpy(async () => {
      throw Object.assign(new Error("rpc flaky"), { code: "SERVER_ERROR" });
    });
    await expect(
      runTick({
        config: makeConfig(),
        priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
        twap: spotTwap(),
        gasReader: gasReaderStub({ 2: 1n }),
        writer,
      })
    ).rejects.toThrow(/rpc flaky/);
    expect(writer.calls).toHaveLength(0);
  });

  it("skips the tick when twap mode is active without an ATTEST token id", async () => {
    const writer = writerSpy(async () => "twap");
    await expect(
      runTick({
        config: makeConfig(), // no attestTokenId
        priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
        twap: spotTwap(),
        gasReader: gasReaderStub({ 2: 1n }),
        writer,
      })
    ).rejects.toThrow(/ORACLE_ATTEST_TOKEN_ID/);
    expect(writer.calls).toHaveLength(0);
    expect(writer.twapSamples).toHaveLength(0);
  });

  it("skips the push (throws) when a required price is missing", async () => {
    const writer = writerSpy(async () => "penguinswap");
    await expect(
      runTick({
        config: makeConfig(),
        priceSource: priceSourceStub({ "creditcoin-2": 0.5 }), // ethereum missing
        twap: spotTwap(),
        gasReader: gasReaderStub({ 2: 1n }),
        writer,
      })
    ).rejects.toThrow(/ethereum/);
    expect(writer.calls).toHaveLength(0);
  });

  it("a failing post-push hook is logged but does not relabel the push as skipped", async () => {
    const writer = writerSpy(async () => "penguinswap");
    const infos: string[] = [];
    const errors: string[] = [];
    const handle = startRunner({
      config: makeConfig(),
      priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
      onSuccess: () => {
        throw new Error("disk full");
      },
      logger: {
        info: (m) => infos.push(m),
        error: (m) => errors.push(m),
      },
    });
    // The first tick runs immediately; poll until it lands rather than racing a
    // fixed timer (the push interval is 60s, so exactly one tick can occur).
    for (let i = 0; i < 100 && writer.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    handle.stop();

    expect(writer.calls).toHaveLength(1);
    expect(infos.some((m) => m.includes("pushed sourcePrice"))).toBe(true);
    expect(errors.some((m) => m.includes("post-push hook failed"))).toBe(true);
    expect(errors.some((m) => m.includes("tick skipped"))).toBe(false);
  });

  it("skips the push when a gas read fails", async () => {
    const writer = writerSpy(async () => "penguinswap");
    await expect(
      runTick({
        config: makeConfig(),
        priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
        twap: spotTwap(),
        gasReader: {
          gasPrice: async () => {
            throw new Error("rpc down");
          },
        },
        writer,
      })
    ).rejects.toThrow(/rpc down/);
    expect(writer.calls).toHaveLength(0);
  });

  it("all reads complete before any push: a gas failure means no TWAPReader push either", async () => {
    const writer = writerSpy(async () => "twap");
    await expect(
      runTick({
        config: makeConfig({ attestTokenId: "attestcoin" }),
        priceSource: priceSourceStub({
          "creditcoin-2": 0.5,
          attestcoin: 5_000_000,
          ethereum: 3000,
        }),
        twap: spotTwap(),
        gasReader: {
          gasPrice: async () => {
            throw new Error("rpc down");
          },
        },
        writer,
      })
    ).rejects.toThrow(/rpc down/);
    expect(writer.twapSamples).toHaveLength(0);
    expect(writer.calls).toHaveLength(0);
  });
});

describe("readActiveMode", () => {
  it("returns the contract's current mode", async () => {
    const writer = writerSpy(async () => "twap");
    const mode = await readActiveMode(
      writer,
      makeConfig({ attestTokenId: "attestcoin" })
    );
    expect(mode).toBe("twap");
  });

  it("throws when twap mode is active without an ATTEST token id", async () => {
    const writer = writerSpy(async () => "twap");
    await expect(readActiveMode(writer, makeConfig())).rejects.toThrow(
      /ORACLE_ATTEST_TOKEN_ID/
    );
  });

  it("penguinswap mode needs no ATTEST id", async () => {
    const writer = writerSpy(async () => "penguinswap");
    await expect(readActiveMode(writer, makeConfig())).resolves.toBe(
      "penguinswap"
    );
  });

  it("propagates a contract read failure (caller surfaces it)", async () => {
    const writer = writerSpy(async () => {
      throw new Error("pricingMode() is not callable");
    });
    await expect(readActiveMode(writer, makeConfig())).rejects.toThrow(
      /not callable/
    );
  });
});

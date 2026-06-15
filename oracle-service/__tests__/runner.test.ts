import type { OracleServiceConfig, PricingMode } from "../src/config.js";
import type {
  ChainPriceUpdate,
  GasPriceReader,
  OracleWriter,
} from "../src/oracle.js";
import type { PriceSource } from "../src/priceSource.js";
import { TwapAggregator } from "../src/priceSource.js";
import { readActiveMode, runTick, startRunner } from "../src/runner.js";
import { usdToScaled } from "../src/scaling.js";

function makeConfig(
  sourceTokenIds: Partial<Record<PricingMode, string>>
): OracleServiceConfig {
  return {
    sourceTokenIds,
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
} {
  const calls: Array<{ sourcePrice: bigint; updates: ChainPriceUpdate[] }> = [];
  return {
    calls,
    assertAuthorized: async () => undefined,
    pricingMode,
    pushPrices: async (sourcePrice, updates) => {
      calls.push({ sourcePrice, updates });
      return "0xhash";
    },
  };
}

// Zero window -> average == latest spot, deterministic.
const spotTwap = (): TwapAggregator => new TwapAggregator(0, () => 0);

describe("runTick", () => {
  it("penguinswap mode writes CTC/USD as sourcePrice and native/USD as dstPrice", async () => {
    const writer = writerSpy(async () => "penguinswap");
    const result = await runTick({
      config: makeConfig({ penguinswap: "creditcoin-2" }),
      priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 20_000_000_000n }),
      writer,
    });

    expect(writer.calls).toHaveLength(1);
    expect(result.sourcePrice).toBe(usdToScaled(0.5));
    expect(result.mode).toBe("penguinswap");
    const u = result.updates[0]!;
    expect(u.chainId).toBe(2);
    expect(u.pricing).toEqual({
      dstPrice: usdToScaled(3000),
      dstGasPrice: 20_000_000_000n,
      priceBuffer: 500n,
      baseFee: 1000n,
    });
  });

  it("twap mode writes ATTEST/USD as sourcePrice", async () => {
    const writer = writerSpy(async () => "twap");
    const result = await runTick({
      config: makeConfig({ twap: "attestcoin" }),
      priceSource: priceSourceStub({ attestcoin: 5_000_000, ethereum: 3000 }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });
    expect(result.mode).toBe("twap");
    expect(result.sourcePrice).toBe(usdToScaled(5_000_000));
  });

  it("re-reads the contract mode each tick, so an on-chain toggle is picked up", async () => {
    let mode: PricingMode = "penguinswap";
    const writer = writerSpy(async () => mode);
    const config = makeConfig({
      twap: "attestcoin",
      penguinswap: "creditcoin-2",
    });
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
    expect(first.sourcePrice).toBe(usdToScaled(0.5));

    mode = "twap"; // owner toggles on-chain
    const second = await runTick({
      config,
      priceSource,
      twap,
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });
    expect(second.mode).toBe("twap");
    expect(second.sourcePrice).toBe(usdToScaled(7));
  });

  it("skips the tick when the contract mode read fails", async () => {
    const writer = writerSpy(async () => {
      throw Object.assign(new Error("rpc flaky"), { code: "SERVER_ERROR" });
    });
    await expect(
      runTick({
        config: makeConfig({ penguinswap: "creditcoin-2" }),
        priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
        twap: spotTwap(),
        gasReader: gasReaderStub({ 2: 1n }),
        writer,
      })
    ).rejects.toThrow(/rpc flaky/);
    expect(writer.calls).toHaveLength(0);
  });

  it("skips the tick when the active mode has no configured source token id", async () => {
    const writer = writerSpy(async () => "twap");
    await expect(
      runTick({
        config: makeConfig({ penguinswap: "creditcoin-2" }),
        priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
        twap: spotTwap(),
        gasReader: gasReaderStub({ 2: 1n }),
        writer,
      })
    ).rejects.toThrow(/ORACLE_SOURCE_TOKEN_ID_TWAP/);
    expect(writer.calls).toHaveLength(0);
  });

  it("skips the push (throws) when a required price is missing", async () => {
    const writer = writerSpy(async () => "penguinswap");
    await expect(
      runTick({
        config: makeConfig({ penguinswap: "creditcoin-2" }),
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
      config: makeConfig({ penguinswap: "creditcoin-2" }),
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
        config: makeConfig({ penguinswap: "creditcoin-2" }),
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
});

describe("readActiveMode", () => {
  it("returns the contract's current mode", async () => {
    const writer = writerSpy(async () => "twap");
    const mode = await readActiveMode(
      writer,
      makeConfig({ twap: "attestcoin", penguinswap: "creditcoin-2" })
    );
    expect(mode).toBe("twap");
  });

  it("throws when the active mode has no configured source token id", async () => {
    const writer = writerSpy(async () => "twap");
    await expect(
      readActiveMode(writer, makeConfig({ penguinswap: "creditcoin-2" }))
    ).rejects.toThrow(/ORACLE_SOURCE_TOKEN_ID_TWAP/);
  });

  it("propagates a contract read failure (caller surfaces it)", async () => {
    const writer = writerSpy(async () => {
      throw new Error("pricingMode() is not callable");
    });
    await expect(
      readActiveMode(writer, makeConfig({ penguinswap: "creditcoin-2" }))
    ).rejects.toThrow(/not callable/);
  });
});

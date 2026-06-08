import type { OracleServiceConfig, PricingMode } from "../src/config.js";
import type {
  ChainPriceUpdate,
  GasPriceReader,
  OracleWriter,
} from "../src/oracle.js";
import type { PriceSource } from "../src/priceSource.js";
import { TwapAggregator } from "../src/priceSource.js";
import { runTick } from "../src/runner.js";
import { usdToScaled } from "../src/scaling.js";

function makeConfig(
  mode: PricingMode,
  sourceTokenId: string
): OracleServiceConfig {
  return {
    sourceTokenId,
    mode,
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

function priceSourceStub(prices: Record<string, number>): PriceSource {
  return {
    fetchUsdPrices: async (ids: string[]) => {
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

function writerSpy(): OracleWriter & {
  calls: Array<{ sourcePrice: bigint; updates: ChainPriceUpdate[] }>;
} {
  const calls: Array<{ sourcePrice: bigint; updates: ChainPriceUpdate[] }> = [];
  return {
    calls,
    assertAuthorized: async () => undefined,
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
    const writer = writerSpy();
    const result = await runTick({
      config: makeConfig("penguinswap", "creditcoin-2"),
      priceSource: priceSourceStub({ "creditcoin-2": 0.5, ethereum: 3000 }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 20_000_000_000n }),
      writer,
    });

    expect(writer.calls).toHaveLength(1);
    expect(result.sourcePrice).toBe(usdToScaled(0.5));
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
    const writer = writerSpy();
    const result = await runTick({
      config: makeConfig("twap", "attestcoin"),
      priceSource: priceSourceStub({ attestcoin: 5_000_000, ethereum: 3000 }),
      twap: spotTwap(),
      gasReader: gasReaderStub({ 2: 1n }),
      writer,
    });
    expect(result.sourcePrice).toBe(usdToScaled(5_000_000));
  });

  it("skips the push (throws) when a required price is missing", async () => {
    const writer = writerSpy();
    await expect(
      runTick({
        config: makeConfig("penguinswap", "creditcoin-2"),
        priceSource: priceSourceStub({ "creditcoin-2": 0.5 }), // ethereum missing
        twap: spotTwap(),
        gasReader: gasReaderStub({ 2: 1n }),
        writer,
      })
    ).rejects.toThrow(/ethereum/);
    expect(writer.calls).toHaveLength(0);
  });

  it("skips the push when a gas read fails", async () => {
    const writer = writerSpy();
    await expect(
      runTick({
        config: makeConfig("penguinswap", "creditcoin-2"),
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

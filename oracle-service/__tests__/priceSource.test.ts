import {
  CoinGeckoError,
  CoinGeckoPriceSource,
  TwapAggregator,
} from "../src/priceSource.js";

interface Call {
  url: string;
  headers: Record<string, string>;
}

/// Build a fetch stub that returns the given responses in sequence (cycling on the last)
/// and records each call.
function fetchStub(
  responses: Array<{ status?: number; body?: unknown; throwErr?: boolean }>,
  calls: Call[]
): typeof fetch {
  let i = 0;
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    calls.push({
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    if (spec.throwErr) throw new Error("ECONNRESET");
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const NO_SLEEP = (): Promise<void> => Promise.resolve();

describe("CoinGeckoPriceSource.fetchUsdPrices", () => {
  it("builds the simple/price URL and parses usd prices", async () => {
    const calls: Call[] = [];
    const src = new CoinGeckoPriceSource({
      baseUrl: "https://api.coingecko.com/api/v3/",
      apiKey: "demo-key",
      fetchImpl: fetchStub(
        [{ body: { ethereum: { usd: 3000 }, "creditcoin-2": { usd: 0.5 } } }],
        calls
      ),
    });
    const prices = await src.fetchUsdPrices(["creditcoin-2", "ethereum"]);
    expect(prices.get("creditcoin-2")).toBe(0.5);
    expect(prices.get("ethereum")).toBe(3000);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v3/simple/price");
    expect(url.searchParams.get("ids")).toBe("creditcoin-2,ethereum");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
    // Demo key header on the public host.
    expect(calls[0]!.headers["x-cg-demo-api-key"]).toBe("demo-key");
  });

  it("uses the pro key header on the pro host", async () => {
    const calls: Call[] = [];
    const src = new CoinGeckoPriceSource({
      baseUrl: "https://pro-api.coingecko.com/api/v3",
      apiKey: "pro-key",
      fetchImpl: fetchStub([{ body: { ethereum: { usd: 1 } } }], calls),
    });
    await src.fetchUsdPrices(["ethereum"]);
    expect(calls[0]!.headers["x-cg-pro-api-key"]).toBe("pro-key");
  });

  it("retries transient 5xx/429 then succeeds", async () => {
    const calls: Call[] = [];
    const src = new CoinGeckoPriceSource({
      baseUrl: "https://api.coingecko.com/api/v3",
      retry: { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: NO_SLEEP,
      fetchImpl: fetchStub(
        [
          { status: 503 },
          { status: 429 },
          { body: { ethereum: { usd: 3000 } } },
        ],
        calls
      ),
    });
    const prices = await src.fetchUsdPrices(["ethereum"]);
    expect(prices.get("ethereum")).toBe(3000);
    expect(calls).toHaveLength(3);
  });

  it("does not retry 4xx", async () => {
    const calls: Call[] = [];
    const src = new CoinGeckoPriceSource({
      baseUrl: "https://api.coingecko.com/api/v3",
      retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: NO_SLEEP,
      fetchImpl: fetchStub([{ status: 400 }], calls),
    });
    await expect(src.fetchUsdPrices(["ethereum"])).rejects.toBeInstanceOf(
      CoinGeckoError
    );
    expect(calls).toHaveLength(1);
  });

  it("retries transport errors", async () => {
    const calls: Call[] = [];
    const src = new CoinGeckoPriceSource({
      baseUrl: "https://api.coingecko.com/api/v3",
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
      sleep: NO_SLEEP,
      fetchImpl: fetchStub(
        [{ throwErr: true }, { body: { ethereum: { usd: 5 } } }],
        calls
      ),
    });
    const prices = await src.fetchUsdPrices(["ethereum"]);
    expect(prices.get("ethereum")).toBe(5);
    expect(calls).toHaveLength(2);
  });

  it("throws when a requested id is missing or non-positive", async () => {
    const calls: Call[] = [];
    const src = new CoinGeckoPriceSource({
      baseUrl: "https://api.coingecko.com/api/v3",
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      fetchImpl: fetchStub(
        [{ body: { ethereum: { usd: 3000 } } }], // "creditcoin-2" missing
        calls
      ),
    });
    await expect(
      src.fetchUsdPrices(["ethereum", "creditcoin-2"])
    ).rejects.toThrow(/creditcoin-2/);
  });
});

describe("TwapAggregator", () => {
  it("returns the spot price with a single sample", () => {
    let clock = 0;
    const agg = new TwapAggregator(1000, () => clock);
    agg.record("x", 100);
    expect(agg.average("x")).toBe(100);
  });

  it("weights each sample by the interval it closes", () => {
    let clock = 0;
    const agg = new TwapAggregator(10_000, () => clock);
    agg.record("x", 100); // t=0 — anchors the window start only
    clock = 100;
    agg.record("x", 200); // closes (0, 100]
    clock = 200;
    agg.record("x", 400); // closes (100, 200]
    // (200*100 + 400*100) / 200 = 300
    expect(agg.average("x")).toBe(300);
  });

  it("the freshest sample carries weight immediately", () => {
    let clock = 0;
    const agg = new TwapAggregator(10_000, () => clock);
    agg.record("x", 100); // t=0
    clock = 100;
    agg.record("x", 200); // t=100, just fetched
    // averaging right after the fetch must reflect the new price — with only the
    // anchor before it, the latest sample owns the whole elapsed interval.
    expect(agg.average("x")).toBe(200);
  });

  it("evicts samples older than the window", () => {
    let clock = 0;
    const agg = new TwapAggregator(1000, () => clock);
    agg.record("x", 100); // t=0
    clock = 2000;
    agg.record("x", 300); // t=2000, cutoff=1000 -> t=0 dropped
    expect(agg.average("x")).toBe(300);
  });

  it("with a zero window always returns the latest spot", () => {
    let clock = 0;
    const agg = new TwapAggregator(0, () => clock);
    agg.record("x", 100);
    clock = 50;
    agg.record("x", 250);
    expect(agg.average("x")).toBe(250);
  });

  it("throws for an unrecorded id", () => {
    const agg = new TwapAggregator(1000, () => 0);
    expect(() => agg.average("missing")).toThrow(/missing/);
  });
});

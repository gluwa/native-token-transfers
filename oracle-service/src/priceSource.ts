import { DEFAULT_RETRY, type RetryOptions, withRetry } from "./retry.js";

/// Fetches spot USD prices for a set of CoinGecko coin ids.
export interface PriceSource {
  /// Returns a `usd` price per requested id. Throws if any requested id is missing
  /// from the upstream response (so a tick that can't price every leg is skipped
  /// rather than pushing partial data).
  fetchUsdPrices(ids: string[]): Promise<Map<string, number>>;
  /// Release any held resources. Optional for in-process test stubs.
  dispose?(): void;
}

/// Carries an ethers-style transient/permanent `code` so withRetry's classifier
/// (`isTransientRpcError`) can decide whether to retry CoinGecko failures.
export class CoinGeckoError extends Error {
  constructor(
    message: string,
    public readonly code: "SERVER_ERROR" | "NETWORK_ERROR" | "BAD_DATA"
  ) {
    super(message);
    this.name = "CoinGeckoError";
  }
}

export interface CoinGeckoPriceSourceOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  retry?: Partial<RetryOptions>;
  /// Test seam — replace setTimeout-based sleep so retry tests don't actually wait.
  sleep?: (ms: number) => Promise<void>;
  /// Test seam — inject a fetch implementation.
  fetchImpl?: typeof fetch;
}

interface SimplePriceResponse {
  [id: string]: { usd?: number } | undefined;
}

export class CoinGeckoPriceSource implements PriceSource {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly retry: RetryOptions;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CoinGeckoPriceSourceOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.sleep = opts.sleep;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchUsdPrices(ids: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const url = new URL(`${this.baseUrl}/simple/price`);
    url.searchParams.set("ids", unique.join(","));
    url.searchParams.set("vs_currencies", "usd");

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) {
      // Pro keys go on the pro host; demo keys on the public host.
      const headerName = this.baseUrl.includes("pro-api")
        ? "x-cg-pro-api-key"
        : "x-cg-demo-api-key";
      headers[headerName] = this.apiKey;
    }

    const body = await withRetry(
      () => this.requestOnce(url, headers),
      this.retry,
      this.sleep
    );

    const out = new Map<string, number>();
    for (const id of unique) {
      const usd = body[id]?.usd;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
        throw new CoinGeckoError(
          `CoinGecko returned no usable usd price for "${id}"`,
          "BAD_DATA"
        );
      }
      out.set(id, usd);
    }
    return out;
  }

  private async requestOnce(
    url: URL,
    headers: Record<string, string>
  ): Promise<SimplePriceResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err) {
      // Transport failure (DNS, connection reset, timeout) — treat as transient.
      throw new CoinGeckoError(
        `CoinGecko request failed: ${err instanceof Error ? err.message : String(err)}`,
        "NETWORK_ERROR"
      );
    }
    if (!res.ok) {
      // 5xx / 429 are transient; other 4xx are not.
      const transient = res.status >= 500 || res.status === 429;
      throw new CoinGeckoError(
        `CoinGecko responded ${res.status}`,
        transient ? "SERVER_ERROR" : "BAD_DATA"
      );
    }
    try {
      return (await res.json()) as SimplePriceResponse;
    } catch {
      throw new CoinGeckoError("CoinGecko returned invalid JSON", "BAD_DATA");
    }
  }
}

interface Sample {
  t: number;
  price: number;
}

/// Maintains a rolling, time-weighted average price per coin id. Each `record` stamps
/// the sample with the current clock and evicts samples older than `windowMs`; `average`
/// weights each sample by the time until the next sample (or until now for the latest).
/// This is the "TWAP pricing data" shared by both modes.
export class TwapAggregator {
  private readonly samples = new Map<string, Sample[]>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  record(id: string, price: number): void {
    const t = this.now();
    const list = this.samples.get(id) ?? [];
    list.push({ t, price });
    const cutoff = t - this.windowMs;
    // Keep samples within the window; if all fell out, retain only the latest.
    let trimmed = list.filter((s) => s.t >= cutoff);
    if (trimmed.length === 0) {
      trimmed = [list[list.length - 1]!];
    }
    this.samples.set(id, trimmed);
  }

  /// Time-weighted average over the retained window. Falls back to the latest price
  /// when there is a single sample or zero elapsed time. Throws if `id` was never
  /// recorded.
  average(id: string): number {
    const list = this.samples.get(id);
    if (!list || list.length === 0) {
      throw new Error(`no samples recorded for "${id}"`);
    }
    if (list.length === 1) return list[0]!.price;

    const now = this.now();
    let weighted = 0;
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const next = i < list.length - 1 ? list[i + 1]!.t : now;
      const dt = Math.max(0, next - list[i]!.t);
      weighted += list[i]!.price * dt;
      total += dt;
    }
    if (total === 0) return list[list.length - 1]!.price;
    return weighted / total;
  }
}

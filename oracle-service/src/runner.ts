import type { OracleServiceConfig } from "./config.js";
import type {
  ChainPriceUpdate,
  GasPriceReader,
  OracleWriter,
} from "./oracle.js";
import type { PriceSource, TwapAggregator } from "./priceSource.js";
import { assertUint64, usdToScaled } from "./scaling.js";

export interface RunnerLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

const consoleLogger: RunnerLogger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
};

export interface RunnerDeps {
  config: OracleServiceConfig;
  priceSource: PriceSource;
  twap: TwapAggregator;
  gasReader: GasPriceReader;
  writer: OracleWriter;
  /// Invoked after a successful push (e.g. to touch the healthcheck heartbeat file).
  onSuccess?: () => void;
  logger?: RunnerLogger;
}

export interface TickResult {
  txHash: string;
  sourcePrice: bigint;
  updates: ChainPriceUpdate[];
}

/// Run a single fetch → time-weight → assemble → push cycle. Throws if any required
/// price or gas read fails, so the caller skips the cycle rather than pushing partial
/// or stale data — the contract retains its previous values.
export async function runTick(deps: RunnerDeps): Promise<TickResult> {
  const { config, priceSource, twap, gasReader, writer } = deps;

  // 1. Fetch every USD leg in one call: the source token + each chain's native token.
  const ids = [
    config.sourceTokenId,
    ...config.chains.map((c) => c.coingeckoId),
  ];
  const prices = await priceSource.fetchUsdPrices(ids);

  // 2. Feed the rolling time-weighted window (one record per unique id).
  for (const id of new Set(ids)) {
    twap.record(id, prices.get(id)!);
  }

  // 3. sourcePrice = time-weighted USD price of ATTEST (twap) or CTC (penguinswap).
  const sourcePrice = usdToScaled(twap.average(config.sourceTokenId));

  // 4. Per chain: dstPrice from the window, dstGasPrice from the chain's RPC.
  const updates: ChainPriceUpdate[] = await Promise.all(
    config.chains.map(async (chain) => {
      const dstPrice = usdToScaled(twap.average(chain.coingeckoId));
      const dstGasPrice = assertUint64(
        await gasReader.gasPrice(chain.chainId),
        `gasPrice(${chain.chainId})`
      );
      return {
        chainId: chain.chainId,
        pricing: {
          dstPrice,
          dstGasPrice,
          priceBuffer: chain.priceBuffer,
          baseFee: chain.baseFee,
        },
      };
    })
  );

  // 5. One atomic batchPriceUpdate.
  const txHash = await writer.pushPrices(sourcePrice, updates);
  return { txHash, sourcePrice, updates };
}

export interface RunnerHandle {
  stop: () => void;
}

/// Start the push loop: run a tick immediately, then schedule the next tick
/// `pushIntervalMs` after each one finishes (no overlap). A failed tick is logged and
/// skipped; the loop keeps running.
export function startRunner(deps: RunnerDeps): RunnerHandle {
  const logger = deps.logger ?? consoleLogger;
  const { pushIntervalMs } = deps.config;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runTick(deps);
      deps.onSuccess?.();
      logger.info(
        `pushed sourcePrice=${result.sourcePrice} to ${result.updates.length} chain(s) ` +
          `in tx ${result.txHash}`
      );
    } catch (err) {
      logger.error(
        `tick skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), pushIntervalMs);
      }
    }
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

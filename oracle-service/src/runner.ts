import type { OracleServiceConfig, PricingMode } from "./config.js";
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
  /// Mode this tick priced under, read from the contract.
  mode: PricingMode;
}

/// Read the contract's current pricing mode and confirm a CoinGecko source token id is
/// configured for it. Throws — so the tick is skipped (or startup aborts) — if the
/// contract read fails or the active mode has no configured token id. The mode is read
/// fresh every tick because the owner can toggle it on-chain at any time.
export async function readActiveMode(
  writer: OracleWriter,
  config: OracleServiceConfig
): Promise<PricingMode> {
  const mode = await writer.pricingMode();
  if (!config.sourceTokenIds[mode]) {
    throw new Error(
      `active pricing mode is "${mode}" but ORACLE_SOURCE_TOKEN_ID_${mode.toUpperCase()} is unset`
    );
  }
  return mode;
}

/// Run a single read-mode → fetch → time-weight → assemble → push cycle. Throws if the
/// mode read, any price, or any gas read fails, so the caller skips the cycle rather
/// than pushing partial or stale data — the contract retains its previous values.
export async function runTick(deps: RunnerDeps): Promise<TickResult> {
  const { config, priceSource, twap, gasReader, writer } = deps;

  // 1. Read the contract's current pricing mode (re-read every tick — it can be toggled
  //    on-chain at any time).
  const mode = await readActiveMode(writer, config);
  const sourceTokenId = config.sourceTokenIds[mode]!;

  // 2. Fetch every USD leg in one call: the source token + each chain's native token.
  const ids = [sourceTokenId, ...config.chains.map((c) => c.coingeckoId)];
  const prices = await priceSource.fetchUsdPrices(ids);

  // 3. Feed the rolling time-weighted window (one record per unique id).
  for (const id of new Set(ids)) {
    twap.record(id, prices.get(id)!);
  }

  // 4. sourcePrice = time-weighted USD price of ATTEST (twap) or CTC (penguinswap).
  //    After a mode toggle the new token starts from a fresh window (spot first, then
  //    re-accumulates) — the "new TWAP pricing" SMC-1681 requires on toggle.
  const sourcePrice = usdToScaled(twap.average(sourceTokenId));

  // 5. Per chain: dstPrice from the window, dstGasPrice from the chain's RPC.
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

  // 6. One atomic batchPriceUpdate.
  const txHash = await writer.pushPrices(sourcePrice, updates);
  return { txHash, sourcePrice, updates, mode };
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
      logger.info(
        `pushed sourcePrice=${result.sourcePrice} (mode=${result.mode}) ` +
          `to ${result.updates.length} chain(s) in tx ${result.txHash}`
      );
      // After the success log: a failing heartbeat write must not relabel a push
      // that landed on-chain as a skipped tick.
      try {
        deps.onSuccess?.();
      } catch (err) {
        logger.error(
          `post-push hook failed (push succeeded): ${err instanceof Error ? err.message : String(err)}`
        );
      }
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

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
  /// Mode the tick priced under, and whether it came from the contract or config.
  mode: PricingMode;
  modeSource: "contract" | "config";
}

/// Resolve the active pricing mode: the contract's `pricingMode()` wins (modes can be
/// toggled on-chain at any time, SMC-1681); `fallbackMode` covers deployments that
/// predate the getter. Throws when neither is available or the active mode has no
/// configured source token id.
export async function resolveMode(
  writer: OracleWriter,
  config: OracleServiceConfig
): Promise<{ mode: PricingMode; modeSource: "contract" | "config" }> {
  const detected = await writer.pricingMode();
  const mode = detected ?? config.fallbackMode;
  if (!mode) {
    throw new Error(
      "contract does not expose pricingMode() and ORACLE_PRICING_MODE is unset — cannot determine pricing mode"
    );
  }
  if (!config.sourceTokenIds[mode]) {
    throw new Error(
      `active pricing mode is "${mode}" but ORACLE_SOURCE_TOKEN_ID_${mode.toUpperCase()} is unset`
    );
  }
  return { mode, modeSource: detected !== undefined ? "contract" : "config" };
}

/// Run a single detect-mode → fetch → time-weight → assemble → push cycle. Throws if
/// any required price or gas read fails, so the caller skips the cycle rather than
/// pushing partial or stale data — the contract retains its previous values.
export async function runTick(deps: RunnerDeps): Promise<TickResult> {
  const { config, priceSource, twap, gasReader, writer } = deps;

  // 1. Detect the active mode from the contract (fall back to config), per tick —
  //    the owner can toggle modes between ticks.
  const { mode, modeSource } = await resolveMode(writer, config);
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
  return { txHash, sourcePrice, updates, mode, modeSource };
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
        `pushed sourcePrice=${result.sourcePrice} (mode=${result.mode} via ${result.modeSource}) ` +
          `to ${result.updates.length} chain(s) in tx ${result.txHash}`
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

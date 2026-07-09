import type { OracleServiceConfig, PricingMode } from "./config.js";
import type {
  ChainPriceUpdate,
  GasPriceReader,
  OracleWriter,
} from "./oracle.js";
import type { PriceSource, TwapAggregator } from "./priceSource.js";
import { usdRatioWad, usdToScaled } from "./scaling.js";

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
  /// TWAPReader.update() tx hash — only set when the tick ran under twap mode.
  twapTxHash: string | undefined;
  sourcePrice: bigint;
  /// ctcPerAttest pushed to the TWAPReader (1e18 fp) — only under twap mode.
  ctcPerAttest: bigint | undefined;
  updates: ChainPriceUpdate[];
  /// Mode this tick priced under, read from the contract.
  mode: PricingMode;
}

/// Read the contract's current pricing mode and confirm the CoinGecko ids it needs are
/// configured. Throws — so the tick is skipped (or startup aborts) — if the contract
/// read fails or twap mode is active without an ATTEST id. The mode is read fresh
/// every tick because the oracleService key can toggle it on-chain at any time.
export async function readActiveMode(
  writer: OracleWriter,
  config: OracleServiceConfig
): Promise<PricingMode> {
  const mode = await writer.pricingMode();
  if (mode === "twap" && !config.attestTokenId) {
    throw new Error(
      `active pricing mode is "twap" but ORACLE_ATTEST_TOKEN_ID is unset — ` +
        `twap mode needs the ATTEST/USD leg to derive ctcPerAttest`
    );
  }
  return mode;
}

/// Run a single read-mode → fetch → time-weight → assemble → push cycle. Throws if the
/// mode read, any price, or any gas read fails, so the caller skips the cycle rather
/// than pushing partial or stale data — the contract retains its previous values.
///
/// Both modes push CTC/USD as the `sourcePrice` anchor (and per-chain `srcPrice`) and
/// native/USD as `dstPrice`. Under twap mode the tick ALSO pushes a spot ctcPerAttest
/// observation into the on-chain TWAPReader — that plus the anchor is how the quoter
/// reconstructs ATTEST/USD (attestUsd = sourcePrice × twapReader.read() / 1e18).
export async function runTick(deps: RunnerDeps): Promise<TickResult> {
  const { config, priceSource, twap, gasReader, writer } = deps;

  // 1. Read the contract's current pricing mode (re-read every tick — it can be toggled
  //    on-chain at any time).
  const mode = await readActiveMode(writer, config);

  // 2. Fetch every USD leg in one call: CTC (always), ATTEST (twap mode), and each
  //    chain's native token.
  const ids = [
    config.ctcTokenId,
    ...(mode === "twap" ? [config.attestTokenId!] : []),
    ...config.chains.map((c) => c.coingeckoId),
  ];
  const prices = await priceSource.fetchUsdPrices(ids);

  // 3. Feed the rolling time-weighted window (one record per unique id).
  for (const id of new Set(ids)) {
    twap.record(id, prices.get(id)!);
  }

  // 4. sourcePrice = time-weighted CTC/USD — the mode-independent anchor. It doubles
  //    as every chain's PricingData.srcPrice (same value, same 1e10 scale).
  const sourcePrice = usdToScaled(twap.average(config.ctcTokenId));

  // 5. Per chain: dstPrice from the window, dstGasPrice from the chain's RPC. All
  //    reads complete before anything is pushed, so a failure here skips the tick
  //    without any on-chain write.
  const updates: ChainPriceUpdate[] = await Promise.all(
    config.chains.map(async (chain) => {
      const dstPrice = usdToScaled(twap.average(chain.coingeckoId));
      const dstGasPrice = await gasReader.gasPrice(chain.chainId);
      return {
        chainId: chain.chainId,
        pricing: {
          baseFee: chain.baseFee,
          dstGasPrice,
          dstPrice,
          srcPrice: sourcePrice,
          priceBuffer: chain.priceBuffer,
        },
      };
    })
  );

  // 6. Twap mode: push the ctcPerAttest observation first — it's an independent spot
  //    sample of a real market price, so it's valid even if the batch push below
  //    fails; the reverse (fresh anchor, stale reader) is the pairing we'd rather
  //    avoid aging further.
  let twapTxHash: string | undefined;
  let ctcPerAttest: bigint | undefined;
  if (mode === "twap") {
    ctcPerAttest = usdRatioWad(
      twap.average(config.attestTokenId!),
      twap.average(config.ctcTokenId)
    );
    twapTxHash = await writer.pushTwapSample(ctcPerAttest);
  }

  // 7. One atomic batchPriceUpdate.
  const txHash = await writer.pushPrices(sourcePrice, updates);
  return { txHash, twapTxHash, sourcePrice, ctcPerAttest, updates, mode };
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
          `to ${result.updates.length} chain(s) in tx ${result.txHash}` +
          (result.twapTxHash
            ? ` (ctcPerAttest=${result.ctcPerAttest} in tx ${result.twapTxHash})`
            : "")
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

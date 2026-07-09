#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { loadConfig, type PricingMode } from "./config.js";
import {
  OracleNotAuthorizedError,
  RpcGasPriceReader,
  RpcOracleWriter,
} from "./oracle.js";
import {
  CoinGeckoPriceSource,
  type PriceSource,
  TwapAggregator,
} from "./priceSource.js";
import { readActiveMode, startRunner } from "./runner.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const priceSource: PriceSource = new CoinGeckoPriceSource({
    baseUrl: config.coingeckoBaseUrl,
    apiKey: config.coingeckoApiKey,
    retry: config.retry,
  });
  const twap = new TwapAggregator(config.twapWindowMs);
  const gasReader = new RpcGasPriceReader(config.chains, {
    retry: config.retry,
  });
  const writer = new RpcOracleWriter({
    rpcUrl: config.rpcUrl,
    contractAddress: config.contractAddress,
    signingKey: config.signingKey,
    retry: config.retry,
    txWaitTimeoutMs: config.txWaitTimeoutMs,
  });

  // Refuse to start if the signer isn't the contract's oracleService — pushing prices
  // that the contract will reject is worse than failing loudly here.
  try {
    await writer.assertAuthorized(config.oracleAddress);
  } catch (err) {
    if (err instanceof OracleNotAuthorizedError) {
      console.error(`startup auth check failed: ${err.message}`);
    } else {
      console.error("startup auth check failed:", err);
    }
    writer.dispose();
    gasReader.dispose();
    process.exit(1);
  }

  // Read the contract's current mode once at startup the same way every tick will, so
  // we fail fast if the contract isn't the required quoter (no pricingMode() getter) or
  // twap mode is active without an ATTEST token id, rather than skipping every tick.
  let initialMode: PricingMode;
  try {
    initialMode = await readActiveMode(writer, config);
  } catch (err) {
    console.error(
      `startup mode detection failed: ${err instanceof Error ? err.message : String(err)}`
    );
    writer.dispose();
    gasReader.dispose();
    process.exit(1);
  }

  // Twap mode pushes into the quoter's TWAPReader every tick — verify at startup that
  // the reader is configured and gates update() behind OUR key (its oracleService is
  // set independently of the quoter's). Only checked when twap is the active mode; a
  // later on-chain toggle to twap surfaces the same error per tick.
  if (initialMode === "twap") {
    try {
      await writer.assertTwapReaderAuthorized(config.oracleAddress);
    } catch (err) {
      console.error(
        `startup TWAPReader check failed: ${err instanceof Error ? err.message : String(err)}`
      );
      writer.dispose();
      gasReader.dispose();
      process.exit(1);
    }
  }

  const onSuccess = config.heartbeatFile
    ? (): void => writeFileSync(config.heartbeatFile!, String(Date.now()))
    : undefined;

  const runner = startRunner({
    config,
    priceSource,
    twap,
    gasReader,
    writer,
    onSuccess,
  });

  console.log(
    `oracle-service started (mode=${initialMode}, ctc=${config.ctcTokenId}, ` +
      `attest=${config.attestTokenId ?? "unset"}, ` +
      `chains=${config.chains.map((c) => c.chainId).join(",")}, ` +
      `interval=${config.pushIntervalMs}ms, contract=${config.contractAddress})`
  );

  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, shutting down`);
    runner.stop();
    writer.dispose();
    gasReader.dispose();
    priceSource.dispose?.();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

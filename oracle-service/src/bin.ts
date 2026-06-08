#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { loadConfig } from "./config.js";
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
import { startRunner } from "./runner.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const priceSource: PriceSource = new CoinGeckoPriceSource({
    baseUrl: config.coingeckoBaseUrl,
    apiKey: config.coingeckoApiKey,
    retry: config.retry,
  });
  const twap = new TwapAggregator(config.twapWindowMs);
  const gasReader = new RpcGasPriceReader(config.chains, { retry: config.retry });
  const writer = new RpcOracleWriter({
    rpcUrl: config.rpcUrl,
    contractAddress: config.contractAddress,
    signingKey: config.signingKey,
    retry: config.retry,
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
    `oracle-service started (mode=${config.mode}, sourceToken=${config.sourceTokenId}, ` +
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

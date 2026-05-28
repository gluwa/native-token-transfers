#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { QuoterNotAuthorizedError, RpcOnChainQuoter } from "./quoter.js";
import { createQuoterServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const quoter = new RpcOnChainQuoter({
    rpcUrl: config.rpcUrl,
    contractAddress: config.contractAddress,
    retry: config.retry,
  });

  // Refuse to start if the configured signer isn't in authorizedQuoters — issuing
  // quotes the SpecialRelayer will reject is worse than failing loudly here.
  try {
    await quoter.assertAuthorized(config.quoterAddress);
  } catch (err) {
    if (err instanceof QuoterNotAuthorizedError) {
      console.error(`startup auth check failed: ${err.message}`);
    } else {
      console.error("startup auth check failed:", err);
    }
    process.exit(1);
  }

  const server = createQuoterServer({ config, quoter });

  server.listen(config.port, config.host, () => {
    console.log(
      `quoter-service listening on http://${config.host}:${config.port} ` +
        `(quoter=${config.quoterAddress}, srcChain=${config.srcChain}, ` +
        `contract=${config.contractAddress})`
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

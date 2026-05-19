import { SigningKey, Wallet, getAddress, isHexString, zeroPadValue } from "ethers";

import type { RetryOptions } from "./retry.js";

export interface QuoterServiceConfig {
  /// The signing key — must correspond to an address registered in
  /// PenguinBridgeExecutionQuoter.authorizedQuoters.
  signingKey: SigningKey;
  /// 20-byte address of the signer; precomputed so we don't recover it per request.
  quoterAddress: string;
  /// bytes32 universal source-chain address that receives the execution fee.
  payeeAddress: string;
  /// HTTP RPC URL for the source chain.
  rpcUrl: string;
  /// Address of PenguinBridgeExecutionQuoter on the source chain.
  contractAddress: string;
  /// Wormhole chain id of the source chain.
  srcChain: number;
  /// Quote validity window in seconds. SpecialRelayer rejects quotes past expiryTime.
  validitySeconds: number;
  /// Bind host and port for the HTTP server.
  host: string;
  port: number;
  /// Retry policy applied to RPC reads.
  retry: RetryOptions;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

function parsePayeeAddress(raw: string): string {
  if (isHexString(raw, 32)) {
    return raw.toLowerCase();
  }
  if (isHexString(raw, 20)) {
    return zeroPadValue(raw, 32).toLowerCase();
  }
  throw new Error(
    `QUOTER_PAYEE_ADDRESS must be a 20- or 32-byte hex string, got ${raw}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): QuoterServiceConfig {
  const wallet = new Wallet(required(env, "QUOTER_PRIVATE_KEY"));
  const srcChain = Number(required(env, "QUOTER_SRC_CHAIN"));
  if (!Number.isInteger(srcChain) || srcChain < 0 || srcChain > 0xffff) {
    throw new Error(`QUOTER_SRC_CHAIN must be a uint16, got ${srcChain}`);
  }
  const validitySeconds = Number(env.QUOTER_VALIDITY_SECONDS ?? "120");
  if (!Number.isInteger(validitySeconds) || validitySeconds <= 0) {
    throw new Error(
      `QUOTER_VALIDITY_SECONDS must be a positive integer, got ${validitySeconds}`,
    );
  }
  const port = Number(env.QUOTER_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) {
    throw new Error(`QUOTER_PORT must be a uint16, got ${port}`);
  }
  const maxAttempts = Number(env.QUOTER_RPC_MAX_ATTEMPTS ?? "3");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`QUOTER_RPC_MAX_ATTEMPTS must be >= 1, got ${maxAttempts}`);
  }
  const initialDelayMs = Number(env.QUOTER_RPC_INITIAL_DELAY_MS ?? "200");
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error(`QUOTER_RPC_INITIAL_DELAY_MS must be >= 0, got ${initialDelayMs}`);
  }
  const maxDelayMs = Number(env.QUOTER_RPC_MAX_DELAY_MS ?? "2000");
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new Error(
      `QUOTER_RPC_MAX_DELAY_MS must be an integer >= QUOTER_RPC_INITIAL_DELAY_MS, got ${maxDelayMs}`,
    );
  }
  return {
    signingKey: wallet.signingKey,
    quoterAddress: getAddress(wallet.address),
    payeeAddress: parsePayeeAddress(required(env, "QUOTER_PAYEE_ADDRESS")),
    rpcUrl: required(env, "QUOTER_RPC_URL"),
    contractAddress: getAddress(required(env, "QUOTER_CONTRACT_ADDRESS")),
    srcChain,
    validitySeconds,
    host: env.QUOTER_HOST ?? "127.0.0.1",
    port,
    retry: { maxAttempts, initialDelayMs, maxDelayMs },
  };
}

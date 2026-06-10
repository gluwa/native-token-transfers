import { parseEther } from "ethers";

import { loadConfig, parseRole } from "../src/config.js";

const CHAINS_JSON = JSON.stringify([
  {
    chainId: 2,
    name: "ethereum",
    rpcUrl: "http://eth.rpc.test",
    specialRelayerAddress: "0x" + "11".repeat(20),
    coreBridgeAddress: "0x" + "22".repeat(20),
    expectedTransceiver: "0x" + "33".repeat(20),
    confirmations: 2,
    genesisBlock: "100",
    evmChainId: 1,
  },
  {
    chainId: 4,
    rpcUrl: "http://bsc.rpc.test",
    coreBridgeAddress: "0x" + "44".repeat(20),
    confirmations: 1,
  },
]);

/// A complete env for the worker role (the most demanding — needs chains, redis, wallets).
function workerEnv(): NodeJS.ProcessEnv {
  return {
    RELAYER_CHAINS: CHAINS_JSON,
    DATABASE_URL: "postgres://localhost/relayer",
    REDIS_URL: "redis://localhost:6379",
    WALLETS: "wallet-a,wallet-b",
    RELAYER_USE_DEV_SECRETS: "true",
  };
}

describe("loadConfig", () => {
  it("loads defaults for optional fields (worker role)", () => {
    const cfg = loadConfig(workerEnv(), "worker");
    expect(cfg.role).toBe("worker");
    expect(cfg.chains).toHaveLength(2);
    expect(cfg.scanBlockRange).toBe(200);
    expect(cfg.scanLoopDelayMs).toBe(2000);
    expect(cfg.queueVisibilityTimeoutMs).toBe(60000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.submittedTimeoutMin).toBe(5);
    expect(cfg.cronIntervalMin).toBe(2);
    expect(cfg.wormholescanUrl).toBe("https://api.wormholescan.io");
    expect(cfg.walletMinBalanceWei).toBe(parseEther("0.05"));
    expect(cfg.delivery.retryAdditionalGasPct).toBe(10);
    expect(cfg.delivery.maxGasPriceWei).toBe(0n);
    expect(cfg.walletSecretNames).toEqual(["wallet-a", "wallet-b"]);
    expect(cfg.useDevSecrets).toBe(true);
  });

  it("parses the chains array including bigint genesisBlock", () => {
    const cfg = loadConfig(workerEnv(), "worker");
    const eth = cfg.chains.find((c) => c.chainId === 2)!;
    expect(eth.name).toBe("ethereum");
    expect(eth.confirmations).toBe(2);
    expect(eth.genesisBlock).toBe(100n);
    expect(eth.evmChainId).toBe(1);
    const bsc = cfg.chains.find((c) => c.chainId === 4)!;
    // defaults applied
    expect(bsc.name).toBe("chain-4");
    expect(bsc.genesisBlock).toBe(0n);
  });

  it("parses WALLET_MIN_BALANCE as decimal ETH into wei", () => {
    const cfg = loadConfig(
      { ...workerEnv(), WALLET_MIN_BALANCE: "0.1" },
      "worker"
    );
    expect(cfg.walletMinBalanceWei).toBe(parseEther("0.1"));
  });

  it("throws when a required env var is missing", () => {
    const env = workerEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env, "worker")).toThrow(/DATABASE_URL/);
  });

  it("worker role requires WALLETS", () => {
    const env = workerEnv();
    delete env.WALLETS;
    expect(() => loadConfig(env, "worker")).toThrow(/WALLETS/);
  });

  it("worker role requires Key Vault url unless dev secrets are enabled", () => {
    const env = workerEnv();
    delete env.RELAYER_USE_DEV_SECRETS;
    env.RELAYER_MAX_GAS_PRICE_WEI = "100000000000"; // prod worker also needs the ceiling
    expect(() => loadConfig(env, "worker")).toThrow(/AZURE_KEY_VAULT_URL/);
    // With a Key Vault url it loads.
    const cfg = loadConfig(
      { ...env, AZURE_KEY_VAULT_URL: "https://vault.test" },
      "worker"
    );
    expect(cfg.keyVaultUrl).toBe("https://vault.test");
    expect(cfg.useDevSecrets).toBe(false);
  });

  it("production worker (no dev secrets) requires a fee ceiling", () => {
    const env = workerEnv();
    delete env.RELAYER_USE_DEV_SECRETS;
    env.AZURE_KEY_VAULT_URL = "https://vault.test";
    expect(() => loadConfig(env, "worker")).toThrow(
      /RELAYER_MAX_GAS_PRICE_WEI/
    );
    const cfg = loadConfig(
      { ...env, RELAYER_MAX_GAS_PRICE_WEI: "500000000000" },
      "worker"
    );
    expect(cfg.delivery.maxGasPriceWei).toBe(500000000000n);
    // Dev workers and non-wallet roles are exempt (0 = ceiling disabled).
    expect(loadConfig(workerEnv(), "worker").delivery.maxGasPriceWei).toBe(0n);
    const listenerEnv = workerEnv();
    delete listenerEnv.RELAYER_USE_DEV_SECRETS;
    expect(loadConfig(listenerEnv, "listener").delivery.maxGasPriceWei).toBe(
      0n
    );
  });

  it("migrate role needs only DATABASE_URL", () => {
    const cfg = loadConfig(
      { DATABASE_URL: "postgres://localhost/relayer" },
      "migrate"
    );
    expect(cfg.role).toBe("migrate");
    expect(cfg.chains).toEqual([]);
  });

  it("listener role does not require WALLETS or Key Vault", () => {
    const env = workerEnv();
    delete env.WALLETS;
    delete env.RELAYER_USE_DEV_SECRETS;
    const cfg = loadConfig(env, "listener");
    expect(cfg.role).toBe("listener");
    expect(cfg.walletSecretNames).toEqual([]);
  });

  it("rejects out-of-range numeric env vars", () => {
    expect(() =>
      loadConfig({ ...workerEnv(), MAX_RETRIES: "-1" }, "worker")
    ).toThrow(/MAX_RETRIES/);
    expect(() =>
      loadConfig({ ...workerEnv(), CRON_INTERVAL_MIN: "0" }, "worker")
    ).toThrow(/CRON_INTERVAL_MIN/);
    expect(() =>
      loadConfig({ ...workerEnv(), RELAYER_HEALTH_PORT: "999999" }, "worker")
    ).toThrow(/RELAYER_HEALTH_PORT/);
  });

  it("rejects malformed RELAYER_CHAINS", () => {
    expect(() =>
      loadConfig({ ...workerEnv(), RELAYER_CHAINS: "not json" }, "worker")
    ).toThrow(/RELAYER_CHAINS/);
    expect(() =>
      loadConfig({ ...workerEnv(), RELAYER_CHAINS: "[]" }, "worker")
    ).toThrow(/non-empty/);
    expect(() =>
      loadConfig(
        {
          ...workerEnv(),
          RELAYER_CHAINS: JSON.stringify([{ chainId: 70000, rpcUrl: "x" }]),
        },
        "worker"
      )
    ).toThrow(/uint16/);
  });

  it("rejects an invalid address in RELAYER_CHAINS", () => {
    expect(() =>
      loadConfig(
        {
          ...workerEnv(),
          RELAYER_CHAINS: JSON.stringify([
            { chainId: 2, rpcUrl: "x", coreBridgeAddress: "0xdeadbeef" },
          ]),
        },
        "worker"
      )
    ).toThrow(/not a valid address/);
  });
});

describe("parseRole", () => {
  it("accepts valid roles", () => {
    expect(parseRole("listener")).toBe("listener");
    expect(parseRole("worker")).toBe("worker");
    expect(parseRole("cron")).toBe("cron");
    expect(parseRole("migrate")).toBe("migrate");
  });

  it("throws on missing or invalid role", () => {
    expect(() => parseRole(undefined)).toThrow(/role is required/);
    expect(() => parseRole("bogus")).toThrow(/invalid role/);
  });
});

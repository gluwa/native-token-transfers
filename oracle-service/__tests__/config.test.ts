import { Wallet } from "ethers";
import { loadConfig } from "../src/config.js";

const ORACLE_PRIVATE_KEY = "0x" + 0xa11cen.toString(16).padStart(64, "0");
const ORACLE_ADDRESS = new Wallet(ORACLE_PRIVATE_KEY).address;

const CHAINS = JSON.stringify([
  {
    chainId: 2,
    rpcUrl: "http://eth.test",
    coingeckoId: "ethereum",
    priceBuffer: "500",
    baseFee: "1000000000000000",
  },
]);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ORACLE_PRIVATE_KEY,
    ORACLE_RPC_URL: "http://rpc.test",
    ORACLE_CONTRACT_ADDRESS: "0x" + "1".repeat(40),
    ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP: "creditcoin-2",
    ORACLE_CHAINS: CHAINS,
  };
}

describe("loadConfig", () => {
  it("loads defaults for optional fields", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.oracleAddress).toBe(ORACLE_ADDRESS);
    expect(cfg.sourceTokenIds).toEqual({ penguinswap: "creditcoin-2" });
    expect(cfg.coingeckoBaseUrl).toBe("https://api.coingecko.com/api/v3");
    expect(cfg.coingeckoApiKey).toBeUndefined();
    expect(cfg.pushIntervalMs).toBe(60_000);
    expect(cfg.twapWindowMs).toBe(300_000);
    expect(cfg.txWaitTimeoutMs).toBe(120_000);
    expect(cfg.retry).toEqual({
      maxAttempts: 3,
      initialDelayMs: 200,
      maxDelayMs: 2_000,
    });
  });

  it("parses chains with bigint priceBuffer/baseFee", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.chains).toHaveLength(1);
    const c = cfg.chains[0]!;
    expect(c.chainId).toBe(2);
    expect(c.rpcUrl).toBe("http://eth.test");
    expect(c.coingeckoId).toBe("ethereum");
    expect(c.priceBuffer).toBe(500n);
    expect(c.baseFee).toBe(1_000_000_000_000_000n);
  });

  it("collects source token ids for whichever modes are configured", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_SOURCE_TOKEN_ID_TWAP: "attestcoin",
    });
    expect(cfg.sourceTokenIds).toEqual({
      twap: "attestcoin",
      penguinswap: "creditcoin-2",
    });
  });

  it("requires at least one source token id", () => {
    const env = baseEnv();
    delete env.ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP;
    expect(() => loadConfig(env)).toThrow(/at least one/);
  });

  it("throws when required env vars are missing", () => {
    const env = baseEnv();
    delete env.ORACLE_PRIVATE_KEY;
    expect(() => loadConfig(env)).toThrow(/ORACLE_PRIVATE_KEY/);
  });

  it("rejects malformed ORACLE_CHAINS", () => {
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "{" })).toThrow(
      /valid JSON/
    );
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "[]" })).toThrow(
      /non-empty/
    );
    expect(() =>
      loadConfig({ ...baseEnv(), ORACLE_CHAINS: "[null]" })
    ).toThrow(/must be an object/);
  });

  it("rejects out-of-range chainId and duplicates", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          { chainId: 70000, rpcUrl: "x", coingeckoId: "y" },
        ]),
      })
    ).toThrow(/uint16/);
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          { chainId: 2, rpcUrl: "x", coingeckoId: "y" },
          { chainId: 2, rpcUrl: "z", coingeckoId: "w" },
        ]),
      })
    ).toThrow(/duplicate/);
  });

  it("defaults priceBuffer/baseFee to zero when omitted", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_CHAINS: JSON.stringify([
        { chainId: 2, rpcUrl: "x", coingeckoId: "ethereum" },
      ]),
    });
    expect(cfg.chains[0]!.priceBuffer).toBe(0n);
    expect(cfg.chains[0]!.baseFee).toBe(0n);
  });

  it("accepts large baseFee as a string without precision loss", () => {
    // 1e16 wei (~0.01 ETH) + 1 — exceeds 2^53; only a string is exact.
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_CHAINS: JSON.stringify([
        {
          chainId: 2,
          rpcUrl: "x",
          coingeckoId: "ethereum",
          baseFee: "10000000000000001",
        },
      ]),
    });
    expect(cfg.chains[0]!.baseFee).toBe(10_000_000_000_000_001n);
  });

  it("rejects a bare-number baseFee (amounts must be strings)", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          {
            chainId: 2,
            rpcUrl: "x",
            coingeckoId: "ethereum",
            baseFee: 10000000000000001,
          },
        ]),
      })
    ).toThrow(/encoded as a string/);
  });

  it("rejects a bare-number priceBuffer (amounts must be strings)", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          { chainId: 2, rpcUrl: "x", coingeckoId: "ethereum", priceBuffer: 500 },
        ]),
      })
    ).toThrow(/encoded as a string/);
  });

  it("treats empty-string numeric env vars as unset, not zero", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_TWAP_WINDOW_MS: "",
      ORACLE_PUSH_INTERVAL_MS: "  ",
    });
    expect(cfg.twapWindowMs).toBe(300_000);
    expect(cfg.pushIntervalMs).toBe(60_000);
  });

  it("rejects non-integer numeric env vars", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), ORACLE_TWAP_WINDOW_MS: "abc" })
    ).toThrow(/ORACLE_TWAP_WINDOW_MS/);
  });

  it("rejects bad retry bounds", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), ORACLE_RPC_MAX_ATTEMPTS: "0" })
    ).toThrow();
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_RPC_INITIAL_DELAY_MS: "5000",
        ORACLE_RPC_MAX_DELAY_MS: "1000",
      })
    ).toThrow(/MAX_DELAY/);
  });
});

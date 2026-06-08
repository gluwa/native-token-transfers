import { Wallet } from "ethers";
import { loadConfig } from "../src/config.js";

const ORACLE_PRIVATE_KEY = "0x" + 0xa11cen.toString(16).padStart(64, "0");
const ORACLE_ADDRESS = new Wallet(ORACLE_PRIVATE_KEY).address;

const CHAINS = JSON.stringify([
  {
    chainId: 2,
    rpcUrl: "http://eth.test",
    coingeckoId: "ethereum",
    priceBuffer: 500,
    baseFee: "1000000000000000",
  },
]);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ORACLE_PRIVATE_KEY,
    ORACLE_RPC_URL: "http://rpc.test",
    ORACLE_CONTRACT_ADDRESS: "0x" + "1".repeat(40),
    ORACLE_PRICING_MODE: "penguinswap",
    ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP: "creditcoin-2",
    ORACLE_CHAINS: CHAINS,
  };
}

describe("loadConfig", () => {
  it("loads defaults for optional fields", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.oracleAddress).toBe(ORACLE_ADDRESS);
    expect(cfg.mode).toBe("penguinswap");
    expect(cfg.sourceTokenId).toBe("creditcoin-2");
    expect(cfg.coingeckoBaseUrl).toBe("https://api.coingecko.com/api/v3");
    expect(cfg.coingeckoApiKey).toBeUndefined();
    expect(cfg.pushIntervalMs).toBe(60_000);
    expect(cfg.twapWindowMs).toBe(300_000);
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

  it("selects the source token id matching the mode", () => {
    const twapCfg = loadConfig({
      ...baseEnv(),
      ORACLE_PRICING_MODE: "twap",
      ORACLE_SOURCE_TOKEN_ID_TWAP: "attestcoin",
    });
    expect(twapCfg.mode).toBe("twap");
    expect(twapCfg.sourceTokenId).toBe("attestcoin");
  });

  it("requires the mode-specific source token id", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(),
      ORACLE_PRICING_MODE: "twap",
    };
    delete env.ORACLE_SOURCE_TOKEN_ID_PENGUINSWAP;
    expect(() => loadConfig(env)).toThrow(/ORACLE_SOURCE_TOKEN_ID_TWAP/);
  });

  it("throws when required env vars are missing", () => {
    const env = baseEnv();
    delete env.ORACLE_PRIVATE_KEY;
    expect(() => loadConfig(env)).toThrow(/ORACLE_PRIVATE_KEY/);
  });

  it("rejects an invalid pricing mode", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), ORACLE_PRICING_MODE: "spot" })
    ).toThrow(/ORACLE_PRICING_MODE/);
  });

  it("rejects malformed ORACLE_CHAINS", () => {
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "{" })).toThrow(
      /valid JSON/
    );
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "[]" })).toThrow(
      /non-empty/
    );
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

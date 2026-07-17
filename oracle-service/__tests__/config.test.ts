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
    ORACLE_CTC_TOKEN_ID: "creditcoin-2",
    ORACLE_CHAINS: CHAINS,
  };
}

describe("loadConfig", () => {
  it("loads defaults for optional fields", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.oracleAddress).toBe(ORACLE_ADDRESS);
    expect(cfg.ctcTokenId).toBe("creditcoin-2");
    expect(cfg.attestTokenId).toBeUndefined();
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

  it("collects the optional ATTEST token id", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_ATTEST_TOKEN_ID: "attestcoin",
    });
    expect(cfg.ctcTokenId).toBe("creditcoin-2");
    expect(cfg.attestTokenId).toBe("attestcoin");
  });

  it("requires the CTC token id", () => {
    const env = baseEnv();
    delete env.ORACLE_CTC_TOKEN_ID;
    expect(() => loadConfig(env)).toThrow(/ORACLE_CTC_TOKEN_ID/);
  });

  it("throws when required env vars are missing", () => {
    const env = baseEnv();
    delete env.ORACLE_PRIVATE_KEY;
    expect(() => loadConfig(env)).toThrow(/ORACLE_PRIVATE_KEY/);
  });

  it("does not echo a malformed private key in configuration errors", () => {
    const malformedSecret = "not-a-secret-value";
    let message = "";
    try {
      loadConfig({ ...baseEnv(), ORACLE_PRIVATE_KEY: malformedSecret });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/ORACLE_PRIVATE_KEY/);
    expect(message).not.toContain(malformedSecret);
  });

  it("rejects malformed ORACLE_CHAINS", () => {
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "{" })).toThrow(
      /valid JSON/
    );
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "[]" })).toThrow(
      /non-empty/
    );
    expect(() => loadConfig({ ...baseEnv(), ORACLE_CHAINS: "[null]" })).toThrow(
      /must be an object/
    );
  });

  it("rejects out-of-range chainId and duplicates", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          { chainId: 0, rpcUrl: "x", coingeckoId: "y" },
        ]),
      })
    ).toThrow(/non-zero uint16/);
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
          {
            chainId: 2,
            rpcUrl: "x",
            coingeckoId: "ethereum",
            priceBuffer: 500,
          },
        ]),
      })
    ).toThrow(/encoded as a string/);
  });

  it("rejects a priceBuffer that exceeds uint16 (PricingData.priceBuffer)", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          {
            chainId: 2,
            rpcUrl: "x",
            coingeckoId: "ethereum",
            priceBuffer: "65536",
          },
        ]),
      })
    ).toThrow(/exceeds uint16/);
    // 65535 is the last representable value.
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_CHAINS: JSON.stringify([
        {
          chainId: 2,
          rpcUrl: "x",
          coingeckoId: "ethereum",
          priceBuffer: "65535",
        },
      ]),
    });
    expect(cfg.chains[0]!.priceBuffer).toBe(65_535n);
  });

  it("accepts a baseFee beyond uint64 (CTC wei amounts are uint256 on-chain)", () => {
    // 100 CTC = 1e20 wei — a legitimate base fee that would overflow uint64.
    const cfg = loadConfig({
      ...baseEnv(),
      ORACLE_CHAINS: JSON.stringify([
        {
          chainId: 2,
          rpcUrl: "x",
          coingeckoId: "ethereum",
          baseFee: "100000000000000000000",
        },
      ]),
    });
    expect(cfg.chains[0]!.baseFee).toBe(10n ** 20n);
  });

  it("rejects a baseFee that exceeds uint256", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        ORACLE_CHAINS: JSON.stringify([
          {
            chainId: 2,
            rpcUrl: "x",
            coingeckoId: "ethereum",
            baseFee: (2n ** 256n).toString(),
          },
        ]),
      })
    ).toThrow(/exceeds uint256/);
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

  it("rejects a push interval below 15s (likely a ms/s typo)", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), ORACLE_PUSH_INTERVAL_MS: "150" })
    ).toThrow(/ORACLE_PUSH_INTERVAL_MS must be an integer >= 15000/);
    expect(
      loadConfig({ ...baseEnv(), ORACLE_PUSH_INTERVAL_MS: "15000" })
        .pushIntervalMs
    ).toBe(15_000);
  });

  it("accepts ORACLE_TWAP_WINDOW_MS=0 (disables time-weighting)", () => {
    expect(
      loadConfig({ ...baseEnv(), ORACLE_TWAP_WINDOW_MS: "0" }).twapWindowMs
    ).toBe(0);
    expect(() =>
      loadConfig({ ...baseEnv(), ORACLE_TWAP_WINDOW_MS: "-1" })
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

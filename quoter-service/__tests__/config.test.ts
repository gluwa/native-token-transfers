import { Wallet } from "ethers";
import { loadConfig } from "../src/config.js";

const QUOTER_PRIVATE_KEY = "0x" + (0xa11cen).toString(16).padStart(64, "0");
const QUOTER_ADDRESS = new Wallet(QUOTER_PRIVATE_KEY).address;

function baseEnv(): NodeJS.ProcessEnv {
  return {
    QUOTER_PRIVATE_KEY,
    QUOTER_RPC_URL: "http://rpc.test",
    QUOTER_CONTRACT_ADDRESS: "0x" + "1".repeat(40),
    QUOTER_SRC_CHAIN: "2",
    QUOTER_PAYEE_ADDRESS: "0x" + "f".repeat(40),
  };
}

describe("loadConfig", () => {
  it("loads defaults for optional fields", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.quoterAddress).toBe(QUOTER_ADDRESS);
    expect(cfg.srcChain).toBe(2);
    expect(cfg.validitySeconds).toBe(120);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3000);
    // 20-byte payee gets left-padded to bytes32
    expect(cfg.payeeAddress).toBe("0x" + "0".repeat(24) + "f".repeat(40));
  });

  it("accepts a 32-byte payee unchanged", () => {
    const cfg = loadConfig({ ...baseEnv(), QUOTER_PAYEE_ADDRESS: "0x" + "0".repeat(60) + "fee1" });
    expect(cfg.payeeAddress).toBe("0x" + "0".repeat(60) + "fee1");
  });

  it("throws when required env vars are missing", () => {
    const env = baseEnv();
    delete env.QUOTER_PRIVATE_KEY;
    expect(() => loadConfig(env)).toThrow(/QUOTER_PRIVATE_KEY/);
  });

  it("rejects out-of-range numeric env vars", () => {
    expect(() => loadConfig({ ...baseEnv(), QUOTER_SRC_CHAIN: "70000" })).toThrow();
    expect(() => loadConfig({ ...baseEnv(), QUOTER_VALIDITY_SECONDS: "0" })).toThrow();
    expect(() => loadConfig({ ...baseEnv(), QUOTER_PORT: "999999" })).toThrow();
  });

  it("rejects an invalid payee shape", () => {
    expect(() => loadConfig({ ...baseEnv(), QUOTER_PAYEE_ADDRESS: "0xdeadbeef" })).toThrow();
  });
});

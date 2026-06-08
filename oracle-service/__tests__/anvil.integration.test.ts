import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  Contract,
  ContractFactory,
  type InterfaceAbi,
  JsonRpcProvider,
  Network,
  NonceManager,
  Wallet,
} from "ethers";

import type { OracleServiceConfig } from "../src/config.js";
import {
  RpcGasPriceReader,
  RpcOracleWriter,
} from "../src/oracle.js";
import type { PriceSource } from "../src/priceSource.js";
import { TwapAggregator } from "../src/priceSource.js";
import { runTick } from "../src/runner.js";
import { usdToScaled } from "../src/scaling.js";

// Gate: only run if foundry artifacts + anvil are available locally. Jest sets cwd to
// the workspace dir (oracle-service/), so artifacts live one level up.
const REPO_ROOT = resolvePath(process.cwd(), "..");
const QUOTER_ARTIFACT = resolvePath(
  REPO_ROOT,
  "evm/out/PenguinBridgeExecutionQuoter.sol/PenguinBridgeExecutionQuoter.json"
);
const ARTIFACTS_PRESENT = existsSync(QUOTER_ARTIFACT);
const ANVIL_AVAILABLE = spawnSync("which", ["anvil"]).status === 0;
const maybe = ARTIFACTS_PRESENT && ANVIL_AVAILABLE ? describe : describe.skip;

// Anvil's first default account (funded, deterministic) — acts as the oracleService.
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

interface AnvilHandle {
  proc: ChildProcess;
  rpcUrl: string;
  stop: () => Promise<void>;
}

async function startAnvil(): Promise<AnvilHandle> {
  const port = 18545 + Math.floor(Math.random() * 1000);
  const proc = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (res.ok) {
        return {
          proc,
          rpcUrl,
          stop: () =>
            new Promise<void>((resolve) => {
              proc.once("exit", () => resolve());
              proc.kill("SIGTERM");
            }),
        };
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGTERM");
  throw new Error(`anvil failed to start on ${rpcUrl}`);
}

function loadArtifact(path: string): { abi: InterfaceAbi; bytecode: string } {
  const j = JSON.parse(readFileSync(path, "utf-8")) as {
    abi: InterfaceAbi;
    bytecode: { object: string };
  };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

maybe("oracle end-to-end against anvil", () => {
  const DST_CHAIN = 5;
  let anvil: AnvilHandle;
  let provider: JsonRpcProvider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let quoterContract: any;
  let quoterAddress: string;

  beforeAll(async () => {
    anvil = await startAnvil();
    provider = new JsonRpcProvider(anvil.rpcUrl, Network.from(31337), {
      staticNetwork: true,
    });
    const deployer = new NonceManager(new Wallet(DEPLOYER_KEY, provider));
    const art = loadArtifact(QUOTER_ARTIFACT);
    const factory = new ContractFactory(art.abi, art.bytecode, deployer);
    const quoter = await factory.deploy();
    await quoter.waitForDeployment();
    quoterAddress = await quoter.getAddress();
    quoterContract = new Contract(quoterAddress, art.abi, deployer);

    // The oracle service is the deployer key.
    await (
      await quoterContract.setOracleService(new Wallet(DEPLOYER_KEY).address)
    ).wait();
  }, 30_000);

  afterAll(async () => {
    if (provider) provider.destroy();
    if (anvil) await anvil.stop();
  });

  it("pushes sourcePrice and per-chain PricingData via a real tick", async () => {
    const config = {
      sourceTokenId: "creditcoin-2",
      mode: "penguinswap",
      chains: [
        {
          chainId: DST_CHAIN,
          rpcUrl: anvil.rpcUrl,
          coingeckoId: "ethereum",
          priceBuffer: 750n,
          baseFee: 1_000_000_000_000_000n,
        },
      ],
    } as unknown as OracleServiceConfig;

    const priceSource: PriceSource = {
      fetchUsdPrices: async (ids) =>
        new Map(
          ids.map((id) => [id, id === "creditcoin-2" ? 0.5 : 3000] as const)
        ),
    };

    const writer = new RpcOracleWriter({
      rpcUrl: anvil.rpcUrl,
      contractAddress: quoterAddress,
      signingKey: new Wallet(DEPLOYER_KEY).signingKey,
      staticNetwork: true,
    });
    const gasReader = new RpcGasPriceReader(config.chains);

    try {
      // Boot check: the deployer key is the registered oracleService.
      await writer.assertAuthorized(new Wallet(DEPLOYER_KEY).address);

      const result = await runTick({
        config,
        priceSource,
        twap: new TwapAggregator(0),
        gasReader,
        writer,
      });

      // On-chain state matches what the tick computed.
      const onChainSource = (await quoterContract.sourcePrice()) as bigint;
      expect(onChainSource).toBe(usdToScaled(0.5));
      expect(result.sourcePrice).toBe(usdToScaled(0.5));

      const pd = await quoterContract.pricingData(DST_CHAIN);
      expect(pd.dstPrice).toBe(usdToScaled(3000));
      expect(pd.dstGasPrice).toBeGreaterThan(0n);
      expect(pd.priceBuffer).toBe(750n);
      expect(pd.baseFee).toBe(1_000_000_000_000_000n);
    } finally {
      writer.dispose();
      gasReader.dispose();
    }
  }, 60_000);
});

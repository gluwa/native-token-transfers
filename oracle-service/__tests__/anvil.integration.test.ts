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

import { RpcGasPriceReader, RpcOracleWriter } from "../src/oracle.js";
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

  it("pushes sourcePrice and per-chain PricingData to the real contract", async () => {
    // This fixture deploys the current PenguinBridgeExecutionQuoter, which does not yet
    // expose pricingMode() (that getter is the contract-side SMC-1681 work). So we
    // exercise the write path — batchPriceUpdate ABI encoding, the tx, and on-chain
    // state — directly via pushPrices rather than through runTick (which reads the
    // mode). The mode read is covered against the real contract in the next test.
    const chains = [
      {
        chainId: DST_CHAIN,
        rpcUrl: anvil.rpcUrl,
        coingeckoId: "ethereum",
        priceBuffer: 750n,
        baseFee: 1_000_000_000_000_000n,
      },
    ];

    const writer = new RpcOracleWriter({
      rpcUrl: anvil.rpcUrl,
      contractAddress: quoterAddress,
      signingKey: new Wallet(DEPLOYER_KEY).signingKey,
      staticNetwork: true,
    });
    const gasReader = new RpcGasPriceReader(chains);

    try {
      // Boot check: the deployer key is the registered oracleService.
      await writer.assertAuthorized(new Wallet(DEPLOYER_KEY).address);

      const sourcePrice = usdToScaled(0.5);
      const dstGasPrice = await gasReader.gasPrice(DST_CHAIN);
      await writer.pushPrices(sourcePrice, [
        {
          chainId: DST_CHAIN,
          pricing: {
            dstPrice: usdToScaled(3000),
            dstGasPrice,
            priceBuffer: 750n,
            baseFee: 1_000_000_000_000_000n,
          },
        },
      ]);

      // On-chain state matches what we pushed.
      expect((await quoterContract.sourcePrice()) as bigint).toBe(sourcePrice);
      const pd = await quoterContract.pricingData(DST_CHAIN);
      expect(pd.dstPrice).toBe(usdToScaled(3000));
      expect(pd.dstGasPrice).toBe(dstGasPrice);
      expect(pd.priceBuffer).toBe(750n);
      expect(pd.baseFee).toBe(1_000_000_000_000_000n);
    } finally {
      writer.dispose();
      gasReader.dispose();
    }
  }, 60_000);

  it("surfaces a clear error reading pricingMode() on a contract without the getter", async () => {
    const writer = new RpcOracleWriter({
      rpcUrl: anvil.rpcUrl,
      contractAddress: quoterAddress,
      signingKey: new Wallet(DEPLOYER_KEY).signingKey,
      staticNetwork: true,
    });
    try {
      await expect(writer.pricingMode()).rejects.toThrow(/not callable/);
    } finally {
      writer.dispose();
    }
  }, 30_000);

  it("times out waiting for a stuck transaction instead of hanging the loop", async () => {
    const writer = new RpcOracleWriter({
      rpcUrl: anvil.rpcUrl,
      contractAddress: quoterAddress,
      signingKey: new Wallet(DEPLOYER_KEY).signingKey,
      staticNetwork: true,
      txWaitTimeoutMs: 1_000,
    });
    const updates = [
      {
        chainId: DST_CHAIN,
        pricing: {
          dstPrice: usdToScaled(3000),
          dstGasPrice: 1n,
          priceBuffer: 0n,
          baseFee: 0n,
        },
      },
    ];
    const oracleAddr = new Wallet(DEPLOYER_KEY).address;
    try {
      // With automine off the tx is accepted into the pool but never mined — the
      // bounded wait must reject instead of blocking the push loop forever.
      await provider.send("anvil_setAutomine", [false]);
      await expect(
        writer.pushPrices(usdToScaled(0.5), updates)
      ).rejects.toMatchObject({ code: "TIMEOUT" });

      // Exactly one tx pending (the stuck one).
      const latest = await provider.getTransactionCount(oracleAddr, "latest");
      const pending = await provider.getTransactionCount(oracleAddr, "pending");
      expect(pending).toBe(latest + 1);

      // The next push must reuse the stuck tx's nonce (a replacement attempt — it
      // may be rejected as underpriced or time out itself), NOT queue a second tx
      // behind it. Either way the pending count must not grow.
      await writer.pushPrices(usdToScaled(0.6), updates).catch(() => undefined);
      const pendingAfter = await provider.getTransactionCount(
        oracleAddr,
        "pending"
      );
      expect(pendingAfter).toBe(latest + 1);
    } finally {
      await provider.send("anvil_setAutomine", [true]);
      // Flush the stranded tx so it can't bleed into other tests.
      await provider.send("evm_mine", []);
      writer.dispose();
    }
  }, 30_000);
});

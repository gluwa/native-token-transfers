import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
import { RpcGasPriceReader, RpcOracleWriter } from "../src/oracle.js";
import type { PriceSource } from "../src/priceSource.js";
import { TwapAggregator } from "../src/priceSource.js";
import { runTick } from "../src/runner.js";
import { usdRatioWad, usdToScaled } from "../src/scaling.js";

// The real USCRelayingQuoter + TWAPReader artifacts are vendored from the
// usc-write-ability-research repo (see fixtures/*.json), so the only gate is anvil.
const ANVIL_AVAILABLE = spawnSync("which", ["anvil"]).status === 0;
const maybe = ANVIL_AVAILABLE ? describe : describe.skip;

const FIXTURES = resolvePath(process.cwd(), "__tests__/fixtures");

// Anvil's first default account (funded, deterministic) — acts as the oracleService
// (and contract owner).
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

function loadArtifact(name: string): { abi: InterfaceAbi; bytecode: string } {
  const j = JSON.parse(
    readFileSync(resolvePath(FIXTURES, `${name}.json`), "utf-8")
  ) as { abi: InterfaceAbi; bytecode: string };
  return { abi: j.abi, bytecode: j.bytecode };
}

function stubPriceSource(prices: Record<string, number>): PriceSource {
  return {
    fetchUsdPrices: async (ids: string[]) =>
      new Map(ids.map((id) => [id, prices[id]!])),
  };
}

maybe(
  "oracle end-to-end against anvil (USCRelayingQuoter + TWAPReader)",
  () => {
    const DST_CHAIN = 5;
    const ORACLE_ADDR = new Wallet(DEPLOYER_KEY).address;
    let anvil: AnvilHandle;
    let provider: JsonRpcProvider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let quoterContract: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let twapReaderContract: any;
    let quoterAddress: string;
    let twapReaderAddress: string;
    let writer: RpcOracleWriter;
    let deployer: NonceManager;

    const chains = () => [
      {
        chainId: DST_CHAIN,
        rpcUrl: anvil.rpcUrl,
        coingeckoId: "ethereum",
        priceBuffer: 750n,
        baseFee: 1_000_000_000_000_000n,
      },
    ];

    const tickConfig = (): OracleServiceConfig =>
      ({
        oracleAddress: ORACLE_ADDR,
        ctcTokenId: "creditcoin-2",
        attestTokenId: "attestcoin",
        chains: chains(),
        pushIntervalMs: 60_000,
      }) as unknown as OracleServiceConfig;

    beforeAll(async () => {
      anvil = await startAnvil();
      provider = new JsonRpcProvider(anvil.rpcUrl, Network.from(31337), {
        staticNetwork: true,
      });
      // NonceManager pins the deploy sequence's nonces locally. The writer under test
      // sends its own txs from the same key, so any later owner-side tx must reset()
      // the manager first (see the penguinswap test).
      deployer = new NonceManager(new Wallet(DEPLOYER_KEY, provider));

      // TWAPReader(initialOwner, oracleService) first, then
      // USCRelayingQuoter(initialOwner, twapReader, oracleService).
      const readerArt = loadArtifact("TWAPReader");
      const reader = await new ContractFactory(
        readerArt.abi,
        readerArt.bytecode,
        deployer
      ).deploy(ORACLE_ADDR, ORACLE_ADDR);
      await reader.waitForDeployment();
      twapReaderAddress = await reader.getAddress();
      twapReaderContract = new Contract(
        twapReaderAddress,
        readerArt.abi,
        deployer
      );

      const quoterArt = loadArtifact("USCRelayingQuoter");
      const quoter = await new ContractFactory(
        quoterArt.abi,
        quoterArt.bytecode,
        deployer
      ).deploy(ORACLE_ADDR, twapReaderAddress, ORACLE_ADDR);
      await quoter.waitForDeployment();
      quoterAddress = await quoter.getAddress();
      quoterContract = new Contract(quoterAddress, quoterArt.abi, deployer);

      writer = new RpcOracleWriter({
        rpcUrl: anvil.rpcUrl,
        contractAddress: quoterAddress,
        signingKey: new Wallet(DEPLOYER_KEY).signingKey,
        staticNetwork: true,
      });
    }, 30_000);

    afterAll(async () => {
      if (writer) writer.dispose();
      if (provider) provider.destroy();
      if (anvil) await anvil.stop();
    });

    it("passes the boot checks against the real contracts", async () => {
      await writer.assertAuthorized(ORACLE_ADDR);
      await writer.assertTwapReaderAuthorized(ORACLE_ADDR);
      // The quoter deploys in TWAP mode (enum default 0).
      await expect(writer.pricingMode()).resolves.toBe("twap");
    });

    it("runs a full twap-mode tick: CTC anchor + PricingData on the quoter, ctcPerAttest on the TWAPReader", async () => {
      const gasReader = new RpcGasPriceReader(chains());
      try {
        const result = await runTick({
          config: tickConfig(),
          priceSource: stubPriceSource({
            "creditcoin-2": 0.5,
            attestcoin: 5_000_000,
            ethereum: 3000,
          }),
          twap: new TwapAggregator(0),
          gasReader,
          writer,
        });

        expect(result.mode).toBe("twap");
        const expectedAnchor = usdToScaled(0.5);
        expect(result.sourcePrice).toBe(expectedAnchor);

        // Quoter state: mode-independent CTC/USD anchor + per-chain PricingData in the
        // real struct layout.
        expect((await quoterContract.sourcePrice()) as bigint).toBe(
          expectedAnchor
        );
        const pd = await quoterContract.pricingData(DST_CHAIN);
        expect(pd.baseFee).toBe(1_000_000_000_000_000n);
        expect(pd.dstGasPrice).toBe(result.updates[0]!.pricing.dstGasPrice);
        expect(pd.dstPrice).toBe(usdToScaled(3000));
        expect(pd.srcPrice).toBe(expectedAnchor);
        expect(pd.priceBuffer).toBe(750n);

        // TWAPReader state: the tick pushed spot ctcPerAttest = 5e6 / 0.5 = 1e7 ATTEST
        // priced in CTC, 1e18 fp.
        const expectedRatio = usdRatioWad(5_000_000, 0.5);
        expect(result.ctcPerAttest).toBe(expectedRatio);
        expect((await twapReaderContract.lastPrice()) as bigint).toBe(
          expectedRatio
        );

        // With the anchor and the reader sample in place, the quoter can derive
        // ATTEST/USD: sourcePrice × ctcPerAttest / 1e18 (= 5e6 USD ×1e10).
        expect((await quoterContract.getAttestUsdPrice()) as bigint).toBe(
          usdToScaled(5_000_000)
        );
      } finally {
        gasReader.dispose();
      }
    }, 60_000);

    it("a penguinswap-mode tick pushes prices but no TWAPReader sample", async () => {
      // Toggle on-chain — setPricingMode is onlyOracle and re-anchors atomically.
      // The writer has sent txs from this key since deployment; resync the manager.
      deployer.reset();
      await (await quoterContract.setPricingMode(1, usdToScaled(0.4))).wait();

      const readerTsBefore =
        (await twapReaderContract.lastTimestamp()) as bigint;
      const gasReader = new RpcGasPriceReader(chains());
      try {
        const result = await runTick({
          config: tickConfig(),
          priceSource: stubPriceSource({
            "creditcoin-2": 0.6,
            ethereum: 3100,
          }),
          twap: new TwapAggregator(0),
          gasReader,
          writer,
        });

        expect(result.mode).toBe("penguinswap");
        expect(result.twapTxHash).toBeUndefined();
        expect((await quoterContract.sourcePrice()) as bigint).toBe(
          usdToScaled(0.6)
        );
        const pd = await quoterContract.pricingData(DST_CHAIN);
        expect(pd.dstPrice).toBe(usdToScaled(3100));
        expect(pd.srcPrice).toBe(usdToScaled(0.6));
        // No reader write happened.
        expect((await twapReaderContract.lastTimestamp()) as bigint).toBe(
          readerTsBefore
        );
      } finally {
        gasReader.dispose();
      }
    }, 60_000);

    it("surfaces a clear error reading pricingMode() on a contract without the getter", async () => {
      // The TWAPReader exposes no pricingMode() — a stand-in for pointing the service
      // at the wrong contract.
      const wrongTarget = new RpcOracleWriter({
        rpcUrl: anvil.rpcUrl,
        contractAddress: twapReaderAddress,
        signingKey: new Wallet(DEPLOYER_KEY).signingKey,
        staticNetwork: true,
      });
      try {
        await expect(wrongTarget.pricingMode()).rejects.toThrow(/not callable/);
      } finally {
        wrongTarget.dispose();
      }
    }, 30_000);

    it("times out on a stuck transaction, then replaces it with bumped fees", async () => {
      const stuckWriter = new RpcOracleWriter({
        rpcUrl: anvil.rpcUrl,
        contractAddress: quoterAddress,
        signingKey: new Wallet(DEPLOYER_KEY).signingKey,
        staticNetwork: true,
        txWaitTimeoutMs: 1_000,
      });
      const updates = (dstPrice: bigint) => [
        {
          chainId: DST_CHAIN,
          pricing: {
            baseFee: 0n,
            dstGasPrice: 1n,
            dstPrice,
            srcPrice: usdToScaled(0.5),
            priceBuffer: 0n,
          },
        },
      ];
      try {
        // With automine off the tx is accepted into the pool but never mined — the
        // bounded wait must reject instead of blocking the push loop forever.
        await provider.send("anvil_setAutomine", [false]);
        await expect(
          stuckWriter.pushPrices(usdToScaled(0.5), updates(usdToScaled(3000)))
        ).rejects.toMatchObject({ code: "TIMEOUT" });

        // Exactly one tx pending (the stuck one).
        const latest = await provider.getTransactionCount(
          ORACLE_ADDR,
          "latest"
        );
        const pending = await provider.getTransactionCount(
          ORACLE_ADDR,
          "pending"
        );
        expect(pending).toBe(latest + 1);

        // The next push must reuse the stuck tx's nonce with fees bumped ≥12.5%, so
        // the node ACCEPTS the replacement even though market gas hasn't moved (a
        // same-fee resend would be rejected as underpriced). It can't mine either, so
        // it also times out — but it must not queue a second tx behind the first.
        await expect(
          stuckWriter.pushPrices(usdToScaled(0.6), updates(usdToScaled(3000)))
        ).rejects.toMatchObject({ code: "TIMEOUT" });
        const pendingAfter = await provider.getTransactionCount(
          ORACLE_ADDR,
          "pending"
        );
        expect(pendingAfter).toBe(latest + 1);

        // Mining now lands exactly one tx — the bumped replacement, carrying the
        // second push's prices.
        await provider.send("anvil_setAutomine", [true]);
        await provider.send("evm_mine", []);
        expect(await provider.getTransactionCount(ORACLE_ADDR, "latest")).toBe(
          latest + 1
        );
        expect((await quoterContract.sourcePrice()) as bigint).toBe(
          usdToScaled(0.6)
        );
      } finally {
        await provider.send("anvil_setAutomine", [true]);
        // Flush any stranded tx so it can't bleed into other tests.
        await provider.send("evm_mine", []);
        stuckWriter.dispose();
      }
    }, 30_000);
  }
);

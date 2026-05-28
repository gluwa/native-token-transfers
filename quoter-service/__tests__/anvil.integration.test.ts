import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AddressInfo } from "node:net";

import {
  AbiCoder,
  Contract,
  ContractFactory,
  type InterfaceAbi,
  JsonRpcProvider,
  Network,
  NonceManager,
  Wallet,
  getBytes,
  zeroPadValue,
} from "ethers";

import type { QuoterServiceConfig } from "../src/config.js";
import { RpcOnChainQuoter } from "../src/quoter.js";
import { createQuoterServer } from "../src/server.js";
import { SIGNED_QUOTE_LENGTH } from "../src/signedQuote.js";

// Gate: only run if foundry artifacts + anvil are available locally. This keeps the
// test useful in dev environments without forcing CI to install foundry.
// Jest sets cwd to the workspace dir (quoter-service/), so artifacts live one level up.
const REPO_ROOT = resolvePath(process.cwd(), "..");
const QUOTER_ARTIFACT = resolvePath(
  REPO_ROOT,
  "evm/out/PenguinBridgeExecutionQuoter.sol/PenguinBridgeExecutionQuoter.json"
);
const RELAYER_ARTIFACT = resolvePath(
  REPO_ROOT,
  "evm/out/SpecialRelayer.sol/SpecialRelayer.json"
);
const ARTIFACTS_PRESENT =
  existsSync(QUOTER_ARTIFACT) && existsSync(RELAYER_ARTIFACT);
const ANVIL_AVAILABLE = spawnSync("which", ["anvil"]).status === 0;
const runIntegration = ARTIFACTS_PRESENT && ANVIL_AVAILABLE;
const maybe = runIntegration ? describe : describe.skip;

// Anvil's first default account private key (deterministic).
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Second default account — used to submit the requestExecution transaction (so the
// deployer/owner balance change doesn't muddle the payee balance check).
const USER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
// Independent quoter signing key — must be added to authorizedQuoters during setup.
const QUOTER_PRIVATE_KEY = "0x" + 0xa11cen.toString(16).padStart(64, "0");

interface AnvilHandle {
  proc: ChildProcess;
  rpcUrl: string;
  stop: () => Promise<void>;
}

async function startAnvil(): Promise<AnvilHandle> {
  // Port 0 isn't supported by anvil; pick a random high port and retry on collision.
  const port = 18545 + Math.floor(Math.random() * 1000);
  const proc = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  // Wait for RPC to become ready.
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

maybe("end-to-end against anvil", () => {
  const SRC_CHAIN = 2;
  const DST_CHAIN = 5;
  // Universal (bytes32) and EVM (20-byte) forms of the payee — must agree.
  const PAYEE_EOA = "0xc0ffee1234567890abcdef1234567890abcdef00";
  const PAYEE_ADDR =
    "0x" + "0".repeat(24) + "c0ffee1234567890abcdef1234567890abcdef00";

  // ethers v6's provider.getBalance occasionally returned stale values after tx.wait()
  // in this setup; raw eth_getBalance is reliable.
  const rawBalance = async (addr: string): Promise<bigint> =>
    BigInt((await provider.send("eth_getBalance", [addr, "latest"])) as string);

  let anvil: AnvilHandle;
  let provider: JsonRpcProvider;
  let deployer: NonceManager;
  let deployerAddress: string;
  // Typed as `any` because ethers v6 surfaces ABI methods through a dynamic Proxy that
  // TypeScript can't see; the contract call itself is what verifies correctness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let quoterContract: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let relayerContract: any;

  beforeAll(async () => {
    anvil = await startAnvil();
    provider = new JsonRpcProvider(anvil.rpcUrl, Network.from(31337), {
      staticNetwork: true,
    });
    const baseWallet = new Wallet(DEPLOYER_KEY, provider);
    deployerAddress = baseWallet.address;
    // NonceManager tracks pending nonces locally so back-to-back deploys against a
    // fresh anvil don't collide on getTransactionCount before the first tx is mined.
    deployer = new NonceManager(baseWallet);

    const quoterArt = loadArtifact(QUOTER_ARTIFACT);
    const relayerArt = loadArtifact(RELAYER_ARTIFACT);

    const quoterFactory = new ContractFactory(
      quoterArt.abi,
      quoterArt.bytecode,
      deployer
    );
    const relayerFactory = new ContractFactory(
      relayerArt.abi,
      relayerArt.bytecode,
      deployer
    );

    const quoter = await quoterFactory.deploy();
    await quoter.waitForDeployment();
    quoterContract = new Contract(
      await quoter.getAddress(),
      quoterArt.abi,
      deployer
    );

    const relayer = await relayerFactory.deploy();
    await relayer.waitForDeployment();
    relayerContract = new Contract(
      await relayer.getAddress(),
      relayerArt.abi,
      deployer
    );

    // Wire SpecialRelayer ↔ quoter.
    await (await relayerContract.setSourceChainId(SRC_CHAIN)).wait();
    await (
      await relayerContract.setExecutionQuoter(await quoter.getAddress())
    ).wait();

    // Configure pricing: deployer acts as oracle so we can push prices in one call.
    await (await quoterContract.setOracleService(deployerAddress)).wait();
    await (
      await quoterContract.priceUpdate(BigInt(2_000) * 10n ** 10n, DST_CHAIN, {
        dstPrice: BigInt(1_000) * 10n ** 10n,
        dstGasPrice: 20n * 10n ** 9n,
        priceBuffer: 1_000n,
        baseFee: 10n ** 15n, // 0.001 ether
      })
    ).wait();

    // Authorize the quoter signing key (matches what the off-chain service will use).
    const quoterSigner = new Wallet(QUOTER_PRIVATE_KEY).address;
    await (await quoterContract.addQuoter(quoterSigner)).wait();
  }, 30_000);

  afterAll(async () => {
    if (anvil) await anvil.stop();
    if (provider) provider.destroy();
  });

  it("issues a signedQuoteBytes that SpecialRelayer.requestExecution accepts", async () => {
    const wallet = new Wallet(QUOTER_PRIVATE_KEY);
    const cfg: QuoterServiceConfig = {
      signingKey: wallet.signingKey,
      quoterAddress: wallet.address,
      payeeAddress: PAYEE_ADDR,
      rpcUrl: anvil.rpcUrl,
      contractAddress: await quoterContract.getAddress(),
      srcChain: SRC_CHAIN,
      validitySeconds: 600,
      host: "127.0.0.1",
      port: 0,
      retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10 },
    };

    const quoter = new RpcOnChainQuoter({
      rpcUrl: cfg.rpcUrl,
      contractAddress: cfg.contractAddress,
      retry: cfg.retry,
    });
    try {
      // Boot check should pass — we registered this signer above.
      await quoter.assertAuthorized(cfg.quoterAddress);

      const server = createQuoterServer({ config: cfg, quoter });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      try {
        const addr = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${addr.port}`;

        const res = await fetch(`${baseUrl}/quote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dstChain: DST_CHAIN,
            dstAddr: zeroPadValue("0x" + "ab".repeat(20), 32),
            msgValue: "0",
            gasLimit: "200000",
          }),
        });
        if (res.status !== 200) {
          throw new Error(
            `unexpected status ${res.status}: ${await res.text()}`
          );
        }
        const body = (await res.json()) as {
          signedQuoteBytes: string;
          requiredPayment: string;
        };
        const signed = body.signedQuoteBytes;
        expect(getBytes(signed).length).toBe(SIGNED_QUOTE_LENGTH);

        // On-chain quote for the same inputs — should match what the service signed
        // (it reads from the same contract).
        const onChainQuote = (await quoterContract.requestQuote(
          DST_CHAIN,
          zeroPadValue("0x" + "ab".repeat(20), 32),
          "0x0000000000000000000000000000000000000000",
          zeroPadValue("0x", 32), // msgValue = 0, abi.encode(uint256)
          zeroPadValue("0x030d40", 32) // gasLimit = 200000
        )) as bigint;
        expect(BigInt(body.requiredPayment)).toBe(onChainQuote);

        // Submit to SpecialRelayer from a fresh account — verifies the contract
        // accepts the signature, decodes the payment correctly, and forwards funds
        // to the universal payee.
        const user = new Wallet(USER_KEY, provider);
        const relayerAsUser = relayerContract.connect(user);
        const payeeBalanceBefore = await rawBalance(PAYEE_EOA);
        const dstAddr = zeroPadValue("0x" + "ab".repeat(20), 32);
        const requestBytes = "0xdeadbeef";
        const relayInstructions = AbiCoder.defaultAbiCoder().encode(
          ["uint256"],
          [200_000n]
        );
        const tx = await relayerAsUser[
          "requestExecution(uint16,bytes32,address,bytes,bytes,bytes)"
        ](
          DST_CHAIN,
          dstAddr,
          "0x0000000000000000000000000000000000000000",
          signed,
          requestBytes,
          relayInstructions,
          { value: BigInt(body.requiredPayment) }
        );
        const receipt = await tx.wait();
        const payeeBalanceAfter = await rawBalance(PAYEE_EOA);
        expect(payeeBalanceAfter - payeeBalanceBefore).toBe(
          BigInt(body.requiredPayment)
        );

        // The relayer bot needs gasLimit to execute on the destination chain.
        // It reads relayInstructions from the ExecutionRequested event and decodes
        // the uint256 gasLimit out of it.
        const event = relayerContract.interface.parseLog(
          (receipt as { logs: Array<{ topics: string[]; data: string }> })
            .logs[0]!
        );
        expect(event?.name).toBe("ExecutionRequested");
        expect(event?.args["dstChain"]).toBe(BigInt(DST_CHAIN));
        expect(event?.args["dstAddr"]).toBe(dstAddr);
        expect(event?.args["requestBytes"]).toBe(requestBytes);
        expect(event?.args["relayInstructions"]).toBe(relayInstructions);
        const decodedGasLimit = AbiCoder.defaultAbiCoder().decode(
          ["uint256"],
          event?.args["relayInstructions"] as string
        )[0] as bigint;
        expect(decodedGasLimit).toBe(200_000n);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      quoter.dispose();
    }
  }, 60_000);
});

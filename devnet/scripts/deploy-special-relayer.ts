#!/usr/bin/env ts-node

/**
 * Deploy + wire the Penguin Bridge SpecialRelayer path on a devnet source chain.
 *
 * This is what lets the off-chain relayer-bot (which watches
 * `SpecialRelayer.ExecutionRequested`) be exercised end-to-end on the local devnet.
 * The base devnet only sets up the plain Core/NTT path, so the SpecialRelayer + quoter
 * have to be deployed and wired in separately.
 *
 * The script is idempotent and is meant to be run TWICE around the NTT deploy:
 *
 *   1) After deploy-core + deploy-tokenbridge, BEFORE deploy-ntt-forge:
 *        npx tsx devnet/scripts/deploy-special-relayer.ts --chain=chainA
 *      → deploys PenguinBridgeExecutionQuoter (priced to zero for dev), deploys
 *        SpecialRelayer (quoter + sourceChainId), records all three in the manifest,
 *        and prints the RELEASE_SPECIAL_RELAYER_ADDRESS to use for the NTT deploy.
 *
 *   2) After deploy-ntt-forge (wired via RELEASE_SPECIAL_RELAYER_ADDRESS) + configure-ntt:
 *        npx tsx devnet/scripts/deploy-special-relayer.ts --chain=chainA
 *      → sees the relayer is already deployed, skips redeploy, and enables special
 *        relaying for the destination chain on the source transceiver.
 *
 * Env:
 *   DEPLOYER_KEY      - required (anvil deployer; matches the rest of the devnet scripts)
 *   QUOTE_SIGNER_KEY  - optional; key that signs execution quotes. Defaults to the well-known
 *                       anvil account #1. Its address is registered as an authorized quoter.
 *                       Use the SAME key when sending a --special transfer.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { ethers } from "ethers";
import "dotenv/config";

type ChainName = "chainA" | "chainB";

// Well-known anvil account #1 — fine as a devnet quote signer.
const DEFAULT_QUOTE_SIGNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const projectRoot = path.resolve(
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..")
);
const manifestPath = path.join(
  projectRoot,
  "devnet",
  "config",
  "deployment.local.json"
);

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.split("=");
      return [k.replace(/^--/, ""), v ?? ""];
    })
  );
  const chain = (args.chain as ChainName) || "chainA";
  // Destination chain to enable special relaying toward. Defaults to the other chain.
  const dst = (args.dst as ChainName) || (chain === "chainA" ? "chainB" : "chainA");
  return { chain, dst };
}

function parseSimpleEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function chainEnv(chain: ChainName): Record<string, string> {
  const p = path.join(projectRoot, "devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  return parseSimpleEnv(fs.readFileSync(p, "utf8"));
}

function readManifest(): any {
  if (!fs.existsSync(manifestPath))
    throw new Error("deployment.local.json not found. Run deploy-core.ts first.");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifest(m: any) {
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
}

function runForge(scriptFqn: string, rpcUrl: string, deployerKey: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "forge",
      ["script", scriptFqn, "--rpc-url", rpcUrl, "--private-key", deployerKey, "--broadcast", "-vvv"],
      { stdio: "inherit", cwd: path.join(projectRoot, "evm"), env: { ...process.env, ...env } }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`forge exited ${code}`))));
    child.on("error", reject);
  });
}

/** Pull the most recent deployed address for a contract name from a forge broadcast. */
function broadcastAddress(scriptFile: string, evmChainId: number, contractName: string): string {
  const p = path.join(
    projectRoot, "evm", "broadcast", scriptFile, String(evmChainId), "run-latest.json"
  );
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const txs: Array<{ contractName?: string; contractAddress?: string }> = raw?.transactions ?? [];
  const hit = txs.filter((t) => t.contractName === contractName && t.contractAddress).pop();
  if (!hit?.contractAddress) throw new Error(`${contractName} not found in ${p}`);
  return ethers.getAddress(hit.contractAddress);
}

async function main() {
  const DEPLOYER_KEY = process.env["DEPLOYER_KEY"];
  if (!DEPLOYER_KEY) {
    console.error("DEPLOYER_KEY missing. Set it in your root .env (see devnet/config/.env.example).");
    process.exit(1);
  }
  const QUOTE_SIGNER_KEY = process.env["QUOTE_SIGNER_KEY"] || DEFAULT_QUOTE_SIGNER_KEY;
  const signerAddr = new ethers.Wallet(QUOTE_SIGNER_KEY).address;

  const { chain, dst } = parseArgs();
  const srcCfg = chainEnv(chain);
  const dstCfg = chainEnv(dst);
  const rpcUrl = srcCfg["RPC_URL"];
  const evmChainId = Number(srcCfg["CHAIN_ID"]);
  const srcWhChainId = Number(srcCfg["WORMHOLE_CHAIN_ID"]);
  const dstWhChainId = Number(dstCfg["WORMHOLE_CHAIN_ID"]);

  const manifest = readManifest();
  const sec = manifest.chains?.[chain];
  if (!sec) throw new Error(`Missing chains.${chain} in manifest; run deploy-core.ts first.`);

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

  // ── Phase 1: deploy quoter + relayer (skipped if already in the manifest) ──────────
  if (!sec.special_relayer || !sec.execution_quoter) {
    console.log(`[${chain}] deploying PenguinBridgeExecutionQuoter (signer=${signerAddr})...`);
    await runForge(
      "script/DeployPenguinBridgeExecutionQuoter.s.sol:DeployPenguinBridgeExecutionQuoter",
      rpcUrl, DEPLOYER_KEY,
      { EXECUTION_QUOTER_ORACLE_SERVICE: deployer.address, EXECUTION_QUOTER_SIGNER: signerAddr }
    );
    const quoter = broadcastAddress(
      "DeployPenguinBridgeExecutionQuoter.s.sol", evmChainId, "PenguinBridgeExecutionQuoter"
    );

    // Price the quoter to zero for the destination chain: sourcePrice=1 (non-zero so it's
    // "set"), all PricingData fields 0 → requestQuote() returns 0. The deployer is the
    // oracle service (set above), so it may push prices.
    const quoterC = new ethers.Contract(
      quoter,
      [
        "function priceUpdate(uint64 sourcePrice, uint16 chainId, (uint64 dstPrice,uint64 dstGasPrice,uint64 priceBuffer,uint64 baseFee) price)",
        "function requestQuote(uint16,bytes32,address,bytes,bytes) view returns (uint256)",
      ],
      deployer
    );
    await (await quoterC.priceUpdate(1, dstWhChainId, [0, 0, 0, 0])).wait();
    console.log(`[${chain}] quoter ${quoter} priced to 0 for dst chain ${dstWhChainId}`);

    console.log(`[${chain}] deploying SpecialRelayer (sourceChainId=${srcWhChainId})...`);
    await runForge(
      "script/DeploySpecialRelayer.s.sol:DeploySpecialRelayer",
      rpcUrl, DEPLOYER_KEY,
      { SPECIAL_RELAYER_EXECUTION_QUOTER: quoter, SPECIAL_RELAYER_SOURCE_CHAIN_ID: String(srcWhChainId) }
    );
    const relayer = broadcastAddress("DeploySpecialRelayer.s.sol", evmChainId, "SpecialRelayer");

    sec.execution_quoter = quoter;
    sec.special_relayer = relayer;
    sec.quote_signer = signerAddr;
    writeManifest(manifest);
    console.log(`[${chain}] SpecialRelayer: ${relayer}`);
    console.log("");
    console.log("Next: deploy NTT wired to this relayer, e.g.");
    console.log(`  RELEASE_SPECIAL_RELAYER_ADDRESS=${relayer} \\`);
    console.log(`    npx tsx devnet/scripts/deploy-ntt-forge.ts --chain=${chain} --variant=noRateLimiting --mode=locking`);
    console.log(`  npx tsx devnet/scripts/deploy-ntt-forge.ts --chain=${dst} --variant=noRateLimiting --mode=locking`);
    console.log("  npx tsx devnet/scripts/configure-ntt.ts");
    console.log(`  npx tsx devnet/scripts/deploy-special-relayer.ts --chain=${chain}   # re-run to enable relaying`);
    // The NTT can only be wired to this relayer by a deploy that happens AFTER it
    // (specialRelayer is immutable), so phase 2 is for a subsequent run, not this one.
    return;
  }
  console.log(`[${chain}] SpecialRelayer already deployed at ${sec.special_relayer} (skipping deploy)`);

  // ── Phase 2: enable special relaying once the transceiver exists and is wired ──────
  if (!sec.ntt_transceiver) {
    console.log(`[${chain}] no NTT transceiver yet — deploy NTT (wired) then re-run to enable relaying.`);
    return;
  }
  const tr = new ethers.Contract(
    sec.ntt_transceiver,
    [
      "function specialRelayer() view returns (address)",
      "function isSpecialRelayingEnabled(uint16) view returns (bool)",
      "function setIsSpecialRelayingEnabled(uint16 chainId, bool isEnabled)",
    ],
    deployer
  );
  let wired: string;
  try {
    wired = (await tr.specialRelayer()).toLowerCase();
  } catch {
    console.log(
      `[${chain}] transceiver ${sec.ntt_transceiver} not reachable (stale manifest?). ` +
      `Deploy NTT wired with RELEASE_SPECIAL_RELAYER_ADDRESS=${sec.special_relayer}, then re-run.`
    );
    return;
  }
  if (wired !== sec.special_relayer.toLowerCase()) {
    console.log(
      `[${chain}] transceiver.specialRelayer()=${wired} != ${sec.special_relayer}.\n` +
      `  NTT must be (re)deployed with RELEASE_SPECIAL_RELAYER_ADDRESS=${sec.special_relayer} ` +
      `(specialRelayer is immutable). Then re-run this script.`
    );
    return;
  }
  if (await tr.isSpecialRelayingEnabled(dstWhChainId)) {
    console.log(`[${chain}] special relaying already enabled for dst chain ${dstWhChainId}.`);
  } else {
    await (await tr.setIsSpecialRelayingEnabled(dstWhChainId, true)).wait();
    console.log(`[${chain}] special relaying enabled for dst chain ${dstWhChainId}. ✅`);
  }
  console.log(`[${chain}] ready: SpecialRelayer ${sec.special_relayer}, quoter ${sec.execution_quoter}, signer ${sec.quote_signer}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

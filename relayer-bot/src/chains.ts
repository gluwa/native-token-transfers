import { getAddress } from "ethers";

import type { ChainId } from "./types.js";

/// Per-chain runtime configuration. One entry per chain the bot operates on. A chain can
/// act as a SOURCE (we scan its SpecialRelayer for ExecutionRequested) and/or as a
/// DESTINATION (we submit receiveMessage to its WormholeTransceiver).
export interface ChainConfig {
  /// Wormhole chain id (uint16). The id used in the ExecutionRequested event's dstChain
  /// and in Wormholescan URLs / VAA emitter chain.
  chainId: ChainId;
  /// Human-readable label for logs/metrics.
  name: string;
  /// JSON-RPC URL for this chain.
  rpcUrl: string;
  /// SpecialRelayer contract on this chain (the source-side event emitter). Optional
  /// because a destination-only chain need not run a listener.
  specialRelayerAddress?: string;
  /// Wormhole Core bridge on this chain (emits LogMessagePublished). Required on source
  /// chains so the correlator can find the published message.
  coreBridgeAddress?: string;
  /// This chain's WormholeTransceiver address (20-byte). Optional defense-in-depth checks
  /// in both directions: delivery asserts the event's dstAddr decodes to this before
  /// sending TO this chain, and the correlator only accepts LogMessagePublished entries
  /// sent by this address when relaying FROM it (publishMessage is permissionless).
  expectedTransceiver?: string;
  /// Blocks to wait behind the chain head before treating a source log as final. Differs
  /// per chain (e.g. Ethereum ~15, BSC ~15, Avalanche ~1).
  confirmations: number;
  /// Block to start scanning from when no block_tracker row exists yet.
  genesisBlock: bigint;
  /// EVM chain id. When set, providers are constructed as static networks (no
  /// auto-detection round-trips). NOT the Wormhole chain id.
  evmChainId?: number;
}

export class UnknownChainError extends Error {
  constructor(public readonly chainId: ChainId) {
    super(`no ChainConfig registered for Wormhole chain id ${chainId}`);
    this.name = "UnknownChainError";
  }
}

export interface ChainRegistry {
  get(chainId: ChainId): ChainConfig | undefined;
  /// Throws UnknownChainError if absent. Used on the delivery hot path.
  require(chainId: ChainId): ChainConfig;
  all(): ChainConfig[];
}

/// Normalizes and validates addresses, and enforces one entry per chain id.
export function makeChainRegistry(chains: ChainConfig[]): ChainRegistry {
  const byId = new Map<ChainId, ChainConfig>();
  for (const raw of chains) {
    if (byId.has(raw.chainId)) {
      throw new Error(`duplicate ChainConfig for chain id ${raw.chainId}`);
    }
    const normalized: ChainConfig = {
      ...raw,
      specialRelayerAddress: raw.specialRelayerAddress
        ? getAddress(raw.specialRelayerAddress)
        : undefined,
      coreBridgeAddress: raw.coreBridgeAddress
        ? getAddress(raw.coreBridgeAddress)
        : undefined,
      expectedTransceiver: raw.expectedTransceiver
        ? getAddress(raw.expectedTransceiver)
        : undefined,
    };
    byId.set(raw.chainId, normalized);
  }
  return {
    get: (chainId) => byId.get(chainId),
    require: (chainId) => {
      const c = byId.get(chainId);
      if (!c) throw new UnknownChainError(chainId);
      return c;
    },
    all: () => [...byId.values()],
  };
}

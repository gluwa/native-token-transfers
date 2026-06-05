import { Interface } from "ethers";

/// SpecialRelayer.requestExecution emits this on the source chain. The relayer bot
/// watches it. dstChain + dstAddr are indexed; requestBytes + relayInstructions are data.
/// requestBytes is byte-for-byte the Wormhole Core message payload (see correlator.ts);
/// relayInstructions is abi.encode(uint256 gasLimit).
/// Source: evm/src/SpecialRelayer/SpecialRelayer.sol
export const SPECIAL_RELAYER_ABI = [
  "event ExecutionRequested(uint16 indexed dstChain, bytes32 indexed dstAddr, bytes requestBytes, bytes relayInstructions)",
] as const;

/// Wormhole Core bridge. The source tx that emits ExecutionRequested also calls
/// publishMessage, emitting LogMessagePublished. We correlate the two by payload.
export const CORE_ABI = [
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
  "function getCurrentGuardianSetIndex() view returns (uint32)",
  "function messageFee() view returns (uint256)",
] as const;

/// Destination WormholeTransceiver. receiveMessage(vaa) is the manual-delivery entrypoint
/// the bot calls; it runs parseAndVerifyVM and keys replay protection on the VAA's
/// double-keccak body hash (isVAAConsumed). Source: evm/src/interfaces/IWormholeTransceiver.sol
export const WORMHOLE_TRANSCEIVER_ABI = [
  "function receiveMessage(bytes encodedMessage)",
  "function isVAAConsumed(bytes32 hash) view returns (bool)",
  "function getWormholePeer(uint16 chainId) view returns (bytes32)",
] as const;

/// Custom errors the destination call can revert with. We decode reverts against this to
/// classify permanent vs. transient failures and to detect already-delivered messages.
/// Names verified in evm/src/interfaces/IWormholeTransceiver.sol +
/// IWormholeTransceiverState.sol + IManagerBase.sol.
export const TRANSCEIVER_ERROR_ABI = [
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
  "error InvalidVaa(string reason)",
  "error InvalidWormholePeer(uint16 chainId, bytes32 peerAddress)",
  "error PeerNotRegistered(uint16 chainId)",
  "error UnexpectedAdditionalMessages()",
] as const;

export const specialRelayerInterface = new Interface(SPECIAL_RELAYER_ABI);
export const coreInterface = new Interface(CORE_ABI);
export const wormholeTransceiverInterface = new Interface(
  WORMHOLE_TRANSCEIVER_ABI
);
export const transceiverErrorInterface = new Interface(TRANSCEIVER_ERROR_ABI);

export const EXECUTION_REQUESTED_TOPIC =
  specialRelayerInterface.getEvent("ExecutionRequested")!.topicHash;

export const LOG_MESSAGE_PUBLISHED_TOPIC = coreInterface.getEvent(
  "LogMessagePublished"
)!.topicHash;

/// Attempts to decode a revert's error data to one of the known transceiver errors.
/// Returns the error name (e.g. "TransferAlreadyCompleted") or null if it doesn't match.
export function decodeTransceiverError(data: unknown): string | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) {
    return null;
  }
  try {
    const parsed = transceiverErrorInterface.parseError(data);
    return parsed?.name ?? null;
  } catch {
    return null;
  }
}

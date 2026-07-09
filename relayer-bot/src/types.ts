/// Wormhole chain id (uint16). NOT an EVM chain id — e.g. 2 = Ethereum, 4 = BSC,
/// 6 = Avalanche, 30 = Base. See https://docs.wormhole.com/wormhole/reference/constants
export type ChainId = number;

/// `0x`-prefixed hex string.
export type Hex = string;

/// Lifecycle of a relay, persisted in the `transactions` table.
/// pending    → inserted when the event is discovered (before any wallet work)
/// submitting → nonce + wallet reserved and committed BEFORE broadcast (intent log); a
///              crash here is recovered by resubmitting that exact nonce
/// submitted  → destination tx broadcast and its hash recorded
/// confirmed  → cron found an on-chain receipt with status 1
/// failed     → cron/worker saw a revert/timeout; retry_count is incremented
/// dead_letter → retry_count reached max_retries; no further retries
export type TxStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "dead_letter";

/// A row of the `transactions` table, camelCased. The source of truth for execution
/// state, retry eligibility, and audit history.
export interface TransactionRecord {
  id: string;
  sourceChainId: ChainId;
  destinationChainId: ChainId;
  relayerAddress: string;
  /// Hash of the source-chain transaction that emitted ExecutionRequested. Together with
  /// sourceChainId this is the idempotency key.
  eventTxHash: Hex;
  /// Decoded relay-relevant data (the DecodedEvent.payload), stored as JSONB.
  payload: unknown;
  status: TxStatus;
  /// Hash of the destination-chain delivery tx; null until the worker broadcasts.
  relayTxHash: Hex | null;
  walletUsed: string | null;
  /// Nonce used for the destination tx on `walletUsed`. (The design doc spells this
  /// `nonce_usd`; corrected to `nonce_used`.)
  nonceUsed: number | null;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

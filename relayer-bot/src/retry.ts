export interface RetryOptions {
  /// Total attempts including the first try. 1 disables retry entirely.
  maxAttempts: number;
  /// First backoff delay; subsequent attempts double up to `maxDelayMs`.
  initialDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
};

/// Treats ethers v6 transport-layer error codes as transient. Contract reverts
/// (`CALL_EXCEPTION`) and bad input (`INVALID_ARGUMENT`, `BAD_DATA`) are not retryable —
/// retrying them just wastes time before returning the same error.
export function isTransientRpcError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT"
  );
}

/// ioredis surfaces connection-level failures as errors whose code is one of these (or
/// as `MaxRetriesPerRequestError`). Command errors (WRONGTYPE, NOGROUP, etc.) are not
/// transient and should surface immediately.
export function isTransientRedisError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const name = (err as { name?: unknown }).name;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "ENOTFOUND" ||
    name === "MaxRetriesPerRequestError"
  );
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/// Returns a value in [0.75, 1.25] — ±25% multiplicative jitter on the backoff window.
/// Spreads concurrent retries so a transient outage doesn't cause every in-flight
/// operation to retry in lockstep when the dependency recovers.
const defaultJitter = (): number => 0.75 + Math.random() * 0.5;

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  isTransient: (err: unknown) => boolean = isTransientRpcError,
  jitter: () => number = defaultJitter
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === opts.maxAttempts;
      if (isLast || !isTransient(err)) throw err;
      const base = Math.min(
        opts.initialDelayMs * 2 ** (attempt - 1),
        opts.maxDelayMs
      );
      await sleep(Math.round(base * jitter()));
    }
  }
  // Unreachable — the loop either returns or throws on the last attempt.
  throw lastErr;
}

export { defaultJitter };

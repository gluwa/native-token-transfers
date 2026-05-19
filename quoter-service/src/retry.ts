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
/// retrying them just wastes the user's time before returning the same error.
export function isTransientRpcError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "NETWORK_ERROR" || code === "SERVER_ERROR" || code === "TIMEOUT";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === opts.maxAttempts;
      if (isLast || !isTransientRpcError(err)) throw err;
      const delay = Math.min(opts.initialDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws on the last attempt.
  throw lastErr;
}

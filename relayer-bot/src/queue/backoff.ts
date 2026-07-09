import { defaultJitter } from "../retry.js";

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /// Test seam — replace the ±25% jitter with a deterministic factor.
  jitter?: () => number;
}

/// Exponential backoff with ±25% jitter, shared by the worker's nack path and the cron's
/// re-enqueue path: baseMs * 2^retryCount, capped at maxMs.
export function computeBackoffDelayMs(
  retryCount: number,
  opts: BackoffOptions = {}
): number {
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 60_000;
  const jitter = opts.jitter ?? defaultJitter;
  const exp = Math.min(baseMs * 2 ** Math.max(0, retryCount), maxMs);
  return Math.round(exp * jitter());
}

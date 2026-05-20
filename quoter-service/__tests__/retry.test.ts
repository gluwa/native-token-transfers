import { DEFAULT_RETRY, isTransientRpcError, withRetry } from "../src/retry.js";

describe("isTransientRpcError", () => {
  it("retries NETWORK_ERROR / SERVER_ERROR / TIMEOUT", () => {
    expect(isTransientRpcError({ code: "NETWORK_ERROR" })).toBe(true);
    expect(isTransientRpcError({ code: "SERVER_ERROR" })).toBe(true);
    expect(isTransientRpcError({ code: "TIMEOUT" })).toBe(true);
  });

  it("does not retry contract reverts or bad input", () => {
    expect(isTransientRpcError({ code: "CALL_EXCEPTION" })).toBe(false);
    expect(isTransientRpcError({ code: "INVALID_ARGUMENT" })).toBe(false);
    expect(isTransientRpcError({ code: "BAD_DATA" })).toBe(false);
    expect(isTransientRpcError(new Error("plain"))).toBe(false);
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  const opts = { ...DEFAULT_RETRY, maxAttempts: 4, initialDelayMs: 10, maxDelayMs: 100 };
  const noSleep = (_ms: number): Promise<void> => Promise.resolve();

  it("returns the first successful value without retrying", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return "ok";
    }, opts, noSleep);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient errors up to maxAttempts and then surfaces the last error", async () => {
    let calls = 0;
    const err = Object.assign(new Error("rpc down"), { code: "NETWORK_ERROR" });
    await expect(
      withRetry(async () => {
        calls += 1;
        throw err;
      }, opts, noSleep),
    ).rejects.toBe(err);
    expect(calls).toBe(opts.maxAttempts);
  });

  it("recovers after a transient failure followed by a success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("flap"), { code: "SERVER_ERROR" });
      }
      return 42;
    }, opts, noSleep);
    expect(result).toBe(42);
    expect(calls).toBe(3);
  });

  it("does not retry on contract reverts", async () => {
    let calls = 0;
    const err = Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" });
    await expect(
      withRetry(async () => {
        calls += 1;
        throw err;
      }, opts, noSleep),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it("backs off with exponential growth, capped by maxDelayMs", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const err = Object.assign(new Error("flap"), { code: "TIMEOUT" });
    const retryOpts = { maxAttempts: 5, initialDelayMs: 50, maxDelayMs: 120 };
    // Pin jitter to 1.0 so the test can assert exact backoff math without flakiness.
    const noJitter = (): number => 1.0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw err;
      }, retryOpts, sleep, noJitter),
    ).rejects.toBe(err);
    expect(calls).toBe(5);
    // No sleep after the final attempt — only 4 backoff windows.
    expect(delays).toEqual([50, 100, 120, 120]);
  });

  it("applies ±25% jitter to the backoff window", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    const err = Object.assign(new Error("flap"), { code: "NETWORK_ERROR" });
    const retryOpts = { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 100 };
    // Force jitter to its bounds: first call returns min, second returns max.
    const jitters = [0.75, 1.25, 0.75];
    let idx = 0;
    await expect(
      withRetry(async () => {
        throw err;
      }, retryOpts, sleep, () => jitters[idx++]!),
    ).rejects.toBe(err);
    expect(delays).toEqual([75, 125, 75]);
  });

  it("disables retry when maxAttempts is 1", async () => {
    let calls = 0;
    const err = Object.assign(new Error("flap"), { code: "TIMEOUT" });
    await expect(
      withRetry(async () => {
        calls += 1;
        throw err;
      }, { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 10 }, noSleep),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });
});

import { realSleep } from "../src/roles/shared.js";

describe("realSleep", () => {
  it("wakes early when the signal aborts", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleeping = realSleep(60_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("resolves immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await realSleep(60_000, controller.signal);
  });

  it("still sleeps normally without a signal", async () => {
    const start = Date.now();
    await realSleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

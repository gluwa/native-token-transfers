import { createLogger } from "../src/logger.js";
import {
  NoopAlerter,
  SlackAlerter,
  createAlerter,
} from "../src/alerts/alerter.js";

const logger = createLogger({}, { write: () => {} });

describe("SlackAlerter", () => {
  it("posts an alert to the webhook", async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.test/abc",
      logger,
      postImpl: async (url, body) => {
        posts.push({ url, body });
        return { ok: true, status: 200 };
      },
    });
    await alerter.alert("dead_letter.accumulation", { count: 5 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://hooks.slack.test/abc");
    expect(posts[0]!.body).toContain("dead_letter.accumulation");
    expect(posts[0]!.body).toContain("count");
  });

  it("suppresses duplicate alerts within the dedup window, then posts again after it", async () => {
    let t = 0;
    const posts: string[] = [];
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.test/abc",
      logger,
      dedupWindowMs: 10_000,
      now: () => t,
      postImpl: async (_url, body) => {
        posts.push(body);
        return { ok: true, status: 200 };
      },
    });
    await alerter.alert("cron.failure", { error: "x" });
    await alerter.alert("cron.failure", { error: "x" }); // duplicate, suppressed
    expect(posts).toHaveLength(1);
    t += 10_001;
    await alerter.alert("cron.failure", { error: "x" }); // window passed
    expect(posts).toHaveLength(2);
  });

  it("treats different fields as distinct alerts", async () => {
    const posts: string[] = [];
    const alerter = new SlackAlerter({
      webhookUrl: "https://hooks.slack.test/abc",
      logger,
      now: () => 0,
      postImpl: async (_url, body) => {
        posts.push(body);
        return { ok: true, status: 200 };
      },
    });
    await alerter.alert("wallet.low_balance", { wallet: "0xaaa" });
    await alerter.alert("wallet.low_balance", { wallet: "0xbbb" });
    expect(posts).toHaveLength(2);
  });
});

describe("createAlerter", () => {
  it("returns a NoopAlerter when no webhook is configured", () => {
    expect(createAlerter(undefined, logger)).toBeInstanceOf(NoopAlerter);
  });
  it("returns a SlackAlerter when a webhook is configured", () => {
    expect(createAlerter("https://hooks.slack.test/x", logger)).toBeInstanceOf(
      SlackAlerter
    );
  });
});

import { type LogFields, type Logger } from "../logger.js";

/// Raises operational alerts (Slack in prod). Every alert is also logged, so logs remain
/// the single source of truth.
export interface Alerter {
  alert(event: string, fields?: LogFields): Promise<void>;
}

export class NoopAlerter implements Alerter {
  async alert(): Promise<void> {}
}

interface PostResponse {
  ok: boolean;
  status: number;
}
type PostFn = (url: string, body: string) => Promise<PostResponse>;

export interface SlackAlerterOptions {
  webhookUrl: string;
  logger: Logger;
  /// Suppress identical (event, fields) alerts within this window (default 5 min).
  dedupWindowMs?: number;
  /// Test seams.
  postImpl?: PostFn;
  now?: () => number;
}

/// Posts alerts to a Slack incoming webhook, de-duplicating identical alerts within a
/// window so a flapping condition doesn't spam the channel. Uses bare fetch — no Slack
/// SDK dependency, consistent with the repo's minimal-dep style.
export class SlackAlerter implements Alerter {
  private readonly webhookUrl: string;
  private readonly logger: Logger;
  private readonly dedupWindowMs: number;
  private readonly post: PostFn;
  private readonly now: () => number;
  private readonly lastSent = new Map<string, number>();

  constructor(opts: SlackAlerterOptions) {
    this.webhookUrl = opts.webhookUrl;
    this.logger = opts.logger;
    this.dedupWindowMs = opts.dedupWindowMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.post =
      opts.postImpl ??
      (async (url, body) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        return { ok: res.ok, status: res.status };
      });
  }

  async alert(event: string, fields: LogFields = {}): Promise<void> {
    // Alerts are always logged.
    this.logger.warn(`alert:${event}`, fields);

    const key = `${event}:${stableStringify(fields)}`;
    const now = this.now();
    // Prune entries older than the window so the dedup map can't grow unbounded over a
    // long-lived process (high-cardinality fields like a changing `count` make new keys).
    for (const [k, t] of this.lastSent) {
      if (now - t >= this.dedupWindowMs) this.lastSent.delete(k);
    }
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.dedupWindowMs) {
      return; // suppressed within the dedup window
    }
    this.lastSent.set(key, now);

    const text = formatSlackText(event, fields);
    try {
      const res = await this.post(this.webhookUrl, JSON.stringify({ text }));
      if (!res.ok) {
        this.logger.error("alert.post_failed", { event, status: res.status });
      }
    } catch (err) {
      this.logger.error("alert.post_error", { event, error: String(err) });
    }
  }
}

function stableStringify(fields: LogFields): string {
  return Object.keys(fields)
    .sort()
    .map((k) => `${k}=${String(fields[k])}`)
    .join(",");
}

function formatSlackText(event: string, fields: LogFields): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length > 0
    ? `:rotating_light: *${event}*\n${parts.join("\n")}`
    : `:rotating_light: *${event}*`;
}

/// Returns a SlackAlerter when a webhook is configured, else a NoopAlerter (alerts still
/// log at warn level via the role's logger before reaching here in the Slack case).
export function createAlerter(
  webhookUrl: string | undefined,
  logger: Logger
): Alerter {
  return webhookUrl
    ? new SlackAlerter({ webhookUrl, logger })
    : new NoopAlerter();
}

import { type Server, createServer } from "node:http";

import type { Logger } from "./logger.js";

export interface HealthHandle {
  /// Mark a successful unit of work (scan tick / cron run); refreshes the heartbeat.
  heartbeat(): void;
  close(): Promise<void>;
}

export interface StartHealthServerOptions {
  host: string;
  port: number;
  role: string;
  logger: Logger;
  /// If set, /health reports 503 when the last heartbeat is older than this.
  maxHeartbeatAgeMs?: number;
  now?: () => number;
}

/// A tiny liveness/health server reused across roles (same node:http pattern as
/// quoter-service). Backs the Docker HEALTHCHECK and K8s probes.
export function startHealthServer(
  opts: StartHealthServerOptions
): HealthHandle {
  const now = opts.now ?? (() => Date.now());
  let lastBeat = now();

  const server: Server = createServer((req, res) => {
    if (
      req.method !== "GET" ||
      !(req.url === "/health" || req.url === "/healthz")
    ) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const ageMs = now() - lastBeat;
    const stale =
      opts.maxHeartbeatAgeMs !== undefined && ageMs > opts.maxHeartbeatAgeMs;
    res.writeHead(stale ? 503 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: stale ? "stale" : "ok",
        role: opts.role,
        heartbeatAgeMs: ageMs,
      })
    );
  });

  server.listen(opts.port, opts.host, () => {
    opts.logger.info("health.listening", {
      host: opts.host,
      port: opts.port,
      role: opts.role,
    });
  });

  return {
    heartbeat: () => {
      lastBeat = now();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

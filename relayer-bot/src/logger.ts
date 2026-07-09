/// Structured JSON logging. The design doc requires one structured record per major
/// action and status transition, carrying context like chain_id, event_tx_hash,
/// wallet_used, and latency measurements. quoter-service uses bare console.log; we
/// formalize that minimally here without taking on a logging dependency.

export type LogValue = string | number | boolean | bigint | null | undefined;
export type LogFields = Record<string, LogValue>;

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /// Returns a logger that merges `bound` into every record (e.g. { role, chain_id }).
  child(bound: LogFields): Logger;
}

/// Substrings that, if present in a field key, cause the value to be masked. Defense in
/// depth against accidentally logging a private key / secret.
const REDACT_SUBSTRINGS = [
  "key",
  "secret",
  "privatekey",
  "mnemonic",
  "password",
];

function shouldRedact(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_SUBSTRINGS.some((s) => k.includes(s));
}

function serializeValue(value: LogValue): string | number | boolean | null {
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  return value;
}

export interface CreateLoggerOptions {
  /// Override the sink (defaults to process.stdout). Test seam.
  write?: (line: string) => void;
  /// Override the clock (defaults to Date.now). Test seam.
  now?: () => number;
}

export function createLogger(
  base: LogFields = {},
  options: CreateLoggerOptions = {}
): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? (() => Date.now());

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    const record: Record<string, string | number | boolean | null> = {
      ts: new Date(now()).toISOString(),
      level,
      msg,
    };
    const merged = { ...base, ...(fields ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      record[key] = shouldRedact(key) ? "[redacted]" : serializeValue(value);
    }
    write(`${JSON.stringify(record)}\n`);
  };

  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bound) => createLogger({ ...base, ...bound }, options),
  };
}

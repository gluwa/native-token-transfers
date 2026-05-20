import {
  IncomingMessage,
  ServerResponse,
  createServer,
  type Server,
} from "node:http";
import { isHexString } from "ethers";

import type { QuoterServiceConfig } from "./config.js";
import { type OnChainQuoter, type QuoteRequest } from "./quoter.js";
import { signQuote } from "./signedQuote.js";

interface QuoteRequestBody {
  dstChain: unknown;
  dstAddr: unknown;
  msgValue?: unknown;
  gasLimit?: unknown;
}

export interface CreateServerOptions {
  config: QuoterServiceConfig;
  quoter: OnChainQuoter;
  /// Override the clock for tests.
  now?: () => number;
}

interface ParsedBody {
  parsed: QuoteRequest;
}

function parseBigInt(name: string, raw: unknown): bigint {
  if (raw === undefined || raw === null || raw === "") return 0n;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new BadRequest(`${name} must be a non-negative integer`);
    }
    return BigInt(raw);
  }
  if (typeof raw === "string") {
    try {
      const v = BigInt(raw);
      if (v < 0n) throw new BadRequest(`${name} must be non-negative`);
      return v;
    } catch (err) {
      if (err instanceof BadRequest) throw err;
      throw new BadRequest(`${name} is not a valid integer`);
    }
  }
  throw new BadRequest(`${name} must be a number or numeric string`);
}

function parseUint16(name: string, raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > 0xffff
  ) {
    throw new BadRequest(`${name} must be a uint16`);
  }
  return raw;
}

function parseHexAddress(name: string, raw: unknown): string {
  if (typeof raw !== "string") {
    throw new BadRequest(`${name} must be a hex string`);
  }
  if (!isHexString(raw, 20) && !isHexString(raw, 32)) {
    throw new BadRequest(`${name} must be a 20- or 32-byte hex string`);
  }
  return raw;
}

class BadRequest extends Error {}

function parseQuoteRequest(body: QuoteRequestBody): ParsedBody {
  const dstChain = parseUint16("dstChain", body.dstChain);
  const dstAddr = parseHexAddress("dstAddr", body.dstAddr);
  const msgValue = parseBigInt("msgValue", body.msgValue);
  const gasLimit = parseBigInt("gasLimit", body.gasLimit);
  return { parsed: { dstChain, dstAddr, msgValue, gasLimit } };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Cap request bodies; legitimate quote requests are tiny (< 1 KB).
  const MAX_BODY_BYTES = 16 * 1024;
  for await (const chunk of req) {
    const buf =
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new BadRequest("request body too large");
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new BadRequest("invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

export function createQuoterServer(options: CreateServerOptions): Server {
  const { config, quoter, now = () => Math.floor(Date.now() / 1000) } = options;

  const handleQuote = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof BadRequest ? err.message : "bad request",
      });
      return;
    }

    let parsed: QuoteRequest;
    try {
      parsed = parseQuoteRequest((raw ?? {}) as QuoteRequestBody).parsed;
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof BadRequest ? err.message : "bad request",
      });
      return;
    }

    let requiredPayment: bigint;
    try {
      requiredPayment = await quoter.fetchRequiredPayment(parsed);
    } catch (err) {
      sendJson(res, 502, {
        error: "upstream quote fetch failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const expiryTime = BigInt(now() + config.validitySeconds);
    const signed = signQuote(
      {
        quoterAddress: config.quoterAddress,
        payeeAddress: config.payeeAddress,
        srcChain: config.srcChain,
        dstChain: parsed.dstChain,
        expiryTime,
        requiredPayment,
      },
      config.signingKey
    );

    sendJson(res, 200, {
      signedQuoteBytes: signed.signedQuoteBytes,
      requiredPayment: requiredPayment.toString(),
      expiryTime: expiryTime.toString(),
      srcChain: config.srcChain,
      dstChain: parsed.dstChain,
      quoterAddress: config.quoterAddress,
      payeeAddress: config.payeeAddress,
    });
  };

  return createServer((req, res) => {
    if (
      req.method === "GET" &&
      (req.url === "/health" || req.url === "/healthz")
    ) {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && req.url === "/quote") {
      // Don't await — express-style fire and forget; errors are caught inside.
      handleQuote(req, res).catch((err) => {
        sendJson(res, 500, {
          error: "internal error",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
}

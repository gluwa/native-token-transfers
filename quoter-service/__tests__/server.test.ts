import type { AddressInfo } from "node:net";
import { Wallet, getBytes } from "ethers";

import type { QuoterServiceConfig } from "../src/config.js";
import type { OnChainQuoter, QuoteRequest } from "../src/quoter.js";
import { createQuoterServer } from "../src/server.js";
import { SIGNED_QUOTE_LENGTH, decodeSignedQuote } from "../src/signedQuote.js";

const QUOTER_PRIVATE_KEY = "0x" + (0xa11cen).toString(16).padStart(64, "0");

function buildConfig(): QuoterServiceConfig {
  const wallet = new Wallet(QUOTER_PRIVATE_KEY);
  return {
    signingKey: wallet.signingKey,
    quoterAddress: wallet.address,
    payeeAddress: "0x" + "0".repeat(60) + "fee1",
    rpcUrl: "http://unused.test",
    contractAddress: "0x" + "1".repeat(40),
    srcChain: 2,
    validitySeconds: 60,
    host: "127.0.0.1",
    port: 0,
    retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
  };
}

class StubQuoter implements OnChainQuoter {
  public lastRequest: QuoteRequest | undefined;
  constructor(
    private readonly result: bigint | Error,
  ) {}
  async fetchRequiredPayment(req: QuoteRequest): Promise<bigint> {
    this.lastRequest = req;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async assertAuthorized(_quoterAddress: string): Promise<void> {
    // no-op for HTTP-layer tests; boot-time check is exercised in __tests__/quoter.test.ts.
  }
}

async function withServer(
  opts: { quoter: OnChainQuoter; config?: QuoterServiceConfig; now?: () => number },
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const config = opts.config ?? buildConfig();
  const server = createQuoterServer({ config, quoter: opts.quoter, now: opts.now });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /quote", () => {
  it("returns a signed quote that decodes back to the requested fields", async () => {
    const config = buildConfig();
    const quoter = new StubQuoter(123_456_789n);
    const fixedNow = 1_700_000_000;
    await withServer({ config, quoter, now: () => fixedNow }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dstChain: 5,
          dstAddr: "0x" + "ab".repeat(20),
          msgValue: "1000000000000000000",
          gasLimit: 300000,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        signedQuoteBytes: string;
        requiredPayment: string;
        expiryTime: string;
        srcChain: number;
        dstChain: number;
      };
      expect(getBytes(body.signedQuoteBytes).length).toBe(SIGNED_QUOTE_LENGTH);
      expect(body.requiredPayment).toBe("123456789");
      expect(body.expiryTime).toBe(String(fixedNow + config.validitySeconds));
      expect(body.srcChain).toBe(config.srcChain);
      expect(body.dstChain).toBe(5);

      const decoded = decodeSignedQuote(body.signedQuoteBytes);
      expect(decoded.quoterAddress).toBe(config.quoterAddress);
      expect(decoded.payeeAddress).toBe(config.payeeAddress);
      expect(decoded.srcChain).toBe(config.srcChain);
      expect(decoded.dstChain).toBe(5);
      expect(decoded.expiryTime).toBe(BigInt(fixedNow + config.validitySeconds));
      expect(decoded.requiredPayment).toBe(123_456_789n);

      expect(quoter.lastRequest).toEqual({
        dstChain: 5,
        dstAddr: "0x" + "ab".repeat(20),
        refundAddr: undefined,
        msgValue: 1_000_000_000_000_000_000n,
        gasLimit: 300_000n,
      });
    });
  });

  it("rejects malformed input with 400", async () => {
    await withServer({ quoter: new StubQuoter(0n) }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dstChain: "not-a-number" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("returns 502 when the on-chain quoter fails", async () => {
    await withServer(
      { quoter: new StubQuoter(new Error("rpc timeout")) },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/quote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dstChain: 5,
            dstAddr: "0x" + "ab".repeat(20),
            msgValue: "0",
            gasLimit: "100000",
          }),
        });
        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("upstream");
      },
    );
  });

  it("rejects oversized request bodies", async () => {
    await withServer({ quoter: new StubQuoter(0n) }, async (baseUrl) => {
      const oversize = "x".repeat(64 * 1024);
      const res = await fetch(`${baseUrl}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dstChain: 5, junk: oversize }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    await withServer({ quoter: new StubQuoter(0n) }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    await withServer({ quoter: new StubQuoter(0n) }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
    });
  });
});

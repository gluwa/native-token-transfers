import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Interface, Wallet, getAddress } from "ethers";

import {
  OracleNotAuthorizedError,
  QUOTER_WRITE_ABI,
  RpcOracleWriter,
  type RpcOracleWriterOptions,
} from "../src/oracle.js";

const CONTRACT = "0x" + "1".repeat(40);
const ORACLE_KEY = "0x" + 0xa11cen.toString(16).padStart(64, "0");
const ORACLE_ADDR = new Wallet(ORACLE_KEY).address;
const iface = new Interface(QUOTER_WRITE_ABI);

interface RpcRequest {
  method: string;
  params: unknown[];
  id: number | string;
}
type RpcHandler = (req: RpcRequest) => unknown;

class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/// Thrown by a handler to produce a JSON-RPC error response (e.g. an eth_call revert,
/// which is what a contract without the requested function returns).
class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
  }
}

async function withMockRpc(
  handler: RpcHandler,
  fn: (url: string, requests: RpcRequest[]) => Promise<void>
): Promise<void> {
  const requests: RpcRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      try {
        const responses = items.map((item) => {
          requests.push(item);
          try {
            return { jsonrpc: "2.0", id: item.id, result: handler(item) };
          } catch (err) {
            if (err instanceof JsonRpcError) {
              return {
                jsonrpc: "2.0",
                id: item.id,
                error: { code: err.code, message: err.message },
              };
            }
            throw err;
          }
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(Array.isArray(parsed) ? responses : responses[0])
        );
      } catch (err) {
        if (err instanceof HttpStatusError) {
          res.writeHead(err.status, { "content-type": "text/plain" });
          res.end(err.message);
        } else {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(err));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${addr.port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withWriter(
  opts: Partial<RpcOracleWriterOptions> & { rpcUrl: string },
  fn: (w: RpcOracleWriter) => Promise<void>
): Promise<void> {
  const w = new RpcOracleWriter({
    contractAddress: CONTRACT,
    signingKey: new Wallet(ORACLE_KEY).signingKey,
    staticNetwork: true,
    ...opts,
  });
  return fn(w).finally(() => w.dispose());
}

function oracleServiceHandler(addr: string): RpcHandler {
  return (req) => {
    switch (req.method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_call":
        return iface.encodeFunctionResult("oracleService", [addr]);
      default:
        throw new Error(`unexpected RPC method ${req.method}`);
    }
  };
}

describe("RpcOracleWriter.assertAuthorized", () => {
  it("resolves when the signer is the registered oracleService", async () => {
    await withMockRpc(oracleServiceHandler(ORACLE_ADDR), async (url, reqs) => {
      await withWriter({ rpcUrl: url }, async (w) => {
        await expect(w.assertAuthorized(ORACLE_ADDR)).resolves.toBeUndefined();
        const ethCall = reqs.find((r) => r.method === "eth_call");
        const data = (ethCall!.params as Array<{ data: string }>)[0]!.data;
        // selector matches oracleService()
        expect(data.slice(0, 10)).toBe(
          iface.getFunction("oracleService")!.selector
        );
      });
    });
  });

  it("throws OracleNotAuthorizedError on mismatch", async () => {
    const other = "0x" + "2".repeat(40);
    await withMockRpc(oracleServiceHandler(other), async (url) => {
      await withWriter({ rpcUrl: url }, async (w) => {
        await expect(w.assertAuthorized(ORACLE_ADDR)).rejects.toBeInstanceOf(
          OracleNotAuthorizedError
        );
      });
    });
  });

  it("retries transient transport failures on the read", async () => {
    let attempts = 0;
    const handler: RpcHandler = (req) => {
      if (req.method === "eth_call") {
        attempts += 1;
        if (attempts < 3) throw new HttpStatusError(503);
        return iface.encodeFunctionResult("oracleService", [ORACLE_ADDR]);
      }
      if (req.method === "eth_chainId") return "0x7a69";
      throw new Error(`unexpected ${req.method}`);
    };
    await withMockRpc(handler, async (url) => {
      await withWriter(
        {
          rpcUrl: url,
          retry: { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 1 },
          sleep: () => Promise.resolve(),
        },
        async (w) => {
          await expect(
            w.assertAuthorized(ORACLE_ADDR)
          ).resolves.toBeUndefined();
          expect(attempts).toBe(3);
        }
      );
    });
  });
});

describe("RpcOracleWriter.pricingMode", () => {
  const PRICING_MODE_SELECTOR = iface.getFunction("pricingMode")!.selector;

  /// eth_call handler that answers pricingMode() with `respond` and anything else
  /// (chainId aside) with an error.
  function pricingModeHandler(respond: () => unknown): RpcHandler {
    return (req) => {
      if (req.method === "eth_chainId") return "0x7a69";
      if (req.method === "eth_call") {
        const data = (req.params as Array<{ data: string }>)[0]!.data;
        if (data.slice(0, 10) === PRICING_MODE_SELECTOR) return respond();
        throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
      }
      throw new Error(`unexpected RPC method ${req.method}`);
    };
  }

  it("maps 0 -> twap and 1 -> penguinswap", async () => {
    for (const [raw, mode] of [
      [0, "twap"],
      [1, "penguinswap"],
    ] as const) {
      await withMockRpc(
        pricingModeHandler(() =>
          iface.encodeFunctionResult("pricingMode", [raw])
        ),
        async (url) => {
          await withWriter({ rpcUrl: url }, async (w) => {
            await expect(w.pricingMode()).resolves.toBe(mode);
          });
        }
      );
    }
  });

  it("throws a clear error when the call reverts (contract lacks the getter)", async () => {
    await withMockRpc(
      pricingModeHandler(() => {
        throw new JsonRpcError(3, "execution reverted");
      }),
      async (url) => {
        await withWriter({ rpcUrl: url }, async (w) => {
          await expect(w.pricingMode()).rejects.toThrow(/not callable/);
        });
      }
    );
  });

  it("throws when the call returns empty data (contract lacks the getter)", async () => {
    await withMockRpc(
      pricingModeHandler(() => "0x"),
      async (url) => {
        await withWriter({ rpcUrl: url }, async (w) => {
          await expect(w.pricingMode()).rejects.toThrow(/not callable/);
        });
      }
    );
  });

  it("rejects an unknown mode value", async () => {
    await withMockRpc(
      pricingModeHandler(() => iface.encodeFunctionResult("pricingMode", [7])),
      async (url) => {
        await withWriter({ rpcUrl: url }, async (w) => {
          await expect(w.pricingMode()).rejects.toThrow(/unknown pricingMode/);
        });
      }
    );
  });

  it("throws (after retry) on transient transport failure instead of falling back", async () => {
    let attempts = 0;
    await withMockRpc(
      pricingModeHandler(() => {
        attempts += 1;
        throw new HttpStatusError(503);
      }),
      async (url) => {
        await withWriter(
          {
            rpcUrl: url,
            retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
            sleep: () => Promise.resolve(),
          },
          async (w) => {
            await expect(w.pricingMode()).rejects.toMatchObject({
              code: "SERVER_ERROR",
            });
            expect(attempts).toBe(2);
          }
        );
      }
    );
  });
});

describe("batchPriceUpdate ABI", () => {
  it("encodes/decodes with PricingData fields in (baseFee, dstGasPrice, dstPrice, srcPrice, priceBuffer) order", () => {
    // Field order mirrors IUSCRelayingQuoter.PricingData exactly.
    const pricing = {
      baseFee: 7n,
      dstGasPrice: 2000n,
      dstPrice: 1000n,
      srcPrice: 42n,
      priceBuffer: 500n,
    };
    const data = iface.encodeFunctionData("batchPriceUpdate", [
      42n,
      [2, 5],
      [pricing, pricing],
    ]);
    const decoded = iface.decodeFunctionData("batchPriceUpdate", data);
    expect(decoded[0]).toBe(42n);
    expect(decoded[1].map((c: bigint) => Number(c))).toEqual([2, 5]);
    // Tuple positional order must match the Solidity struct.
    const tuple = decoded[2][0];
    expect(tuple[0]).toBe(7n); // baseFee
    expect(tuple[1]).toBe(2000n); // dstGasPrice
    expect(tuple[2]).toBe(1000n); // dstPrice
    expect(tuple[3]).toBe(42n); // srcPrice
    expect(tuple[4]).toBe(500n); // priceBuffer
  });
});

describe("RpcOracleWriter.pushTwapSample", () => {
  const TWAP_READER_SELECTOR = iface.getFunction("twapReader")!.selector;

  it("fails with a clear error when the quoter's TWAPReader is unset", async () => {
    const handler: RpcHandler = (req) => {
      if (req.method === "eth_chainId") return "0x7a69";
      if (req.method === "eth_call") {
        const data = (req.params as Array<{ data: string }>)[0]!.data;
        if (data.slice(0, 10) === TWAP_READER_SELECTOR) {
          return iface.encodeFunctionResult("twapReader", [
            "0x" + "0".repeat(40),
          ]);
        }
        throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
      }
      throw new Error(`unexpected RPC method ${req.method}`);
    };
    await withMockRpc(handler, async (url) => {
      await withWriter({ rpcUrl: url }, async (w) => {
        await expect(w.pushTwapSample(10n ** 25n)).rejects.toThrow(
          /twapReader\(\) is unset/
        );
      });
    });
  });
});

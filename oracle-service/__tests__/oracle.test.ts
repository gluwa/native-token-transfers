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
          return { jsonrpc: "2.0", id: item.id, result: handler(item) };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
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

describe("batchPriceUpdate ABI", () => {
  it("encodes/decodes with PricingData fields in (dstPrice, dstGasPrice, priceBuffer, baseFee) order", () => {
    const pricing = {
      dstPrice: 1000n,
      dstGasPrice: 2000n,
      priceBuffer: 500n,
      baseFee: 7n,
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
    expect(tuple[0]).toBe(1000n); // dstPrice
    expect(tuple[1]).toBe(2000n); // dstGasPrice
    expect(tuple[2]).toBe(500n); // priceBuffer
    expect(tuple[3]).toBe(7n); // baseFee
  });
});

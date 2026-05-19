import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Interface, getAddress, zeroPadValue } from "ethers";

import {
  QUOTER_ABI,
  QuoterNotAuthorizedError,
  RpcOnChainQuoter,
  type RpcOnChainQuoterOptions,
} from "../src/quoter.js";

const CONTRACT = "0x" + "1".repeat(40);
const QUOTER = "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7";
const iface = new Interface(QUOTER_ABI);

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
class JsonRpcError extends Error {
  constructor(message: string, public readonly rpcCode: number = -32000) {
    super(message);
  }
}

async function withMockRpc(
  handler: RpcHandler,
  fn: (url: string, requests: RpcRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RpcRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      try {
        const responses = items.map((item) => {
          requests.push(item);
          try {
            const result = handler(item);
            return { jsonrpc: "2.0", id: item.id, result };
          } catch (err) {
            if (err instanceof JsonRpcError) {
              return { jsonrpc: "2.0", id: item.id, error: { code: err.rpcCode, message: err.message } };
            }
            throw err;
          }
        });
        const payload = Array.isArray(parsed) ? responses : responses[0];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
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

function makeBaseHandler(callResult: string): RpcHandler {
  return (req) => {
    switch (req.method) {
      case "eth_chainId":
        return "0x7a69"; // 31337
      case "eth_blockNumber":
        return "0x1";
      case "eth_call":
        return callResult;
      default:
        throw new Error(`unexpected RPC method ${req.method}`);
    }
  };
}

async function withQuoter(
  opts: RpcOnChainQuoterOptions,
  fn: (q: RpcOnChainQuoter) => Promise<void>,
): Promise<void> {
  const q = new RpcOnChainQuoter(opts);
  try {
    await fn(q);
  } finally {
    q.dispose();
  }
}

describe("RpcOnChainQuoter.fetchRequiredPayment", () => {
  it("encodes the contract call with the expected arguments", async () => {
    const expectedResult = iface.encodeFunctionResult("requestQuote", [123_456_789n]);
    await withMockRpc(makeBaseHandler(expectedResult), async (url, reqs) => {
      await withQuoter({ rpcUrl: url, contractAddress: CONTRACT, staticNetwork: true }, async (quoter) => {
        const got = await quoter.fetchRequiredPayment({
          dstChain: 5,
          dstAddr: "0x" + "ab".repeat(20),
          msgValue: 1_000_000_000_000_000_000n,
          gasLimit: 300_000n,
        });
        expect(got).toBe(123_456_789n);

        const ethCall = reqs.find((r) => r.method === "eth_call");
        expect(ethCall).toBeDefined();
        const params = ethCall!.params as Array<{ to: string; data: string }>;
        expect(getAddress(params[0].to)).toBe(getAddress(CONTRACT));

        const decoded = iface.decodeFunctionData("requestQuote", params[0].data);
        expect(decoded[0]).toBe(5n);
        // dstAddr is left-padded from 20 bytes to bytes32
        expect(decoded[1].toLowerCase()).toBe(zeroPadValue("0x" + "ab".repeat(20), 32).toLowerCase());
        // refundAddr defaults to zero
        expect(decoded[2]).toBe("0x0000000000000000000000000000000000000000");
        // requestBytes = abi.encode(uint256(msgValue))
        expect(BigInt(decoded[3])).toBe(1_000_000_000_000_000_000n);
        // relayInstructions = abi.encode(uint256(gasLimit))
        expect(BigInt(decoded[4])).toBe(300_000n);
      });
    });
  });

  it("retries transient transport failures and eventually succeeds", async () => {
    let ethCallAttempts = 0;
    const result = iface.encodeFunctionResult("requestQuote", [42n]);
    const handler: RpcHandler = (req) => {
      if (req.method === "eth_call") {
        ethCallAttempts += 1;
        // First two attempts respond with HTTP 503 — ethers maps to SERVER_ERROR,
        // which our retry classifier treats as transient.
        if (ethCallAttempts < 3) throw new HttpStatusError(503);
        return result;
      }
      return makeBaseHandler(result)(req);
    };
    await withMockRpc(handler, async (url) => {
      await withQuoter(
        {
          rpcUrl: url,
          contractAddress: CONTRACT,
          retry: { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 1 },
          sleep: () => Promise.resolve(),
          staticNetwork: true,
        },
        async (quoter) => {
          const got = await quoter.fetchRequiredPayment({
            dstChain: 5,
            dstAddr: "0x" + "ab".repeat(20),
            msgValue: 0n,
            gasLimit: 100_000n,
          });
          expect(got).toBe(42n);
          expect(ethCallAttempts).toBe(3);
        },
      );
    });
  });

  it("does not retry contract reverts (CALL_EXCEPTION)", async () => {
    let attempts = 0;
    const handler: RpcHandler = (req) => {
      if (req.method === "eth_call") {
        attempts += 1;
        // VM revert response — ethers maps RPC error code 3 + "execution reverted"
        // to CALL_EXCEPTION, which is non-retryable.
        throw new JsonRpcError("execution reverted", 3);
      }
      return makeBaseHandler("0x")(req);
    };
    await withMockRpc(handler, async (url) => {
      await withQuoter(
        {
          rpcUrl: url,
          contractAddress: CONTRACT,
          retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1 },
          sleep: () => Promise.resolve(),
          staticNetwork: true,
        },
        async (quoter) => {
          await expect(
            quoter.fetchRequiredPayment({
              dstChain: 5,
              dstAddr: "0x" + "ab".repeat(20),
              msgValue: 0n,
              gasLimit: 100_000n,
            }),
          ).rejects.toThrow();
          // Exactly one attempt — no retries on contract revert.
          expect(attempts).toBe(1);
        },
      );
    });
  });
});

describe("RpcOnChainQuoter.assertAuthorized", () => {
  it("resolves silently when the quoter is registered", async () => {
    const result = iface.encodeFunctionResult("isAuthorizedQuoter", [true]);
    await withMockRpc(makeBaseHandler(result), async (url, reqs) => {
      await withQuoter({ rpcUrl: url, contractAddress: CONTRACT, staticNetwork: true }, async (quoter) => {
        await expect(quoter.assertAuthorized(QUOTER)).resolves.toBeUndefined();

        const ethCall = reqs.find((r) => r.method === "eth_call");
        const data = (ethCall!.params as Array<{ data: string }>)[0].data;
        const decoded = iface.decodeFunctionData("isAuthorizedQuoter", data);
        expect(getAddress(decoded[0])).toBe(getAddress(QUOTER));
      });
    });
  });

  it("throws QuoterNotAuthorizedError when registration is missing", async () => {
    const result = iface.encodeFunctionResult("isAuthorizedQuoter", [false]);
    await withMockRpc(makeBaseHandler(result), async (url) => {
      await withQuoter({ rpcUrl: url, contractAddress: CONTRACT, staticNetwork: true }, async (quoter) => {
        await expect(quoter.assertAuthorized(QUOTER)).rejects.toBeInstanceOf(
          QuoterNotAuthorizedError,
        );
      });
    });
  });
});

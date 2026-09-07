"use server";

import https from "node:https";
import type { ClientRequest } from "node:http";
import fs from "node:fs";

export type SubgraphDeploymentHit = {
  ipfsHash: string;
  network?: string;
  queryFeesAmount: string;
};

export type TokenDiscoveryResult = {
  address: string;
  total: number;
  deployments: SubgraphDeploymentHit[];
  error?: string;
};

const MCP_BASE_URL = "https://subgraphs.mcp.thegraph.com";
const TIMEOUT_MS = 15_000;

function resolveApiKey(): string {
  if (process.env.GRAPH_API_KEY) {
    return process.env.GRAPH_API_KEY.trim();
  }
  try {
    const homedir = process.env.USERPROFILE || process.env.HOME || "";
    if (homedir) {
      const cliPath = `${homedir}/.graph-cli.json`;
      if (fs.existsSync(cliPath)) {
        const parsed = JSON.parse(fs.readFileSync(cliPath, "utf8"));
        if (parsed.apiKeys?.studio) return parsed.apiKeys.studio;
        const first = Object.values(parsed)[0];
        if (typeof first === "string" && first.length === 32) return first;
      }
    }
  } catch {}
  return "";
}

function mapChainIdToMcpChain(chainId: number): string | null {
  if (chainId === 8453) return "base";
  if (chainId === 1) return "mainnet";
  // Base Sepolia (84532) has no decentralized deployments; degrade cleanly
  return null;
}

/**
 * Queries Subgraph MCP get_top_subgraph_deployments for each token contract address.
 * Deterministic call: one contract address + chain -> deployments ranked by query fees.
 */
export async function searchSubgraphsForTokens(
  addresses: string[],
  chainId: number = 8453
): Promise<Record<string, TokenDiscoveryResult>> {
  const sanitized = addresses
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

  const unique = Array.from(new Set(sanitized));
  const fallbackResults: Record<string, TokenDiscoveryResult> = {};
  for (const addr of unique) {
    fallbackResults[addr] = { address: addr, total: 0, deployments: [] };
  }

  if (unique.length === 0) return fallbackResults;

  const mcpChain = mapChainIdToMcpChain(chainId);
  // Base Sepolia or unindexed testnet: degrade cleanly like Token API does
  if (!mcpChain) {
    return fallbackResults;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    for (const addr of unique) {
      fallbackResults[addr].error = "GRAPH_API_KEY unset";
    }
    return fallbackResults;
  }

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let sseReq: ClientRequest | null = null;
    let reqId = 1;
    const pending = new Map<number, { resolve: (res: unknown) => void; reject: (err: unknown) => void }>();
    let messageEndpoint: string | null = null;
    const results: Record<string, TokenDiscoveryResult> = { ...fallbackResults };

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (sseReq) {
        try {
          sseReq.destroy();
        } catch {}
        sseReq = null;
      }
    }

    timer = setTimeout(() => {
      cleanup();
      for (const addr of unique) {
        if (!results[addr].deployments.length && !results[addr].error) {
          results[addr].error = "MCP request timed out";
        }
      }
      resolve(results);
    }, TIMEOUT_MS);

    function parseSseChunk(chunk: Buffer, onEvent: (event: string, data: string) => void) {
      const lines = chunk.toString().split(/\r?\n/);
      let currentEvent = "message";
      let currentData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData += (currentData ? "\n" : "") + line.slice(5).trim();
        } else if (line.trim() === "") {
          if (currentData) {
            onEvent(currentEvent, currentData);
            currentEvent = "message";
            currentData = "";
          }
        }
      }
    }

    async function sendRpc(endpoint: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = reqId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        const url = new URL(endpoint);
        const postReq = https.request(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Authorization: `Bearer ${apiKey}`,
          },
        });

        postReq.on("error", rej);
        postReq.write(payload);
        postReq.end();
      });
    }

    try {
      const sseUrl = new URL(`${MCP_BASE_URL}/sse`);
      sseReq = https.request(
        sseUrl,
        {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${apiKey}`,
            "Cache-Control": "no-cache",
          },
        },
        (sseRes) => {
          if (sseRes.statusCode !== 200) {
            cleanup();
            for (const addr of unique) {
              results[addr].error = `MCP SSE status ${sseRes.statusCode}`;
            }
            resolve(results);
            return;
          }

          let buffer = "";
          sseRes.on("data", async (chunk) => {
            buffer += chunk.toString();
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop() ?? "";

            for (const block of parts) {
              parseSseChunk(Buffer.from(block + "\n\n"), async (event, data) => {
                if (event === "endpoint") {
                  messageEndpoint = data.startsWith("http") ? data : `${MCP_BASE_URL}${data}`;
                  try {
                    await sendRpc(messageEndpoint, "initialize", {
                      protocolVersion: "2024-11-05",
                      capabilities: {},
                      clientInfo: { name: "bone-dry-mcp-lookup", version: "1.0.0" },
                    });

                    // Search top subgraph deployments for each token contract address
                    for (const addr of unique) {
                      try {
                        const rawResult = (await sendRpc(messageEndpoint, "tools/call", {
                          name: "get_top_subgraph_deployments",
                          arguments: { contract_address: addr, chain: mcpChain },
                        })) as { content?: Array<{ type: string; text: string }>; isError?: boolean };

                        if (rawResult?.content?.[0]?.text) {
                          const parsed = JSON.parse(rawResult.content[0].text) as {
                            subgraphDeployments?: Array<{
                              ipfsHash?: string;
                              manifest?: { network?: string };
                              queryFeesAmount?: string;
                            }>;
                          };

                          const hits: SubgraphDeploymentHit[] = (parsed.subgraphDeployments || []).map((dep) => ({
                            ipfsHash: dep.ipfsHash ?? "",
                            network: dep.manifest?.network,
                            queryFeesAmount: dep.queryFeesAmount ?? "0",
                          }));

                          results[addr] = {
                            address: addr,
                            total: hits.length,
                            deployments: hits,
                          };
                        }
                      } catch (tokenErr) {
                        results[addr] = {
                          address: addr,
                          total: 0,
                          deployments: [],
                          error: (tokenErr as Error).message,
                        };
                      }
                    }

                    cleanup();
                    resolve(results);
                  } catch (initErr) {
                    cleanup();
                    for (const addr of unique) {
                      results[addr].error = (initErr as Error).message;
                    }
                    resolve(results);
                  }
                } else if (event === "message") {
                  try {
                    const msg = JSON.parse(data);
                    if (msg.id && pending.has(msg.id)) {
                      const p = pending.get(msg.id)!;
                      pending.delete(msg.id);
                      if (msg.error) {
                        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                      } else {
                        p.resolve(msg.result);
                      }
                    }
                  } catch {}
                }
              });
            }
          });

          sseRes.on("error", (err: Error) => {
            cleanup();
            for (const addr of unique) {
              if (!results[addr].deployments.length) results[addr].error = err.message;
            }
            resolve(results);
          });
        }
      );

      sseReq.on("error", (err: Error) => {
        cleanup();
        for (const addr of unique) {
          results[addr].error = err.message;
        }
        resolve(results);
      });

      sseReq.end();
    } catch (e) {
      cleanup();
      for (const addr of unique) {
        results[addr].error = (e as Error).message;
      }
      resolve(results);
    }
  });
}

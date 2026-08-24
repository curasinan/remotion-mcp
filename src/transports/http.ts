/**
 * Streamable HTTP transport.
 *
 * Exists so this server can be registered as a custom connector on Claude web
 * and mobile, which cannot spawn a local subprocess. Read the security notes
 * before enabling it.
 *
 * This server spawns child processes and writes files. Reaching it over a
 * network is therefore a materially different risk from running it over stdio,
 * and the defaults reflect that:
 *
 *   - MCP_HTTP_TOKEN is mandatory; the server refuses to start without one
 *   - Binds 127.0.0.1 unless MCP_HTTP_HOST is set, which logs a warning
 *   - Rejects cross-origin requests, which blocks DNS rebinding
 *   - Constant-time token comparison
 *
 * Built on node:http rather than express: one fewer dependency to ship inside
 * an .mcpb bundle, and nothing here needs a framework.
 */

import { createServer as createHttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_BODY_BYTES = 12_000_000;

export interface HttpTransportOptions {
  port: number;
  host: string;
  token: string;
  createServer: () => McpServer;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare lengths separately; timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length)
    return false;
  return timingSafeEqual(a, b);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin)
    return true; // Non-browser clients send no Origin header.
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function startHttpTransport(options: HttpTransportOptions): void {
  const { port, host, token, createServer } = options;
  const http = createHttpServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
        sendJson(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: "Origin not allowed" });
        return;
      }
      const authorization = req.headers.authorization ?? "";
      const provided = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      if (!tokensMatch(provided, token)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="remotion-viz-mcp-server"',
        });
        res.end(JSON.stringify({ error: "Invalid or missing bearer token" }));
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        sendJson(res, 400, {
          error: error instanceof Error ? error.message : "Malformed request body",
        });
        return;
      }
      // A fresh server and transport per request keeps the deployment
      // stateless, which avoids request-id collisions between clients.
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      console.error("HTTP request failed:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    });
  });

  http.listen(port, host, () => {
    console.error(`Listening on http://${host}:${port}/mcp`);
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.error(`WARNING: bound to ${host}, not loopback. This server spawns processes and writes files. Do not expose it directly to the internet; put it behind an authenticated tunnel.`);
    }
  });
}

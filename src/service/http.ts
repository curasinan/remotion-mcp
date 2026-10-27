/**
 * The service's HTTP root (design 5.2). Each request is routed, its raw body read under the cap, and its identity
 * verified on those exact bytes before any MCP server exists. Only then does it get a fresh McpServer and a fresh
 * stateless transport: a stateless transport cannot be reused, and a server connects to one transport only. When the
 * response closes, the transport and server are closed, which aborts the tool's signal and so stops its render.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SERVER_VERSION } from "../constants.js";
import type { ServiceAuditEvent } from "./audit.js";
import type { ServiceConfig } from "./config.js";
import { IDENTITY_HEADER, IDENTITY_MAX_TTL_S } from "./constants.js";
import { ReplayCache, verifyRequest } from "./identity.js";
import { registerServiceTools, type ServiceContext } from "./registry.js";
import { errorText, serviceLog } from "./tools.js";

export interface ServiceHandlerDeps { clock?: { nowS(): number; startedAtS: number };
  createServer?: () => McpServer } // tests count servers through this

/** The one route. Any other path gets 404, and any other method on it gets 405. */
const MCP_PATH = "/mcp";
/** Fields a caller may not use to pick a tenant: the verified claims carry it. Each is ignored and audited. */
const IGNORED_FIELDS = ["tenant", "team", "team_id"] as const;

type BodyRead = { kind: "ok"; body: Buffer } | { kind: "too_large"; drained: boolean } | { kind: "gone" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whole seconds of the wall clock, as the gateway signs `iat` and `exp`. */
const wallClockS = (): number => Math.floor(Date.now() / 1000);

/**
 * The raw body, read under `cap` and counted as it arrives, so a chunked body without a Content-Length is capped too.
 * Past the cap nothing more is kept. The rest is read and dropped until the request ends, so the 413 reaches the
 * client rather than being lost to a reset (`drained`), or until another `cap` bytes have arrived, when the 413 goes
 * out on a connection that then closes.
 */
function readBody(req: IncomingMessage, cap: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= cap) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      if (total > 2 * cap) settle({ kind: "too_large", drained: false });
    });
    req.on("end", () => settle(total > cap ? { kind: "too_large", drained: true }
      : { kind: "ok", body: Buffer.concat(chunks, total) }));
    // The client went away before the body ended: nobody is left to answer.
    req.on("error", () => settle({ kind: "gone" }));
    req.on("close", () => settle({ kind: "gone" }));
  });
}

/** `_meta.<field>` and `arguments.<field>` for each ignored field present at the top level of either. Paths only. */
function ignoredFieldsOf(message: unknown): string[] {
  const params = isRecord(message) ? message.params : undefined;
  if (!isRecord(params)) return [];
  const found: string[] = [];
  for (const container of ["_meta", "arguments"] as const) {
    const value = params[container];
    if (!isRecord(value)) continue;
    for (const field of IGNORED_FIELDS) if (Object.hasOwn(value, field)) found.push(`${container}.${field}`);
  }
  return found;
}

/**
 * The request handler. Refusals answer with an empty body and are audited as `refused`, with the reason as the
 * category and the status, and no claims fields: none were verified. It never rejects; an unexpected error is logged
 * for the operator and answered with 500.
 */
export function createServiceHandler(ctx: ServiceContext, cfg: ServiceConfig,
  deps: ServiceHandlerDeps = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const clock = deps.clock ?? { nowS: wallClockS, startedAtS: wallClockS() };
  // One skew for both, as verifyRequest requires.
  const replay = new ReplayCache(cfg.skewS);

  const record = (event: Omit<ServiceAuditEvent, "ts">): void => {
    try {
      ctx.audit.record({ ts: new Date().toISOString(), ...event });
    } catch {
      // Auditing must never be the reason a request fails.
    }
  };

  const refuse = (res: ServerResponse, status: number, category: string, headers: Record<string, string> = {}): void => {
    record({ outcome: "refused", category, http_status: status });
    res.writeHead(status, { ...headers, "content-length": "0" });
    res.end();
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Registered first, so a connection cut off at any point below is seen.
    const response: { closed: boolean; onClose?: () => void } = { closed: false };
    res.once("close", () => {
      response.closed = true;
      response.onClose?.();
    });

    // 1. Route and method. The path is compared as sent: no URL parsing, so `//host/mcp` is not `/mcp`.
    const pathOnly = (req.url ?? "").split("?", 1)[0];
    if (pathOnly !== MCP_PATH) return refuse(res, 404, "not_found");
    if (req.method !== "POST") return refuse(res, 405, "method_not_allowed", { allow: "POST" });

    // 2. The raw body, under the cap.
    const read = await readBody(req, cfg.bodyCapBytes);
    if (read.kind === "gone") return;
    if (read.kind === "too_large") {
      return refuse(res, 413, "body_too_large", read.drained ? {} : { connection: "close" });
    }

    // 3. Identity on the raw bytes, then the parse, the claims against the message, and replay.
    const header = req.headers[IDENTITY_HEADER];
    const verdict = verifyRequest(typeof header === "string" ? header : undefined, read.body, {
      key: cfg.identityKey, audience: cfg.audience, nowS: clock.nowS(), skewS: cfg.skewS,
      maxTtlS: IDENTITY_MAX_TTL_S, startedAtS: clock.startedAtS,
    }, replay);
    if (!verdict.ok) return refuse(res, verdict.status, verdict.reason);
    const { claims, message } = verdict;
    const identity = { request_id: claims.request_id, principal: claims.principal, tenant: claims.tenant };

    // 4. A tenant or team field has no effect; it is recorded, by its path only.
    const fields = ignoredFieldsOf(message);
    if (fields.length > 0) record({ outcome: "violation", ...identity, tool: claims.tool, fields });

    // 5. The verified identity reaches the tools as authInfo.
    (req as IncomingMessage & { auth?: AuthInfo }).auth = {
      token: "", clientId: claims.principal, scopes: [], extra: { claims },
    };

    // 6-8. A fresh server and a fresh stateless transport for this request alone.
    const server = deps.createServer?.() ?? new McpServer({ name: "remotion-viz-service", version: SERVER_VERSION });
    registerServiceTools(server, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // 10. A closed response, finished or cut off, closes both. Closing aborts every in-flight tool's signal.
    response.onClose = () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    };
    if (response.closed) return response.onClose();
    await server.connect(transport);
    // 9. The message as verified: the transport never reads the body again.
    await transport.handleRequest(req, res, message);
  }

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      serviceLog(ctx, undefined, "http", "internal", errorText(err));
      try {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        record({ outcome: "error", category: "internal", http_status: 500 });
        res.writeHead(500, { "content-length": "0" });
        res.end();
      } catch {
        // The connection is already gone; there is nobody to answer.
      }
    });
  };
}

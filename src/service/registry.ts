/**
 * The service profile's tool registry (design 5.2 step 7, 5.5). The four tools are registered from the frozen
 * SERVICE_TOOLS by the one `registerTool` call below. The absence suite counts registration call sites in the
 * compiled closure, so no other file registers a tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { AuditSink, ServiceAuditEvent } from "./audit.js";
import { serviceError } from "./errors.js";
import type { runRenderProcess } from "./render-process.js";
import type { RenderSlots } from "./slots.js";
import type { LoadedPack } from "./templates.js";
import { TOOL_DEFS, type ToolDef, type ToolExtra } from "./tools.js";

export const SERVICE_TOOLS = Object.freeze(
  ["list_templates", "render_still", "render_video_start", "render_job_status"] as const,
);

export interface ServiceContext { pack: LoadedPack; slots: RenderSlots; run: typeof runRenderProcess;
  cli: { file: string; prefixArgs: string[] }; browserExecutable: string; tempRoot: string; audit: AuditSink;
  stillDeadlineMs: number; cliTimeoutMs: number; graceMs: number; verifyDeadlineMs: number;
  pngCapBytes: number; shutdown: AbortSignal; onUnverifiedCleanup: () => void }

type Identity = Pick<ServiceAuditEvent, "request_id" | "principal" | "tenant">;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The verified claims' ids, which the HTTP handler puts in `authInfo.extra.claims`. */
function identityOf(extra: ToolExtra | undefined): Identity {
  const claims: unknown = extra?.authInfo?.extra?.claims;
  if (typeof claims !== "object" || claims === null) return {};
  const c = claims as Record<string, unknown>;
  return { request_id: text(c.request_id), principal: text(c.principal), tenant: text(c.tenant) };
}

/** What a successful result returned: an image's decoded bytes and a text's UTF-8 bytes, in content order. */
function resultBytes(result: CallToolResult): Buffer {
  return Buffer.concat(result.content.map((item) => {
    if (item.type === "image") return Buffer.from(item.data, "base64");
    if (item.type === "text") return Buffer.from(item.text, "utf8");
    return Buffer.alloc(0);
  }));
}

/**
 * What the SDK calls for one tool. It runs the handler, records one audit event of hashes and sizes, and turns any
 * throw into `internal`, so no exception, and no message one carries, reaches the SDK.
 */
function wrap(name: string, def: ToolDef, takesArgs: boolean, ctx: ServiceContext) {
  return async (...received: unknown[]): Promise<CallToolResult> => {
    const started = performance.now();
    const ts = new Date().toISOString();
    // The SDK passes (args, extra) to a tool with an input schema, and (extra) alone to one without.
    const args = takesArgs ? received[0] : undefined;
    const extra = (takesArgs ? received[1] : received[0]) as ToolExtra | undefined;
    let identity: Identity = {};
    let params: Pick<ServiceAuditEvent, "params_hash" | "params_bytes"> = {};
    let outcome: Pick<ServiceAuditEvent, "outcome" | "category" | "result_hash" | "result_bytes">;
    let result: CallToolResult;
    try {
      identity = identityOf(extra);
      if (args !== undefined) {
        const json = JSON.stringify(args);
        params = { params_hash: ctx.audit.hash(json), params_bytes: Buffer.byteLength(json, "utf8") };
      }
      result = await def.handler(args, extra as ToolExtra, ctx);
      if (result.isError === true) {
        outcome = { outcome: "error", category: text(result.structuredContent?.category) };
      } else {
        const bytes = resultBytes(result);
        outcome = { outcome: "ok", result_hash: ctx.audit.hash(bytes), result_bytes: bytes.length };
      }
    } catch {
      result = serviceError("internal");
      outcome = { outcome: "error", category: "internal" };
    }
    const event: ServiceAuditEvent = { ts, outcome: outcome.outcome, ...identity, tool: name,
      category: outcome.category, duration_ms: Math.round(performance.now() - started), ...params,
      result_hash: outcome.result_hash, result_bytes: outcome.result_bytes };
    try {
      ctx.audit.record(event);
    } catch {
      // Auditing must never be the reason a tool call fails.
    }
    return result;
  };
}

/** Registers the four tools on `server`, each behind its wrapper. A fresh server per request calls this once. */
export function registerServiceTools(server: McpServer, ctx: ServiceContext): void {
  for (const name of SERVICE_TOOLS) {
    const def: ToolDef = TOOL_DEFS[name];
    // Strict: an argument the schema does not name is refused, not silently dropped.
    const inputSchema = def.inputSchema === undefined ? undefined : z.object(def.inputSchema).strict();
    server.registerTool(name, { description: def.description, inputSchema },
      wrap(name, def, inputSchema !== undefined, ctx));
  }
}

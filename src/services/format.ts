/**
 * Shared response construction. Every tool returns through these helpers so
 * text content, structured content and error shape stay consistent.
 */

import { CHARACTER_LIMIT } from "../constants.js";
import { log, summariseArguments } from "./log.js";
import { ResponseFormat, ToolInputError } from "../types.js";
import { recordAuditEvent } from "./audit.js";

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolResponse {
  [key: string]: unknown;
  content: (ToolTextContent | ToolImageContent)[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Truncate a response body, telling the caller how to get the rest. */
export function enforceCharacterLimit(
  text: string,
  remedy: string,
  limit: number = CHARACTER_LIMIT,
): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, Math.max(0, limit - 200));
  return `${kept}\n\n[Truncated: response was ${text.length} characters, limit is ${limit}. ${remedy}]`;
}

export function buildResponse(
  markdown: string,
  structured: Record<string, unknown>,
  format: ResponseFormat,
  truncationRemedy = "Narrow the request and call again.",
): ToolResponse {
  const body =
    format === ResponseFormat.JSON
      ? JSON.stringify(structured, null, 2)
      : markdown;

  return {
    content: [{ type: "text", text: enforceCharacterLimit(body, truncationRemedy) }],
    structuredContent: structured,
  };
}

/**
 * An error response, bounded like every other response.
 *
 * This was the one builder that skipped the character cap, and it is the path most
 * likely to carry unbounded text the server did not write: safeHandler's generic
 * catch interpolates `error.message` verbatim, and a native addon or a bundler can
 * produce a very long one.
 *
 * The message is truncated, never the hint. The hint is server-authored and is the
 * only actionable part; trimming the combined string from the end would keep 25,000
 * characters of somebody else's stack trace and drop the one sentence saying what to
 * do about it.
 */
export function buildErrorResponse(message: string, hint?: string): ToolResponse {
  const suffix = hint ? `\n\nNext step: ${hint}` : "";
  const head = enforceCharacterLimit(
    message,
    "The omitted text is upstream output, not part of the fix below.",
    Math.max(200, CHARACTER_LIMIT - suffix.length),
  );
  // Backstop for a pathologically long hint, which would otherwise blow the cap on
  // its own. A no-op in every ordinary case.
  const text = enforceCharacterLimit(`${head}${suffix}`, "Narrow the request and call again.");
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

/**
 * Wrap a tool handler so no exception escapes as a protocol-level error.
 * Per the MCP spec, tool failures belong inside the result object.
 */
export function safeHandler<TInput>(
  toolName: string,
  handler: (input: TInput) => Promise<ToolResponse>,
): (input: TInput) => Promise<ToolResponse> {
  return async (input: TInput): Promise<ToolResponse> => {
    const startedAt = Date.now();
    log.info("tool_call", { tool: toolName, arguments: summariseArguments(input) });
    recordAuditEvent({ event: "tool_call", tool: toolName, detail: summariseArguments(input) });
    try {
      const response = await handler(input);
      const outcome = response.isError ? "error" : "ok";
      const duration_ms = Date.now() - startedAt;
      log.info("tool_result", { tool: toolName, outcome, duration_ms });
      recordAuditEvent({ event: "tool_result", tool: toolName, outcome, duration_ms });
      return response;
    } catch (error) {
      const duration_ms = Date.now() - startedAt;
      if (error instanceof ToolInputError) {
        // A rejected input is an expected outcome, logged as a refusal rather
        // than a crash. The message can carry a path, so it is not logged.
        log.warn("tool_rejected", { tool: toolName, duration_ms });
        recordAuditEvent({
          event: "tool_rejected",
          tool: toolName,
          duration_ms,
          category: error.category,
          detail: { message: error.message },
        });
        return buildErrorResponse(`${toolName}: ${error.message}`, error.hint);
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error("tool_failed", { tool: toolName, duration_ms });
      recordAuditEvent({ event: "tool_failed", tool: toolName, duration_ms, detail: { message } });
      return buildErrorResponse(
        `${toolName} failed: ${message}`,
        "Run remotion_check_environment to confirm Node, the Remotion CLI and the Chrome Headless Shell are all available.",
      );
    }
  };
}

export function bulletList(items: string[]): string {
  return items.length === 0 ? "_(none)_" : items.map((i) => `- ${i}`).join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds % 60)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

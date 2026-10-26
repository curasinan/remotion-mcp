/**
 * The four service tools (design 5.5): what each one declares and does. registry.ts registers them, each behind a
 * wrapper that audits the call and turns any throw into `internal`, so a handler here may throw.
 */

import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

import { buildStillArgv } from "../services/render-core.js";
import type { ServiceAuditEvent } from "./audit.js";
import { serviceError } from "./errors.js";
import type { ServiceContext } from "./registry.js";
import { childEnv, type CleanupReport, type RenderProcessResult } from "./render-process.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolDef { description: string; inputSchema?: ZodRawShape;
  handler(args: unknown, extra: ToolExtra, ctx: ServiceContext): Promise<CallToolResult> }

interface RenderStillArgs { template_id: string; frame?: number; props: Record<string, unknown> }

/** The file names inside a render's work dir. The CLI runs with its cwd there, so both are relative. */
const OUTPUT_FILE = "out.png";
const PROPS_FILE = "props.json";

export type CallIdentity = Pick<ServiceAuditEvent, "request_id" | "principal" | "tenant">;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The verified claims' ids, which the HTTP handler puts in `authInfo.extra.claims`. */
export function callIdentity(extra: ToolExtra | undefined): CallIdentity {
  const claims: unknown = extra?.authInfo?.extra?.claims;
  if (typeof claims !== "object" || claims === null) return {};
  const c = claims as Record<string, unknown>;
  return { request_id: text(c.request_id), principal: text(c.principal), tenant: text(c.tenant) };
}

/** An error's message, for the operator's log only. Never throws. */
export function errorText(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return "an error whose message cannot be read";
  }
}

/** How many characters one message, and one output tail, may take in a log line once escaped. */
const LOG_PART_CHARS = 2_500;
const LOG_ID_CHARS = 200;
/** A backslash, a control character, a line or paragraph separator, or a lone surrogate. */
const LOG_ESCAPED = /^[\\\p{Cc}\p{Zl}\p{Zp}\p{Cs}]$/u;

/** One character as a log line carries it: itself, or an escape, so the line stays one line. */
function logChar(c: string): string {
  if (!LOG_ESCAPED.test(c)) return c;
  if (c === "\\") return "\\\\";
  return `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

/**
 * `value` escaped onto one line, and at most `max` characters long: its start, or for an output tail its end, where
 * the last output is. Only whole characters and whole escapes are kept.
 */
function oneLine(value: string, max: number, keep: "start" | "end"): string {
  // A character escapes to at least itself, so no more than max + 1 code units can matter. A pair cut in two here
  // never fits: every piece together is then longer than max.
  const raw = keep === "start" ? value.slice(0, max + 1) : value.slice(-(max + 1));
  const pieces = Array.from(raw, logChar);
  if (keep === "end") pieces.reverse();
  const kept: string[] = [];
  let length = 0;
  for (const piece of pieces) {
    if (length + piece.length > max) break;
    kept.push(piece);
    length += piece.length;
  }
  if (keep === "end") kept.reverse();
  return kept.join("");
}

/**
 * Writes one line to the operator's log, `ctx.log`, or else to stderr:
 * `service: <tool> <category> request_id=<id>: <message>[: <output tail>]`. Everything after the prefix is escaped
 * onto one line and bounded. The log is never a caller's: no result and no audit event carries any of it. It never
 * throws, so a failing log cannot change what a call returns, or keep onUnverifiedCleanup from running.
 */
export function serviceLog(ctx: ServiceContext, extra: ToolExtra | undefined, tool: string, category: string,
  message: string, outputTail?: string): void {
  try {
    const requestId = callIdentity(extra).request_id;
    const id = requestId === undefined ? "-" : oneLine(requestId, LOG_ID_CHARS, "start");
    let line = `service: ${tool} ${category} request_id=${id}: ${oneLine(message, LOG_PART_CHARS, "start")}`;
    if (outputTail !== undefined) line += `: ${oneLine(outputTail, LOG_PART_CHARS, "end")}`;
    if (ctx.log === undefined) process.stderr.write(`${line}\n`);
    else ctx.log(line);
  } catch {
    // Diagnostics never decide what a call does.
  }
}

/** One render's view of serviceLog. */
type RenderLog = (category: string, message: string, outputTail?: string) => void;

/**
 * Removes a work dir, retrying the transient failures fs.rm retries. A failure is logged by its error code only,
 * since its message names the path; a dir that is already gone is not one. Never rejects.
 */
async function removeDir(dir: string, log: RenderLog): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === "ENOENT") return;
    log("internal", `work dir removal failed: ${typeof code === "string" ? code : "no error code"}`);
  }
}

/** O_NOFOLLOW where the platform has one (not Windows): a symlink swapped in after the lstat is still not followed. */
const OUTPUT_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * The PNG the CLI wrote, or why there is none to return. Only a regular file is opened: lstat, never stat, so a
 * symlink is never followed, and a FIFO, whose open would block, or a directory is never opened. It reads at most
 * `cap + 1` bytes, enough to tell a file over the cap, so an oversized output is never read whole.
 */
async function readOutput(file: string, cap: number): Promise<Buffer | "missing" | "not_file" | "empty" | "too_large"> {
  const chunks: Buffer[] = [];
  let total = 0;
  let handle: FileHandle | undefined;
  try {
    if (!(await fs.lstat(file)).isFile()) return "not_file";
    handle = await fs.open(file, OUTPUT_OPEN_FLAGS);
    // `end` is inclusive.
    for await (const chunk of handle.createReadStream({ end: cap, autoClose: false }) as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch {
    return "missing";
  } finally {
    await handle?.close().catch(() => {});
  }
  if (total === 0) return "empty";
  if (total > cap) return "too_large";
  return Buffer.concat(chunks, total);
}

/**
 * Maps a settled run to what the caller gets, in the brief's order. A render_failed also logs why, with the CLI's
 * output tail, for the operator. Never throws.
 */
async function responseFor(result: RenderProcessResult, dir: string, cap: number,
  log: RenderLog): Promise<CallToolResult> {
  if (result.timedOut) return serviceError("render_timeout");
  const failed = (reason: string): CallToolResult => {
    log("render_failed", reason, result.outputTail);
    return serviceError("render_failed");
  };
  // The tool's signal aborted, so its connection is gone and the SDK sends nothing; or the service is shutting down.
  if (result.aborted) return failed("aborted");
  if (result.signal !== null) return failed(`signal ${result.signal}`);
  if (result.exitCode !== 0) return failed(`exit code ${String(result.exitCode)}`);
  const png = await readOutput(path.join(dir, OUTPUT_FILE), cap);
  if (png === "missing") return failed("no out.png");
  if (png === "not_file") return failed("out.png is not a regular file");
  if (png === "empty") return failed("out.png is empty");
  if (png === "too_large") return serviceError("output_too_large");
  return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
}

/**
 * `cleanup` with a handler attached at once. Its contract rules out a rejection; one that came anyway, while the
 * response was still reading out.png, would otherwise be an unhandled rejection, which exits the process with the
 * caller's props on disk. A rejection counts as an unverified cleanup.
 */
function settleCleanup(cleanup: Promise<CleanupReport>): Promise<CleanupReport> {
  return Promise.resolve(cleanup).catch((err: unknown): CleanupReport => (
    { verified: false, survivors: [], cause: `cleanup rejected: ${errorText(err)}` }));
}

/**
 * Once every process of the render is gone, or cleanup gives up.
 * - Verified: removes the work dir, then frees the slot.
 * - Unverified: logs the cause, removes the work dir, then calls onUnverifiedCleanup, which exits the process. The dir
 *   goes first so the caller's props are off disk by then. If the handler throws instead, the service fails closed:
 *   the slot stays held, since the render's processes may still be alive, and the error is rethrown where nothing
 *   catches it, so the process dies of an uncaught exception and its restart policy recovers it.
 * Never rejects.
 */
async function afterCleanup(cleanup: Promise<CleanupReport>, dir: string, release: () => void, ctx: ServiceContext,
  log: RenderLog): Promise<void> {
  const report: CleanupReport | undefined = await cleanup;
  if (report?.verified === true) {
    await removeDir(dir, log);
    release();
    return;
  }
  log("internal", `cleanup unverified: ${report?.cause ?? "no cause given"}`);
  await removeDir(dir, log);
  try {
    ctx.onUnverifiedCleanup();
  } catch (err) {
    queueMicrotask(() => {
      throw err;
    });
    return;
  }
  release();
}

async function renderStill(args: unknown, extra: ToolExtra, ctx: ServiceContext): Promise<CallToolResult> {
  const log: RenderLog = (category, message, outputTail) => serviceLog(ctx, extra, "render_still", category, message,
    outputTail);
  const { template_id: id, frame = 0, props } = args as RenderStillArgs;
  // template() before validateProps(), which throws for an unknown id.
  const template = ctx.pack.template(id);
  if (template === undefined) return serviceError("unknown_template");
  if (frame >= template.maxFrames) return serviceError("frame_out_of_range");
  const verdict = ctx.pack.validateProps(id, props);
  if (!verdict.ok) return serviceError("invalid_props", verdict.paths);

  const release = ctx.slots.tryAcquire();
  if (release === null) return serviceError("render_busy");

  let dir: string | undefined;
  let result: RenderProcessResult;
  let cleanup: Promise<CleanupReport>;
  try {
    dir = await fs.mkdtemp(path.join(ctx.tempRoot, "r-")); // 0700
    // Props reach the CLI as a file, never as an argv string, which any process on the host can read.
    await fs.writeFile(path.join(dir, PROPS_FILE), JSON.stringify(props), { mode: 0o600, flag: "wx" });
    const argv = buildStillArgv({
      source: ctx.pack.bundleDir,
      compositionId: template.compositionId,
      output: OUTPUT_FILE,
      frame,
      propsFile: PROPS_FILE,
      width: template.width,
      height: template.height,
      browserExecutable: ctx.browserExecutable,
      timeoutMs: ctx.cliTimeoutMs,
    });
    result = await ctx.run(ctx.cli.file, [...ctx.cli.prefixArgs, ...argv], {
      cwd: dir,
      env: childEnv(process.env, dir),
      deadlineMs: ctx.stillDeadlineMs,
      graceMs: ctx.graceMs,
      verifyDeadlineMs: ctx.verifyDeadlineMs,
      // A closed connection or a service shutdown stops the render.
      signal: AbortSignal.any([extra.signal, ctx.shutdown]),
    });
    // Before anything else awaits: see settleCleanup.
    cleanup = settleCleanup(result.cleanup);
  } catch (err) {
    // No process was started, so there is nothing to wait for: free both at once.
    if (dir !== undefined) await removeDir(dir, log);
    release();
    throw err;
  }

  const workDir = dir;
  try {
    return await responseFor(result, workDir, ctx.pngCapBytes, log);
  } finally {
    // Only after the response is built, which reads out.png from the dir; the slot stays held until the render's
    // processes are gone.
    void afterCleanup(cleanup, workDir, release, ctx, log);
  }
}

async function listTemplates(_args: unknown, _extra: ToolExtra, ctx: ServiceContext): Promise<CallToolResult> {
  // map() builds a new array; the manifest and its entries are frozen and never changed.
  const templates = ctx.pack.manifest.templates.map(({ id, width, height, propsSchema }) => (
    { id, width, height, propsSchema }));
  const body = { templates };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
}

async function notImplemented(): Promise<CallToolResult> {
  return serviceError("not_implemented");
}

export const TOOL_DEFS = Object.freeze({
  list_templates: {
    description: "List the templates this deployment renders. Returns { templates: [{ id, width, height, "
      + "propsSchema }] }. propsSchema is the JSON Schema (draft 2020-12) that render_still validates props "
      + "against. Takes no arguments.",
    handler: listTemplates,
  },
  render_still: {
    description: "Render one frame of a template as a PNG, returned as image content. template_id is an id from "
      + "list_templates; frame defaults to 0 and must be below the template's frame count; props must match the "
      + "template's propsSchema. Errors are a category and a fixed message: unknown_template, frame_out_of_range, "
      + "invalid_props (with the JSON pointers of the failing props), render_busy, render_timeout, render_failed, "
      + "output_too_large or internal.",
    inputSchema: {
      template_id: z.string().max(100),
      frame: z.number().int().min(0).optional(),
      props: z.record(z.string(), z.unknown()),
    },
    handler: renderStill,
  },
  render_video_start: {
    description: "Start a video render. Not implemented yet: always returns not_implemented.",
    handler: notImplemented,
  },
  render_job_status: {
    description: "Report a video render job's status. Not implemented yet: always returns not_implemented.",
    inputSchema: { job_id: z.string().max(100) },
    handler: notImplemented,
  },
} satisfies Record<string, ToolDef>);

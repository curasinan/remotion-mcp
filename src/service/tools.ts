/**
 * The four service tools (design 5.5): what each one declares and does. registry.ts registers them, each behind a
 * wrapper that audits the call and turns any throw into `internal`, so a handler here may throw.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

import { buildStillArgv } from "../services/render-core.js";
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

const removeDir = (dir: string): Promise<void> => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

/**
 * The PNG the CLI wrote, or why there is none to return. It reads at most `cap + 1` bytes, enough to tell a file over
 * the cap, so an oversized output is never read whole. A missing file, or one that is not a file, is "missing".
 */
async function readOutput(file: string, cap: number): Promise<Buffer | "missing" | "too_large"> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    // `end` is inclusive.
    for await (const chunk of createReadStream(file, { end: cap }) as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch {
    return "missing";
  }
  if (total === 0) return "missing";
  if (total > cap) return "too_large";
  return Buffer.concat(chunks, total);
}

/** Maps a settled run to what the caller gets, in the brief's order. Never throws. */
async function responseFor(result: RenderProcessResult, dir: string, cap: number): Promise<CallToolResult> {
  if (result.timedOut) return serviceError("render_timeout");
  // The tool's signal aborted, so its connection is gone and the SDK sends nothing; or the service is shutting down.
  if (result.aborted) return serviceError("render_failed");
  if (result.exitCode !== 0 || result.signal !== null) return serviceError("render_failed");
  const png = await readOutput(path.join(dir, OUTPUT_FILE), cap);
  if (png === "missing") return serviceError("render_failed");
  if (png === "too_large") return serviceError("output_too_large");
  return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
}

/**
 * Once every process of the render is gone, or cleanup gives up: removes the work dir, reports an unverified cleanup,
 * then frees the slot. The dir goes first because `onUnverifiedCleanup` exits the process, and the caller's props
 * must be off disk by then. Never rejects.
 */
async function afterCleanup(cleanup: Promise<CleanupReport>, dir: string, release: () => void,
  ctx: ServiceContext): Promise<void> {
  let verified = false;
  try {
    verified = (await cleanup).verified === true;
  } catch {
    // cleanup never rejects by contract; if it did, nothing is verified.
  }
  try {
    await removeDir(dir);
    if (!verified) ctx.onUnverifiedCleanup();
  } catch {
    // A throwing handler must not keep the slot.
  } finally {
    release();
  }
}

async function renderStill(args: unknown, extra: ToolExtra, ctx: ServiceContext): Promise<CallToolResult> {
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
  } catch (err) {
    // No process was started, so there is nothing to wait for: free both at once.
    if (dir !== undefined) await removeDir(dir);
    release();
    throw err;
  }

  const workDir = dir;
  try {
    return await responseFor(result, workDir, ctx.pngCapBytes);
  } finally {
    // Only after the response is built, which reads out.png from the dir; the slot stays held until the render's
    // processes are gone.
    void afterCleanup(result.cleanup, workDir, release, ctx);
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

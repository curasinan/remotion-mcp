/**
 * Rendering tools.
 *
 * The still renderer exists so a broken animation can be diagnosed in seconds
 * from a single frame instead of minutes from a full encode. Reach for
 * remotion_render_still first and remotion_render_video only once a frame
 * looks right.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIMEOUT_RENDER_MS } from "../constants.js";
import {
  compositionIdField,
  entryPointField,
  outputPathField,
  projectDirField,
  propsJsonField,
  responseFormatField,
} from "../schemas/common.js";
import { isRemotionProject } from "../services/environment.js";
import { assertSafePositional, diagnoseCliFailure, fenceUntrusted, resolveRemotionCli, runCommand, tailOutput } from "../services/exec.js";
import {
  buildErrorResponse,
  buildResponse,
  formatBytes,
  formatDuration,
  safeHandler,
  type ToolResponse,
} from "../services/format.js";
import { displayPath, ensureParentDirectory, resolveExistingDirectory, resolveInWorkspace } from "../services/paths.js";
import { ToolInputError } from "../types.js";
import { requireEntryPoint } from "./project.js";

/** Largest file we will inline as a base64 image content block. */
const MAX_INLINE_IMAGE_BYTES = 1_500_000;

const CODECS = [
  "h264",
  "h265",
  "vp8",
  "vp9",
  "prores",
  "gif",
  "mp3",
  "aac",
  "wav",
] as const;

const RenderStillShape = {
  project_dir: projectDirField,
  entry_point: entryPointField,
  composition_id: compositionIdField,
  output_path: outputPathField(
    "Output PNG path relative to the workspace root, e.g. 'tactics-video/out/frame.png'",
  ),
  frame: z
    .number()
    .int()
    .default(0)
    .describe("Frame number to render. Negative values count from the end, so -1 is the last frame."),
  scale: z
    .number()
    .min(0.1)
    .max(4)
    .default(1)
    .describe("Resolution multiplier. Use 0.5 for fast iteration on a 1080p composition."),
  props_json: propsJsonField,
  return_image: z
    .boolean()
    .default(true)
    .describe("Attach the rendered PNG to the response so it can be inspected directly. Skipped automatically for files over 1.5 MB."),
  response_format: responseFormatField,
};
type RenderStillInput = z.infer<z.ZodObject<typeof RenderStillShape>>;

const RenderVideoShape = {
  project_dir: projectDirField,
  entry_point: entryPointField,
  composition_id: compositionIdField,
  output_path: outputPathField(
    "Output file path relative to the workspace root, e.g. 'tactics-video/out/clip.mp4'",
  ),
  codec: z
    .enum(CODECS)
    .default("h264")
    .describe("Output codec. h264 for mp4, gif for animated GIF, prores for editing handoff."),
  frames: z
    .string()
    .regex(/^\d+(-\d*)?$/, "Use a single number ('30'), a range ('0-90') or an open range ('100-')")
    .optional()
    .describe("Frame subset to render, e.g. '0-90'. Omit to render the whole composition. Rendering a short range first is the fastest way to check an encode."),
  scale: z
    .number()
    .min(0.1)
    .max(4)
    .default(1)
    .describe("Resolution multiplier"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe("Number of CPU threads. Omit to let Remotion choose. Lower this if renders crash with out-of-memory errors."),
  props_json: propsJsonField,
  response_format: responseFormatField,
};
type RenderVideoInput = z.infer<z.ZodObject<typeof RenderVideoShape>>;

function validatePropsJson(propsJson: string | undefined): string | null {
  if (propsJson === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(propsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ToolInputError(
        "props_json must be a JSON object.",
        'Wrap the values in braces, for example \'{"title":"Haramball"}\'.',
      );
    }
    return propsJson;
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError(
      `props_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'Pass a serialized JSON object such as \'{"speed":2}\'. Single quotes around keys are not valid JSON.',
    );
  }
}

interface RenderContext {
  dir: string;
  entry: string;
  output: string;
  /** The exact token handed to the CLI as the output positional. */
  outputArg: string;
}

function prepareRender(
  projectDir: string,
  entryPoint: string | undefined,
  outputPath: string,
): RenderContext {
  const dir = resolveExistingDirectory(projectDir);
  if (!isRemotionProject(dir)) {
    throw new ToolInputError(
      `'${displayPath(dir)}' has no remotion dependency in package.json.`,
      "Call remotion_check_environment for a full diagnosis, or point project_dir at the real project directory.",
    );
  }
  const entry = requireEntryPoint(dir, entryPoint);
  const output = resolveInWorkspace(outputPath);
  ensureParentDirectory(output);

  const outputArg = path.relative(dir, output);
  assertSafePositional(outputArg, "output path");
  assertSafePositional(entry, "entry point");

  return { dir, entry, output, outputArg };
}

function renderFailure(
  label: string,
  cliSource: "local" | "npx",
  result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean },
  outputPath?: string,
): ToolResponse {
  // A render killed mid-encode leaves a truncated file. Reporting failure while
  // leaving it on disk invites the next step to be taken against a broken
  // artefact that looks like a finished one.
  if (result.timedOut && outputPath) {
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      // Something that outlived the kill still holds it open; the error below
      // already says the render did not finish.
    }
  }

  const combined = tailOutput(`${result.stdout}\n${result.stderr}`);
  return buildErrorResponse(
    `${label} exited with code ${result.exitCode}${result.timedOut ? " after timing out" : ""}.\n\n${fenceUntrusted(combined)}`,
    diagnoseCliFailure(combined, cliSource, result.timedOut),
  );
}

export function registerRenderTools(server: McpServer): void {
  server.registerTool(
    "remotion_render_still",
    {
      title: "Render Remotion Still Frame",
      description: `Render one frame of a Remotion composition to a PNG and, by default, attach that PNG to the response so the result can be looked at directly.

This is the fast feedback loop. A still takes seconds where a full video takes minutes, and most layout, colour and timing mistakes are visible in a single frame. Render a still, look at it, fix the composition, repeat, and only call remotion_render_video once a frame looks correct.

Args:
  - project_dir (string): Project directory relative to the workspace root (default: '.')
  - entry_point (string, optional): Entry point relative to project_dir; omit to auto-detect
  - composition_id (string, required): Composition id from remotion_list_compositions
  - output_path (string, required): Output PNG path relative to the workspace root
  - frame (number): Frame to render; negative counts from the end (default: 0)
  - scale (number): Resolution multiplier, 0.1 to 4 (default: 1)
  - props_json (string, optional): Serialized JSON object of input props
  - return_image (boolean): Attach the PNG to the response (default: true)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "success": boolean,
    "output_path": string,      // Relative to the workspace root
    "frame": number,
    "file_size_bytes": number,
    "duration_ms": number,
    "image_attached": boolean   // False when the PNG exceeded the 1.5 MB inline cap
  }
  When image_attached is true, the response also carries the PNG as an image content block.

Examples:
  - Use when: "show me frame 45 of the Haramball composition" -> composition_id="Haramball", frame=45
  - Use when: Checking a layout change without waiting for a full encode -> scale=0.5
  - Use when: Testing how props change the output -> props_json='{"team":"away"}'
  - Don't use when: You need motion or audio (use remotion_render_video)

Error Handling:
  - "No compositions" in the output means the id is wrong; call remotion_list_compositions
  - Browser or Chrome errors mean the headless shell is missing; call remotion_ensure_browser
  - Returns an error if props_json is not a valid JSON object`,
      inputSchema: RenderStillShape,
      // openWorld: rendering bundles and executes the project's own code, which
      // decides for itself what it loads.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeHandler("remotion_render_still", async (input: RenderStillInput) => {
      const props = validatePropsJson(input.props_json);
      const ctx = prepareRender(input.project_dir, input.entry_point, input.output_path);
      const cli = resolveRemotionCli(ctx.dir);

      const args = [
        ...cli.prefixArgs,
        "still",
        ctx.entry,
        input.composition_id,
        ctx.outputArg,
        `--frame=${input.frame}`,
        `--scale=${input.scale}`,
        "--image-format=png",
        "--overwrite",
        "--log=info",
      ];
      if (props) args.push(`--props=${props}`);

      const result = await runCommand(cli.file, args, {
        cwd: ctx.dir,
        timeoutMs: TIMEOUT_RENDER_MS,
      });

      if (result.exitCode !== 0 || !fs.existsSync(ctx.output)) {
        return renderFailure("remotion still", cli.source, result, ctx.output);
      }

      const size = fs.statSync(ctx.output).size;
      const attach = input.return_image && size <= MAX_INLINE_IMAGE_BYTES;

      const structured = {
        success: true,
        output_path: displayPath(ctx.output),
        frame: input.frame,
        file_size_bytes: size,
        duration_ms: result.durationMs,
        image_attached: attach,
      };

      const markdown = [
        `# Rendered frame ${input.frame} of \`${input.composition_id}\``,
        "",
        `- **Output:** \`${displayPath(ctx.output)}\``,
        `- **Size:** ${formatBytes(size)}`,
        `- **Took:** ${formatDuration(result.durationMs)}`,
        ...(input.return_image && !attach
          ? ["", `Image not attached: ${formatBytes(size)} exceeds the ${formatBytes(MAX_INLINE_IMAGE_BYTES)} inline cap. Re-render with a lower scale to inspect it inline.`]
          : []),
      ].join("\n");

      const response = buildResponse(markdown, structured, input.response_format);
      if (attach) {
        response.content.push({
          type: "image",
          data: fs.readFileSync(ctx.output).toString("base64"),
          mimeType: "image/png",
        });
      }
      return response;
    }),
  );

  server.registerTool(
    "remotion_render_video",
    {
      title: "Render Remotion Video",
      description: `Render a Remotion composition to a video or audio file.

Renders are slow and expensive, so confirm the composition works first: call remotion_list_compositions to check it builds, then remotion_render_still to check a frame looks right, then render a short frames range before committing to the full duration.

Args:
  - project_dir (string): Project directory relative to the workspace root (default: '.')
  - entry_point (string, optional): Entry point relative to project_dir; omit to auto-detect
  - composition_id (string, required): Composition id from remotion_list_compositions
  - output_path (string, required): Output file path relative to the workspace root
  - codec ('h264'|'h265'|'vp8'|'vp9'|'prores'|'gif'|'mp3'|'aac'|'wav'): Default 'h264'
  - frames (string, optional): Subset such as '0-90' or '100-'. Omit for the full composition.
  - scale (number): Resolution multiplier, 0.1 to 4 (default: 1)
  - concurrency (number, optional): CPU threads, 1 to 64. Omit to let Remotion choose.
  - props_json (string, optional): Serialized JSON object of input props
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "success": boolean,
    "output_path": string,       // Relative to the workspace root
    "codec": string,
    "frames": string|null,       // Range requested, null when full composition
    "file_size_bytes": number,
    "duration_ms": number,
    "log_tail": string           // Last portion of the render log
  }

Examples:
  - Use when: "render the Haramball composition to mp4" -> composition_id="Haramball", output_path="out/haramball.mp4"
  - Use when: Producing a shareable loop -> codec="gif", frames="0-60", scale=0.5
  - Use when: Sanity-checking an encode cheaply -> frames="0-30", scale=0.5
  - Don't use when: One frame answers the question (use remotion_render_still)

Error Handling:
  - Out-of-memory failures: retry with concurrency=2 and scale=0.5
  - Browser or Chrome errors: call remotion_ensure_browser first
  - Times out after 30 minutes; render a frames subset instead of the full composition`,
      inputSchema: RenderVideoShape,
      // openWorld: see remotion_render_still.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeHandler("remotion_render_video", async (input: RenderVideoInput) => {
      const props = validatePropsJson(input.props_json);
      const ctx = prepareRender(input.project_dir, input.entry_point, input.output_path);
      const cli = resolveRemotionCli(ctx.dir);

      const args = [
        ...cli.prefixArgs,
        "render",
        ctx.entry,
        input.composition_id,
        ctx.outputArg,
        `--codec=${input.codec}`,
        `--scale=${input.scale}`,
        "--overwrite",
        "--log=info",
      ];
      if (input.frames) args.push(`--frames=${input.frames}`);
      if (input.concurrency) args.push(`--concurrency=${input.concurrency}`);
      if (props) args.push(`--props=${props}`);

      const result = await runCommand(cli.file, args, {
        cwd: ctx.dir,
        timeoutMs: TIMEOUT_RENDER_MS,
      });

      if (result.exitCode !== 0 || !fs.existsSync(ctx.output)) {
        return renderFailure("remotion render", cli.source, result, ctx.output);
      }

      const size = fs.statSync(ctx.output).size;
      const structured = {
        success: true,
        output_path: displayPath(ctx.output),
        codec: input.codec,
        frames: input.frames ?? null,
        file_size_bytes: size,
        duration_ms: result.durationMs,
        log_tail: tailOutput(`${result.stdout}\n${result.stderr}`, 1_500),
      };

      const markdown = [
        `# Rendered \`${input.composition_id}\``,
        "",
        `- **Output:** \`${displayPath(ctx.output)}\``,
        `- **Codec:** ${input.codec}`,
        `- **Frames:** ${input.frames ?? "full composition"}`,
        `- **Size:** ${formatBytes(size)}`,
        `- **Took:** ${formatDuration(result.durationMs)}`,
      ].join("\n");

      return buildResponse(markdown, structured, input.response_format);
    }),
  );
}

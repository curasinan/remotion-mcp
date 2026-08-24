/**
 * Project lifecycle tools: scaffold a project, list what it can render.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIMEOUT_BUNDLE_MS } from "../constants.js";
import { entryPointField, projectDirField, responseFormatField } from "../schemas/common.js";
import { findEntryPoint, isRemotionProject } from "../services/environment.js";
import { assertSafePositional, diagnoseCliFailure, resolveNpmCli, resolveRemotionCli, runCommand, tailOutput } from "../services/exec.js";
import {
  buildErrorResponse,
  buildResponse,
  bulletList,
  formatDuration,
  safeHandler,
} from "../services/format.js";
import { displayPath, resolveExistingDirectory, resolveInWorkspace } from "../services/paths.js";
import { PROJECT_TEMPLATE } from "../templates/remotionProject.js";
import type { CompositionSummary } from "../types.js";
import { ToolInputError } from "../types.js";

const InitProjectShape = {
  project_dir: z
    .string()
    .min(1)
    .max(500)
    .describe("Directory to create the project in, relative to the workspace root (e.g. 'tactics-video')"),
  remotion_version: z
    .string()
    .regex(/^[\^~]?\d+\.\d+\.\d+$/, "Use a semver string such as '4.0.0' or '^4.0.0'")
    .default("^4.0.0")
    .describe("Remotion version range written into package.json"),
  install: z
    .boolean()
    .default(false)
    .describe("Run `npm install` after scaffolding. Adds several minutes but leaves a project that can render immediately."),
  response_format: responseFormatField,
};
type InitProjectInput = z.infer<z.ZodObject<typeof InitProjectShape>>;

const ListCompositionsShape = {
  project_dir: projectDirField,
  entry_point: entryPointField,
  response_format: responseFormatField,
};
type ListCompositionsInput = z.infer<z.ZodObject<typeof ListCompositionsShape>>;

/** Resolve the entry point for a project, or explain why it could not be found. */
export function requireEntryPoint(projectDir: string, explicit?: string): string {
  if (explicit) {
    const absolute = resolveInWorkspace(path.join(displayPath(projectDir), explicit));
    if (!fs.existsSync(absolute)) {
      throw new ToolInputError(
        `Entry point '${explicit}' does not exist inside the project.`,
        `Looked at '${absolute}'. Call remotion_check_environment to see which entry points were auto-detected.`,
      );
    }
    assertSafePositional(explicit, "entry point");
    return explicit;
  }

  const detected = findEntryPoint(projectDir);
  if (!detected) {
    throw new ToolInputError(
      "No Remotion entry point could be auto-detected.",
      "Create src/index.ts containing `registerRoot(RemotionRoot)`, or pass entry_point explicitly.",
    );
  }
  assertSafePositional(detected, "entry point");
  return detected;
}

/**
 * Parse the table that `remotion compositions` prints. The column layout is
 * not a stable contract, so ids are extracted leniently and numeric metadata
 * is attached only when the row clearly carries it.
 */
export function parseCompositionsOutput(stdout: string): CompositionSummary[] {
  const results: CompositionSummary[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || /^-+$/.test(line)) continue;
    if (/^(id|composition)\b/i.test(line)) continue;

    const columns = line.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
    const id = columns[0];
    if (!id || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(id)) continue;

    const summary: CompositionSummary = { id };
    const dimensions = /(\d+)\s*x\s*(\d+)/i.exec(line);
    if (dimensions) {
      summary.width = Number(dimensions[1]);
      summary.height = Number(dimensions[2]);
    }
    const fps = /(\d+(?:\.\d+)?)\s*fps/i.exec(line);
    if (fps) summary.fps = Number(fps[1]);
    const frames = /(\d+)\s*frames?/i.exec(line);
    if (frames) summary.duration_in_frames = Number(frames[1]);

    results.push(summary);
  }
  return results;
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "remotion_init_project",
    {
      title: "Initialize Remotion Project",
      description: `Scaffold a minimal, working Remotion 4 project: package.json, tsconfig.json, remotion.config.ts, src/index.ts, src/Root.tsx and one example composition.

Use this instead of writing Remotion boilerplate by hand. The generated project is deliberately small and correct, so the usual first-run failures (wrong React version pairing, a missing registerRoot call, an entry point the CLI cannot find) do not happen.

The target directory must be empty or nonexistent. This tool never overwrites existing files.

Args:
  - project_dir (string, required): Directory to create, relative to the workspace root
  - remotion_version (string): Semver range for Remotion (default: '^4.0.0')
  - install (boolean): Also run npm install (default: false)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "project_dir": string,        // Path relative to the workspace root
    "files_created": string[],    // Paths relative to project_dir
    "installed": boolean,         // Whether npm install ran and succeeded
    "next_steps": string[]        // Ordered commands or tool calls to run next
  }

Examples:
  - Use when: "set up a Remotion project for my tactics animations" -> project_dir="tactics-video"
  - Use when: Starting fresh and you want a known-good baseline to modify
  - Don't use when: A project already exists (this tool refuses to overwrite)

Error Handling:
  - Returns an error if the directory exists and is not empty, listing what is in it
  - Returns an error if the path escapes the workspace root`,
      inputSchema: InitProjectShape,
      // openWorld because install:true runs npm install against the registry.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safeHandler("remotion_init_project", async (input: InitProjectInput) => {
      const target = resolveInWorkspace(input.project_dir);

      if (fs.existsSync(target)) {
        const entries = fs.readdirSync(target);
        if (entries.length > 0) {
          return buildErrorResponse(
            `Directory '${input.project_dir}' already exists and is not empty (${entries.length} entries: ${entries.slice(0, 8).join(", ")}).`,
            "Pick an empty directory, or if this is already a Remotion project call remotion_check_environment against it instead.",
          );
        }
      }

      const created: string[] = [];
      for (const [relative, contents] of Object.entries(
        PROJECT_TEMPLATE(input.remotion_version, path.basename(target)),
      )) {
        const filePath = path.join(target, relative);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, contents, "utf8");
        created.push(relative);
      }

      let installed = false;
      let installLog = "";
      if (input.install) {
        const npm = resolveNpmCli();
        const result = await runCommand(npm.file, [...npm.prefixArgs, "install"], {
          cwd: target,
          timeoutMs: TIMEOUT_BUNDLE_MS,
        });
        installed = result.exitCode === 0;
        installLog = tailOutput(`${result.stdout}\n${result.stderr}`, 2_000);
      }

      const nextSteps = [
        ...(installed ? [] : [`Run \`npm install\` in ${displayPath(target)}`]),
        "Call remotion_ensure_browser so the first render does not stall on a browser download",
        "Call remotion_list_compositions to confirm the entry point resolves",
        "Call remotion_render_still to check a single frame before rendering video",
      ];

      const structured = {
        project_dir: displayPath(target),
        files_created: created,
        installed,
        next_steps: nextSteps,
      };

      const markdown = [
        `# Created Remotion project at \`${displayPath(target)}\``,
        "",
        `Remotion version range: \`${input.remotion_version}\``,
        "",
        "## Files",
        "",
        bulletList(created),
        "",
        "## Install",
        "",
        input.install
          ? installed
            ? "npm install succeeded."
            : `npm install failed:\n\n\`\`\`\n${installLog}\n\`\`\``
          : "Skipped (install=false).",
        "",
        "## Next steps",
        "",
        bulletList(nextSteps),
      ].join("\n");

      return buildResponse(markdown, structured, input.response_format);
    }),
  );

  server.registerTool(
    "remotion_list_compositions",
    {
      title: "List Remotion Compositions",
      description: `List every composition registered in a Remotion project, with its dimensions, fps and duration where the CLI reports them.

This bundles the project, so it doubles as the cheapest way to find out whether the code compiles at all. If a composition you expect is missing, it was not registered in Root.tsx. If the command fails, the error output is the real compile error, returned verbatim.

Args:
  - project_dir (string): Project directory relative to the workspace root (default: '.')
  - entry_point (string, optional): Entry point relative to project_dir; omit to auto-detect
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "project_dir": string,
    "entry_point": string,
    "count": number,
    "compositions": [
      {
        "id": string,                  // Pass this as composition_id to the render tools
        "width": number,               // Present when reported
        "height": number,
        "fps": number,
        "duration_in_frames": number
      }
    ],
    "raw_output": string               // Unparsed CLI output, for when parsing misses something
  }

Examples:
  - Use when: "what can I render in this project?" -> project_dir="tactics-video"
  - Use when: You need the exact composition id before calling remotion_render_video
  - Use when: You want a fast compile check without rendering anything
  - Don't use when: The project has no node_modules yet (run npm install first)

Error Handling:
  - Returns the bundler's compile error verbatim when the project does not build
  - Returns an error if no entry point can be found, listing the paths that were tried`,
      inputSchema: ListCompositionsShape,
      // Not read-only: listing compositions bundles the project, which executes
      // its code and writes a build cache. Not a closed world either - bundling
      // resolves imports, and with no local install the CLI is fetched by npx.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeHandler("remotion_list_compositions", async (input: ListCompositionsInput) => {
      const dir = resolveExistingDirectory(input.project_dir);

      if (!isRemotionProject(dir)) {
        return buildErrorResponse(
          `'${displayPath(dir)}' does not look like a Remotion project: package.json has no remotion dependency.`,
          "Call remotion_check_environment for a full diagnosis, or remotion_init_project to create a project here.",
        );
      }

      const entry = requireEntryPoint(dir, input.entry_point);
      const cli = resolveRemotionCli(dir);
      const result = await runCommand(cli.file, [...cli.prefixArgs, "compositions", entry], {
        cwd: dir,
        timeoutMs: TIMEOUT_BUNDLE_MS,
      });

      if (result.exitCode !== 0) {
        const combined = tailOutput(`${result.stdout}\n${result.stderr}`);
        return buildErrorResponse(
          `remotion compositions exited with code ${result.exitCode}${result.timedOut ? " after timing out" : ""}.\n\n\`\`\`\n${combined}\n\`\`\``,
          diagnoseCliFailure(combined, cli.source, result.timedOut),
        );
      }

      const compositions = parseCompositionsOutput(result.stdout);
      const structured = {
        project_dir: displayPath(dir),
        entry_point: entry,
        count: compositions.length,
        compositions,
        raw_output: tailOutput(result.stdout, 3_000),
      };

      const markdown = [
        `# Compositions in \`${displayPath(dir)}\``,
        "",
        `Entry point: \`${entry}\` (bundled in ${formatDuration(result.durationMs)})`,
        "",
        compositions.length === 0
          ? "No compositions were parsed. Raw CLI output:\n\n```\n" + tailOutput(result.stdout, 3_000) + "\n```"
          : compositions
              .map((c) => {
                const meta = [
                  c.width && c.height ? `${c.width}x${c.height}` : null,
                  c.fps ? `${c.fps} fps` : null,
                  c.duration_in_frames ? `${c.duration_in_frames} frames` : null,
                ]
                  .filter(Boolean)
                  .join(", ");
                return `- **${c.id}**${meta ? ` — ${meta}` : ""}`;
              })
              .join("\n"),
      ].join("\n");

      return buildResponse(markdown, structured, input.response_format);
    }),
  );
}

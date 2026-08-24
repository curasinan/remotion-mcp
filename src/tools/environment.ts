/**
 * Diagnostic tools. Run these first when anything Remotion-related fails.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { projectDirField, responseFormatField } from "../schemas/common.js";
import { buildEnvironmentReport } from "../services/environment.js";
import { resolveRemotionCli, runCommand, tailOutput } from "../services/exec.js";
import {
  buildErrorResponse,
  buildResponse,
  bulletList,
  formatDuration,
  safeHandler,
} from "../services/format.js";
import { displayPath, resolveExistingDirectory, getWorkspaceRoot } from "../services/paths.js";
import { ResponseFormat } from "../types.js";
import { TIMEOUT_BUNDLE_MS } from "../constants.js";

const CheckEnvironmentShape = {
  project_dir: projectDirField,
  response_format: responseFormatField,
};
type CheckEnvironmentInput = z.infer<z.ZodObject<typeof CheckEnvironmentShape>>;

const EnsureBrowserShape = {
  project_dir: projectDirField,
  response_format: responseFormatField,
};
type EnsureBrowserInput = z.infer<z.ZodObject<typeof EnsureBrowserShape>>;

export function registerEnvironmentTools(server: McpServer): void {
  server.registerTool(
    "remotion_check_environment",
    {
      title: "Check Remotion Environment",
      description: `Diagnose whether this machine can render Remotion videos, and report a specific fix for each thing that is missing.

Run this FIRST whenever a Remotion command fails, hangs, or produces an empty output file. It checks the four causes behind almost every Remotion failure: a Node version below 18, no local Remotion install, a missing Chrome Headless Shell, and an entry point that is not where the CLI looks for it.

Args:
  - project_dir (string): Project directory relative to the workspace root (default: '.')
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "workspace_root": string,          // Directory all paths are confined to
    "project_dir": string,             // Directory that was inspected
    "is_remotion_project": boolean,    // package.json declares a remotion dependency
    "remotion_entry_point": string|null, // Auto-detected entry point, relative to project_dir
    "checks": [
      {
        "name": string,                // e.g. "Chrome Headless Shell"
        "found": boolean,
        "version": string,             // Present when detectable
        "detail": string,              // What was observed
        "fix": string                  // Present only when found is false
      }
    ],
    "blocking_problems": string[],     // Fixes for everything that blocks rendering
    "ready_to_render": boolean
  }

Examples:
  - Use when: "my Remotion render keeps failing" -> project_dir="tactics-video"
  - Use when: "is my machine set up for Remotion?" -> project_dir="."
  - Don't use when: You want the list of compositions (use remotion_list_compositions)

Error Handling:
  - Returns an error if project_dir does not exist or escapes the workspace root
  - Never throws for a missing tool; a missing tool is reported as found=false with a fix`,
      inputSchema: CheckEnvironmentShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler("remotion_check_environment", async (input: CheckEnvironmentInput) => {
      const dir = resolveExistingDirectory(input.project_dir);
      const report = await buildEnvironmentReport(dir);

      const lines: string[] = [
        "# Remotion Environment Check",
        "",
        `**Workspace root:** \`${report.workspace_root}\``,
        `**Project directory:** \`${displayPath(dir)}\``,
        `**Ready to render:** ${report.ready_to_render ? "yes" : "no"}`,
        "",
        "## Checks",
        "",
      ];

      for (const check of report.checks) {
        const mark = check.found ? "PASS" : "FAIL";
        const version = check.version ? ` (${check.version})` : "";
        lines.push(`### ${mark} ${check.name}${version}`);
        if (check.detail) lines.push(check.detail);
        if (check.fix) lines.push(`**Fix:** ${check.fix}`);
        lines.push("");
      }

      if (report.blocking_problems.length > 0) {
        lines.push("## Blocking problems", "", bulletList(report.blocking_problems));
      } else {
        lines.push("## Blocking problems", "", "None. Rendering should work.");
      }

      return buildResponse(
        lines.join("\n"),
        report as unknown as Record<string, unknown>,
        input.response_format,
      );
    }),
  );

  server.registerTool(
    "remotion_ensure_browser",
    {
      title: "Ensure Remotion Browser",
      description: `Download the Chrome Headless Shell that Remotion renders with, if it is not already cached.

Remotion fetches this browser lazily on the first render. That means the first render on a new machine spends several minutes downloading before it produces anything, and on a slow or restricted network it fails with an error that looks like a rendering bug rather than a download failure. Calling this tool up front separates the two.

Safe to call repeatedly: if the browser is already cached the command exits immediately without downloading.

Args:
  - project_dir (string): Project directory relative to the workspace root (default: '.')
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "success": boolean,
    "already_present": boolean,   // True when nothing needed downloading
    "duration_ms": number,
    "output": string              // Tail of the CLI output
  }

Examples:
  - Use when: Setting up a machine for the first time
  - Use when: remotion_check_environment reported Chrome Headless Shell as missing
  - Don't use when: You just want to know whether it is present (use remotion_check_environment)

Error Handling:
  - Returns an error naming the network or disk problem if the download fails
  - Requires a Remotion project; run remotion_init_project first if there is none`,
      inputSchema: EnsureBrowserShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeHandler("remotion_ensure_browser", async (input: EnsureBrowserInput) => {
      const dir = resolveExistingDirectory(input.project_dir);
      const cli = resolveRemotionCli(dir);
      const result = await runCommand(cli.file, [...cli.prefixArgs, "browser", "ensure"], {
        cwd: dir,
        timeoutMs: TIMEOUT_BUNDLE_MS,
      });

      const combined = `${result.stdout}\n${result.stderr}`.trim();

      if (result.exitCode !== 0) {
        return buildErrorResponse(
          `remotion browser ensure exited with code ${result.exitCode}${result.timedOut ? " after timing out" : ""}.\n\n${tailOutput(combined)}`,
          result.timedOut
            ? "The download exceeded 5 minutes. Check the network connection, then call this tool again; partial downloads resume."
            : "If this says the CLI was not found, run `npm install` in the project directory first.",
        );
      }

      const alreadyPresent = /already|up to date|exists/i.test(combined) || result.durationMs < 4_000;
      const structured = {
        success: true,
        already_present: alreadyPresent,
        duration_ms: result.durationMs,
        output: tailOutput(combined, 2_000),
      };

      const markdown = [
        "# Chrome Headless Shell",
        "",
        alreadyPresent
          ? "Already cached, nothing downloaded."
          : `Downloaded in ${formatDuration(result.durationMs)}.`,
        "",
        combined ? "```\n" + tailOutput(combined, 2_000) + "\n```" : "",
      ].join("\n");

      return buildResponse(markdown, structured, input.response_format);
    }),
  );

  server.registerTool(
    "remotion_get_workspace_info",
    {
      title: "Get Workspace Info",
      description: `Report the workspace root that every file path argument in this server is resolved against and confined to.

Use this when a path argument is rejected as "outside the workspace root", or before passing paths so they are written relative to the right base. The root is set by the REMOTION_MCP_WORKSPACE environment variable and falls back to the server process working directory.

Args: none

Returns (JSON format):
  {
    "workspace_root": string,       // Absolute, symlink-resolved path
    "configured_via": string        // "REMOTION_MCP_WORKSPACE" or "process cwd"
  }

Examples:
  - Use when: A tool returned "resolves outside the workspace root"
  - Use when: You need to know what "." means before calling other tools
  - Don't use when: You want to know whether a project can render (use remotion_check_environment)

Error Handling:
  - Cannot fail`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler("remotion_get_workspace_info", async () => {
      const structured = {
        workspace_root: getWorkspaceRoot(),
        configured_via: process.env.REMOTION_MCP_WORKSPACE
          ? "REMOTION_MCP_WORKSPACE"
          : "process cwd",
      };
      const markdown = [
        "# Workspace",
        "",
        `**Root:** \`${structured.workspace_root}\``,
        `**Configured via:** ${structured.configured_via}`,
        "",
        "All path arguments are resolved against this root and may not escape it.",
      ].join("\n");
      return buildResponse(markdown, structured, ResponseFormat.MARKDOWN);
    }),
  );
}

#!/usr/bin/env node
/**
 * remotion-viz-mcp-server
 *
 * Tools for rendering Remotion compositions and for validating and
 * rasterizing SVG/HTML visualizations, with diagnostics that name the fix for
 * the failures these two workflows actually hit.
 *
 * Transport: stdio only.
 *
 * This server spawns child processes, compiles and runs code out of the
 * workspace, and writes files to paths given as tool arguments. Over stdio the
 * only thing that can reach it is the process that launched it. Exposing that
 * capability over a network would put a bearer token between the internet and
 * a code execution surface, so no network transport is offered. See
 * docs/adr/0001-transport-stdio-only.md.
 *
 * Set REMOTION_MCP_WORKSPACE to the directory that file paths resolve against.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { ConfigError, loadConfig } from "./config.js";
import { getWorkspaceRoot } from "./services/paths.js";
import { registerCompareTools } from "./tools/compare.js";
import { registerEnvironmentTools } from "./tools/environment.js";
import { registerProjectTools } from "./tools/project.js";
import { registerRenderTools } from "./tools/render.js";
import { registerStudioTools } from "./tools/studio.js";
import { registerVisualizationTools } from "./tools/visualize.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerEnvironmentTools(server);
  registerProjectTools(server);
  registerRenderTools(server);
  registerStudioTools(server);
  registerVisualizationTools(server);
  registerCompareTools(server);

  return server;
}

function printHelp(): void {
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}

Usage:
  remotion-viz-mcp-server        Run as an MCP server over stdio
  remotion-viz-mcp-server --help Show this message

Environment:
  REMOTION_MCP_WORKSPACE  Directory that all file path arguments resolve
                          against and are confined to. Defaults to the
                          process working directory.
  PUPPETEER_EXECUTABLE_PATH
                          Chrome/Edge binary for viz_render_html. Optional;
                          a system browser or Remotion's own download is
                          discovered automatically.

Current workspace root: ${getWorkspaceRoot()}

Tools:
  remotion_check_environment   Diagnose why Remotion commands fail
  remotion_ensure_browser      Pre-download the Chrome Headless Shell
  remotion_get_workspace_info  Report the configured workspace root
  remotion_init_project        Scaffold a minimal Remotion 4 project
  remotion_list_compositions   List compositions, doubles as a compile check
  remotion_render_still        Render one frame and attach the PNG
  remotion_render_video        Render a video or audio file
  remotion_start_studio        Start the Studio dev server in the background
  remotion_stop_studio         Stop a Studio started by this server
  viz_validate_svg             Lint SVG against real renderer constraints
  viz_render_svg               Rasterize SVG to PNG and attach it
  viz_render_html              Screenshot HTML to PNG and attach it
  viz_compare                  Pixel-diff two PNGs and report what changed
`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  // Fail fast: a bad workspace, allowlist or browser path stops the server here
  // with a specific message rather than surfacing later as a tool failure.
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());

  // stdout carries the JSON-RPC stream, so all logging goes to stderr.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} on stdio`);
  console.error(`Workspace root: ${getWorkspaceRoot()}`);
}

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});

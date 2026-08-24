#!/usr/bin/env node
/**
 * remotion-viz-mcp-server
 *
 * Tools for rendering Remotion compositions and for validating and
 * rasterizing SVG/HTML visualizations, with diagnostics that name the fix for
 * the failures these two workflows actually hit.
 *
 * Transports:
 *   stdio (default)  Claude Desktop, Claude Code, MCPB bundles
 *   http             Claude web and mobile custom connectors, via a tunnel
 *
 * stdio is the default because this server spawns child processes and writes
 * files. HTTP is opt-in and requires a bearer token.
 *
 * Set REMOTION_MCP_WORKSPACE to the directory that file paths resolve against.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpTransport } from "./transports/http.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { getWorkspaceRoot } from "./services/paths.js";
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
  MCP_TRANSPORT           "stdio" (default) or "http"
  MCP_HTTP_TOKEN          Bearer token. Required when transport is http.
  MCP_HTTP_PORT           HTTP port, default 3333
  MCP_HTTP_HOST           Bind address, default 127.0.0.1
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
`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

  if (transport === "http") {
    const token = process.env.MCP_HTTP_TOKEN;
    if (!token || token.length < 24) {
      console.error("ERROR: MCP_TRANSPORT=http requires MCP_HTTP_TOKEN with at least 24 characters.\n"
        + "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
      process.exit(1);
    }
    console.error(`${SERVER_NAME} v${SERVER_VERSION} on streamable HTTP`);
    console.error(`Workspace root: ${getWorkspaceRoot()}`);
    startHttpTransport({
      port: Number.parseInt(process.env.MCP_HTTP_PORT ?? "3333", 10),
      host: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
      token,
      createServer,
    });
    return;
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

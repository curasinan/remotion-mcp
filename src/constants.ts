/**
 * Shared constants for remotion-viz-mcp-server.
 */

export const SERVER_NAME = "remotion-viz-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum characters returned in any single tool response body. */
export const CHARACTER_LIMIT = 25_000;

/** Maximum bytes of SVG/HTML source accepted by the visualization tools. */
export const MAX_SOURCE_BYTES = 2_000_000;

/** Default timeouts, in milliseconds. */
export const TIMEOUT_FAST_MS = 30_000;
export const TIMEOUT_BUNDLE_MS = 300_000;
export const TIMEOUT_RENDER_MS = 1_800_000;

/** Upper bound on how much stdout/stderr we keep from a child process. */
export const MAX_CHILD_OUTPUT_BYTES = 400_000;

/** Raster output guardrails. */
export const MAX_RASTER_DIMENSION = 8_000;
export const DEFAULT_RASTER_WIDTH = 1_200;

/**
 * Root directory that every file path argument is resolved against and
 * confined to. Prevents directory traversal out of the user's workspace.
 */
export const WORKSPACE_ROOT: string =
  process.env.REMOTION_MCP_WORKSPACE ?? process.cwd();

/** How many frames a "quick check" still render defaults to. */
export const DEFAULT_STILL_FRAME = 0;

/**
 * Shared constants for remotion-viz-mcp-server.
 */

export const SERVER_NAME = "remotion-viz-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum characters returned in any single tool response body. */
export const CHARACTER_LIMIT = 25_000;

/** Maximum bytes of SVG/HTML source accepted by the visualization tools. */
export const MAX_SOURCE_BYTES = 2_000_000;

/**
 * How long viz_render_html may spend loading a page.
 *
 * This has to be passed to puppeteer as protocolTimeout, not only as the
 * setContent timeout. setContent runs the document write as a
 * Runtime.callFunctionOn before it builds the lifecycle watcher the `timeout`
 * option governs, so a script that blocks the renderer thread is bounded only
 * by protocolTimeout, which defaults to 180 s. A page containing
 * `while(true){}` therefore held the tool for 181 s while the docs promised 30.
 */
export const TIMEOUT_PAGE_LOAD_MS = 30_000;

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
 * Total pixel budget for one rasterization, across both axes.
 *
 * MAX_RASTER_DIMENSION alone bounds only the width the caller asked for. Height
 * is derived from the source's own aspect ratio, so a tall viewBox turns a legal
 * width into an arbitrarily large allocation. At 4 bytes per pixel this cap is
 * 256 MB, and it is the same area as a MAX_RASTER_DIMENSION square.
 */
export const MAX_RASTER_PIXELS = MAX_RASTER_DIMENSION * MAX_RASTER_DIMENSION;

/**
 * Root directory that every file path argument is resolved against and
 * confined to. Prevents directory traversal out of the user's workspace.
 */
export const WORKSPACE_ROOT: string =
  process.env.REMOTION_MCP_WORKSPACE ?? process.cwd();

/** How many frames a "quick check" still render defaults to. */
export const DEFAULT_STILL_FRAME = 0;

/** Shared constants for remotion-viz-mcp-server. */

export const SERVER_NAME = "remotion-viz-mcp-server";

/** Must equal manifest.json's `version`; tests and the bundle build enforce this. */
export const SERVER_VERSION = "1.2.1";

/** Maximum characters returned in any single tool response body. */
export const CHARACTER_LIMIT = 25_000;

/** Maximum bytes of SVG/HTML source accepted by the visualization tools. */
export const MAX_SOURCE_BYTES = 2_000_000;

/** How long viz_render_html may spend loading a page. */
export const TIMEOUT_PAGE_LOAD_MS = 45_000;

/** Puppeteer `protocolTimeout`: a backstop for hung CDP commands, not the page deadline. */
export const TIMEOUT_CDP_PROTOCOL_MS = 120_000;

/** Default timeouts, in milliseconds. */
export const TIMEOUT_FAST_MS = 30_000;
export const TIMEOUT_BUNDLE_MS = 300_000;
export const TIMEOUT_RENDER_MS = 1_800_000;

/** Upper bound on stdout/stderr kept from a child process. */
export const MAX_CHILD_OUTPUT_BYTES = 400_000;

/** Raster output guardrails. */
export const MAX_RASTER_DIMENSION = 8_000;
export const DEFAULT_RASTER_WIDTH = 1_200;

/** Total pixel budget for one rasterization, since height follows the source aspect ratio. */
export const MAX_RASTER_PIXELS = MAX_RASTER_DIMENSION * MAX_RASTER_DIMENSION;

/** Root directory every file path argument is resolved against and confined to. */
export const WORKSPACE_ROOT: string =
  process.env.REMOTION_MCP_WORKSPACE ?? process.cwd();

/** How many frames a "quick check" still render defaults to. */
export const DEFAULT_STILL_FRAME = 0;

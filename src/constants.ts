/**
 * Shared constants for remotion-viz-mcp-server.
 */

export const SERVER_NAME = "remotion-viz-mcp-server";

/**
 * Must equal manifest.json's `version`, which is the source of truth for what
 * ships. They disagreed once — the manifest said 1.1.0 while this said 1.0.0 — so
 * a bug report would have cited one version while the running code was the other.
 *
 * Two things now stop that recurring: the guard in test/unit.test.mjs, which fails
 * `npm test`, and the fail-fast in scripts/build-bundle.mjs, which refuses to
 * produce a bundle at all. Bump both together.
 */
export const SERVER_VERSION = "1.2.0";

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
export const TIMEOUT_PAGE_LOAD_MS = 45_000;

/**
 * Connection-wide cap on every CDP command, passed to puppeteer as
 * `protocolTimeout`. It is a backstop against a command that never returns at
 * all, NOT the deadline for page work - rasterizeHtml enforces that itself, so
 * it applies to setContent and screenshot together rather than to each command
 * separately.
 *
 * Keeping these separate is the fix for a real CI failure. This value used to
 * be TIMEOUT_PAGE_LOAD_MS, which meant the page-load deadline also capped
 * page.screenshot() - a command with no deadline of its own that legitimately
 * takes longer on a cold browser. On 2026-08-30 that failed three CI legs in a
 * row, always the first browser test of the run: windows-latest reported
 * "Page.captureScreenshot timed out", macos-latest reported "Navigation
 * timeout of 30000 ms exceeded". test/timeouts.test.mjs holds them apart.
 */
export const TIMEOUT_CDP_PROTOCOL_MS = 120_000;

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

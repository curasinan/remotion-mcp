/**
 * Rasterization.
 *
 * SVG goes through resvg: no browser, deterministic output, native prebuilt
 * binaries for every platform we ship.
 *
 * HTML goes through puppeteer-core driving a browser that already exists on
 * the machine (see services/browser.ts). Bundling Chrome would add ~150 MB to
 * a distributable extension for a capability most users get for free.
 */

import { Resvg } from "@resvg/resvg-js";
import {
  MAX_RASTER_DIMENSION,
  MAX_RASTER_PIXELS,
  TIMEOUT_CDP_PROTOCOL_MS,
} from "../constants.js";
import { locateBrowser } from "./browser.js";
import { findFilesystemReferences } from "./svg.js";
import { DENY_ALL, decideRequest, type NetworkPolicy } from "./network.js";
import { browserLimiter } from "./limit.js";
import { loadConfig } from "../config.js";
import { ToolInputError } from "../types.js";

export interface RasterResult {
  png: Buffer;
  width: number;
  height: number;
  /** Resources the network policy refused, deduplicated. Empty when none. */
  blockedRequests?: string[];
}

/**
 * Reject an output size before anything tries to allocate it.
 *
 * resvg is a native addon running in this process, and an allocation it cannot
 * satisfy aborts the whole server rather than throwing: the Rust allocator
 * fast-fails, so there is no JavaScript exception for safeHandler to catch and
 * every concurrent tool call dies with it. A 120-byte SVG declaring
 * viewBox="0 0 100 5000000" reaches 288 GB at the default width of 1200, which
 * is why this check runs on intrinsic dimensions before render() is called.
 */
function assertRasterBudget(
  intrinsicWidth: number,
  intrinsicHeight: number,
  targetWidth: number,
): void {
  if (
    !Number.isFinite(intrinsicWidth)
    || !Number.isFinite(intrinsicHeight)
    || intrinsicWidth <= 0
    || intrinsicHeight <= 0
  ) {
    throw new ToolInputError(
      `The SVG reports an unusable intrinsic size (${intrinsicWidth} x ${intrinsicHeight}).`,
      'Give the root <svg> a viewBox with positive width and height, for example viewBox="0 0 800 450".',
      "raster_budget",
    );
  }

  const outputHeight = Math.round((targetWidth * intrinsicHeight) / intrinsicWidth);
  const aspect = `${intrinsicWidth} x ${intrinsicHeight}`;

  if (outputHeight > MAX_RASTER_DIMENSION) {
    throw new ToolInputError(
      `Rendering this SVG at width ${targetWidth} would produce a ${targetWidth} x ${outputHeight} image, and the height limit is ${MAX_RASTER_DIMENSION}.`,
      `The source's own aspect ratio is ${aspect}, so height grows with width. Lower width to at most ${Math.max(1, Math.floor((MAX_RASTER_DIMENSION * intrinsicWidth) / intrinsicHeight))}, or correct the viewBox if that shape is not what you meant.`,
      "raster_budget",
    );
  }

  if (targetWidth * outputHeight > MAX_RASTER_PIXELS) {
    throw new ToolInputError(
      `Rendering this SVG at width ${targetWidth} would produce ${targetWidth * outputHeight} pixels, and the limit is ${MAX_RASTER_PIXELS}.`,
      `The source's own aspect ratio is ${aspect}. Lower width, or correct the viewBox if that shape is not what you meant.`,
      "raster_budget",
    );
  }
}

export function rasterizeSvg(source: string, targetWidth: number): RasterResult {
  if (targetWidth < 1 || targetWidth > MAX_RASTER_DIMENSION) {
    throw new ToolInputError(
      `width must be between 1 and ${MAX_RASTER_DIMENSION}, got ${targetWidth}.`,
      `Pick a width inside that range. ${MAX_RASTER_DIMENSION} is the cap that keeps memory use bounded.`,
    );
  }

  // Enforced here rather than only in validateSvg because this is the sink.
  // validateSvg is also exposed as its own advisory tool, and an advisory check
  // is not a security control: rasterizeSvg is where the file would be opened.
  const references = findFilesystemReferences(source);
  if (references.length > 0) {
    const shown = references.slice(0, 3).map((r) => `'${r.slice(0, 80)}'`).join(", ");
    throw new ToolInputError(
      `The SVG references ${references.length} resource(s) outside the document and will not be rendered: ${shown}.`,
      'Embed the asset as a data: URI instead. A local path would be read off disk and composited into the returned image, which is why it is refused; a remote URL is never fetched and would render as a blank gap. Fragment references such as href="#id" are unaffected.',
      "svg_reference",
    );
  }

  let resvg: Resvg;
  try {
    resvg = new Resvg(source, {
      fitTo: { mode: "width", value: targetWidth },
      font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" },
      logLevel: "off",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(
      `resvg could not parse the SVG: ${message}`,
      "Call viz_validate_svg on the same source first. It names the exact rule that was broken and how to fix it.",
    );
  }

  // Intrinsic size is readable before render() and covers sources that carry no
  // viewBox at all, where there is nothing for a source-level parse to measure.
  assertRasterBudget(resvg.width, resvg.height, targetWidth);

  let rendered: ReturnType<Resvg["render"]>;
  try {
    rendered = resvg.render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(
      `resvg failed while rendering the SVG: ${message}`,
      "Call viz_validate_svg on the same source. If it reports no errors, simplify the document: very large element counts and deeply nested filters are the usual causes.",
    );
  }

  return {
    png: Buffer.from(rendered.asPng()),
    width: rendered.width,
    height: rendered.height,
  };
}

interface InterceptedRequest {
  url(): string;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface PuppeteerPage {
  setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  setContent(html: string, options: Record<string, unknown>): Promise<void>;
  screenshot(options: Record<string, unknown>): Promise<Uint8Array>;
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: string, handler: (arg: never) => void): void;
}

interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
  /** The underlying OS process, so a wedged browser can be killed outright. */
  process(): { kill(signal?: string): boolean } | null;
}

interface PuppeteerLike {
  launch(options: Record<string, unknown>): Promise<PuppeteerBrowser>;
}

async function loadPuppeteer(): Promise<{ lib: PuppeteerLike; full: boolean }> {
  // Prefer the full package when present: it manages its own Chrome. It is
  // optional and usually absent, so this is a runtime probe through an indirect
  // specifier rather than a static import the compiler would try to resolve.
  const optionalPuppeteer = "puppeteer";
  try {
    const mod = (await import(optionalPuppeteer)) as unknown as { default?: PuppeteerLike };
    return { lib: mod.default ?? (mod as unknown as PuppeteerLike), full: true };
  } catch {
    // Fall through to puppeteer-core, which needs an executable path.
  }

  try {
    const mod = (await import("puppeteer-core")) as unknown as { default?: PuppeteerLike };
    return { lib: mod.default ?? (mod as unknown as PuppeteerLike), full: false };
  } catch {
    throw new ToolInputError(
      "Neither puppeteer nor puppeteer-core is installed, so HTML cannot be screenshotted.",
      "Run `npm install puppeteer-core` in the server directory and make sure Chrome or Edge is installed. SVG rasterization via viz_render_svg needs no browser and keeps working either way.",
    );
  }
}

export async function rasterizeHtml(
  html: string,
  width: number,
  height: number,
  fullPage: boolean,
  deviceScaleFactor: number,
  projectDir?: string,
  policy: NetworkPolicy = DENY_ALL,
): Promise<RasterResult> {
  return browserLimiter.run(() =>
    rasterizeHtmlUnlimited(html, width, height, fullPage, deviceScaleFactor, projectDir, policy),
  );
}

/**
 * How far the CDP backstop must sit above the page deadline.
 *
 * The backstop exists to catch a command that never returns at all. It must
 * never be the thing that fires first for work that is merely slow, or it
 * overrides the deadline and refuses legitimate renders - which is exactly the
 * CI failure that produced this split.
 */
const CDP_BACKSTOP_MARGIN_MS = 30_000;

/**
 * Puppeteer launch options, extracted so the timeout relationship is testable
 * without launching a browser. Exported for test/timeouts.test.mjs.
 */
export function buildLaunchOptions(input: {
  args: string[];
  pageLoadTimeoutMs: number;
}): Record<string, unknown> {
  return {
    headless: true,
    args: input.args,
    // Structurally above the page deadline, not merely above it by convention,
    // so raising REMOTION_MCP_PAGE_TIMEOUT_MS cannot invert the relationship.
    protocolTimeout: Math.max(
      TIMEOUT_CDP_PROTOCOL_MS,
      input.pageLoadTimeoutMs + CDP_BACKSTOP_MARGIN_MS,
    ),
  };
}

/**
 * Bound `work` by a wall clock the caller controls.
 *
 * setContent's own `timeout` option cannot do this job alone: it governs the
 * lifecycle watcher, which is built AFTER the document write, so a script that
 * blocks the renderer thread is never seen by it. And screenshot has no
 * deadline of its own at all. One deadline over both, enforced here, bounds
 * every way the page phase can fail to return - and the caller's `finally`
 * still tears the browser down, which is what actually frees the slot.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The loser of the race keeps running until teardown kills the browser. Its
  // rejection is expected and must not surface as an unhandled rejection.
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolInputError(
              `Rendering did not finish within ${ms} ms.`,
              "Simplify the page, or raise REMOTION_MCP_PAGE_TIMEOUT_MS if the machine is heavily loaded. A page whose script never yields will always hit this.",
            ),
          );
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function rasterizeHtmlUnlimited(
  html: string,
  width: number,
  height: number,
  fullPage: boolean,
  deviceScaleFactor: number,
  projectDir?: string,
  policy: NetworkPolicy = DENY_ALL,
): Promise<RasterResult> {
  const { lib, full } = await loadPuppeteer();

  const args = ["--disable-dev-shm-usage", "--font-render-hinting=none"];

  // The renderer sandbox is the boundary between attacker-supplied markup and
  // this machine, and it was switched off. Verified working when left on, so it
  // stays on. The escape hatch exists for environments that genuinely cannot
  // provide it - an unprivileged container without user namespaces - and it is
  // named so that turning it on reads like the weakening it is.
  if (loadConfig().disableBrowserSandbox) {
    args.push("--no-sandbox");
  }

  const pageLoadTimeoutMs = loadConfig().pageLoadTimeoutMs;
  const launchOptions = buildLaunchOptions({ args, pageLoadTimeoutMs });

  if (!full) {
    const location = await locateBrowser(projectDir);
    if (!location.executablePath) {
      throw new ToolInputError(
        `puppeteer-core needs a browser executable and none was found. ${location.detail}`,
        "Set PUPPETEER_EXECUTABLE_PATH to a Chrome, Chromium or Edge binary, or install Chrome. If you already use Remotion, call remotion_ensure_browser and this tool will reuse that download.",
      );
    }
    launchOptions.executablePath = location.executablePath;
  }

  const browser = await lib.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor });

    // The gate goes on before any content exists, so nothing can slip out
    // between page creation and setContent.
    const blocked = new Map<string, string>();
    await page.setRequestInterception(true);
    page.on("request", (request: InterceptedRequest) => {
      const url = request.url();
      const decision = decideRequest(url, policy);
      if (decision.allowed) {
        void request.continue();
        return;
      }
      if (!blocked.has(url)) blocked.set(url, decision.reason ?? "blocked");
      void request.abort();
    });

    const consoleErrors: string[] = [];
    page.on("pageerror", (error: unknown) => {
      consoleErrors.push(error instanceof Error ? error.message : String(error));
    });

    const lowered = html.trimStart().toLowerCase();
    const document = lowered.startsWith("<!doctype") || lowered.startsWith("<html")
      ? html
      : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;}</style></head><body>${html}</body></html>`;

    // One deadline over both commands, not one each: a caller cares that the
    // render returns, not which half of it was slow.
    const shot = await withDeadline(
      (async () => {
        await page.setContent(document, {
          waitUntil: "networkidle0",
          timeout: pageLoadTimeoutMs,
        });
        return page.screenshot({ type: "png", fullPage });
      })(),
      pageLoadTimeoutMs,
    );

    const blockedRequests = [...blocked.entries()].map(([url, reason]) => `${url} (${reason})`);

    if (consoleErrors.length > 0) {
      // A blocked fetch surfaces as "Failed to fetch", which reads like a bug in
      // the markup. Say which policy decision caused it instead.
      const cause = blockedRequests.length > 0
        ? ` ${blockedRequests.length} network request(s) were refused by policy, which is the usual cause: ${blockedRequests.slice(0, 3).join("; ")}`
        : "";
      throw new ToolInputError(
        `The page threw ${consoleErrors.length} script error(s): ${consoleErrors.slice(0, 3).join("; ")}.${cause}`,
        blockedRequests.length > 0
          ? "Rendering runs with no network access. Inline the data the script needs, or remove the request."
          : "Fix the script errors, or remove the script if the visual does not depend on it. A page that throws during load usually screenshots blank.",
      );
    }

    return { png: Buffer.from(shot), width, height, blockedRequests };
  } finally {
    // close() waits on a renderer that may be wedged, and a browser that
    // outlives this process leaves orphaned chrome processes behind: they
    // detach from the job object, so nothing reclaims them. Bound the graceful
    // path, then kill what is left.
    const child = browser.process();
    try {
      await Promise.race([
        browser.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
    } catch {
      // Already gone, or never came up. The kill below is the backstop.
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Process had already exited.
      }
    }
  }
}

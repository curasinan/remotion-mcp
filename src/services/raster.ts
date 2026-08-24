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
import { MAX_RASTER_DIMENSION } from "../constants.js";
import { locateBrowser } from "./browser.js";
import { ToolInputError } from "../types.js";

export interface RasterResult {
  png: Buffer;
  width: number;
  height: number;
}

export function rasterizeSvg(source: string, targetWidth: number): RasterResult {
  if (targetWidth < 1 || targetWidth > MAX_RASTER_DIMENSION) {
    throw new ToolInputError(
      `width must be between 1 and ${MAX_RASTER_DIMENSION}, got ${targetWidth}.`,
      `Pick a width inside that range. ${MAX_RASTER_DIMENSION} is the cap that keeps memory use bounded.`,
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

  const rendered = resvg.render();
  return {
    png: Buffer.from(rendered.asPng()),
    width: rendered.width,
    height: rendered.height,
  };
}

interface PuppeteerLike {
  launch(options: Record<string, unknown>): Promise<{
    newPage(): Promise<{
      setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
      setContent(html: string, options: Record<string, unknown>): Promise<void>;
      screenshot(options: Record<string, unknown>): Promise<Uint8Array>;
      on(event: string, handler: (arg: unknown) => void): void;
    }>;
    close(): Promise<void>;
  }>;
}

async function loadPuppeteer(): Promise<{ lib: PuppeteerLike; full: boolean }> {
  // Prefer the full package when present: it manages its own Chrome.
  try {
    const mod = (await import("puppeteer")) as unknown as { default?: PuppeteerLike };
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
): Promise<RasterResult> {
  const { lib, full } = await loadPuppeteer();

  const launchOptions: Record<string, unknown> = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  };

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

    const consoleErrors: string[] = [];
    page.on("pageerror", (error: unknown) => {
      consoleErrors.push(error instanceof Error ? error.message : String(error));
    });

    const lowered = html.trimStart().toLowerCase();
    const document = lowered.startsWith("<!doctype") || lowered.startsWith("<html")
      ? html
      : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;}</style></head><body>${html}</body></html>`;

    await page.setContent(document, { waitUntil: "networkidle0", timeout: 30_000 });
    const shot = await page.screenshot({ type: "png", fullPage });

    if (consoleErrors.length > 0) {
      throw new ToolInputError(
        `The page threw ${consoleErrors.length} script error(s): ${consoleErrors.slice(0, 3).join("; ")}`,
        "Fix the script errors, or remove the script if the visual does not depend on it. A page that throws during load usually screenshots blank.",
      );
    }

    return { png: Buffer.from(shot), width, height };
  } finally {
    await browser.close();
  }
}

/**
 * Chrome discovery.
 *
 * Bundling a browser would add ~150 MB to a distributable extension, so
 * instead we find one that already exists. Resolution order, most explicit
 * first:
 *
 *   1. PUPPETEER_EXECUTABLE_PATH or CHROME_PATH, set by the user
 *   2. A full `puppeteer` install, which manages its own Chrome
 *   3. Chrome, Chromium, Brave or Edge installed system-wide
 *   4. The Chrome Headless Shell that Remotion already downloaded
 *
 * Step 4 matters: if Remotion works on this machine, a browser is present, so
 * HTML screenshots should work too without a second download.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BrowserLocation {
  executablePath: string | null;
  source: "env" | "puppeteer-bundled" | "system" | "remotion-cache" | "none";
  detail: string;
}

function firstExisting(candidates: (string | undefined | null)[]): string | null {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function systemChromeCandidates(): string[] {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  switch (process.platform) {
    case "win32":
      return [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ];
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ];
    default:
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/usr/bin/brave-browser",
        "/snap/bin/chromium",
      ];
  }
}

/** Recursive scan bounded by depth, used for the Remotion browser cache. */
function findUnder(root: string, matcher: (name: string) => boolean, depth: number): string | null {
  if (depth < 0 || !fs.existsSync(root)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && matcher(entry.name)) return full;
    if (entry.isDirectory()) {
      const nested = findUnder(full, matcher, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

function remotionCachedBrowser(projectDir?: string): string | null {
  const binaryNames = process.platform === "win32"
    ? ["chrome-headless-shell.exe", "chrome.exe"]
    : ["chrome-headless-shell", "chrome", "headless_shell"];

  const roots = [
    projectDir ? path.join(projectDir, "node_modules", ".remotion") : null,
    path.join(os.homedir(), ".cache", "remotion"),
    path.join(os.homedir(), "Library", "Caches", "remotion"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "remotion") : null,
  ].filter((r): r is string => r !== null);

  for (const root of roots) {
    const hit = findUnder(root, (name) => binaryNames.includes(name), 5);
    if (hit) return hit;
  }
  return null;
}

/** Whether a full `puppeteer` install (which manages its own Chrome) is present. */
export async function hasBundledPuppeteer(): Promise<boolean> {
  try {
    await import("puppeteer");
    return true;
  } catch {
    return false;
  }
}

export async function locateBrowser(projectDir?: string): Promise<BrowserLocation> {
  const fromEnv = firstExisting([
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ]);
  if (fromEnv) {
    return {
      executablePath: fromEnv,
      source: "env",
      detail: `Set explicitly via ${process.env.PUPPETEER_EXECUTABLE_PATH ? "PUPPETEER_EXECUTABLE_PATH" : "CHROME_PATH"}.`,
    };
  }

  if (await hasBundledPuppeteer()) {
    return {
      executablePath: null,
      source: "puppeteer-bundled",
      detail: "The full puppeteer package is installed and will use the Chrome it manages.",
    };
  }

  const system = firstExisting(systemChromeCandidates());
  if (system) {
    return {
      executablePath: system,
      source: "system",
      detail: `Found a system browser at ${system}.`,
    };
  }

  const cached = remotionCachedBrowser(projectDir);
  if (cached) {
    return {
      executablePath: cached,
      source: "remotion-cache",
      detail: `Reusing the browser Remotion already downloaded: ${cached}`,
    };
  }

  return {
    executablePath: null,
    source: "none",
    detail: "No browser found. Install Chrome or Edge, or set PUPPETEER_EXECUTABLE_PATH to a Chromium binary, or run remotion_ensure_browser to download one.",
  };
}

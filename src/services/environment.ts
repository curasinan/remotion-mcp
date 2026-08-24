/**
 * Environment detection.
 *
 * Most "Remotion just errors" reports trace back to one of four causes:
 * a Node version below 18, no local Remotion install, a missing Chrome
 * Headless Shell, or an entry point that does not exist where the CLI looks.
 * This module checks all four and attaches a concrete remedy to each failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, resolveRemotionCli } from "./exec.js";
import { locateBrowser } from "./browser.js";
import { getWorkspaceRoot } from "./paths.js";
import type { EnvironmentReport, ToolCheck } from "../types.js";

/** Entry point locations the Remotion CLI and community templates use. */
const ENTRY_POINT_CANDIDATES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/index.jsx",
  "remotion/index.ts",
  "remotion/index.tsx",
  "index.ts",
  "index.tsx",
];

export function findEntryPoint(projectDir: string): string | null {
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (fs.existsSync(path.join(projectDir, candidate))) return candidate;
  }
  return null;
}

export function readPackageJson(projectDir: string): Record<string, unknown> | null {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getRemotionDependencyVersion(projectDir: string): string | null {
  const pkg = readPackageJson(projectDir);
  if (!pkg) return null;
  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  return deps["remotion"] ?? null;
}

export function isRemotionProject(projectDir: string): boolean {
  return getRemotionDependencyVersion(projectDir) !== null;
}

/** Heuristic scan of the locations Remotion caches its Chrome Headless Shell. */
function findCachedBrowser(projectDir: string): string | null {
  const roots = [
    path.join(projectDir, "node_modules", ".remotion"),
    path.join(os.homedir(), ".cache", "remotion"),
    path.join(os.homedir(), "Library", "Caches", "remotion"),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "remotion")
      : null,
  ].filter((r): r is string => r !== null);

  for (const root of roots) {
    const hit = shallowFind(root, "chrome-headless-shell", 3);
    if (hit) return hit;
  }
  return null;
}

function shallowFind(root: string, needle: string, depth: number): string | null {
  if (depth < 0 || !fs.existsSync(root)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.name.includes(needle)) return full;
    if (entry.isDirectory()) {
      const nested = shallowFind(full, needle, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

async function checkNode(): Promise<ToolCheck> {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const ok = major >= 18;
  return {
    name: "Node.js",
    found: ok,
    version: process.versions.node,
    detail: ok ? "Meets the Remotion 4 minimum." : "Below the Remotion 4 minimum.",
    ...(ok ? {} : { fix: "Install Node.js 18 or newer, then restart the MCP server." }),
  };
}

async function checkRemotionCli(projectDir: string): Promise<ToolCheck> {
  const cli = resolveRemotionCli(projectDir);
  const result = await runCommand(cli.file, [...cli.prefixArgs, "versions"], {
    cwd: projectDir,
    timeoutMs: 90_000,
  });

  if (result.exitCode === 0) {
    const version = /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
    return {
      name: "Remotion CLI",
      found: true,
      ...(version ? { version } : {}),
      detail:
        cli.source === "local"
          ? "Using the project's local install (node_modules/.bin/remotion)."
          : "No local install found; falling back to npx, which is slower and may resolve a different version than your project.",
      ...(cli.source === "npx"
        ? { fix: "Run `npm install` inside the project so the local Remotion CLI is used." }
        : {}),
    };
  }

  return {
    name: "Remotion CLI",
    found: false,
    detail: (result.stderr || result.stdout).slice(0, 400) || "Command produced no output.",
    fix: "Run `npm install` in the project directory. If there is no project yet, call remotion_init_project first.",
  };
}

async function checkBrowser(projectDir: string): Promise<ToolCheck> {
  const cached = findCachedBrowser(projectDir);
  if (cached) {
    return {
      name: "Chrome Headless Shell",
      found: true,
      detail: `Cached at ${cached}`,
    };
  }
  return {
    name: "Chrome Headless Shell",
    found: false,
    detail:
      "No cached browser found in the usual locations. Remotion downloads this on first render, which is the most common cause of a render that fails or appears to hang.",
    fix: "Call remotion_ensure_browser to download it now, so the first real render is not the thing that discovers it is missing.",
  };
}

async function checkScreenshotBrowser(projectDir: string): Promise<ToolCheck> {
  const location = await locateBrowser(projectDir);
  const found = location.source !== "none";
  return {
    name: "HTML screenshot browser",
    found,
    detail: location.detail,
    ...(found
      ? {}
      : {
          fix: "Install Chrome or Edge, or set PUPPETEER_EXECUTABLE_PATH to a Chromium binary. Only viz_render_html needs this; every other tool works without it.",
        }),
  };
}

async function checkFfmpeg(): Promise<ToolCheck> {
  const result = await runCommand("ffmpeg", ["-version"], { timeoutMs: 15_000 });
  const found = result.exitCode === 0;
  const version = found ? /ffmpeg version (\S+)/.exec(result.stdout)?.[1] : undefined;
  return {
    name: "System FFmpeg (optional)",
    found,
    ...(version ? { version } : {}),
    detail: found
      ? "Present. Useful for post-processing, though Remotion 4 bundles its own FFmpeg for rendering."
      : "Not on PATH. This is fine: Remotion 4 ships its own FFmpeg and does not need a system install.",
  };
}

export async function buildEnvironmentReport(
  projectDir: string | null,
): Promise<EnvironmentReport> {
  const dir = projectDir ?? getWorkspaceRoot();
  const checks: ToolCheck[] = [];

  checks.push(await checkNode());

  const isProject = isRemotionProject(dir);
  const entry = isProject ? findEntryPoint(dir) : null;

  checks.push({
    name: "Remotion project",
    found: isProject,
    ...(getRemotionDependencyVersion(dir)
      ? { version: getRemotionDependencyVersion(dir) as string }
      : {}),
    detail: isProject
      ? `package.json in ${dir} declares a remotion dependency.`
      : `No remotion dependency found in ${dir}/package.json.`,
    ...(isProject
      ? {}
      : { fix: "Call remotion_init_project to scaffold one, or pass project_dir pointing at your existing project." }),
  });

  checks.push({
    name: "Entry point",
    found: entry !== null,
    ...(entry ? { detail: `Found ${entry}` } : {}),
    ...(entry
      ? {}
      : {
          detail: `None of ${ENTRY_POINT_CANDIDATES.join(", ")} exist in ${dir}.`,
          fix: "Create src/index.ts that calls registerRoot(RemotionRoot), or pass entry_point explicitly to the render tools.",
        }),
  });

  if (isProject) {
    checks.push(await checkRemotionCli(dir));
    checks.push(await checkBrowser(dir));
  }

  checks.push(await checkScreenshotBrowser(dir));
  checks.push(await checkFfmpeg());

  const NON_BLOCKING = ["optional", "HTML screenshot browser"];
  const blocking = checks
    .filter((c) => !c.found && c.fix && !NON_BLOCKING.some((n) => c.name.includes(n)))
    .map((c) => `${c.name}: ${c.fix}`);

  return {
    workspace_root: getWorkspaceRoot(),
    project_dir: dir,
    is_remotion_project: isProject,
    remotion_entry_point: entry,
    checks,
    blocking_problems: blocking,
    ready_to_render: blocking.length === 0,
  };
}

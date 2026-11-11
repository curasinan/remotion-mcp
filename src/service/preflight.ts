/**
 * The checks the service passes before it listens (design 5.6, global constraints). Each failure throws
 * `preflight: <check>: <what was missing>`, naming the check and never echoing the pack's own text, an OS message or a
 * key. The CLI is resolved from the pack's own node_modules, never through npx.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { ServiceConfig } from "./config.js";
import { MIN_REMOTION_RENDERER } from "./constants.js";
import { childEnv } from "./render-process.js";
import { loadPack, PackError, type LoadedPack } from "./templates.js";

export interface PreflightDeps {
  /** The absolute path of `cmd` on `pathVar`, or null. An in-process PATH scan that never spawns. */
  which(cmd: string, pathVar: string): string | null;
  /** Whether `file --version` exits 0, run without a shell and with a render's allowlisted environment. */
  runVersion(file: string): Promise<boolean>;
}

/** How long the browser's `--version` may take before it counts as not running. */
const VERSION_TIMEOUT_MS = 30_000;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** A regular file, following symlinks. Never throws. */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function which(cmd: string, pathVar: string): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    // An empty or relative entry would resolve against the cwd.
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, cmd);
    if (!isFile(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Present but not executable: keep looking, as a shell does.
    }
  }
  return null;
}

function runVersion(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, ["--version"], {
      env: childEnv(process.env, os.tmpdir()), shell: false, timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL",
    }, (err) => resolve(err === null));
  });
}

export const defaultPreflightDeps: PreflightDeps = Object.freeze({ which, runVersion });

const fail = (check: string, missing: string): Error => new Error(`preflight: ${check}: ${missing}`);

/** A JSON file's top-level object, or undefined when it is missing, unreadable or not an object. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `x.y.z` compared to `min` part by part, as numbers: a string comparison would put 4.0.99 above 4.0.458. Anything
 * but a plain release version, a pre-release included, is refused.
 */
function atLeast(version: unknown, min: string): boolean {
  const have = typeof version === "string" ? RELEASE_VERSION.exec(version) : null;
  const want = RELEASE_VERSION.exec(min);
  if (have === null || want === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(have[i]);
    const b = Number(want[i]);
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The package.json of the `@remotion/renderer` the CLI loads, or undefined when none resolves. It is resolved from the
 * CLI's own package.json, as the CLI's require resolves it, so a copy nested under the CLI comes before the hoisted one.
 */
function rendererPackageJson(packDir: string): string | undefined {
  try {
    // createRequire needs an absolute path. config.ts already refuses a relative PACK_DIR; resolve() also normalises it.
    return createRequire(path.resolve(packDir, "node_modules", "@remotion", "cli", "package.json"))
      .resolve("@remotion/renderer/package.json");
  } catch {
    return undefined;
  }
}

/** The `@remotion/renderer` the CLI loads is at least MIN_REMOTION_RENDERER and has the setpriv wrapper. */
function checkRenderer(packDir: string): void {
  const pkgPath = rendererPackageJson(packDir);
  const pkg = pkgPath === undefined ? undefined : readJsonObject(pkgPath);
  if (pkgPath === undefined || pkg === undefined || typeof pkg.version !== "string") {
    throw fail("@remotion/renderer", "no installed package with a version under PACK_DIR/node_modules");
  }
  if (!atLeast(pkg.version, MIN_REMOTION_RENDERER)) {
    throw fail("@remotion/renderer", `the installed version is below ${MIN_REMOTION_RENDERER}, or is not x.y.z`);
  }
  // A file check, not require(): the package's exports do not expose this path, and loading it would run the
  // renderer's code in the service.
  if (!isFile(path.join(path.dirname(pkgPath), "dist", "linux", "wrap-with-setpriv.js"))) {
    throw fail("@remotion/renderer", "dist/linux/wrap-with-setpriv.js is missing");
  }
}

/**
 * The CLI as `node <the bin script>`, from `<packDir>/node_modules/@remotion/cli/package.json`'s `bin.remotion` (or
 * `bin` when it is a string). Never resolveRemotionCli, which falls back to npx.
 */
function resolveCli(packDir: string): { file: string; prefixArgs: string[] } {
  const dir = path.join(packDir, "node_modules", "@remotion", "cli");
  const pkg = readJsonObject(path.join(dir, "package.json"));
  const bin = pkg?.bin;
  const script = typeof bin === "string" ? bin
    : typeof bin === "object" && bin !== null ? (bin as Record<string, unknown>).remotion : undefined;
  const scriptPath = typeof script === "string" && script !== "" ? path.resolve(dir, script) : undefined;
  if (scriptPath === undefined || !isFile(scriptPath)) {
    throw fail("@remotion/cli", "no installed package with a remotion bin script under PACK_DIR/node_modules; "
      + "no npx fallback is used");
  }
  return { file: process.execPath, prefixArgs: [scriptPath] };
}

function checkPack(packDir: string): LoadedPack {
  try {
    return loadPack(packDir);
  } catch (err) {
    // The PackError's own message is the pack's text, so it is never shown, and one fixed message covers every check
    // loadPack runs, so it never blames one that passed.
    if (err instanceof PackError) {
      throw fail("PACK_DIR", "the template pack failed its checks (manifest, bundle or JSON Schema gate)");
    }
    throw err;
  }
}

/** AUDIT_LOG_PATH can be opened for appending, so the audit sink's swallowed write errors cannot hide a bad path. */
function checkAudit(auditLogPath: string): void {
  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.closeSync(fs.openSync(auditLogPath, "a", 0o600));
  } catch {
    throw new Error("preflight: AUDIT_LOG_PATH is not writable");
  }
}

/** Runs every startup check in turn and throws at the first that fails. */
export async function preflight(cfg: ServiceConfig, deps: PreflightDeps = defaultPreflightDeps):
  Promise<{ pack: LoadedPack; cli: { file: string; prefixArgs: string[] } }> {
  // The PATH the renders get: tools.ts builds their environment from process.env.
  if (deps.which("setpriv", process.env.PATH ?? "") === null) throw fail("setpriv", "not found on PATH");
  checkRenderer(cfg.packDir);
  if (!(await deps.runVersion(cfg.browserExecutable))) {
    throw fail("browser", "BROWSER_EXECUTABLE did not run --version successfully");
  }
  const cli = resolveCli(cfg.packDir);
  const pack = checkPack(cfg.packDir);
  checkAudit(cfg.auditLogPath);
  return { pack, cli };
}

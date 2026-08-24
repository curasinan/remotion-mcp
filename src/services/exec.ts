/**
 * Child process execution.
 *
 * Commands are always spawned with an explicit argv array and `shell: false`,
 * so user-supplied strings (composition IDs, props JSON, file names) can never
 * be interpreted as shell metacharacters.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { MAX_CHILD_OUTPUT_BYTES, TIMEOUT_FAST_MS } from "../constants.js";
import { ToolInputError } from "../types.js";
import type { CommandResult } from "../types.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runCommand(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const { cwd, timeoutMs = TIMEOUT_FAST_MS, env } = options;
  const startedAt = Date.now();

  return new Promise<CommandResult>((resolve) => {
    // Narrowed to match the stdio configuration below, so stdout/stderr are
    // known non-null.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(file, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, CI: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // spawn can fail synchronously rather than emitting 'error'. EINVAL on a
      // Windows .cmd shim is the case that matters, and letting it reject the
      // promise turned a precise platform fault into a generic tool failure.
      const err = error as NodeJS.ErrnoException;
      resolve({
        command: [file, ...args].join(" "),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr:
          err.code === "EINVAL"
            ? `Could not start '${file}': Node refuses to spawn a .cmd shim without a shell (EINVAL). This is a bug in how the command was resolved, not a problem with your project.`
            : `Could not start '${file}': ${err.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_CHILD_OUTPUT_BYTES) return current;
      return current + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({
        command: [file, ...args].join(" "),
        exitCode,
        signal,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        command: [file, ...args].join(" "),
        exitCode: null,
        signal: null,
        stdout: "",
        stderr:
          error.code === "ENOENT"
            ? `Executable '${file}' was not found on PATH.`
            : error.message,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    child.on("close", finish);
  });
}

/** Spawn a long-lived process detached from this server and return its PID. */
export function spawnDetached(
  file: string,
  args: string[],
  cwd: string,
  logFile: string,
): number | undefined {
  const out = fs.openSync(logFile, "a");
  try {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    return child.pid;
  } finally {
    // The child has inherited the descriptor; this process no longer needs it.
    fs.closeSync(out);
  }
}

export interface ResolvedCli {
  /** An executable spawn() can start with shell:false on every platform. */
  file: string;
  prefixArgs: string[];
  source: "local" | "npx";
}

/**
 * Read a package's declared bin script, resolved to a real .js path.
 *
 * `bin` is either a string or a name-to-path map, so both shapes are handled.
 * Returns null rather than throwing: an unreadable or absent package simply
 * means this candidate is not the one, and the caller moves on.
 */
function readPackageBin(packageDir: string, binName: string): string | null {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) return null;

  let manifest: { bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    return null;
  }

  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin : bin?.[binName];
  if (!relative) return null;

  const resolved = path.join(packageDir, relative);
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * npm ships its own CLIs as plain scripts next to the node binary. Using those
 * directly avoids the .cmd shims for the same reason resolveRemotionCli does.
 */
function nodeBundledCli(name: "npm-cli.js" | "npx-cli.js"): string | null {
  const candidate = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    name,
  );
  return fs.existsSync(candidate) ? candidate : null;
}

/** npm itself, spawned without going through npm.cmd. */
export function resolveNpmCli(): { file: string; prefixArgs: string[] } {
  const cli = nodeBundledCli("npm-cli.js");
  if (cli) return { file: process.execPath, prefixArgs: [cli] };
  return { file: process.platform === "win32" ? "npm.cmd" : "npm", prefixArgs: [] };
}

/**
 * Locate the Remotion CLI for a project, as something spawnable without a shell.
 *
 * Prefers the project's own install so its Remotion version is the one that
 * runs, and only falls back to npx.
 *
 * Both paths deliberately end at `node <script>.js` rather than at a bin shim.
 * Since Node 20.12, spawning a .cmd file with shell:false throws EINVAL, and it
 * throws SYNCHRONOUSLY - not as an 'error' event - so on Windows every Remotion
 * tool failed before the child existed. The obvious repair, shell:true, would
 * hand every argument to cmd.exe and turn the argument-injection surface that
 * assertSafePositional guards into shell command injection. Resolving to the
 * underlying .js keeps shell:false and fixes the platform difference at its
 * source.
 */
export function resolveRemotionCli(projectDir: string): ResolvedCli {
  const modules = path.join(projectDir, "node_modules");

  for (const pkg of [path.join(modules, "@remotion", "cli"), path.join(modules, "remotion")]) {
    const script = readPackageBin(pkg, "remotion");
    if (script) {
      return { file: process.execPath, prefixArgs: [script], source: "local" };
    }
  }

  // A local install whose manifest could not be read still works on platforms
  // where the bin is a shebang script rather than a .cmd shim.
  if (process.platform !== "win32") {
    const shim = path.join(modules, ".bin", "remotion");
    if (fs.existsSync(shim)) {
      return { file: shim, prefixArgs: [], source: "local" };
    }
  }

  const npx = nodeBundledCli("npx-cli.js");
  if (npx) {
    return { file: process.execPath, prefixArgs: [npx, "--yes", "remotion"], source: "npx" };
  }
  return {
    file: process.platform === "win32" ? "npx.cmd" : "npx",
    prefixArgs: ["--yes", "remotion"],
    source: "npx",
  };
}

/**
 * Map raw Remotion CLI failure output to the one next step that actually
 * unblocks it. Shared by every tool that shells out, so the same symptom never
 * produces two different pieces of advice.
 */
export function diagnoseCliFailure(
  output: string,
  cliSource: "local" | "npx",
  timedOut: boolean,
): string {
  const lower = output.toLowerCase();

  if (timedOut) {
    return "The command exceeded its time limit. Render a short frames range first to confirm the composition works, then scale up.";
  }
  if (
    cliSource === "npx"
    && (lower.includes("could not determine executable")
      || lower.includes("command not found")
      || lower.includes("not found on path"))
  ) {
    return "The Remotion CLI is not installed here. Run `npm install` inside the project directory, then retry. The server only falls back to npx when node_modules is missing.";
  }
  if (lower.includes("browser") || lower.includes("chrome") || lower.includes("headless")) {
    return "This is a browser problem, not a code problem. Call remotion_ensure_browser, then retry.";
  }
  if (lower.includes("no compositions") || lower.includes("could not find a composition")) {
    return "Call remotion_list_compositions to get the exact registered composition ids.";
  }
  if (lower.includes("out of memory") || lower.includes("javascript heap")) {
    return "Retry with concurrency=2 and scale=0.5. Full-resolution parallel renders are the usual cause.";
  }
  if (lower.includes("enoent") || lower.includes("cannot find module")) {
    return "A file or module the entry point imports is missing. Check the import paths, then run `npm install` if it is a package.";
  }
  return "The output above is Remotion's own error. Fix it in the source, then run this tool again.";
}

/** Strip ANSI escape sequences so CLI output is readable in a transcript. */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/** Keep only the last `maxChars` of noisy build output, where errors live. */
export function tailOutput(input: string, maxChars = 6_000): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `... (${trimmed.length - maxChars} earlier characters omitted)\n${trimmed.slice(-maxChars)}`;
}

/**
 * Last check before a string becomes a positional argv element.
 *
 * shell:false stops a value from being reparsed by a shell, but it does not
 * stop the program itself from reading it as an option. The Remotion CLI parses
 * with minimist, so any token beginning with "-" is an option no matter how it
 * got there. The tokens reaching the CLI are derived rather than raw - an entry
 * point returned verbatim, an output path put through path.relative() - so the
 * derived form is what has to be asserted.
 */
export function assertSafePositional(token: string, label: string): void {
  if (token.startsWith("-")) {
    throw new ToolInputError(
      `The ${label} resolves to '${token}', which the Remotion CLI would read as a command-line option rather than a path.`,
      "Choose a value whose first character is not '-'.",
    );
  }
}

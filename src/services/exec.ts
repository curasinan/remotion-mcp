/** Child process execution with explicit argv arrays and `shell: false`. */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { MAX_CHILD_OUTPUT_BYTES, TIMEOUT_FAST_MS } from "../constants.js";
import { cliLimiter } from "./limit.js";
import { ToolInputError } from "../types.js";
import type { CommandResult } from "../types.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Kills a process tree: the process group on POSIX, taskkill /T on Windows. */
export function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through to the single-process kill below.
    }
  } else {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No process group, or already gone.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

export async function runCommand(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  return cliLimiter.run(() => runCommandUnlimited(file, args, options));
}

async function runCommandUnlimited(
  file: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const { cwd, timeoutMs = TIMEOUT_FAST_MS, env } = options;
  const startedAt = Date.now();

  return new Promise<CommandResult>((resolve) => {
    // Typed to match the stdio config below, so stdout/stderr are non-null.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(file, args, {
        cwd,
        shell: false,
        windowsHide: true,
        // Process-group leader on POSIX so the whole group can be signalled.
        detached: process.platform !== "win32",
        env: { ...process.env, CI: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // spawn can throw synchronously, e.g. EINVAL for a Windows .cmd shim.
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

    let escalation: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid === undefined) return;
      // SIGTERM first so a render can close its output, then SIGKILL.
      killTree(pid, "SIGTERM");
      escalation = setTimeout(() => killTree(pid, "SIGKILL"), 5_000);
      escalation.unref();
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
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
      if (escalation) clearTimeout(escalation);
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

/** Resolves a package's declared bin script to a path, or null if unavailable. */
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

/** Path to an npm CLI script bundled with Node, avoiding .cmd shims. */
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

/** Locates the Remotion CLI as `node <script>.js`, preferring the local install over npx. */
export function resolveRemotionCli(projectDir: string): ResolvedCli {
  const modules = path.join(projectDir, "node_modules");

  for (const pkg of [path.join(modules, "@remotion", "cli"), path.join(modules, "remotion")]) {
    const script = readPackageBin(pkg, "remotion");
    if (script) {
      return { file: process.execPath, prefixArgs: [script], source: "local" };
    }
  }

  // Off Windows, the .bin shim is a runnable shebang script.
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

/** Maps Remotion CLI failure output to a single next step. */
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
export function tailOutput(input: string, maxChars = 2_500): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `... (${trimmed.length - maxChars} earlier characters omitted)\n${trimmed.slice(-maxChars)}`;
}

/** Fences untrusted output, replacing backticks with U+02CB so it cannot close the fence. */
export function fenceUntrusted(raw: string, maxChars = 2_500): string {
  const neutralised = tailOutput(raw, maxChars).replace(/`/g, "ˋ");
  return "```text\n" + neutralised + "\n```";
}

/** Rejects a positional argv token that starts with "-", which the CLI would parse as an option. */
export function assertSafePositional(token: string, label: string): void {
  if (token.startsWith("-")) {
    throw new ToolInputError(
      `The ${label} resolves to '${token}', which the Remotion CLI would read as a command-line option rather than a path.`,
      "Choose a value whose first character is not '-'.",
      "argv_injection",
    );
  }
}

/**
 * Child process execution.
 *
 * Commands are always spawned with an explicit argv array and `shell: false`,
 * so user-supplied strings (composition IDs, props JSON, file names) can never
 * be interpreted as shell metacharacters.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_CHILD_OUTPUT_BYTES, TIMEOUT_FAST_MS } from "../constants.js";
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
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, CI: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

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
  const child = spawn(file, args, {
    cwd,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

/**
 * Locate the Remotion CLI for a project. Prefers the locally installed binary
 * so the project's own Remotion version is used, and only falls back to npx.
 */
export function resolveRemotionCli(projectDir: string): {
  file: string;
  prefixArgs: string[];
  source: "local" | "npx";
} {
  const binName = process.platform === "win32" ? "remotion.cmd" : "remotion";
  const local = path.join(projectDir, "node_modules", ".bin", binName);
  if (fs.existsSync(local)) {
    return { file: local, prefixArgs: [], source: "local" };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { file: npx, prefixArgs: ["--yes", "remotion"], source: "npx" };
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

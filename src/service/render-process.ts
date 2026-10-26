/**
 * The service's own spawner for the Remotion CLI (design 5.6, ADR-7). It never goes through runCommand or
 * cliLimiter. The CLI leads its own process group and Chrome leads another, so while the CLI is alive the
 * spawner records every descendant and its group from /proc. Stopping a render signals every recorded
 * group, then verifies that every recorded process is gone.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killTree } from "../services/exec.js";

export interface CleanupReport {
  verified: boolean;
  /** The recorded pids still alive at the verification deadline. */
  survivors: number[];
}

export interface RenderProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** At this deadline the result settles with `timedOut`, and the kill continues in `cleanup`. */
  deadlineMs: number;
  /** Time between SIGTERM and SIGKILL after a deadline or an abort. */
  graceMs: number;
  /** How long after the SIGKILL `cleanup` waits for every recorded process to be gone. */
  verifyDeadlineMs: number;
  signal?: AbortSignal;
  /** Signals a process group, or the pid when it leads none. Defaults to killTree; tests inject. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface RenderProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** The last 2 500 characters of stdout and stderr, in arrival order. For the service's logs, never a caller. */
  outputTail: string;
  /** Settles once every recorded process is gone, or the verification deadline has passed. Never rejects. */
  cleanup: Promise<CleanupReport>;
}

type Outcome = Omit<RenderProcessResult, "outputTail" | "cleanup">;

const OUTPUT_TAIL_CHARS = 2_500;
/** How often the tree is recorded while the CLI is alive, besides on every chunk of output. */
const SNAPSHOT_INTERVAL_MS = 250;
const VERIFY_POLL_MS = 50;
/** The variables a render's processes get, besides REMOTION_* and TMPDIR. Keys are never among them. */
const CHILD_ENV_NAMES = new Set(["PATH", "HOME", "LANG", "NODE_ENV"]);
const DIGITS = /^\d+$/;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses a `/proc/<pid>/stat` line: `pid (comm) state ppid pgrp ...`. The command name may hold spaces and
 * ")", so the fields are read after the last ")". Returns null for anything else.
 */
export function parseProcStat(line: string): { pid: number; ppid: number; pgid: number } | null {
  const open = line.indexOf(" (");
  const close = line.lastIndexOf(")");
  if (open < 1 || close < open) return null;
  const pid = line.slice(0, open);
  const [, ppid = "", pgid = ""] = line.slice(close + 1).trim().split(/\s+/);
  if (!DIGITS.test(pid) || !DIGITS.test(ppid) || !DIGITS.test(pgid)) return null;
  return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) };
}

function readStat(file: string): { pid: number; ppid: number; pgid: number } | null {
  try {
    return parseProcStat(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // exited since the listing, or unreadable
  }
}

/**
 * Every descendant of `rootPid`, found by walking parent pids in `/proc`, and their process groups. Off Linux,
 * without a `procDir`, it finds nothing. It never returns a pid or pgid <= 1, nor anything in `selfPgid`
 * (the service's own group, read from `<procDir>/self/stat` by default), and never walks through either:
 * pid 1 is the ancestor of everything, and the service's group holds the service.
 */
export function descendantsOf(
  rootPid: number,
  opts: { procDir?: string; selfPgid?: number } = {},
): { pids: number[]; pgids: number[] } {
  const procDir = opts.procDir ?? (process.platform === "linux" ? "/proc" : undefined);
  if (procDir === undefined || rootPid <= 1) return { pids: [], pgids: [] };
  let names: string[];
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return { pids: [], pgids: [] };
  }
  const selfPgid = opts.selfPgid ?? readStat(path.join(procDir, "self", "stat"))?.pgid;

  const childrenOf = new Map<number, { pid: number; pgid: number }[]>();
  for (const name of names) {
    if (!DIGITS.test(name)) continue;
    const stat = readStat(path.join(procDir, name, "stat"));
    if (stat === null) continue;
    const siblings = childrenOf.get(stat.ppid);
    if (siblings) siblings.push(stat);
    else childrenOf.set(stat.ppid, [stat]);
  }

  const pids: number[] = [];
  const pgids = new Set<number>();
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of childrenOf.get(parent) ?? []) {
      if (child.pid <= 1 || child.pgid === selfPgid || seen.has(child.pid)) continue;
      seen.add(child.pid);
      pids.push(child.pid);
      if (child.pgid > 1) pgids.add(child.pgid);
      queue.push(child.pid);
    }
  }
  return { pids, pgids: [...pgids] };
}

/** A render's environment: PATH, HOME, LANG, NODE_ENV and REMOTION_* from `source`, and TMPDIR = `workDir`. */
export function childEnv(source: NodeJS.ProcessEnv, workDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (CHILD_ENV_NAMES.has(name) || name.startsWith("REMOTION_"))) env[name] = value;
  }
  env.TMPDIR = workDir;
  return env;
}

/** Whether a process exists. Only ESRCH means gone: EPERM means it exists and belongs to someone else. */
function exists(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Spawns `file` detached, so it leads its own process group, and settles on its exit or at the deadline,
 * whichever comes first. An abort settles it at once, as `aborted`. Then `cleanup` stops every process the
 * render started and settles once they are verified gone.
 *
 * It rejects only when no process was started: a bad duration, a spawn that throws, or a spawn error such as
 * ENOENT. A signal that is already aborted starts nothing and resolves as `aborted`.
 */
export async function runRenderProcess(
  file: string,
  args: string[],
  o: RenderProcessOptions,
): Promise<RenderProcessResult> {
  for (const [name, value] of [["deadlineMs", o.deadlineMs], ["graceMs", o.graceMs],
    ["verifyDeadlineMs", o.verifyDeadlineMs]] as const) {
    // NaN would make the verification poll forever, and its slot would never free.
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`runRenderProcess: ${name} must be a finite number >= 0, got ${String(value)}`);
    }
  }
  if (o.signal?.aborted) {
    return {
      exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "",
      cleanup: Promise.resolve({ verified: true, survivors: [] }),
    };
  }
  const kill = o.kill ?? killTree;

  const child = spawn(file, args, {
    cwd: o.cwd, env: o.env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  const cliPid = child.pid;
  if (cliPid === undefined) {
    // No process exists. The 'error' event follows on the next tick, and nothing needs cleaning up.
    return new Promise<never>((_, reject) => child.once("error", reject));
  }

  // The CLI leads its own group, so its pid is also its group's id.
  const pids = new Set<number>([cliPid]);
  const pgids = new Set<number>([cliPid]);
  let alive = true;
  let tail = "";

  // Once the CLI has exited its orphans are reparented and the walk finds nothing, so the union recorded
  // while it was alive is what cleanup signals.
  const record = (): void => {
    if (!alive) return;
    const found = descendantsOf(cliPid);
    for (const pid of found.pids) pids.add(pid);
    for (const pgid of found.pgids) pgids.add(pgid);
  };
  const onOutput = (chunk: string): void => {
    tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
    record();
  };
  // Drained continuously, so a render that writes megabytes never wedges on a full pipe.
  child.stdout.setEncoding("utf8").on("data", onOutput);
  child.stderr.setEncoding("utf8").on("data", onOutput);
  const ticker = setInterval(record, SNAPSHOT_INTERVAL_MS);

  const send = (id: number, signal: NodeJS.Signals): void => {
    try {
      kill(id, signal);
    } catch {
      // The verification below is the arbiter.
    }
  };

  const verify = async (): Promise<CleanupReport> => {
    const until = Date.now() + o.verifyDeadlineMs;
    for (;;) {
      const survivors = [...pids].filter(exists);
      if (survivors.length === 0) return { verified: true, survivors: [] };
      if (Date.now() >= until) return { verified: false, survivors };
      await delay(VERIFY_POLL_MS);
    }
  };

  /** After a deadline or abort: SIGTERM, then SIGKILL after the grace. After a normal exit: SIGKILL at once. */
  const terminate = async (graceful: boolean): Promise<CleanupReport> => {
    if (graceful) {
      record();
      for (const pgid of pgids) send(pgid, "SIGTERM");
      await delay(o.graceMs);
    }
    record(); // the CLI may still be alive after the grace, as the real one hangs after SIGTERM
    for (const pgid of pgids) send(pgid, "SIGKILL");
    // A recorded process may have left its group since it was recorded.
    for (const pid of pids) if (exists(pid)) send(pid, "SIGKILL");
    return verify();
  };

  let finish!: (report: CleanupReport) => void;
  const cleanup = new Promise<CleanupReport>((resolve) => { finish = resolve; });
  let stopping = false;
  const stop = (graceful: boolean): void => {
    if (stopping) return;
    stopping = true;
    void terminate(graceful)
      .catch((): CleanupReport => ({ verified: false, survivors: [...pids] }))
      .then((report) => {
        clearInterval(ticker);
        finish(report);
      });
  };

  return new Promise<RenderProcessResult>((resolve) => {
    let exitedWith: Outcome | undefined;
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ ...outcome, outputTail: tail, cleanup });
    };
    // A stop that lands after the CLI's exit, while its output is still draining, settles with that exit.
    const halt = (outcome: Outcome): void => {
      if (exitedWith) return settle(exitedWith);
      settle(outcome);
      stop(true);
    };

    const deadline = setTimeout(
      () => halt({ exitCode: null, signal: null, timedOut: true, aborted: false }),
      o.deadlineMs,
    );
    const onAbort = (): void => halt({ exitCode: null, signal: null, timedOut: false, aborted: true });
    o.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("exit", (exitCode, signal) => {
      alive = false;
      clearInterval(ticker);
      exitedWith = { exitCode, signal, timedOut: false, aborted: false };
      stop(false);
    });
    // 'close' follows 'exit' once stdout and stderr have ended, so the tail holds the CLI's last words.
    child.on("close", () => {
      if (exitedWith) settle(exitedWith);
    });
    // After a successful spawn nothing this module does can raise one; listening keeps it from throwing.
    child.on("error", () => {});
  });
}

/**
 * The service's own spawner for the Remotion CLI (design 5.6, ADR-7). It never goes through runCommand or
 * cliLimiter. The CLI leads its own process group and Chrome leads another, so while the CLI is alive the
 * spawner records every descendant and its group from /proc. Stopping a render signals every recorded
 * group, then verifies that every recorded process is gone and that the CLI's stdout and stderr have closed,
 * since an open pipe means a process nobody recorded still holds it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killTree } from "../services/exec.js";

export interface CleanupReport {
  verified: boolean;
  /** The recorded pids still alive at the verification deadline. */
  survivors: number[];
  /**
   * Why cleanup is unverified: survivors, pipes held open by a process nobody recorded, or an unexpected error's
   * message. Absent when verified. For the service's own log, never a caller.
   */
  cause?: string;
}

export interface RenderProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** At this deadline the result settles with `timedOut`, and the kill continues in `cleanup`. 0..2147483647. */
  deadlineMs: number;
  /** Time between SIGTERM and SIGKILL after a deadline or an abort. 0..2147483647. */
  graceMs: number;
  /**
   * How long after the SIGKILL `cleanup` waits for every recorded process to be gone and for the CLI's stdout and
   * stderr to close. 0..2147483647.
   */
  verifyDeadlineMs: number;
  signal?: AbortSignal;
  /** Signals a process group, or the pid when it leads none. Defaults to killTree; tests inject. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Called after each snapshot of the CLI's descendants. A test seam, like `kill`. */
  onSnapshot?: (s: { pids: number[]; pgids: number[] }) => void;
  /** Where the snapshots read the process table. Defaults to /proc; tests point it at a doctored copy. */
  procDir?: string;
}

export interface RenderProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /**
   * The last 2 500 characters of stdout and stderr, in arrival order, as they stood when the result settled. For
   * the service's logs, never a caller.
   */
  outputTail: string;
  /**
   * Settles once every recorded process is gone and the CLI's pipes have closed, or the verification deadline has
   * passed. Never rejects.
   */
  cleanup: Promise<CleanupReport>;
}

type Outcome = Omit<RenderProcessResult, "outputTail" | "cleanup">;

const OUTPUT_TAIL_CHARS = 2_500;
/** How often the tree is recorded while the CLI is alive, besides on every chunk of output. */
const SNAPSHOT_INTERVAL_MS = 250;
const VERIFY_POLL_MS = 50;
/** The longest delay setTimeout honours. Node fires a longer one after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const PIPES_HELD_OPEN = "pipes held open";
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

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spawns `file` detached, so it leads its own process group, and settles on its exit or at the deadline,
 * whichever comes first. An abort settles it at once, as `aborted`. Then `cleanup` stops every process the
 * render started and settles once they are verified gone and the CLI's stdout and stderr have closed.
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
    // NaN or Number.MAX_VALUE would make the verification poll forever, and its slot would never free. Past
    // MAX_TIMER_MS a timer fires after 1 ms.
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
      throw new RangeError(`runRenderProcess: ${name} must be a finite number in 0..${MAX_TIMER_MS}, got ${String(value)}`);
    }
  }
  if (o.signal?.aborted) {
    return {
      exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "",
      cleanup: Promise.resolve({ verified: true, survivors: [] }),
    };
  }
  const kill = o.kill ?? killTree;
  // The service's own group, from the real /proc whatever `procDir` says, since the kill path signals real ids.
  const selfPgid = process.platform === "linux" ? readStat("/proc/self/stat")?.pgid : undefined;

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
  // A process the snapshots never saw, such as a daemonised grandchild, can hold the CLI's pipes after its exit.
  let openPipes = 2;
  child.stdout.once("close", () => { openPipes -= 1; });
  child.stderr.once("close", () => { openPipes -= 1; });

  // Once the CLI has exited its orphans are reparented and the walk finds nothing, so the union recorded
  // while it was alive is what cleanup signals.
  const record = (): void => {
    if (!alive) return;
    const found = descendantsOf(cliPid, { procDir: o.procDir });
    for (const pid of found.pids) pids.add(pid);
    for (const pgid of found.pgids) pgids.add(pgid);
    o.onSnapshot?.(found);
  };
  // A snapshot that fails while the CLI runs is retried on the next chunk or tick. One that fails while stopping
  // is an unexpected error, which the stop reports.
  const recordWhileRunning = (): void => {
    try {
      record();
    } catch {
      // The next snapshot, or the stop's own, records the tree.
    }
  };
  const onOutput = (chunk: string): void => {
    tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
    recordWhileRunning();
  };
  // Drained continuously, so a render that writes megabytes never wedges on a full pipe.
  child.stdout.setEncoding("utf8").on("data", onOutput);
  child.stderr.setEncoding("utf8").on("data", onOutput);
  const ticker = setInterval(recordWhileRunning, SNAPSHOT_INTERVAL_MS);

  let killError: string | undefined;
  const send = (id: number, signal: NodeJS.Signals): void => {
    // Whatever a snapshot recorded, never an id <= 1 (killTree(0) signals the service's own group, killTree(1)
    // signals -1, every process the service may signal), the service's own group, or the service itself.
    if (!Number.isInteger(id) || id <= 1 || id === selfPgid || id === process.pid) return;
    try {
      kill(id, signal);
    } catch (err) {
      // The verification below is the arbiter; the first failure goes into its cause.
      killError ??= `kill(${id}, ${signal}) threw: ${messageOf(err)}`;
    }
  };

  const verify = async (): Promise<CleanupReport> => {
    // The monotonic clock, so a wall-clock step cannot stretch or cut the deadline.
    const until = performance.now() + o.verifyDeadlineMs;
    for (;;) {
      const survivors = [...pids].filter(exists);
      if (survivors.length === 0 && openPipes === 0) return { verified: true, survivors: [] };
      if (performance.now() >= until) {
        const causes: string[] = [];
        if (survivors.length > 0) causes.push(`recorded processes still alive: ${survivors.join(", ")}`);
        // With nothing recorded alive, an open pipe means a process nobody recorded holds it.
        if (openPipes > 0) causes.push(PIPES_HELD_OPEN);
        if (killError !== undefined) causes.push(killError);
        return { verified: false, survivors, cause: causes.join("; ") };
      }
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
      .catch((err: unknown): CleanupReport => ({ verified: false, survivors: [...pids], cause: messageOf(err) }))
      .then((report) => {
        clearInterval(ticker);
        // Decided: let go of the pipes, so one an escaped process holds open does not stay open here.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(report);
      });
  };

  return new Promise<RenderProcessResult>((resolve) => {
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ ...outcome, outputTail: tail, cleanup });
    };
    // A deadline or abort after the CLI's exit finds the result settled, and its stop already under way.
    const halt = (outcome: Outcome): void => {
      if (settled) return;
      settle(outcome);
      stop(true);
    };

    const deadline = setTimeout(
      () => halt({ exitCode: null, signal: null, timedOut: true, aborted: false }),
      o.deadlineMs,
    );
    const onAbort = (): void => halt({ exitCode: null, signal: null, timedOut: false, aborted: true });
    o.signal?.addEventListener("abort", onAbort, { once: true });

    // Settles on the exit, not on 'close': a process that escaped every snapshot may hold the pipes open for
    // as long as it lives. The tail is what has arrived by then. Cleanup waits for the pipes.
    child.on("exit", (exitCode, signal) => {
      alive = false;
      clearInterval(ticker);
      settle({ exitCode, signal, timedOut: false, aborted: false });
      stop(false);
    });
    // After a successful spawn nothing this module does can raise one; listening keeps it from throwing.
    child.on("error", () => {});
  });
}

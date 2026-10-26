// The render-process spawner and render slots (design 5.6, ADR-7, review focus 3).
// The spawning cases need /proc and process groups, so they run on Linux only. CI sets
// REQUIRE_LINUX_PROCESS_TESTS=1 on ubuntu, where the gate below fails if they could not run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.join(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist-service");
const SERVICE = path.join(DIST, "service");
if (!fs.existsSync(path.join(SERVICE, "render-process.js"))) {
  throw new Error("dist-service/service/render-process.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const { runRenderProcess, parseProcStat, descendantsOf, childEnv } =
  await import(pathToFileURL(path.join(SERVICE, "render-process.js")).href);
const { RenderSlots } = await import(pathToFileURL(path.join(SERVICE, "slots.js")).href);
const { killTree } = await import(pathToFileURL(path.join(DIST, "services", "exec.js")).href);

/** Every test that spawns has this timeout, so a hang fails with the test's name instead of stalling CI. */
const SPAWN_TIMEOUT_MS = 30_000;
const SPAWNS = { timeout: SPAWN_TIMEOUT_MS };
const LINUX_ONLY = { ...SPAWNS, skip: process.platform !== "linux" && "needs /proc and process groups" };
const FAKE_CLI = path.join(REPO, "test", "fixtures", "proc-tree", "fake-cli.mjs");

/** Every wait polls its condition to this deadline. None sleeps a guessed duration. */
const WAIT_MS = 10_000;
const POLL_MS = 25;

/**
 * Polls `probe` until it returns something other than undefined, and fails with `message` at the deadline.
 * The deadline is on the monotonic clock, so a test that moves Date.now cannot stretch it.
 */
async function pollFor(probe, message) {
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) return assert.fail(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Resolves after two turns of the event loop, so at least one whole poll phase runs after the call. Data that
 * was already in a pipe when it is called has then been read, and its 'data' events emitted. It waits for an
 * event-loop phase, not for a duration.
 */
async function ioTurns() {
  for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A probe for pollFor: undefined while `promise` is pending, then its value. A rejection is thrown from the probe,
 * so the poll fails with it.
 */
function track(promise) {
  let settled = false;
  let value;
  let error;
  promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e ?? new Error("rejected"); });
  return () => {
    if (error !== undefined) throw error;
    return settled ? value : undefined;
  };
}

/** The service's own process group, read after the last ")" of /proc/self/stat. */
const ownPgid = () => parseProcStat(fs.readFileSync("/proc/self/stat", "utf8")).pgid;

/** Whether a process exists or, for a negative id, whether that process group still has a member. */
function exists(id) {
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

/** Polls until none of `ids` exists. */
const allGone = (ids) => pollFor(
  () => (ids.some(exists) ? undefined : true),
  () => `still alive ${WAIT_MS / 1000}s later: ${ids.filter(exists).join(", ")}`,
);

/** Whether `promise` has settled, once the microtasks already queued have run. */
async function settledYet(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** A process's argv as /proc shows it, or "" once it is gone. */
function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "";
  }
}

/**
 * A temp dir for one spawning test. On teardown it SIGKILLs every pid and group the handshake file names, and
 * every id the test adds to `ids`, ignoring ESRCH, so a failing test leaves nothing running.
 */
function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-tree-"));
  const handshake = path.join(dir, "pids.json");
  const ids = new Set();
  t.after(() => {
    const p = readJson(handshake) ?? {};
    // p.daemon is the grandchild that escaped by daemonising: it leads a group of its own.
    for (const id of [...ids, p.cli, p.browser, p.grandchild, p.browserPgid && -p.browserPgid,
      p.intermediate, p.daemon, p.daemon && -p.daemon]) {
      // Never 0, 1 or -1: they mean this test's own group, init, or every process it may signal.
      if (!Number.isInteger(id) || Math.abs(id) <= 1) continue;
      try {
        process.kill(id, "SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    ids,
    exitFile: path.join(dir, "exit"),
    /** fake-cli's argv, with the handshake file and `flags`. */
    argv: (...flags) => [FAKE_CLI, `--write-file=${handshake}`, ...flags],
    /** The handshake, once it has been written. */
    pids: (who) => pollFor(() => readJson(handshake), `${who} never wrote its pids`),
    /** Resolves once fake-cli has printed "ready", the line that makes runRenderProcess snapshot the tree. */
    ready: () => pollFor(() => (fs.existsSync(`${handshake}.ready`) ? true : undefined), "fake-cli never printed ready"),
    /** fake-cli's marker files beside the handshake: <handshake>.<name>. */
    marker: (name) => `${handshake}.${name}`,
  };
}

/** runRenderProcess options for a test. The deadline is never reached unless a test lowers it. */
const options = (s, extra = {}) => ({
  cwd: s.dir, env: childEnv(process.env, s.dir), deadlineMs: 50_000, graceMs: 200, verifyDeadlineMs: WAIT_MS, ...extra,
});

test("linux process tests ran where required", () => {
  if (process.env.REQUIRE_LINUX_PROCESS_TESTS !== "1") return;
  assert.equal(process.platform, "linux",
    `REQUIRE_LINUX_PROCESS_TESTS=1, but this is ${process.platform}, so the Linux-only cases skipped`);
  assert.doesNotThrow(() => fs.readFileSync("/proc/self/stat", "utf8"),
    "REQUIRE_LINUX_PROCESS_TESTS=1, but /proc/self/stat is unreadable, so the /proc walk would find nothing");
});

test('parseProcStat reads fields after the last ")"', () => {
  assert.deepEqual(parseProcStat("123 (a b) S 1 123 ..."), { pid: 123, ppid: 1, pgid: 123 });
  assert.deepEqual(parseProcStat("124 (x) (y)) S 7 9 ..."), { pid: 124, ppid: 7, pgid: 9 });
  // A command name may itself hold ") S <ppid> <pgid>", which a parse at the first ")" would believe.
  assert.deepEqual(parseProcStat("125 (a) S 1 1) S 7 9 0 -1\n"), { pid: 125, ppid: 7, pgid: 9 });
  for (const garbage of ["", "garbage", "126 (x)", "127 (x) S", "128 (x) S 1", "129 (x) S a 9", "x (y) S 1 2",
    "(x) S 1 2"]) {
    assert.equal(parseProcStat(garbage), null, JSON.stringify(garbage));
  }
});

test("descendantsOf never returns pid or pgid <= 1 or its own group", (t) => {
  const procDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
  t.after(() => fs.rmSync(procDir, { recursive: true, force: true }));
  const SELF_PGID = 777;
  const stat = (pid, ppid, pgid, comm = "p") => {
    fs.mkdirSync(path.join(procDir, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(procDir, String(pid), "stat"), `${pid} (${comm}) S ${ppid} ${pgid} 0 0 -1\n`);
  };
  fs.mkdirSync(path.join(procDir, "self"));
  fs.writeFileSync(path.join(procDir, "self", "stat"), `50 (node) S 40 ${SELF_PGID} 0 0 -1\n`);
  stat(100, 50, 100, "cli");          // the root
  stat(101, 100, 101, "browser");     // leads its own group
  stat(102, 101, 101, "helper");      // in the browser's group
  stat(103, 101, 103, "a) S 1 1");    // a name that forges fields; found by its real ppid 101
  stat(107, 100, 0);                  // its pid is kept, its pgid 0 is not
  stat(108, 100, 1);                  // its pid is kept, its pgid 1 is not: kill(-1) signals every process
  stat(0, 100, 0);                    // pid 0 is never returned
  stat(1, 100, 1, "init");            // pid 1 is never returned, nor walked through
  stat(104, 1, 104);                  //   so this is not found
  stat(105, 100, SELF_PGID, "self");  // the service's own group is never returned, nor walked through
  stat(106, 105, 106);                //   so this is not found
  stat(200, 50, 200);                 // not a descendant
  fs.mkdirSync(path.join(procDir, "300"));
  fs.writeFileSync(path.join(procDir, "300", "stat"), "garbage");
  fs.mkdirSync(path.join(procDir, "301"));  // exited between the listing and the read: no stat file

  const sorted = (r) => ({ pids: [...r.pids].sort((a, b) => a - b), pgids: [...r.pgids].sort((a, b) => a - b) });
  const expected = { pids: [101, 102, 103, 107, 108], pgids: [101, 103] };
  // The service's group, read from <procDir>/self/stat, as production reads /proc/self/stat.
  assert.deepEqual(sorted(descendantsOf(100, { procDir })), expected);
  assert.deepEqual(sorted(descendantsOf(100, { procDir, selfPgid: SELF_PGID })), expected);
  // An explicit selfPgid overrides <procDir>/self/stat: with 999 named as its own, 105's subtree is found.
  assert.deepEqual(sorted(descendantsOf(100, { procDir, selfPgid: 999 })),
    { pids: [101, 102, 103, 105, 106, 107, 108], pgids: [101, 103, 106, 777] });
  for (const root of [0, 1]) {
    assert.deepEqual(descendantsOf(root, { procDir }), { pids: [], pgids: [] }, `root ${root} is everything`);
  }
  assert.deepEqual(descendantsOf(100, { procDir: path.join(procDir, "missing") }), { pids: [], pgids: [] });
  if (process.platform !== "linux") {
    assert.deepEqual(descendantsOf(process.pid), { pids: [], pgids: [] }, "no /proc, so nothing is found");
  }
});

test("runRenderProcess starts nothing for an aborted signal or a bad duration, and rejects when the CLI cannot start", SPAWNS, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Spawning this rejects with ENOENT, so a result that resolves proves nothing was spawned.
  const missing = path.join(dir, "no-such-cli");
  const base = { cwd: dir, env: childEnv(process.env, dir), deadlineMs: 1_000, graceMs: 0, verifyDeadlineMs: 0 };

  const aborted = await runRenderProcess(missing, [], { ...base, signal: AbortSignal.abort() });
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.timedOut, false);
  assert.deepEqual(await aborted.cleanup, { verified: true, survivors: [] });

  // Past 2147483647 ms, setTimeout fires after 1 ms instead, and a verification deadline of Number.MAX_VALUE
  // would poll forever.
  for (const key of ["deadlineMs", "graceMs", "verifyDeadlineMs"]) {
    const bads = [Number.NaN, -1, Infinity, 2_147_483_648, ...(key === "verifyDeadlineMs" ? [Number.MAX_VALUE] : [])];
    for (const bad of bads) {
      await assert.rejects(runRenderProcess(missing, [], { ...base, [key]: bad }), RangeError, `${key} = ${bad}`);
    }
    // The largest delay a timer takes is accepted: it gets as far as the spawn.
    await assert.rejects(runRenderProcess(missing, [], { ...base, [key]: 2_147_483_647 }), { code: "ENOENT" },
      `${key} = 2147483647`);
  }

  // No process exists, so there is no cleanup to wait for: the caller frees its slot at once.
  await assert.rejects(runRenderProcess(missing, [], base), { code: "ENOENT" });
});

test("a normal exit kills the detached browser the CLI left behind", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const run = runRenderProcess(process.execPath, s.argv(`--exit-on-file=${s.exitFile}`), options(s));
  const pids = await s.pids("fake-browser");
  await s.ready();
  assert.notEqual(pids.browserPgid, pids.cli, "the browser leads a group of its own");

  fs.writeFileSync(s.exitFile, "");
  const result = await run;
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.match(result.outputTail, /ready/);
  assert.deepEqual(await result.cleanup, { verified: true, survivors: [] });
  await allGone([pids.browser, pids.grandchild, -pids.browserPgid, pids.cli]);
});

test("the deadline returns timedOut before cleanup finishes", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const calls = [];
  const kill = (id, signal) => {
    s.ids.add(id);
    calls.push({ id, signal, cmdline: cmdline(id) });
    killTree(id, signal);
  };
  // fake-cli's start-up time does not matter. If the deadline beats its SIGTERM handler, SIGTERM kills it;
  // otherwise SIGKILL does after the grace. Either way the result settles at the deadline, before the kill ends.
  const result = await runRenderProcess(process.execPath, s.argv("--no-browser", "--ignore-sigterm"),
    options(s, { deadlineMs: 500, kill }));
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(await settledYet(result.cleanup), false, "the result waited for the kill, not the deadline");

  assert.deepEqual(await result.cleanup, { verified: true, survivors: [] });
  const ids = [...new Set(calls.map((c) => c.id))];
  assert.equal(ids.length, 1, `with no browser only the CLI's own group is signalled, got ${ids.join(", ")}`);
  assert.match(calls[0].cmdline, /fake-cli\.mjs/, "the signalled pid is the CLI");
  assert.equal(exists(ids[0]), false, "the CLI pid is gone");
});

test("a CLI that ignores SIGTERM is SIGKILLed after the grace", LINUX_ONLY, async (t) => {
  const s = scene(t);
  // Long enough that a SIGKILL sent with no grace, a few ms after the SIGTERM, cannot pass for one sent after it.
  const GRACE_MS = 300;
  // Node fires a timer by whole-millisecond reads of a clock that may be coarse, so it can fire up to about 2 ms
  // short of GRACE_MS as performance.now() measures it.
  const CLOCK_SLACK_MS = 5;
  const calls = [];
  const kill = (id, signal) => {
    calls.push({ id, signal, alive: exists(id), at: performance.now() });
    killTree(id, signal);
  };
  const controller = new AbortController();
  const run = runRenderProcess(process.execPath, s.argv("--no-browser", "--ignore-sigterm"),
    options(s, { signal: controller.signal, kill, graceMs: GRACE_MS }));
  const { cli } = await s.pids("fake-cli");
  await s.ready(); // its SIGTERM handler is installed before it prints ready

  controller.abort();
  const result = await run;
  assert.equal(result.aborted, true);
  const report = await result.cleanup;
  const term = calls.findIndex((c) => c.id === cli && c.signal === "SIGTERM");
  const sigkill = calls.findIndex((c) => c.id === cli && c.signal === "SIGKILL");
  assert.ok(term >= 0, "SIGTERM was sent to the CLI's group");
  assert.ok(sigkill > term, "SIGKILL followed the SIGTERM");
  const waited = calls[sigkill].at - calls[term].at;
  assert.ok(waited >= GRACE_MS - CLOCK_SLACK_MS,
    `the SIGKILL landed ${waited.toFixed(1)} ms after the SIGTERM, short of the ${GRACE_MS} ms grace`);
  assert.equal(calls[sigkill].alive, true, "the CLI outlived its SIGTERM, so the SIGKILL is what stopped it");
  assert.deepEqual(report, { verified: true, survivors: [] });
  assert.equal(exists(cli), false);
});

test("REVIEW FOCUS 3: aborting the signal after the handshake kills every descendant group, including the one the CLI created", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const slots = new RenderSlots(1);
  const release = slots.tryAcquire();
  const controller = new AbortController();
  const calls = [];
  const kill = (id, signal) => {
    calls.push({ id, signal });
    killTree(id, signal);
  };
  // --ignore-sigterm, as the real CLI hangs after SIGTERM.
  const run = runRenderProcess(process.execPath, s.argv("--ignore-sigterm"),
    options(s, { signal: controller.signal, kill }));
  const pids = await s.pids("fake-browser");
  await s.ready();
  assert.notEqual(pids.browserPgid, pids.cli, "the browser leads a group of its own");

  controller.abort(); // the client disconnected
  const result = await run;
  assert.equal(result.aborted, true);
  assert.equal(slots.inUse, 1, "the slot is held while the kill runs");
  // The slot above is this test's own bookkeeping. This is what makes holding it correct: the kill is still running.
  assert.equal(await settledYet(result.cleanup), false, "cleanup had already settled when the result did");
  void result.cleanup.finally(release);
  await slots.drained();
  // The slot freed only once cleanup verified, so every process is already gone: no polling here.
  for (const [name, id] of [["cli", pids.cli], ["browser", pids.browser], ["grandchild", pids.grandchild],
    ["browser group", -pids.browserPgid]]) {
    assert.equal(exists(id), false, `${name} ${id} outlived the slot`);
  }
  assert.deepEqual(await result.cleanup, { verified: true, survivors: [] });
  for (const group of [pids.cli, pids.browserPgid]) {
    assert.ok(calls.some((c) => c.id === group && c.signal === "SIGTERM"), `group ${group} got the graceful SIGTERM`);
  }
  release();
  assert.equal(slots.inUse, 0, "a second release frees nothing");
});

test("cleanup reports unverified with the survivor when a kill is skipped", LINUX_ONLY, async (t) => {
  const s = scene(t);
  // The browser's group, known once the handshake is in. The browser leads it, so its pid is skipped too.
  let skipped;
  const calls = [];
  const kill = (id, signal) => {
    calls.push({ id, signal });
    if (id !== skipped) killTree(id, signal);
  };
  const run = runRenderProcess(process.execPath, s.argv(`--exit-on-file=${s.exitFile}`),
    options(s, { kill, verifyDeadlineMs: 500 }));
  const pids = await s.pids("fake-browser");
  skipped = pids.browserPgid;
  await s.ready();

  fs.writeFileSync(s.exitFile, "");
  const result = await run;
  assert.equal(result.exitCode, 0);
  const report = await result.cleanup;
  assert.equal(report.verified, false);
  assert.ok(report.survivors.includes(pids.browser), `survivors [${report.survivors}] name the browser ${pids.browser}`);
  assert.ok(report.survivors.every((id) => id === pids.browser || id === pids.grandchild),
    `survivors [${report.survivors}] are only the skipped group's`);
  assert.equal(exists(pids.browser), true, "the browser really survived");
  // The grandchild shares the skipped group, but a recorded pid still alive is SIGKILLed by its own pid.
  assert.ok(calls.some((c) => c.id === pids.grandchild && c.signal === "SIGKILL"), "the grandchild was SIGKILLed by pid");
  await allGone([pids.grandchild]);
  assert.match(report.cause ?? "", /still alive/, "the report says why it is unverified");
});

test("a CLI whose child daemonises settles at its exit, and cleanup reports the pipes the escaped grandchild holds", LINUX_ONLY, async (t) => {
  const s = scene(t);
  // The grandchild is reparented away from the CLI before any snapshot sees it. An empty procDir makes that
  // certain, instead of a race between the daemonising and the 250 ms snapshot ticker.
  const procDir = path.join(s.dir, "proc");
  fs.mkdirSync(procDir);
  const DEADLINE_MS = 20_000;
  const run = runRenderProcess(process.execPath, s.argv("--daemonize", `--exit-on-file=${s.exitFile}`),
    options(s, { procDir, deadlineMs: DEADLINE_MS, verifyDeadlineMs: 500 }));
  // Checked the moment the result settles: cleanup cannot have settled yet, since it waits up to 500 ms for the
  // pipes. A result that waited for 'close' would settle only after cleanup has let go of them.
  let cleanupSettledFirst;
  const settled = track(run.then(async (result) => {
    cleanupSettledFirst = await settledYet(result.cleanup);
    return result;
  }));
  const p = await s.pids("the daemonised grandchild");
  // The scene's teardown also kills it; this names the pid the grandchild wrote, in case the test fails first.
  t.after(() => {
    for (const id of [p.daemon, -p.daemon]) {
      try {
        process.kill(id, "SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
    }
  });
  await s.ready();
  await allGone([p.intermediate]); // so the grandchild is no descendant of the CLI

  fs.writeFileSync(s.exitFile, "");
  // WAIT_MS is half the deadline, so a result that waited for the pipes to close settles too late to pass.
  const result = await pollFor(settled,
    `the result did not settle within ${WAIT_MS / 1000}s of the CLI's exit: it waited for the pipes the grandchild holds`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(cleanupSettledFirst, false, "the result settled at the exit, before cleanup decided");
  const report = await result.cleanup;
  assert.equal(report.verified, false, "an unrecorded process holds the CLI's pipes");
  assert.equal(report.cause, "pipes held open");
  assert.deepEqual(report.survivors, [], "the only recorded process, the CLI, is gone");
  // Once cleanup has decided, the service lets go of the pipes: the grandchild's writes fail, and it exits.
  await allGone([p.daemon]);
});

test("the kill path never signals a pid or group <= 1, nor the service's own group, whatever a snapshot holds", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const selfPgid = ownPgid();
  // Ids that no process has: kill(2) on them gives ESRCH.
  const FAKE = 2_000_000_000;
  // A doctored /proc, built aside and renamed into place, so a snapshot sees all of it or none. Its self/stat
  // names a group that is not the service's, so descendantsOf passes the real one through to the kill path, which
  // reads the service's group from the real /proc/self/stat.
  const procDir = path.join(s.dir, "proc");
  const staging = `${procDir}.tmp`;
  const stat = (pid, ppid, pgid, name = String(pid)) => {
    fs.mkdirSync(path.join(staging, name), { recursive: true });
    fs.writeFileSync(path.join(staging, name, "stat"), `${pid} (p) S ${ppid} ${pgid} 0 0 -1\n`);
  };
  // The kill seam records only, so a regression here can never signal anything real.
  const calls = [];
  const kill = (id, signal) => { calls.push({ id, signal }); };
  const snapshots = [];
  const run = runRenderProcess(process.execPath, s.argv("--no-browser", `--exit-on-file=${s.exitFile}`),
    options(s, { procDir, kill, verifyDeadlineMs: 200, onSnapshot: (snap) => snapshots.push(snap) }));
  const { cli } = await s.pids("fake-cli");
  stat(process.pid, 1, FAKE + 9, "self");
  stat(FAKE + 1, cli, selfPgid);       // in the service's own group
  stat(selfPgid, cli, FAKE + 2);       // the leader of the service's group, by pid: killTree(pid) signals -pid first
  stat(process.pid, cli, FAKE + 3);    // the service itself
  stat(FAKE + 4, cli, 1);              // in init's group: descendantsOf drops pgid 1, and so does the kill path
  stat(FAKE + 5, cli, FAKE + 5);       // an ordinary group, which is signalled
  fs.renameSync(staging, procDir);
  await pollFor(() => (snapshots.some((snap) => snap.pgids.includes(FAKE + 5)) ? true : undefined),
    "no snapshot recorded the doctored tree");

  fs.writeFileSync(s.exitFile, "");
  const result = await run;
  assert.equal(result.exitCode, 0);
  const report = await result.cleanup;
  const forbidden = calls.filter((c) => c.id <= 1 || c.id === selfPgid || c.id === process.pid);
  assert.deepEqual(forbidden, [], `the service's group is ${selfPgid} and its pid ${process.pid}`);
  assert.ok(calls.some((c) => c.id === FAKE + 5 && c.signal === "SIGKILL"), "the ordinary group was still signalled");
  // What it refused to signal is still alive, so cleanup cannot be verified, and the service exits.
  assert.equal(report.verified, false);
  assert.ok(report.survivors.includes(process.pid), `survivors [${report.survivors}] name the service itself`);
});

test("a CLI that prints nothing has its browser recorded by the snapshot ticker, and killed", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const snapshots = [];
  const run = runRenderProcess(process.execPath, s.argv("--silent", `--exit-on-file=${s.exitFile}`),
    options(s, { onSnapshot: (snap) => snapshots.push(snap) }));
  const pids = await s.pids("fake-browser");
  assert.notEqual(pids.browserPgid, pids.cli, "the browser leads a group of its own");
  // No output means no snapshot on a chunk: only the ticker can record the browser.
  await pollFor(() => (snapshots.some((snap) => snap.pids.includes(pids.browser)) ? true : undefined),
    () => `no snapshot recorded the browser ${pids.browser} in ${WAIT_MS / 1000}s (${snapshots.length} snapshots)`);

  fs.writeFileSync(s.exitFile, "");
  const result = await run;
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputTail, "", "the CLI printed nothing");
  assert.deepEqual(await result.cleanup, { verified: true, survivors: [] });
  await allGone([pids.browser, pids.grandchild, -pids.browserPgid]);
});

test("outputTail keeps the last 2 500 characters of stdout and stderr together", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const run = runRenderProcess(process.execPath, s.argv("--no-browser", "--flood", `--exit-on-file=${s.exitFile}`),
    options(s));
  await s.pids("fake-cli");
  // fake-cli writes stderr's block only after stdout's has been read here, so stderr's arrives last.
  await pollFor(() => (fs.existsSync(s.marker("stdout")) ? true : undefined), "fake-cli never wrote its stdout block");
  await ioTurns();
  fs.writeFileSync(s.marker("go"), "");
  await s.ready();
  await ioTurns();

  fs.writeFileSync(s.exitFile, "");
  const result = await run;
  assert.equal(result.exitCode, 0);
  const tail = result.outputTail;
  assert.ok(tail.length <= 2_500, `outputTail holds ${tail.length} characters`);
  assert.ok(tail.endsWith("<<STDERR-END>>\n"), `outputTail ends with stderr's last line: ...${JSON.stringify(tail.slice(-40))}`);
  assert.ok(!tail.includes("<<STDOUT-END>>"), "stdout's block is more than 2 500 characters back");
  assert.deepEqual(await result.cleanup, { verified: true, survivors: [] });
});

test("a kill that throws leaves cleanup unverified, and the cause names the error", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const controller = new AbortController();
  const kill = () => { throw new Error("the kill seam refused"); };
  const run = runRenderProcess(process.execPath, s.argv("--no-browser", "--ignore-sigterm"),
    options(s, { signal: controller.signal, kill, graceMs: 0, verifyDeadlineMs: 200 }));
  const { cli } = await s.pids("fake-cli");
  await s.ready();

  controller.abort();
  const report = await (await run).cleanup;
  assert.equal(report.verified, false);
  assert.deepEqual(report.survivors, [cli], "no signal reached the CLI");
  assert.match(report.cause ?? "", /the kill seam refused/);
});

test("an unexpected error while stopping leaves cleanup unverified, with its message as the cause", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const controller = new AbortController();
  // Throws from the stop's first snapshot, which no part of the stop expects.
  let armed = false;
  const onSnapshot = () => {
    if (armed) throw new Error("the snapshot seam failed mid-stop");
  };
  const run = runRenderProcess(process.execPath, s.argv("--no-browser", "--ignore-sigterm"),
    options(s, { signal: controller.signal, onSnapshot }));
  const { cli } = await s.pids("fake-cli");
  await s.ready();

  armed = true;
  controller.abort();
  const result = await run;
  assert.equal(result.aborted, true);
  const report = await result.cleanup;
  assert.equal(report.verified, false);
  assert.equal(report.cause, "the snapshot seam failed mid-stop");
  assert.ok(report.survivors.includes(cli), `survivors [${report.survivors}] name the CLI it never stopped`);
});

test("a snapshot seam that throws while the CLI runs crashes nothing, and the snapshot is still recorded", LINUX_ONLY, async (t) => {
  const s = scene(t);
  let thrown = 0;
  const onSnapshot = () => {
    thrown += 1;
    throw new Error("the snapshot seam failed");
  };
  const run = runRenderProcess(process.execPath, s.argv(`--exit-on-file=${s.exitFile}`), options(s, { onSnapshot }));
  const pids = await s.pids("fake-browser");
  await s.ready();
  await pollFor(() => (thrown > 0 ? true : undefined), "no snapshot ran");

  fs.writeFileSync(s.exitFile, "");
  const result = await run;
  assert.equal(result.exitCode, 0);
  // The seam runs after each snapshot is recorded, so the browser's group is still known, and killed.
  assert.deepEqual(await result.cleanup, { verified: true, survivors: [] });
  await allGone([pids.browser, pids.grandchild, -pids.browserPgid]);
});

test("the verification deadline is on the monotonic clock, so a wall-clock step back cannot stretch it", LINUX_ONLY, async (t) => {
  const s = scene(t);
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => realNow.call(Date) + offset);
  const controller = new AbortController();
  // Records only, so the CLI outlives every signal and verification runs to its deadline. Right after the
  // SIGKILL, once the verification has taken its start time, the wall clock steps back an hour.
  const kill = (_id, signal) => {
    if (signal === "SIGKILL") setImmediate(() => { offset = -3_600_000; });
  };
  const run = runRenderProcess(process.execPath, s.argv("--no-browser", "--ignore-sigterm"),
    options(s, { signal: controller.signal, kill, graceMs: 0, verifyDeadlineMs: 300 }));
  const { cli } = await s.pids("fake-cli");
  await s.ready();

  controller.abort();
  const cleanup = track((await run).cleanup);
  const report = await pollFor(cleanup,
    "cleanup never settled: its 300 ms deadline moved back with the wall clock");
  assert.equal(report.verified, false);
  assert.deepEqual(report.survivors, [cli]);
});

test("childEnv keeps PATH, HOME and REMOTION_*, sets TMPDIR to the work dir, and drops IDENTITY_HMAC_KEY and AUDIT_HMAC_KEY", () => {
  const source = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/render",
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    REMOTION_CHROME_MODE: "headless-shell",
    IDENTITY_HMAC_KEY: "identity-sentinel",
    AUDIT_HMAC_KEY: "audit-sentinel",
    TMPDIR: "/tmp",
    NODE_OPTIONS: "--require /x.js",
    NOT_REMOTION_X: "x",
    remotion_lower: "x",
    UNSET: undefined,
  };
  const env = childEnv(source, "/work/r-1");
  assert.deepEqual(env, {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/render",
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    REMOTION_CHROME_MODE: "headless-shell",
    TMPDIR: "/work/r-1",
  });
  assert.equal(source.TMPDIR, "/tmp", "the source is left unchanged");
});

test("RenderSlots refuses past capacity; a release frees exactly once; drained resolves only at zero", async () => {
  const slots = new RenderSlots(2);
  assert.equal(await settledYet(slots.drained()), true, "nothing held: drained at once");

  const a = slots.tryAcquire();
  const b = slots.tryAcquire();
  assert.equal(typeof a, "function");
  assert.equal(typeof b, "function");
  assert.equal(slots.inUse, 2);
  assert.equal(slots.tryAcquire(), null, "refused past capacity");

  const drained = slots.drained();
  a();
  a();
  assert.equal(slots.inUse, 1, "a second release of the same slot frees nothing");
  const c = slots.tryAcquire();
  assert.equal(typeof c, "function");
  assert.equal(slots.tryAcquire(), null, "b and c are both still held");

  b();
  assert.equal(await settledYet(drained), false, "c is still held");
  c();
  assert.equal(slots.inUse, 0);
  assert.equal(await settledYet(drained), true, "drained at zero");

  for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => new RenderSlots(bad), RangeError, `capacity ${bad}`);
  }
});

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

const LINUX_ONLY = { skip: process.platform !== "linux" && "needs /proc and process groups" };
const FAKE_CLI = path.join(REPO, "test", "fixtures", "proc-tree", "fake-cli.mjs");

/** Every wait polls its condition to this deadline. None sleeps a guessed duration. */
const WAIT_MS = 10_000;
const POLL_MS = 25;

/** Polls `probe` until it returns something other than undefined, and fails with `message` at the deadline. */
async function pollFor(probe, message) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return assert.fail(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

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
    for (const id of [...ids, p.cli, p.browser, p.grandchild, p.browserPgid && -p.browserPgid]) {
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
  const expected = { pids: [101, 102, 103, 107], pgids: [101, 103] };
  // The service's group, read from <procDir>/self/stat, as production reads /proc/self/stat.
  assert.deepEqual(sorted(descendantsOf(100, { procDir })), expected);
  assert.deepEqual(sorted(descendantsOf(100, { procDir, selfPgid: SELF_PGID })), expected);
  // An explicit selfPgid overrides <procDir>/self/stat: with 999 named as its own, 105's subtree is found.
  assert.deepEqual(sorted(descendantsOf(100, { procDir, selfPgid: 999 })),
    { pids: [101, 102, 103, 105, 106, 107], pgids: [101, 103, 106, 777] });
  for (const root of [0, 1]) {
    assert.deepEqual(descendantsOf(root, { procDir }), { pids: [], pgids: [] }, `root ${root} is everything`);
  }
  assert.deepEqual(descendantsOf(100, { procDir: path.join(procDir, "missing") }), { pids: [], pgids: [] });
  if (process.platform !== "linux") {
    assert.deepEqual(descendantsOf(process.pid), { pids: [], pgids: [] }, "no /proc, so nothing is found");
  }
});

test("runRenderProcess starts nothing for an aborted signal or a bad duration, and rejects when the CLI cannot start", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Spawning this rejects with ENOENT, so a result that resolves proves nothing was spawned.
  const missing = path.join(dir, "no-such-cli");
  const base = { cwd: dir, env: childEnv(process.env, dir), deadlineMs: 1_000, graceMs: 0, verifyDeadlineMs: 0 };

  const aborted = await runRenderProcess(missing, [], { ...base, signal: AbortSignal.abort() });
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.timedOut, false);
  assert.deepEqual(await aborted.cleanup, { verified: true, survivors: [] });

  for (const key of ["deadlineMs", "graceMs", "verifyDeadlineMs"]) {
    for (const bad of [Number.NaN, -1, Infinity]) {
      await assert.rejects(runRenderProcess(missing, [], { ...base, [key]: bad }), RangeError, `${key} = ${bad}`);
    }
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

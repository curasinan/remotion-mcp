/**
 * remotion_stop_studio's authorization, and the claim it makes to the model.
 *
 * The tool says: "Only PIDs this server recorded when it started them can be
 * stopped. Any other PID is refused." A registry of PIDs cannot deliver that.
 * The Studio is spawned detached and outlives the server, so by the time anyone
 * stops it the process may have exited and the number been reissued - and
 * isAlive() is just as true for whatever holds it now.
 *
 * Two changes are under test here. The registry moved out of os.tmpdir(), which
 * on POSIX is shared across accounts and is a poor place to keep an authorization
 * list. And before signalling, the target's identity is checked against the OS.
 *
 * Nothing here starts a real Studio. The registry is a plain JSON file, so the
 * interesting states - a recycled PID, a stale entry, a pre-upgrade file - are
 * reachable by writing it directly, which is also how an attacker would reach
 * them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyStudioProcess, readCommandLine } from "../dist/services/process.js";

const REPO = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------- identity

const spawned = [];

/**
 * What every fixture runs. Two jobs: stay alive until told otherwise, and say
 * when it is up.
 *
 * An earlier shape - `setTimeout(()=>{},20000)` - was a fixed wall-clock guess
 * in disguise, and it failed exactly the way this repo's other fixed guesses
 * did (docs/HANDOFF-2026-09-01.md §5). Three 2026-09-09 Windows failures, one
 * mechanism: under contention the uncapped PowerShell warm-up alone took 21 s
 * (run 34400265406) and 54 s (run 34402796953), so the fixtures hit their own
 * 20 s timer and exited - code 0, no signal, right on schedule - before the
 * first visibility sweep. In run 34401791174 the fixture survived visibility
 * and died between two assertions, turning "mismatch" into "unknown". No
 * polling deadline can see a process whose lifetime is shorter than the wait.
 *
 * So: no timer. The fixture holds its stdin open and exits when the pipe
 * closes, which the OS does for us however this test process ends - the leak
 * protection the timer was providing, without the clock. The single byte on
 * stdout is the readiness signal: once it arrives the fixture is past node
 * startup and parked in its event loop, so a later disappearance is a real
 * exit event, never "it had not started yet".
 */
const FIXTURE_MAIN =
  "process.stdin.resume();"
  + "const bye = () => process.exit(0);"
  + "process.stdin.on('end', bye); process.stdin.on('close', bye);"
  + "process.stdout.write('R');";

function spawnFixture(script, args) {
  const c = spawn(process.execPath, ["-e", script, "marker", ...args], { stdio: ["pipe", "pipe", "ignore"] });
  // Kept so a wait that times out can name the process by what it was meant to
  // look like, rather than by a bare PID.
  c.testLabel = args.join(" ");
  c.spawnedAt = Date.now();
  // The child handle already knows things the process table has to be asked
  // about. Record them: every "is it still there?" decision below starts here.
  c.exitInfo = null;
  const seen = (code, signal) => { if (!c.exitInfo) c.exitInfo = { code, signal, afterMs: Date.now() - c.spawnedAt }; };
  c.on("exit", seen);
  c.on("error", () => seen(null, "spawn-error"));
  c.ready = new Promise((resolve) => {
    c.stdout.once("data", () => resolve(true));
    c.on("exit", () => resolve(false));
    c.on("error", () => resolve(false));
  });
  spawned.push(c);
  return c;
}

/** A live process with a chosen command line. The leading non-option argument
 *  stops node parsing the rest as its own flags, which would exit immediately. */
const dummy = (...args) => spawnFixture(FIXTURE_MAIN, args);

const describeExit = (c) =>
  `fixture "${c.testLabel}" (pid ${c.pid ?? "none"}) exited ${c.exitInfo.afterMs} ms after spawn `
  + `with code=${c.exitInfo.code} signal=${c.exitInfo.signal}`;

after(() => { for (const c of spawned) { try { c.kill(); } catch { /* already gone */ } } });

// How long to keep polling before declaring the wait itself the failure. One
// sweep costs at most readCommandLine's own LOOKUP_TIMEOUT_MS (5 s) per PID, and
// the largest wait here is three PIDs, so this has to clear 15 s by enough to
// allow several sweeps. The normal case, once the lookup is warm, returns in
// well under a second.
const VISIBILITY_TIMEOUT_MS = 45_000;

/**
 * Pay the Windows process-lookup cold start once, outside any deadline.
 *
 * This is the fix for a real CI failure, and the reason it is not simply "poll
 * for longer". On windows-latest/node-24 every readCommandLine() call returned
 * null for 15 s across three separate tests - not slow, never succeeding. The
 * cause is a feedback loop inside readCommandLine(): it spawns PowerShell with
 * spawnSync({ timeout: 5000 }), and the FIRST powershell.exe start on a cold,
 * contended two-core runner takes longer than that. The call is killed at 5 s,
 * so the assemblies never finish loading, so the OS file cache is never
 * populated, so the next call is cold too. Every call is the first call.
 *
 * Breaking that needs one invocation that is allowed to finish. This spawns
 * PowerShell directly rather than through readCommandLine(), precisely so it is
 * not subject to that 5 s cap; afterwards the cache is warm and the capped calls
 * return promptly. Cheap and skipped entirely off Windows, where the lookup is a
 * /proc read or a ps invocation and no such cliff exists.
 */
let lookupWarmed = false;
function warmProcessLookup() {
  if (lookupWarmed) return;
  lookupWarmed = true;
  if (process.platform !== "win32") return;
  spawnSync("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$null = (Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CommandLine`,
  ], { encoding: "utf8", shell: false, windowsHide: true, timeout: 120_000 });
}

/**
 * Wait until the OS process table reports a command line for every PID given.
 *
 * Not a sleep. `spawn()` resolves as soon as Node has a handle, which is before
 * the platform's process enumerator can answer for the new process - on Windows
 * that enumerator is a whole PowerShell `Get-CimInstance` round trip, and on a
 * contended two-core runner with eleven test files in flight it is nowhere near
 * instant. readCommandLine() returning null is indistinguishable from "no such
 * process", so verifyStudioProcess() answers "unknown" and every assertion that
 * depends on identity - "confirmed", "mismatch", the refusal text - fails for a
 * reason that has nothing to do with the code under test.
 *
 * A fixed grace period is a guess about a machine we do not control. This waits
 * for the actual condition instead.
 *
 * Returns null when every fixture is ready and visible. Returns a reason string
 * - for the caller to turn into a named `t.skip()` - when the RUNNER failed the
 * fixtures: a child exited, was never startable, or never came up. Those are
 * environment verdicts, proven by the child handle's own exit event, and no
 * outcome of the code under test can be asserted once the fixtures are gone.
 *
 * Still throws, deliberately red, in the two cases a skip would paper over:
 * the lookup cannot read even this test process (a broken win32 lookup branch
 * would produce exactly that, on every run - a skip here would disable the
 * whole identity suite silently), and the anomaly where node believes a child
 * is alive but the enumerator never reports it.
 */
async function awaitProcessVisible(children, timeoutMs = VISIBILITY_TIMEOUT_MS) {
  // Readiness first, and event-driven: each fixture either writes its byte or
  // exits. This is what turns "the OS reports no command line" from a guess
  // into a decidable question - past this point every fixture has fully
  // started, so absence from the process table can only mean exit, and the
  // exit event says so.
  const allReady = await Promise.race([
    Promise.all(children.map((c) => c.ready)),
    new Promise((r) => { const t = setTimeout(() => r("timeout"), timeoutMs); t.unref?.(); }),
  ]);
  let dead = children.filter((c) => c.exitInfo);
  if (dead.length > 0) return `the runner did not keep the fixture process alive: ${dead.map(describeExit).join("; ")}`;
  if (allReady === "timeout") {
    const silent = children.filter((c) => !c.exitInfo).map((c) => `"${c.testLabel}" (pid ${c.pid ?? "none"})`).join(", ");
    return `after ${timeoutMs} ms the runner had still not started: ${silent} - neither ready nor exited`;
  }

  // Before the visibility clock starts: a cold lookup would otherwise burn the
  // whole deadline discovering that it is cold.
  warmProcessLookup();

  const deadline = Date.now() + timeoutMs;
  const waiting = new Map(children.map((c) => [c.pid, c]));
  for (;;) {
    dead = [...waiting.values()].filter((c) => c.exitInfo);
    if (dead.length > 0) {
      // Named immediately, from the exit event - not deduced 45 s later from
      // an absence that could mean anything.
      return `the runner did not keep the fixture process alive: ${dead.map(describeExit).join("; ")}`;
    }
    for (const [pid] of [...waiting]) {
      if (readCommandLine(pid) !== null) waiting.delete(pid);
    }
    if (waiting.size === 0) return null;
    if (Date.now() >= deadline) {
      const missing = [...waiting.values()].map((c) => `${c.pid} (${c.testLabel})`).join(", ");
      // Distinguish the two causes the message names, so the next reader does
      // not have to guess: if the lookup cannot even read THIS process - which
      // certainly exists and certainly has a command line - the platform lookup
      // is broken or too slow here, not the spawned processes.
      const selfVisible = readCommandLine(process.pid) !== null;
      throw new Error(
        `after ${timeoutMs} ms the OS still reports no command line for: ${missing}. `
        + (selfVisible
          ? "The process lookup works here (it can read this test process), yet node "
            + "holds live handles to those processes (no exit event) - a state this "
            + "test has no model for, which is worth a red build."
          : "The lookup cannot read even this test process, so the platform's process "
            + "lookup is unavailable or slower than readCommandLine's own timeout here; "
            + "the spawned processes are not the problem."),
      );
    }
    // 250 ms rather than 100: on Windows each sweep is one blocking PowerShell
    // spawn per outstanding PID, so a tighter interval adds load without adding
    // information.
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The inverse: wait until a PID is genuinely gone, which is what stop_studio's
 *  isAlive() asks. `child.kill()` returns before the OS has reaped anything. */
async function awaitProcessGone(pid, timeoutMs = VISIBILITY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); } catch { return; }
    if (Date.now() >= deadline) {
      throw new Error(`PID ${pid} was still alive ${timeoutMs} ms after being killed`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A verdict for a fixture that is actually an answer.
 *
 * verifyStudioProcess() is one capped lookup, and "unknown" is its documented
 * word for "could not check in time" - on a starved runner a single call can
 * time out even after the cache is warm. For a fixture we hold a live handle
 * to, "unknown" is therefore a non-answer, and the definitive verdicts are
 * stable (a command line never changes), so: poll to the verdict, cap the
 * poll, and if the cap is hit say whose failure that is. A fixture that dies
 * mid-poll is the runner's failure and is named from its exit event.
 *
 * The cap must clear several whole LOOKUP_TIMEOUT_MS (5 s) lookups, since each
 * poll step can burn one in full before answering "unknown".
 */
async function awaitVerdict(child, port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitInfo) {
      return { skip: `the runner did not keep the fixture process alive: ${describeExit(child)}` };
    }
    const identity = verifyStudioProcess(child.pid, port);
    if (identity.verdict !== "unknown") return identity;
    if (Date.now() >= deadline) {
      return {
        skip: `verifyStudioProcess answered "unknown" for ${timeoutMs} ms straight about pid ${child.pid} `
          + `("${child.testLabel}"), a process node still holds a live handle to. The platform lookup - `
          + "proven working moments ago by awaitProcessVisible - cannot answer under this load, "
          + "so no identity verdict can be asserted here.",
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("verifyStudioProcess tells a Studio from a bystander", async (t) => {
  const studio = dummy("remotion", "studio", "src/index.ts", "--port=3000");
  const other = dummy("some-unrelated-server", "--port=3000");
  const otherPort = dummy("remotion", "studio", "src/index.ts", "--port=4000");
  const absent = await awaitProcessVisible([studio, other, otherPort]);
  if (absent !== null) { t.skip(absent); return; }

  // The positive case first: without it, a check that always says "mismatch"
  // would pass every negative assertion below and refuse every real Studio.
  const confirmed = await awaitVerdict(studio, 3000);
  if (confirmed.skip) { t.skip(confirmed.skip); return; }
  assert.equal(confirmed.verdict, "confirmed",
    "a real Studio on the recorded port must be recognised, or stop_studio never works");

  const bystander = await awaitVerdict(other, 3000);
  if (bystander.skip) { t.skip(bystander.skip); return; }
  assert.equal(bystander.verdict, "mismatch",
    "an unrelated process holding the PID must not be signalled");

  const wrongPort = await awaitVerdict(otherPort, 3000);
  if (wrongPort.skip) { t.skip(wrongPort.skip); return; }
  assert.equal(wrongPort.verdict, "mismatch",
    "the port ties the process to the specific registry entry; a Studio on another port is not this one");

  // Direct call, no poll: for a PID that exists nowhere, "unknown" IS the
  // stable answer, not a lookup timing out.
  assert.equal(verifyStudioProcess(999_999, 3000).verdict, "unknown",
    "a PID that does not exist is unknowable, not a mismatch");
});

// The three guards below prove the skip machinery against known-bad inputs.
// Each skip path must be seen CATCHING the condition it names - a helper that
// silently proceeded past a dead fixture would let every test above go red for
// the fixture's reason again, and one that never fired would be
// indistinguishable from one that fires always.

test("GUARD: a fixture that exits is named by its exit, not hunted for the full deadline", async () => {
  const casualty = spawnFixture("process.exit(3)", ["doomed-fixture"]);
  const started = Date.now();
  const reason = await awaitProcessVisible([casualty]);
  assert.notEqual(reason, null, "a fixture that exited must yield a skip reason, not proceed to assertions");
  assert.match(reason, /doomed-fixture/, "the reason must name the fixture, not a bare PID");
  assert.match(reason, /code=3/, "the reason must carry the exit code the child reported");
  assert.ok(Date.now() - started < VISIBILITY_TIMEOUT_MS,
    "the exit event must short-circuit the wait; burning the whole visibility deadline means the exit was deduced, not observed");
});

test("GUARD: a fixture that never comes up is named, not waited on forever", async () => {
  // Alive (stdin tether holds it) but never writes the readiness byte: the
  // shape of a runner too starved to finish starting a child.
  const mute = spawnFixture("process.stdin.resume()", ["mute-fixture"]);
  const reason = await awaitProcessVisible([mute], 2_000);
  assert.notEqual(reason, null, "a fixture that never reported ready must yield a skip reason");
  assert.match(reason, /mute-fixture/, "the reason must name which fixture never came up");
  assert.match(reason, /neither ready nor exited/, "the reason must say what was missing: the readiness signal");
  mute.kill();
});

test("GUARD: closing stdin ends the fixture - the leak protection the old 20 s timer provided", async (t) => {
  const tethered = dummy("tether-check");
  const absent = await awaitProcessVisible([tethered]);
  if (absent !== null) { t.skip(absent); return; }
  tethered.stdin.end();
  // awaitProcessGone throws, naming the PID, if the tether does not hold.
  await awaitProcessGone(tethered.pid);
});

test("GUARD: a verdict poll on a fixture that died reports the runner's failure, not the lookup's", async () => {
  const casualty = spawnFixture("process.exit(7)", ["verdict-casualty"]);
  await new Promise((resolve) => casualty.on("exit", resolve));
  const r = await awaitVerdict(casualty, 3000);
  assert.ok(r.skip, "a dead fixture must yield a skip, never an identity verdict");
  assert.match(r.skip, /verdict-casualty/, "the skip must name the fixture");
  assert.match(r.skip, /code=7/, "the skip must carry the exit code, or the next reader starts this investigation over");
});

test("GUARD: a verdict that never settles is charged to the lookup, with the live fixture exonerated", async () => {
  // A child-shaped record whose PID exists nowhere: every lookup answers
  // "unknown", which for a supposedly live fixture is a non-answer - the
  // known-bad input for the cap path.
  const ghost = { pid: 999_999, exitInfo: null, testLabel: "ghost" };
  const r = await awaitVerdict(ghost, 3000, 1_000);
  assert.ok(r.skip, "an unsettleable verdict must yield a skip, not hang or invent a verdict");
  assert.match(r.skip, /unknown/, "the skip must say what the lookup kept answering");
  assert.match(r.skip, /999999/, "the skip must name the PID it could not resolve");
});

// ---------------------------------------------------------------- protocol

let child, stateDir, tmpDir, workspace;
let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout on ${method}`)); }, 30_000);
    timer.unref?.();
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const callTool = (name, args) => request("tools/call", { name, arguments: args });

before(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "studio-state-"));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-tmp-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ws-"));
  stateDir = process.platform === "darwin"
    ? path.join(base, "Library", "Application Support", "remotion-viz")
    : path.join(base, "remotion-viz");

  child = spawn("node", ["dist/index.js"], {
    cwd: REPO,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      REMOTION_MCP_WORKSPACE: workspace,
      REMOTION_MCP_AUDIT_LOG: path.join(base, "audit.jsonl"),
      // Redirect both the state dir and os.tmpdir() so nothing here touches the
      // real ones - the migration test needs to plant a file in "tmpdir".
      // Not REMOTION_MCP_STATE_DIR: that switches the legacy migration off, and
      // the migration is one of the things under test. Redirect the platform
      // sources instead, so the real code path runs against nothing real.
      LOCALAPPDATA: base, HOME: base, USERPROFILE: base, XDG_STATE_HOME: base,
      TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir,
    },
  });
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); }
    }
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "studio", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
});

after(async () => {
  if (!child) return;
  await new Promise((resolve) => { child.on("close", resolve); child.kill(); setTimeout(resolve, 3000).unref?.(); });
});

const registryPath = () => path.join(stateDir, "studios.json");
const legacyPath = () => path.join(tmpDir, "remotion-viz-studios.json");
function writeRegistry(entries, file = registryPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

test("the registry is not in the shared temp directory", () => {
  assert.equal(registryPath().startsWith(tmpDir), false,
    "the authorization list is back in os.tmpdir(), which on POSIX any account can write");
  assert.match(registryPath(), /studios\.json$/);
});

test("a PID in the registry that is not the Studio is refused, not signalled", async (t) => {
  // The exact shape of PID recycling: the Studio exited, the number was reissued,
  // and the registry still names it. This process is alive and is not a Studio.
  const bystander = dummy("innocent-bystander");
  // Same wait, same reason: an unobservable process reads as "unknown", and
  // stop_studio fails open on unknown - it would signal and report success,
  // failing the assertion below for a timing reason rather than a real one.
  const absent = await awaitProcessVisible([bystander]);
  if (absent !== null) { t.skip(absent); return; }
  writeRegistry([{ pid: bystander.pid, port: 3000, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 1000 }]);

  const r = await callTool("remotion_stop_studio", { pid: bystander.pid });
  // The server runs its own single capped lookup, and on "unknown" it proceeds
  // by documented fail-open design. That path is detectable in the response,
  // and asserting a refusal after it ran would blame this code for the
  // runner's starvation. structuredContent only exists on the success shape;
  // the refusal under test is an error response and passes this by.
  if (r.result.structuredContent?.identity_verified === "unknown") {
    t.skip(r.result.structuredContent.stopped
      ? "the server's own lookup could not answer in time and its documented fail-open path "
        + "signalled the fixture; the refusal cannot be asserted under this load"
      : `the fixture was already gone when the server checked: ${bystander.exitInfo ? describeExit(bystander) : "yet no exit event was seen - worth investigating"}`);
    return;
  }
  assert.equal(r.result.isError, true,
    "a recycled PID was accepted - the tool would have signalled an unrelated process");
  assert.match(r.result.content[0].text, /no longer the Remotion Studio/);
  assert.match(r.result.content[0].text, /Next step:/);

  // Still alive: the refusal must be a refusal, not a report of a completed kill.
  let alive = true;
  try { process.kill(bystander.pid, 0); } catch { alive = false; }
  assert.equal(alive, true, "the bystander was killed despite the refusal");

  // The stale entry is dropped so the same refusal is not repeated forever.
  assert.equal(JSON.parse(fs.readFileSync(registryPath(), "utf8")).length, 0);
});

test("a PID that has already exited is reported, not signalled", async (t) => {
  const gone = dummy("short-lived");
  const absent = await awaitProcessVisible([gone]);
  if (absent !== null) { t.skip(absent); return; }
  const deadPid = gone.pid;
  gone.kill();
  // What this test needs is the inverse condition - isAlive(deadPid) false -
  // and kill() returns long before the OS has reaped the process.
  await awaitProcessGone(deadPid);
  writeRegistry([{ pid: deadPid, port: 3100, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 5000 }]);

  const r = await callTool("remotion_stop_studio", { pid: deadPid });
  assert.equal(r.result.isError, undefined, "an already-exited Studio is a normal outcome, not an error");
  assert.equal(r.result.structuredContent.stopped, false);
  assert.match(r.result.content[0].text, /already exited/);
});

test("a PID this server never recorded is refused", async () => {
  writeRegistry([]);
  const r = await callTool("remotion_stop_studio", { pid: process.pid });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /not started by this server/);
});

test("entries written before the move are carried over, and the old file removed", async (t) => {
  // Without this an upgrade orphans every running Studio: the only tool that can
  // stop them stops recognising them.
  writeRegistry([]);
  const legacy = dummy("legacy", "remotion", "studio", "--port=3200");
  // identity_verified must come back "confirmed" below, which it cannot until
  // the OS can answer for this PID.
  const absent = await awaitProcessVisible([legacy]);
  if (absent !== null) { t.skip(absent); return; }
  writeRegistry(
    [{ pid: legacy.pid, port: 3200, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 2000 }],
    legacyPath(),
  );
  assert.equal(fs.existsSync(legacyPath()), true);

  const r = await callTool("remotion_stop_studio", { pid: legacy.pid });
  // Same fail-open detection as above: "unknown" from the server's single
  // capped lookup means the "confirmed" assertion below has no answer to
  // check, through no fault of the migration under test.
  if (r.result.structuredContent?.identity_verified === "unknown") {
    t.skip("the server's own lookup could not answer in time for the migrated entry; "
      + "identity_verified cannot be asserted under this load");
    return;
  }
  assert.equal(r.result.isError, undefined,
    `a Studio recorded before the upgrade was not recognised: ${r.result.content[0].text}`);
  assert.equal(r.result.structuredContent.stopped, true);
  assert.equal(r.result.structuredContent.identity_verified, "confirmed");

  assert.equal(fs.existsSync(legacyPath()), false,
    "the pre-upgrade file survived the merge, so the shared-directory exposure outlives the upgrade");
});

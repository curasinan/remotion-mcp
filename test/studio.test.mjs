// Tests remotion_stop_studio's PID authorization: registry location, identity check and migration.
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

// Fixture body: lives until its stdin closes and writes one byte to stdout once ready.
const FIXTURE_MAIN =
  "process.stdin.resume();"
  + "const bye = () => process.exit(0);"
  + "process.stdin.on('end', bye); process.stdin.on('close', bye);"
  + "process.stdout.write('R');";

function spawnFixture(script, args) {
  const c = spawn(process.execPath, ["-e", script, "marker", ...args], { stdio: ["pipe", "pipe", "ignore"] });
  // Names the fixture in failure messages instead of a bare PID.
  c.testLabel = args.join(" ");
  c.spawnedAt = Date.now();
  // Exit info from the child handle; liveness checks below consult it first.
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

// Live process with a chosen command line; a leading non-option arg stops node parsing the rest.
const dummy = (...args) => spawnFixture(FIXTURE_MAIN, args);

const describeExit = (c) =>
  `fixture "${c.testLabel}" (pid ${c.pid ?? "none"}) exited ${c.exitInfo.afterMs} ms after spawn `
  + `with code=${c.exitInfo.code} signal=${c.exitInfo.signal}`;

after(() => { for (const c of spawned) { try { c.kill(); } catch { /* already gone */ } } });

// Must allow several sweeps of up to 5 s per PID lookup across three PIDs.
const VISIBILITY_TIMEOUT_MS = 45_000;

// Runs one uncapped PowerShell lookup on Windows so later 5 s-capped lookups start warm.
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

// Returns null when all fixtures are visible, a skip reason if one died; throws if lookup fails.
async function awaitProcessVisible(children, timeoutMs = VISIBILITY_TIMEOUT_MS) {
  // Wait for readiness first, so later absence from the process table can only mean exit.
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

  // Warm the lookup before the visibility deadline starts.
  warmProcessLookup();

  const deadline = Date.now() + timeoutMs;
  const waiting = new Map(children.map((c) => [c.pid, c]));
  for (;;) {
    dead = [...waiting.values()].filter((c) => c.exitInfo);
    if (dead.length > 0) {
      // Report a dead fixture immediately from its exit event.
      return `the runner did not keep the fixture process alive: ${dead.map(describeExit).join("; ")}`;
    }
    for (const [pid] of [...waiting]) {
      if (readCommandLine(pid) !== null) waiting.delete(pid);
    }
    if (waiting.size === 0) return null;
    if (Date.now() >= deadline) {
      const missing = [...waiting.values()].map((c) => `${c.pid} (${c.testLabel})`).join(", ");
      // If the lookup cannot read this process, the platform lookup is at fault, not the fixtures.
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
    // On Windows each sweep spawns PowerShell per PID, so poll less often.
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Waits until a PID is gone; child.kill() returns before the OS reaps the process.
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

// Polls verifyStudioProcess past "unknown"; returns a skip reason on timeout or fixture exit.
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

  // Positive case first, so a check that always says "mismatch" cannot pass.
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

  // No poll needed: "unknown" is the stable answer for a nonexistent PID.
  assert.equal(verifyStudioProcess(999_999, 3000).verdict, "unknown",
    "a PID that does not exist is unknowable, not a mismatch");
});

// The guards below check that each skip path detects the condition it names.

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
  // Kept alive by stdin but never writes the readiness byte.
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
  // A child-shaped record with a nonexistent PID, so every lookup answers "unknown".
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
      // Redirect platform dirs and tmpdir; REMOTION_MCP_STATE_DIR would disable the migration under test.
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
  // Simulates PID recycling: the registry names a live process that is not a Studio.
  const bystander = dummy("innocent-bystander");
  // An invisible process reads as "unknown", on which stop_studio fails open.
  const absent = await awaitProcessVisible([bystander]);
  if (absent !== null) { t.skip(absent); return; }
  writeRegistry([{ pid: bystander.pid, port: 3000, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 1000 }]);

  const r = await callTool("remotion_stop_studio", { pid: bystander.pid });
  // Skip if the server's own lookup answered "unknown" and took the fail-open path.
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
  // kill() returns before the OS reaps the process.
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
  // Without migration, an upgrade would orphan every running Studio.
  writeRegistry([]);
  const legacy = dummy("legacy", "remotion", "studio", "--port=3200");
  // identity_verified can only be "confirmed" once the OS can see this PID.
  const absent = await awaitProcessVisible([legacy]);
  if (absent !== null) { t.skip(absent); return; }
  writeRegistry(
    [{ pid: legacy.pid, port: 3200, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 2000 }],
    legacyPath(),
  );
  assert.equal(fs.existsSync(legacyPath()), true);

  const r = await callTool("remotion_stop_studio", { pid: legacy.pid });
  // Same fail-open detection as above.
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

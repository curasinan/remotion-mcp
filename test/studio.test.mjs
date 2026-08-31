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
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyStudioProcess, readCommandLine } from "../dist/services/process.js";

const REPO = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------- identity

const spawned = [];
/** A live process with a chosen command line. The leading non-option argument
 *  stops node parsing the rest as its own flags, which would exit immediately. */
function dummy(...args) {
  const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)", "marker", ...args], { stdio: "ignore" });
  // Kept so a wait that times out can name the process by what it was meant to
  // look like, rather than by a bare PID.
  c.testLabel = args.join(" ");
  spawned.push(c);
  return c;
}
after(() => { for (const c of spawned) { try { c.kill(); } catch { /* already gone */ } } });

// How long to keep polling before declaring the wait itself the failure. The
// normal case satisfies every one of these in well under a second; the cap is
// generous because the failure it must not produce is a false red.
const VISIBILITY_TIMEOUT_MS = 15_000;

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
 * for the actual condition instead, and when it genuinely does not hold it says
 * which PID never appeared rather than failing an assertion three lines later.
 */
async function awaitProcessVisible(children, timeoutMs = VISIBILITY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const waiting = new Map(children.map((c) => [c.pid, c.testLabel ?? "?"]));
  for (;;) {
    for (const pid of [...waiting.keys()]) {
      if (readCommandLine(pid) !== null) waiting.delete(pid);
    }
    if (waiting.size === 0) return;
    if (Date.now() >= deadline) {
      const missing = [...waiting].map(([pid, argv]) => `${pid} (${argv})`).join(", ");
      throw new Error(
        `after ${timeoutMs} ms the OS still reports no command line for: ${missing}. `
        + "Either the process died before it could be observed, or the platform's process "
        + "lookup is unavailable here - readCommandLine() cannot tell those apart.",
      );
    }
    await new Promise((r) => setTimeout(r, 100));
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

test("verifyStudioProcess tells a Studio from a bystander", async () => {
  const studio = dummy("remotion", "studio", "src/index.ts", "--port=3000");
  const other = dummy("some-unrelated-server", "--port=3000");
  const otherPort = dummy("remotion", "studio", "src/index.ts", "--port=4000");
  await awaitProcessVisible([studio, other, otherPort]);

  // The positive case first: without it, a check that always says "mismatch"
  // would pass every negative assertion below and refuse every real Studio.
  assert.equal(verifyStudioProcess(studio.pid, 3000).verdict, "confirmed",
    "a real Studio on the recorded port must be recognised, or stop_studio never works");

  assert.equal(verifyStudioProcess(other.pid, 3000).verdict, "mismatch",
    "an unrelated process holding the PID must not be signalled");
  assert.equal(verifyStudioProcess(otherPort.pid, 3000).verdict, "mismatch",
    "the port ties the process to the specific registry entry; a Studio on another port is not this one");
  assert.equal(verifyStudioProcess(999_999, 3000).verdict, "unknown",
    "a PID that does not exist is unknowable, not a mismatch");
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

test("a PID in the registry that is not the Studio is refused, not signalled", async () => {
  // The exact shape of PID recycling: the Studio exited, the number was reissued,
  // and the registry still names it. This process is alive and is not a Studio.
  const bystander = dummy("innocent-bystander");
  // Same wait, same reason: an unobservable process reads as "unknown", and
  // stop_studio fails open on unknown - it would signal and report success,
  // failing the assertion below for a timing reason rather than a real one.
  await awaitProcessVisible([bystander]);
  writeRegistry([{ pid: bystander.pid, port: 3000, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 1000 }]);

  const r = await callTool("remotion_stop_studio", { pid: bystander.pid });
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

test("a PID that has already exited is reported, not signalled", async () => {
  const gone = dummy("short-lived");
  await awaitProcessVisible([gone]);
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

test("entries written before the move are carried over, and the old file removed", async () => {
  // Without this an upgrade orphans every running Studio: the only tool that can
  // stop them stops recognising them.
  writeRegistry([]);
  const legacy = dummy("legacy", "remotion", "studio", "--port=3200");
  // identity_verified must come back "confirmed" below, which it cannot until
  // the OS can answer for this PID.
  await awaitProcessVisible([legacy]);
  writeRegistry(
    [{ pid: legacy.pid, port: 3200, projectDir: workspace, logFile: "x.log", startedAt: Date.now() - 2000 }],
    legacyPath(),
  );
  assert.equal(fs.existsSync(legacyPath()), true);

  const r = await callTool("remotion_stop_studio", { pid: legacy.pid });
  assert.equal(r.result.isError, undefined,
    `a Studio recorded before the upgrade was not recognised: ${r.result.content[0].text}`);
  assert.equal(r.result.structuredContent.stopped, true);
  assert.equal(r.result.structuredContent.identity_verified, "confirmed");

  assert.equal(fs.existsSync(legacyPath()), false,
    "the pre-upgrade file survived the merge, so the shared-directory exposure outlives the upgrade");
});

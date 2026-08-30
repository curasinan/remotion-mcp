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

import { verifyStudioProcess } from "../dist/services/process.js";

const REPO = path.join(import.meta.dirname, "..");

// ---------------------------------------------------------------- identity

const spawned = [];
/** A live process with a chosen command line. The leading non-option argument
 *  stops node parsing the rest as its own flags, which would exit immediately. */
function dummy(...args) {
  const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)", "marker", ...args], { stdio: "ignore" });
  spawned.push(c);
  return c;
}
after(() => { for (const c of spawned) { try { c.kill(); } catch { /* already gone */ } } });

test("verifyStudioProcess tells a Studio from a bystander", async () => {
  const studio = dummy("remotion", "studio", "src/index.ts", "--port=3000");
  const other = dummy("some-unrelated-server", "--port=3000");
  const otherPort = dummy("remotion", "studio", "src/index.ts", "--port=4000");
  await new Promise((r) => setTimeout(r, 700));

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
  await new Promise((r) => setTimeout(r, 600));
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
  await new Promise((r) => setTimeout(r, 300));
  const deadPid = gone.pid;
  gone.kill();
  await new Promise((r) => setTimeout(r, 500));
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
  await new Promise((r) => setTimeout(r, 600));
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

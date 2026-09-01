/**
 * The test suite must never write to the user's production audit log.
 *
 * It did. `smoke-test.mjs` and `test/protocol.test.mjs` spawned the server with only
 * REMOTION_MCP_WORKSPACE set, so parseAuditLogPath fell through to
 * defaultAuditLogPath() and every run appended to
 * %LOCALAPPDATA%\remotion-viz\audit.jsonl (or the macOS/XDG equivalent). Measured on
 * a real install: 418 of 420 recorded events — 99.5% — were test fixtures, including
 * a 48% "security refusal" rate that is entirely `../../../escape.png` and friends.
 *
 * That log is not scratch data. `npm run gateway` and "show me the gateway" render it
 * as a usage dashboard, and it is size-capped with rotation, so at volume test runs
 * evict the real usage they are drowning.
 *
 * These tests never touch the real default path. They redirect the platform base
 * directories (LOCALAPPDATA / XDG_STATE_HOME / HOME) into a temp dir, so the
 * "default" location under test is a fake one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");

/** Mirrors defaultAuditLogPath() in src/config.ts against a redirected home. */
function defaultAuditPathFor(base) {
  if (process.platform === "win32") return path.join(base, "remotion-viz", "audit.jsonl");
  if (process.platform === "darwin") {
    return path.join(base, "Library", "Application Support", "remotion-viz", "audit.jsonl");
  }
  return path.join(base, "remotion-viz", "audit.jsonl");
}

/** Redirect every base dir defaultAuditLogPath() consults, so no real path is used. */
function redirectedEnv(base) {
  return {
    LOCALAPPDATA: base,                                   // win32
    HOME: base,                                           // darwin/linux via os.homedir()
    USERPROFILE: base,
    XDG_STATE_HOME: base,                                 // linux
  };
}

/** Drive one tool call through a freshly spawned server and resolve when it answers. */
function callOnce(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/index.js"], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let buf = "";
    const pending = new Map();
    let id = 1;
    const send = (method, params) =>
      new Promise((res) => {
        const i = id++;
        pending.set(i, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
      });
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const r = pending.get(msg.id);
        if (r) { pending.delete(msg.id); r(msg); }
      }
    });
    child.on("error", reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 30_000);
    timer.unref?.();
    (async () => {
      await send("initialize", {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "audit-isolation", version: "1.0.0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      await send("tools/call", {
        name: "viz_validate_svg",
        arguments: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>' },
      });
      clearTimeout(timer);
      // Give recordAuditEvent's synchronous append time to land before we look.
      await new Promise((r) => setTimeout(r, 300));
      child.kill();
      resolve();
    })().catch(reject);
  });
}

// Positive control. Without this, "the file was not written" proves nothing — it
// would also pass if the audit trail were broken outright.
test("a server spawned with no audit override DOES write to the default path", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "audit-iso-pos-"));
  const expected = defaultAuditPathFor(base);
  await callOnce({ ...redirectedEnv(base), REMOTION_MCP_WORKSPACE: base });
  assert.equal(fs.existsSync(expected), true,
    `expected the default audit log at ${expected} to exist — if this fails the detection below is meaningless`);
  assert.ok(fs.readFileSync(expected, "utf8").includes("viz_validate_svg"));
});

test("a server spawned WITH an audit override leaves the default path untouched", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "audit-iso-neg-"));
  const defaultPath = defaultAuditPathFor(base);
  const override = path.join(base, "isolated", "audit.jsonl");
  await callOnce({
    ...redirectedEnv(base),
    REMOTION_MCP_WORKSPACE: base,
    REMOTION_MCP_AUDIT_LOG: override,
  });
  assert.equal(fs.existsSync(override), true, "the override path should have received the events");
  assert.ok(fs.readFileSync(override, "utf8").includes("viz_validate_svg"));
  assert.equal(fs.existsSync(defaultPath), false,
    `the default audit log at ${defaultPath} must not be created when an override is set`);
});

// The regression guard. The two tests above verify the mechanism; this one verifies
// that every harness in the repo actually uses it. A future test file that spawns the
// server and forgets the override reintroduces the exact bug this file exists for.
//
// Deliberately coarse: it asks whether a file that mentions dist/index.js also
// mentions REMOTION_MCP_AUDIT_LOG, not whether the two are wired together. A file
// could satisfy it with the name in a comment while still polluting. That is
// accepted — the behavioural tests above cover the mechanism, and this only has to
// catch the plain omission, which is how the bug actually happened.
test("every harness that spawns the server redirects ALL of its persistent state", () => {
  // Two kinds now. The audit log is appended to; the Studio registry is worse -
  // loading it UNLINKS the pre-1.2.0 file as a migration step, so a suite that
  // missed this would delete real state on a developer's machine just by running.
  const roots = [REPO, path.join(REPO, "test"), path.join(REPO, "scripts")];
  const offenders = [];
  for (const dir of roots) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".mjs")) continue;
      const full = path.join(dir, e.name);
      const src = fs.readFileSync(full, "utf8");
      // Spawns either the source build or a bundled copy, AND drives it over
      // JSON-RPC. The second half matters: scripts/build-bundle.mjs names
      // server/index.js to check it exists and never runs it.
      const namesServer = src.includes("dist/index.js") || src.includes('"server", "index.js"');
      if (!namesServer || !src.includes('"initialize"')) continue;
      // Two valid isolations. REMOTION_MCP_STATE_DIR redirects the state dir and
      // switches off the legacy migration. Redirecting the platform sources plus
      // os.tmpdir() isolates everything including that migration, which is what a
      // test of the migration itself needs.
      const byOverride = src.includes("REMOTION_MCP_STATE_DIR");
      const byRedirect = /LOCALAPPDATA|XDG_STATE_HOME/.test(src) && /TMPDIR|TEMP:/.test(src);
      const missing = [];
      if (!src.includes("REMOTION_MCP_AUDIT_LOG")) missing.push("REMOTION_MCP_AUDIT_LOG");
      if (!byOverride && !byRedirect) missing.push("REMOTION_MCP_STATE_DIR (or a home+tmpdir redirect)");
      if (missing.length > 0) offenders.push(`${path.relative(REPO, full)} (missing ${missing.join(", ")})`);
    }
  }
  assert.deepEqual(offenders, [],
    "these spawn the server without redirecting all of its persistent state, so running them "
    + `reads, writes or deletes the real user's files: ${offenders.join("; ")}`);
});

// Test harnesses must never write to the user's real audit log or state; base dirs are redirected.
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
      // Give recordAuditEvent's synchronous append time to land before reading.
      await new Promise((r) => setTimeout(r, 300));
      child.kill();
      resolve();
    })().catch(reject);
  });
}

// Positive control: proves the audit trail works, so the negative test below is meaningful.
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

// Text scan: every .mjs that spawns the server must also name the audit and state overrides.
test("every harness that spawns the server redirects ALL of its persistent state", () => {
  // Covers the audit log and the Studio registry, whose load unlinks a legacy file.
  const roots = [REPO, path.join(REPO, "test"), path.join(REPO, "scripts")];
  const offenders = [];
  for (const dir of roots) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".mjs")) continue;
      const full = path.join(dir, e.name);
      const src = fs.readFileSync(full, "utf8");
      // Must name the server AND drive it over JSON-RPC; merely naming the bundle is not a spawn.
      const namesServer = src.includes("dist/index.js") || src.includes('"server", "index.js"');
      if (!namesServer || !src.includes('"initialize"')) continue;
      // Isolated either by the state-dir override or by redirecting platform dirs plus tmpdir.
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

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { recordAuditEvent, readAuditEvents } from "../dist/services/audit.js";
import { rasterizeSvg } from "../dist/services/raster.js";
import { ToolInputError } from "../dist/types.js";

test("audit log defaults to a per-user state dir outside the workspace", () => {
  const c = loadConfig({});
  assert.ok(c.auditLogPath.endsWith(path.join("remotion-viz", "audit.jsonl")));
  assert.ok(path.isAbsolute(c.auditLogPath));
});

test("REMOTION_MCP_AUDIT_LOG overrides the path", () => {
  const target = path.join(os.tmpdir(), "audit-cfg-test", "a.jsonl");
  const c = loadConfig({ REMOTION_MCP_AUDIT_LOG: target });
  assert.equal(c.auditLogPath, path.resolve(target));
});

test("config exposes a positive auditMaxBytes default", () => {
  const c0 = loadConfig({});
  assert.ok(typeof c0.auditMaxBytes === "number" && c0.auditMaxBytes > 0);
});

test("recordAuditEvent appends and readAuditEvents reads it back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-rw-"));
  process.env.REMOTION_MCP_AUDIT_LOG = path.join(dir, "audit.jsonl");
  recordAuditEvent({ event: "tool_call", tool: "viz_validate_svg" });
  const events = readAuditEvents();
  const last = events[events.length - 1];
  assert.equal(last.tool, "viz_validate_svg");
  assert.equal(last.event, "tool_call");
  assert.equal(last.decision, "observe"); // default seam value
  assert.ok(typeof last.ts === "string" && last.ts.includes("T"));
  delete process.env.REMOTION_MCP_AUDIT_LOG;
});

test("the log rotates and never exceeds the byte cap by more than one segment", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-rot-"));
  process.env.REMOTION_MCP_AUDIT_LOG = path.join(dir, "audit.jsonl");
  // Force many writes; cap is 5MB (2.5MB/segment). Use a large detail to fill fast.
  const big = "x".repeat(50_000);
  for (let i = 0; i < 120; i++) recordAuditEvent({ event: "tool_call", tool: "t", detail: { big, i } });
  const current = path.join(dir, "audit.jsonl");
  const prev = current + ".1";
  const total = (fs.existsSync(current) ? fs.statSync(current).size : 0)
    + (fs.existsSync(prev) ? fs.statSync(prev).size : 0);
  assert.ok(total <= 5_000_000 + 60_000, `total ${total} exceeded cap`);
  // Most recent event is still readable after rotation.
  const events = readAuditEvents();
  assert.equal(events[events.length - 1].detail.i, 119);
  delete process.env.REMOTION_MCP_AUDIT_LOG;
});

test("an oversized SVG throws with category raster_budget", () => {
  const tall = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 5000000"><rect width="100" height="5000000"/></svg>';
  try {
    rasterizeSvg(tall, 1200);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolInputError);
    assert.equal(e.category, "raster_budget");
  }
});

test("a local-file SVG reference throws with category svg_reference", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="C:/x.png"/></svg>';
  try {
    rasterizeSvg(svg, 100);
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.category, "svg_reference");
  }
});

import { spawn } from "node:child_process";

test("a tool call and its rejection are recorded in the audit log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-e2e-"));
  const logPath = path.join(dir, "audit.jsonl");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ws-"));
  const child = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, REMOTION_MCP_WORKSPACE: ws, REMOTION_MCP_AUDIT_LOG: logPath, REMOTION_MCP_STATE_DIR: dir },
  });
  let buf = ""; const pending = new Map(); let id = 1;
  child.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; const m = JSON.parse(l); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } } });
  const req = (method, params) => new Promise((res) => { const i = id++; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  await req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  // A rejected path traversal.
  await req("tools/call", { name: "viz_render_svg", arguments: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>', output_path: "../../../escape.png" } });
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.event === "tool_call" && e.tool === "viz_render_svg"));
  assert.ok(lines.some((e) => e.event === "tool_rejected" && e.category === "path_traversal"));
});

test("a network_block event round-trips through the audit log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-net-"));
  process.env.REMOTION_MCP_AUDIT_LOG = path.join(dir, "audit.jsonl");
  recordAuditEvent({ event: "network_block", tool: "viz_render_html", category: "network_block", detail: { count: 2, hosts: ["evil.example", "169.254.169.254"] } });
  const events = readAuditEvents();
  const last = events[events.length - 1];
  assert.equal(last.event, "network_block");
  assert.equal(last.category, "network_block");
  assert.equal(last.detail.count, 2);
  delete process.env.REMOTION_MCP_AUDIT_LOG;
});

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadConfig, ConfigError } from "../dist/config.js";
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

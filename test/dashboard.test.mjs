import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("the generator builds a self-contained dashboard from the audit log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-"));
  const logPath = path.join(dir, "audit.jsonl");
  const out = path.join(dir, "gateway.html");
  // Seed a log with one call and one categorized refusal.
  const events = [
    { ts: "2026-08-25T10:00:00.000Z", event: "tool_call", tool: "viz_render_svg", decision: "observe" },
    { ts: "2026-08-25T10:00:01.000Z", event: "tool_rejected", tool: "viz_render_svg", decision: "observe", category: "path_traversal", detail: { message: "resolves outside the workspace root" } },
    { ts: "2026-08-25T10:00:02.000Z", event: "network_block", tool: "viz_render_html", decision: "observe", category: "network_block", detail: { count: 1, hosts: ["evil.example"] } },
  ];
  fs.writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  execFileSync("node", ["scripts/build-dashboard.mjs", "--out", out], {
    env: { ...process.env, REMOTION_MCP_AUDIT_LOG: logPath },
  });

  const html = fs.readFileSync(out, "utf8");
  // Self-contained: no external resource LOADS. Inert URL strings inside the
  // embedded audit JSON are fine — only <script>/<img>/<link>/... src|href to
  // http(s), @import, and CSS url(http...) are forbidden.
  const externalRefs = [
    /<(?:script|img|source|iframe|link|use|image)\b[^>]*\b(?:src|href)\s*=\s*["']https?:/i,
    /@import[^;]*https?:/i,
    /url\(\s*["']?https?:\/\//i,
  ];
  assert.ok(!externalRefs.some((re) => re.test(html)), "dashboard must not load external resources");
  // Contains the data and the security section.
  assert.ok(html.includes("path_traversal"));
  assert.ok(html.includes("network_block"));
  assert.ok(/security/i.test(html));
});

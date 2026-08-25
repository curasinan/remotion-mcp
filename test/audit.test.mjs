import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../dist/config.js";

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

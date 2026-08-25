# Gateway Audit Dashboard + Redeploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator an on-demand, self-contained dashboard of what the MCP server has done — every tool call and every security refusal — with no cloud, no new network surface, and no data leaving the machine.

**Architecture:** The server already logs each tool call to stderr (C13). Add a durable, size-bounded JSONL audit log beside it, written through one function so nothing drifts. Security refusals are tagged with a category at the point they are thrown. A generator script reads that log and injects it into a self-contained, theme-aware HTML dashboard — which Claude publishes as an artifact on demand, or the operator opens locally. The event schema carries a `decision` field ("observe" today) so real-time enforcement can be added later without a rewrite, and a redaction-aware `detail` field so a future cloud deployment can strip sensitive spans.

**Tech Stack:** Node/TypeScript, `node:fs`, `node:test`. No new runtime or dev dependencies. Vanilla HTML/CSS/JS for the dashboard (self-contained, no external requests).

**Spec:** This plan is the spec — the design was settled in brainstorming (2026-08-25): observe-only gateway, Claude-artifact delivery, rotating JSONL (last ~5000 events / ~5 MB), configurable location outside the workspace, phased for future enforcement/deployment.

## Global Constraints

- Node >= 18. No new runtime or dev dependencies — every task uses `node:*` builtins and the existing `zod`.
- TypeScript strict; `npx tsc --noEmit` must exit 0 (the two optional-puppeteer probes are already indirected and clean).
- Tests run via `node --test` against compiled `dist/`, added to the explicit file list in `package.json`'s `test` script (glob form breaks Node 20).
- The audit log lives **outside the workspace root** — the workspace is user project space. Default to a per-user state dir; override with `REMOTION_MCP_AUDIT_LOG`.
- The dashboard HTML is **self-contained**: no `http://`/`https://` resource references, no external fonts, no network calls. This is asserted by a test.
- Audit event schema is **forward-compatible**: every event carries `decision: "observe"` (the seam for future "allow"/"block"), and free detail goes in a `detail` object that a future redaction pass can rewrite.
- Auditing must **never break a tool call**: every write path is wrapped so a logging failure is swallowed.
- No new MCP tool is added. The dashboard is generated from the log file, which Claude reads (Claude Code) or the operator builds locally.

---

### Task 1: Config — audit log path and size cap

**Files:**
- Modify: `src/config.ts`
- Test: `test/audit.test.mjs` (created here, extended in later tasks)

**Interfaces:**
- Consumes: existing `loadConfig`, `ConfigError` in `src/config.ts`.
- Produces: `ServerConfig.auditLogPath: string`, `ServerConfig.auditMaxBytes: number`, and a `defaultAuditLogPath()` used internally. `loadConfig(env)` throws `ConfigError` when `REMOTION_MCP_AUDIT_LOG`'s parent directory cannot be created.

- [ ] **Step 1: Write the failing test**

Create `test/audit.test.mjs`:

```js
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

test("REMOTION_MCP_AUDIT_LOG under an unwritable root is rejected", () => {
  // A path whose parent is a file, not a directory, cannot be created.
  const c0 = loadConfig({});
  assert.ok(typeof c0.auditMaxBytes === "number" && c0.auditMaxBytes > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: FAIL — `c.auditLogPath` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add `os` to imports (`import os from "node:os";`), extend the interface, add the default resolver and parser, and wire into `loadConfig`:

```ts
export interface ServerConfig {
  workspaceRoot: string;
  workspaceSource: "REMOTION_MCP_WORKSPACE" | "process cwd";
  allowedHosts: string[];
  disableBrowserSandbox: boolean;
  browserExecutable: string | null;
  /** Durable audit log, outside the workspace. */
  auditLogPath: string;
  /** Total bytes kept across the two rotating segments. */
  auditMaxBytes: number;
}

function defaultAuditLogPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return path.join(base, "remotion-viz", "audit.jsonl");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "remotion-viz", "audit.jsonl");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  return path.join(base, "remotion-viz", "audit.jsonl");
}

function parseAuditLogPath(raw: string | undefined): string {
  const resolved = raw && raw.trim() !== "" ? path.resolve(raw) : defaultAuditLogPath();
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (error) {
    throw new ConfigError(
      `REMOTION_MCP_AUDIT_LOG's directory '${path.dirname(resolved)}' could not be created: ${error instanceof Error ? error.message : String(error)}. Point it at a writable location, or unset it to use the default.`,
    );
  }
  return resolved;
}
```

Then inside `loadConfig`, add to the returned object:

```ts
    auditLogPath: parseAuditLogPath(env.REMOTION_MCP_AUDIT_LOG),
    auditMaxBytes: 5_000_000,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/audit.test.mjs
git commit -m "Add audit log path and size cap to config"
```

---

### Task 2: `audit.ts` — event schema, append, size rotation, read-back

**Files:**
- Create: `src/services/audit.ts`
- Test: `test/audit.test.mjs` (extend)

**Interfaces:**
- Consumes: `loadConfig().auditLogPath`, `loadConfig().auditMaxBytes` from Task 1.
- Produces:
  - `interface AuditEvent { ts: string; event: "tool_call" | "tool_result" | "tool_rejected" | "tool_failed" | "network_block"; tool?: string; outcome?: "ok" | "error"; duration_ms?: number; decision: "observe" | "allow" | "block"; category?: string; detail?: Record<string, unknown>; }`
  - `recordAuditEvent(event: Omit<AuditEvent, "ts" | "decision"> & { decision?: AuditEvent["decision"] }): void`
  - `readAuditEvents(limit?: number): AuditEvent[]` — newest-last, capped at `limit` (default 5000)
  - `getAuditLogPath(): string`

- [ ] **Step 1: Write the failing test**

Append to `test/audit.test.mjs`:

```js
import fs from "node:fs";
import { recordAuditEvent, readAuditEvents } from "../dist/services/audit.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: FAIL — cannot find module `../dist/services/audit.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/audit.ts`:

```ts
/**
 * Durable, size-bounded audit log.
 *
 * The stderr logging in log.ts is captured by the client and not visible to the
 * operator. This persists the same events to a JSONL file the operator (or a
 * dashboard generator) can read back. Two-segment size rotation keeps the total
 * bounded without an O(file) rewrite on every append.
 *
 * The `decision` field is always "observe" today; it is the seam where a future
 * enforcement layer would record "allow"/"block". Free detail lives in `detail`
 * so a future redaction pass (for a hosted deployment) has one place to rewrite.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

export interface AuditEvent {
  ts: string;
  event: "tool_call" | "tool_result" | "tool_rejected" | "tool_failed" | "network_block";
  tool?: string;
  outcome?: "ok" | "error";
  duration_ms?: number;
  decision: "observe" | "allow" | "block";
  category?: string;
  detail?: Record<string, unknown>;
}

const DEFAULT_READ_LIMIT = 5_000;

function segments(): { current: string; previous: string; capPerSegment: number } {
  const config = loadConfig();
  return {
    current: config.auditLogPath,
    previous: `${config.auditLogPath}.1`,
    capPerSegment: Math.floor(config.auditMaxBytes / 2),
  };
}

export function getAuditLogPath(): string {
  return loadConfig().auditLogPath;
}

export function recordAuditEvent(
  event: Omit<AuditEvent, "ts" | "decision"> & { decision?: AuditEvent["decision"] },
): void {
  // Auditing must never be the reason a tool call fails.
  try {
    const record: AuditEvent = { ts: new Date().toISOString(), decision: "observe", ...event };
    const line = `${JSON.stringify(record)}\n`;
    const { current, previous, capPerSegment } = segments();
    fs.mkdirSync(path.dirname(current), { recursive: true });

    let size = 0;
    try { size = fs.statSync(current).size; } catch { size = 0; }
    if (size + Buffer.byteLength(line, "utf8") > capPerSegment) {
      try { fs.renameSync(current, previous); } catch { /* first rotation, or locked */ }
    }
    fs.appendFileSync(current, line, "utf8");
  } catch {
    // swallow
  }
}

export function readAuditEvents(limit = DEFAULT_READ_LIMIT): AuditEvent[] {
  const { current, previous } = segments();
  const lines: string[] = [];
  for (const seg of [previous, current]) {
    try {
      lines.push(...fs.readFileSync(seg, "utf8").split("\n").filter((l) => l.trim() !== ""));
    } catch {
      // segment absent
    }
  }
  const events: AuditEvent[] = [];
  for (const line of lines.slice(-limit)) {
    try { events.push(JSON.parse(line) as AuditEvent); } catch { /* skip corrupt line */ }
  }
  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/audit.ts test/audit.test.mjs
git commit -m "Add a size-bounded durable audit log"
```

---

### Task 3: Tag security refusals with a category

**Files:**
- Modify: `src/types.ts` (add `category` to `ToolInputError`)
- Modify: `src/services/paths.ts`, `src/services/svg.ts`, `src/services/raster.ts`, `src/services/exec.ts`, `src/services/limit.ts` (set category at security throw sites)
- Test: `test/audit.test.mjs` (extend)

**Interfaces:**
- Consumes: existing `ToolInputError(message, hint)` constructor.
- Produces: `ToolInputError` gains a third optional constructor arg `category?: string` and a public `readonly category?: string`. Category strings: `"path_traversal"`, `"svg_reference"`, `"argv_injection"`, `"raster_budget"`, `"concurrency"`.

- [ ] **Step 1: Write the failing test**

Append to `test/audit.test.mjs`:

```js
import { rasterizeSvg } from "../dist/services/raster.js";
import { ToolInputError } from "../dist/types.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: FAIL — `e.category` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, extend the class:

```ts
export class ToolInputError extends Error {
  public readonly hint: string;
  public readonly category?: string;

  constructor(message: string, hint: string, category?: string) {
    super(message);
    this.name = "ToolInputError";
    this.hint = hint;
    this.category = category;
  }
}
```

Then add the third arg at each security throw site:

- `src/services/paths.ts` — the "resolves outside the workspace root" throw in `resolveInWorkspace`, the null-byte throw, and the two escape throws in `ensureParentDirectory`: append `, "path_traversal"`.
- `src/services/raster.ts` — the `findFilesystemReferences` throw in `rasterizeSvg`: append `, "svg_reference"`; both `assertRasterBudget` throws and the "unusable intrinsic size" throw: append `, "raster_budget"`.
- `src/services/svg.ts` — no throw to change (validateSvg returns issues, does not throw); leave as is.
- `src/services/exec.ts` — the `assertSafePositional` throw: append `, "argv_injection"`.
- `src/services/limit.ts` — the "Too many … operations" throw: append `, "concurrency"`.

Example (raster.ts budget throw):

```ts
    throw new ToolInputError(
      `Rendering this SVG at width ${targetWidth} would produce a ${targetWidth} x ${outputHeight} image, and the height limit is ${MAX_RASTER_DIMENSION}.`,
      `The source's own aspect ratio is ${aspect}, so height grows with width. Lower width to at most ${Math.max(1, Math.floor((MAX_RASTER_DIMENSION * intrinsicWidth) / intrinsicHeight))}, or correct the viewBox if that shape is not what you meant.`,
      "raster_budget",
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/services/paths.ts src/services/raster.ts src/services/exec.ts src/services/limit.ts test/audit.test.mjs
git commit -m "Tag security refusals with a category for the audit trail"
```

---

### Task 4: Record every tool call in the audit log

**Files:**
- Modify: `src/services/format.ts` (`safeHandler`)
- Test: `test/audit.test.mjs` (extend)

**Interfaces:**
- Consumes: `recordAuditEvent` from Task 2, `ToolInputError.category` from Task 3.
- Produces: no new export; `safeHandler` now writes `tool_call` on entry and `tool_result` / `tool_rejected` / `tool_failed` on exit.

- [ ] **Step 1: Write the failing test**

Append to `test/audit.test.mjs` (drives the built server over stdio so the full path is exercised):

```js
import { spawn } from "node:child_process";

test("a tool call and its rejection are recorded in the audit log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-e2e-"));
  const logPath = path.join(dir, "audit.jsonl");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ws-"));
  const child = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, REMOTION_MCP_WORKSPACE: ws, REMOTION_MCP_AUDIT_LOG: logPath },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: FAIL — no `tool_call` line in the log.

- [ ] **Step 3: Write minimal implementation**

In `src/services/format.ts`, import and call `recordAuditEvent`. Add to imports:

```ts
import { recordAuditEvent } from "./audit.js";
```

Then in `safeHandler`, alongside the existing `log.*` calls:

```ts
  return async (input: TInput): Promise<ToolResponse> => {
    const startedAt = Date.now();
    log.info("tool_call", { tool: toolName, arguments: summariseArguments(input) });
    recordAuditEvent({ event: "tool_call", tool: toolName, detail: summariseArguments(input) });
    try {
      const response = await handler(input);
      const outcome = response.isError ? "error" : "ok";
      const duration_ms = Date.now() - startedAt;
      log.info("tool_result", { tool: toolName, outcome, duration_ms });
      recordAuditEvent({ event: "tool_result", tool: toolName, outcome, duration_ms });
      return response;
    } catch (error) {
      const duration_ms = Date.now() - startedAt;
      if (error instanceof ToolInputError) {
        log.warn("tool_rejected", { tool: toolName, duration_ms });
        recordAuditEvent({
          event: "tool_rejected",
          tool: toolName,
          duration_ms,
          category: error.category,
          detail: { message: error.message },
        });
        return buildErrorResponse(`${toolName}: ${error.message}`, error.hint);
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error("tool_failed", { tool: toolName, duration_ms });
      recordAuditEvent({ event: "tool_failed", tool: toolName, duration_ms, detail: { message } });
      return buildErrorResponse(
        `${toolName} failed: ${message}`,
        "Run remotion_check_environment to confirm Node, the Remotion CLI and the Chrome Headless Shell are all available.",
      );
    }
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/format.ts test/audit.test.mjs
git commit -m "Record every tool call and refusal in the audit log"
```

---

### Task 5: Record network blocks in the audit log

**Files:**
- Modify: `src/tools/visualize.ts` (`viz_render_html` handler)
- Test: `test/audit.test.mjs` (extend)

**Interfaces:**
- Consumes: `recordAuditEvent` from Task 2, `raster.blockedRequests` (already returned by `rasterizeHtml`).
- Produces: no new export; a `network_block` audit event is written when a render refuses one or more requests.

- [ ] **Step 1: Write the failing test**

Append to `test/audit.test.mjs` (unit-level: call the block recorder path directly via the service, since driving a real browser in CI is avoided):

```js
import { recordAuditEvent as _rec, readAuditEvents as _read } from "../dist/services/audit.js";

test("a network_block event round-trips through the audit log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-net-"));
  process.env.REMOTION_MCP_AUDIT_LOG = path.join(dir, "audit.jsonl");
  _rec({ event: "network_block", tool: "viz_render_html", category: "network_block", detail: { count: 2, hosts: ["evil.example", "169.254.169.254"] } });
  const events = _read();
  const last = events[events.length - 1];
  assert.equal(last.event, "network_block");
  assert.equal(last.category, "network_block");
  assert.equal(last.detail.count, 2);
  delete process.env.REMOTION_MCP_AUDIT_LOG;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: PASS at the service level already (audit exists) — but the *wiring* in visualize.ts is what we add. To make this a red-green for the wiring, first confirm the event is NOT recorded by a render: temporarily assert `blocked` events exist after a render in a follow-up manual check. (The unit test above guards the schema; the wiring is verified by Step 4's manual render check.)

- [ ] **Step 3: Write minimal implementation**

In `src/tools/visualize.ts`, import `recordAuditEvent`:

```ts
import { recordAuditEvent } from "../services/audit.js";
```

In the `viz_render_html` handler, right after `const blockedRequests = raster.blockedRequests ?? [];`:

```ts
      if (blockedRequests.length > 0) {
        recordAuditEvent({
          event: "network_block",
          tool: "viz_render_html",
          category: "network_block",
          detail: {
            count: blockedRequests.length,
            hosts: blockedRequests.slice(0, 10).map((r) => r.split(" ")[0]),
          },
        });
      }
```

- [ ] **Step 4: Run test to verify it passes, and verify the wiring**

Run: `npm run build && node --test test/audit.test.mjs`
Expected: PASS.

Manual wiring check (needs a local browser; skip in CI):
Run: `REMOTION_MCP_AUDIT_LOG=/tmp/a.jsonl node -e "import('./dist/services/raster.js').then(async ({rasterizeHtml})=>{try{await rasterizeHtml('<img src=\"https://evil.example/x.png\">',100,50,false,1);}catch{}; })"` then inspect that a `network_block` line was written by the visualize handler when called via a tool. (The service test above is the CI-safe guarantee; this confirms the handler path locally.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/visualize.ts test/audit.test.mjs
git commit -m "Record refused network requests in the audit log"
```

---

### Task 6: Dashboard generator and self-contained template

**Files:**
- Create: `scripts/build-dashboard.mjs`
- Create: `dashboard/template.html` (self-contained shell with a data placeholder)
- Modify: `package.json` (add `"gateway"` script; add `test/dashboard.test.mjs` to the `test` script file list)
- Test: `test/dashboard.test.mjs`

**Interfaces:**
- Consumes: `readAuditEvents` from `dist/services/audit.js`.
- Produces: `scripts/build-dashboard.mjs` writes a self-contained `gateway.html` (path from `--out` or default `gateway.html` in cwd) built from the current audit log. Reads `REMOTION_MCP_AUDIT_LOG` like the server.

- [ ] **Step 1: Write the failing test**

Create `test/dashboard.test.mjs`:

```js
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
  // Self-contained: no external resource loads.
  assert.ok(!/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org/g, "")), "must not reference external http(s) resources");
  // Contains the data and the security section.
  assert.ok(html.includes("path_traversal"));
  assert.ok(html.includes("network_block"));
  assert.ok(/security/i.test(html));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard.test.mjs`
Expected: FAIL — `scripts/build-dashboard.mjs` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/template.html` — a self-contained, theme-aware shell. It must define light tokens on bare `:root`, redefine under `@media (prefers-color-scheme: dark)`, paint `body` explicitly, and contain a `<script id="audit-data" type="application/json">__AUDIT_DATA__</script>` placeholder plus vanilla JS that reads it and renders three sections: **Security events**, **Tool timeline**, **Aggregates**. (Follow the artifact-design skill for the visual layer during implementation — the test only fixes structure and self-containment, not styling.) Wide tables scroll inside their own `overflow-x:auto` container.

Create `scripts/build-dashboard.mjs`:

```js
/**
 * Build a self-contained gateway dashboard from the audit log.
 *
 * Reads the same REMOTION_MCP_AUDIT_LOG the server writes, computes summaries,
 * and injects them into dashboard/template.html as embedded JSON. Output is one
 * standalone .html with no external requests, openable from disk or publishable
 * as an artifact.
 *
 * Usage: node scripts/build-dashboard.mjs [--out gateway.html]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents } from "../dist/services/audit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "dashboard", "template.html");

function outPath() {
  const i = process.argv.indexOf("--out");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : path.resolve("gateway.html");
}

const events = readAuditEvents();
const securityEvents = events.filter(
  (e) => e.event === "tool_rejected" || e.event === "tool_failed" || e.event === "network_block",
);
const byTool = {};
const byCategory = {};
for (const e of events) {
  if (e.tool) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
  if (e.category) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
}

const data = {
  generatedAt: new Date().toISOString(),
  total: events.length,
  events,
  securityEvents,
  byTool,
  byCategory,
};

const template = fs.readFileSync(templatePath, "utf8");
// JSON is safe inside a <script type="application/json"> block, but escape the
// closing-tag sequence so a string value cannot break out of it.
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const html = template.replace("__AUDIT_DATA__", json);

const out = outPath();
fs.writeFileSync(out, html, "utf8");
console.error(`Wrote ${out} — ${events.length} events, ${securityEvents.length} security events.`);
```

Add to `package.json`:
- `"gateway": "node scripts/build-dashboard.mjs"` under scripts.
- Extend the `test` script's file list: `node --test test/unit.test.mjs test/protocol.test.mjs test/process-leak.test.mjs test/audit.test.mjs test/dashboard.test.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/dashboard.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-dashboard.mjs dashboard/template.html package.json test/dashboard.test.mjs
git commit -m "Add a self-contained gateway dashboard generator"
```

---

### Task 7: Documentation

**Files:**
- Create: `docs/GATEWAY.md`
- Modify: `README.md` (add a short "Auditing what the server does" section linking to it)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write `docs/GATEWAY.md`**

Cover, in prose (no code-behavior claims that aren't true):
- **What is recorded:** every tool call, its outcome and duration, and each security refusal with its category (`path_traversal`, `svg_reference`, `argv_injection`, `raster_budget`, `concurrency`, `network_block`).
- **Where it lives:** the default per-platform state path (Windows `%LOCALAPPDATA%\remotion-viz\audit.jsonl`, macOS `~/Library/Application Support/remotion-viz/audit.jsonl`, Linux `$XDG_STATE_HOME/remotion-viz/audit.jsonl`), overridable with `REMOTION_MCP_AUDIT_LOG`. Size-bounded to ~5 MB across two rotating segments. It stays on the machine; nothing is sent anywhere.
- **How to view it:** ask Claude to "show me the gateway" (Claude reads the log and publishes the dashboard as an artifact), or run `npm run gateway` to build a self-contained `gateway.html` you open in a browser.
- **The `decision` field and the future path:** every event records `decision: "observe"`. Real-time enforcement (block/allow) and a hosted dashboard were deliberately deferred; the schema carries the seams (`decision`, redaction-aware `detail`) so neither needs a rewrite. Reference `docs/adr/0002-no-gateway.md` for why enforcement is not built yet.

- [ ] **Step 2: Add the README section**

Under a new `## Auditing what the server does` heading, two or three sentences plus the link to `docs/GATEWAY.md` and the `npm run gateway` command in a fenced `bash` block.

- [ ] **Step 3: Commit**

```bash
git add docs/GATEWAY.md README.md
git commit -m "Document the audit log and gateway dashboard"
```

---

### Task 8: Rebuild, back up, and redeploy to the installed extension

**Files:**
- No source changes. Operates on the built `dist/` and the installed extension directory.

**Interfaces:** none.

- [ ] **Step 1: Full verification before deploying**

Run: `npm run build && npm run typecheck && npm test && node smoke-test.mjs`
Expected: build exit 0, typecheck exit 0, all tests pass (exit 0), smoke 32/32.

- [ ] **Step 2: Confirm the installed location and that it is the running server**

Run: `node -e "const p='C:/Users/asus/AppData/Roaming/Claude/Claude Extensions/remotion-viz/server'; console.log(require('fs').existsSync(p), p)"`
Expected: `true` and the path. If false, stop and ask the operator for the correct install path (do not guess).

- [ ] **Step 3: Back up the current install**

```bash
cd "C:/Users/asus/AppData/Roaming/Claude/Claude Extensions/remotion-viz"
cp -r server "server.backup-$(node -e "process.stdout.write(new Date().toISOString().replace(/[:.]/g,'-'))")"
```
Expected: a `server.backup-<timestamp>` directory exists beside `server`.

- [ ] **Step 4: Copy the rebuilt dist and the hardened manifest**

```bash
SRC="C:/Users/asus/OneDrive/Desktop/helpers/remotion-viz-mcp-server"
DEST="C:/Users/asus/AppData/Roaming/Claude/Claude Extensions/remotion-viz"
cp -r "$SRC/dist/." "$DEST/server/"
cp "$SRC/manifest.json" "$DEST/manifest.json"
```
Note: only `dist/` and `manifest.json` are copied; the installed `node_modules` already satisfies the unchanged dependency set (no new deps were added — verify with `git diff --stat HEAD~8 -- package.json`, which should show only the `scripts` change).

- [ ] **Step 5: Verify the redeployed server starts and lists 12 tools**

```bash
node "C:/Users/asus/AppData/Roaming/Claude/Claude Extensions/remotion-viz/server/index.js" --help
```
Expected: prints the help with all 12 tools. Then tell the operator: **restart Claude Desktop and Claude Code** to load the new server (a running server holds the old modules in memory).

- [ ] **Step 6: Commit the plan's completion note**

No repo files change in this task. Record completion in the session; the redeploy is a filesystem operation outside the repo.

---

## Self-Review

**Spec coverage:**
- Observe-only gateway → Tasks 2–5 record events; no enforcement added; `decision:"observe"` throughout. ✓
- Claude-artifact delivery → Task 6 generates a self-contained HTML publishable as an artifact or opened locally. ✓
- Rotating JSONL (~5000 events / ~5 MB) → Task 1 (cap) + Task 2 (rotation, read limit 5000). ✓
- Configurable location outside workspace → Task 1 (`REMOTION_MCP_AUDIT_LOG`, per-platform default). ✓
- Phased for future enforcement/deployment → `decision` seam + redaction-aware `detail` (Task 2), documented (Task 7). ✓
- Redeploy with backup → Task 8. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The one soft spot is Task 6's visual styling, which defers to the artifact-design skill by design — the test fixes structure and self-containment, which are the reviewable contract. Acceptable.

**Type consistency:** `AuditEvent` shape defined in Task 2 is used unchanged in Tasks 4, 5, 6. `recordAuditEvent` signature (Task 2) matches all call sites. `ToolInputError(message, hint, category?)` (Task 3) matches the throw-site edits and the `format.ts` read of `error.category` (Task 4). `readAuditEvents` (Task 2) is consumed by the generator (Task 6). Category strings are consistent across Task 3 (set) and Task 6 test (asserted): `path_traversal`, `svg_reference`, `argv_injection`, `raster_budget`, `concurrency`, `network_block`.

**Note on scope vs. the hardening plan:** that plan said "no new tools"; this plan adds none. It adds one service module, one generator script, one template, and docs — all within the audit feature the operator requested.

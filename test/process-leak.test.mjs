/**
 * Process-lifecycle regression tests (T-6, T-7).
 *
 * These are Windows-specific in how they count processes, so they skip
 * elsewhere rather than assert something they cannot measure. Acceptance
 * criterion 3: no tool call leaves a process behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const isWindows = process.platform === "win32";

function chromeCount() {
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      "(Get-Process chrome -ErrorAction SilentlyContinue).Count",
    ], { encoding: "utf8" });
    return Number(out.trim() || 0);
  } catch {
    return 0;
  }
}

test("a blocking-script render leaves no chrome process behind", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const before = chromeCount();
  await assert.rejects(() => rasterizeHtml("<script>while(true){}</script>", 200, 100, false, 1));
  // Give the SIGKILL backstop a moment.
  await new Promise((r) => setTimeout(r, 4000));
  const after = chromeCount();
  assert.ok(after <= before, `chrome count grew: ${before} -> ${after}`);
});

test("a blocking render returns well under the old 181s in about 31s", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const start = Date.now();
  await assert.rejects(() => rasterizeHtml("<script>while(true){}</script>", 200, 100, false, 1));
  const elapsed = (Date.now() - start) / 1000;
  assert.ok(elapsed < 60, `took ${elapsed}s, expected under 60`);
});

test("concurrent renders do not launch one browser each", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const before = chromeCount();
  let peak = before;
  let polling = true;
  (async () => {
    while (polling) { const c = chromeCount(); if (c > peak) peak = c; await new Promise((r) => setTimeout(r, 500)); }
  })();
  const html = '<div style="background:#0af;width:200px;height:100px"></div>';
  await Promise.all(Array.from({ length: 5 }, () => rasterizeHtml(html, 400, 200, false, 1).catch(() => null)));
  polling = false;
  // With a one-at-a-time limiter, five calls never hold five browsers. Each
  // browser is ~9 processes, so a per-call launch would peak near +45.
  assert.ok(peak - before < 20, `peak was +${peak - before}, expected the limiter to hold it well below five browsers`);
});

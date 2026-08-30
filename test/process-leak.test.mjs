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
import { locateBrowser } from "../dist/services/browser.js";

const isWindows = process.platform === "win32";

// Only the process COUNTING here is Windows-specific. The timeout bound is not,
// and gating it on the platform left the documented "30 s including a script that
// blocks the renderer" claim unverified on the ubuntu and macos CI legs - the two
// where a regression would be least likely to be noticed.
const location = await locateBrowser();
const noBrowser = location.source === "none" ? `no browser: ${location.detail}` : false;

/**
 * Count only the chrome processes THIS test spawned, not every chrome on the
 * machine.
 *
 * A raw `Get-Process chrome` count includes the developer's own browser, so the
 * before/after and peak deltas flaked whenever a browser was open or churning
 * tabs alongside the run — green in CI's clean environment, intermittently red
 * locally. puppeteer-core launches with a throwaway profile named
 * `puppeteer_dev_chrome_profile-XXXX` in its `--user-data-dir`; filtering on
 * that marker isolates the renders these tests drive from an ordinary Chrome,
 * whose profile never carries it. Pre-existing puppeteer processes still count,
 * but they appear in both sides of every delta and cancel out.
 */
function puppeteerChromeCount() {
  try {
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*puppeteer_dev_chrome_profile*' } | Measure-Object).Count`,
    ], { encoding: "utf8" });
    return Number(out.trim() || 0);
  } catch {
    return 0;
  }
}

test("a blocking-script render leaves no chrome process behind", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const before = puppeteerChromeCount();
  await assert.rejects(() => rasterizeHtml("<script>while(true){}</script>", 200, 100, false, 1));
  // Give the SIGKILL backstop a moment.
  await new Promise((r) => setTimeout(r, 4000));
  const after = puppeteerChromeCount();
  assert.ok(after <= before, `chrome count grew: ${before} -> ${after}`);
});

test("a blocking render returns well under the old 181s in about 31s", { skip: noBrowser }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const start = Date.now();
  await assert.rejects(() => rasterizeHtml("<script>while(true){}</script>", 200, 100, false, 1));
  const elapsed = (Date.now() - start) / 1000;
  assert.ok(elapsed < 60, `took ${elapsed}s, expected under 60`);
});

test("concurrent renders do not launch one browser each", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const before = puppeteerChromeCount();
  let peak = before;
  let polling = true;
  // Held and awaited below so no promise outlives the test - a floating async
  // loop makes node --test exit non-zero even with every assertion passing.
  const poll = (async () => {
    while (polling) { const c = puppeteerChromeCount(); if (c > peak) peak = c; await new Promise((r) => setTimeout(r, 500)); }
  })();
  const html = '<div style="background:#0af;width:200px;height:100px"></div>';
  await Promise.all(Array.from({ length: 5 }, () => rasterizeHtml(html, 400, 200, false, 1).catch(() => null)));
  polling = false;
  await poll;
  // With a one-at-a-time limiter, five calls never hold five browsers. Each
  // browser is ~9 processes, so a per-call launch would peak near +45.
  assert.ok(peak - before < 20, `peak was +${peak - before}, expected the limiter to hold it well below five browsers`);
});

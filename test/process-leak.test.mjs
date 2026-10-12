// Process-lifecycle tests: no render leaves a browser process behind or runs unbounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { locateBrowser } from "../dist/services/browser.js";

const isWindows = process.platform === "win32";

// Process counting is Windows-only; the timeout bound runs on every platform with a browser.
const location = await locateBrowser();
const noBrowser = location.source === "none" ? `no browser: ${location.detail}` : false;

// Counts only puppeteer-launched chrome (by its profile dir), ignoring the user's own browser.
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

// Upper bound so a leaked process fails the test instead of hanging it.
const REAP_TIMEOUT_MS = 15_000;

// Polls until renderers are reaped down to `target` or the deadline passes; returns the last count.
async function awaitChromeCountAtMost(target, timeoutMs = REAP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let count = puppeteerChromeCount();
  while (count > target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    count = puppeteerChromeCount();
  }
  return count;
}

test("a blocking-script render leaves no chrome process behind", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const before = puppeteerChromeCount();
  await assert.rejects(() => rasterizeHtml("<script>while(true){}</script>", 200, 100, false, 1));
  const after = await awaitChromeCountAtMost(before);
  assert.ok(
    after <= before,
    `chrome count grew: ${before} -> ${after}, and was still there ${REAP_TIMEOUT_MS / 1000}s after `
    + `the render rejected. The SIGKILL backstop in rasterizeHtml's finally block did not clear them.`,
  );
});

// Allowance for browser launch plus teardown on a slow, contended machine.
const LAUNCH_TEARDOWN_ALLOWANCE_S = 45;

test("a wedged renderer is bounded by the page deadline, not puppeteer's default", { skip: noBrowser }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const { loadConfig } = await import("../dist/config.js");

  // Derived from config because CI may raise REMOTION_MCP_PAGE_TIMEOUT_MS.
  const budgetS = loadConfig().pageLoadTimeoutMs / 1000;
  const bound = budgetS + LAUNCH_TEARDOWN_ALLOWANCE_S;

  const start = Date.now();
  await assert.rejects(() => rasterizeHtml("<script>while(true){}</script>", 200, 100, false, 1));
  const elapsed = (Date.now() - start) / 1000;

  assert.ok(
    elapsed < bound,
    `took ${elapsed}s, expected under ${bound}s (${budgetS}s deadline + ${LAUNCH_TEARDOWN_ALLOWANCE_S}s launch/teardown allowance)`,
  );
});

test("concurrent renders do not launch one browser each", { skip: !isWindows }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const before = puppeteerChromeCount();
  let peak = before;
  let polling = true;
  // Awaited below; a floating async loop makes node --test exit non-zero.
  const poll = (async () => {
    while (polling) { const c = puppeteerChromeCount(); if (c > peak) peak = c; await new Promise((r) => setTimeout(r, 500)); }
  })();
  const html = '<div style="background:#0af;width:200px;height:100px"></div>';
  await Promise.all(Array.from({ length: 5 }, () => rasterizeHtml(html, 400, 200, false, 1).catch(() => null)));
  polling = false;
  await poll;
  // Each browser is ~9 processes, so a per-call launch would peak near +45.
  assert.ok(peak - before < 20, `peak was +${peak - before}, expected the limiter to hold it well below five browsers`);
});

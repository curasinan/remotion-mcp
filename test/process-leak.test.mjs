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

// Generous on purpose. The normal case clears in a fraction of this; the cap
// exists so a genuinely leaked process still fails the test rather than hanging
// it, not as an estimate of how long reaping takes.
const REAP_TIMEOUT_MS = 15_000;

/**
 * Poll until the OS has reaped the chrome processes down to `target`, or the
 * deadline passes. Returns the last count either way, so the caller asserts on
 * a real number rather than on whether the wait happened to be long enough.
 *
 * Why polling and not a fixed wait: by the time rasterizeHtml() rejects, its
 * `finally` has already raced browser.close() for 5 s and then sent SIGKILL, so
 * what remains is a post-kill reap, not a race with close(). But SIGKILL goes to
 * the top-level chrome.exe only. Its renderer children inherit the
 * `--user-data-dir` this counter filters on, so they keep being counted until
 * the OS tears them down after their parent dies - and on a contended runner
 * that is not instant. A fixed 4 s was a guess at how long that takes on a
 * machine we do not control.
 */
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

// Browser launch plus teardown, on a cold and contended machine. Measured at
// ~20 s on the slowest observed CI runner; doubled for headroom.
const LAUNCH_TEARDOWN_ALLOWANCE_S = 45;

test("a wedged renderer is bounded by the page deadline, not puppeteer's default", { skip: noBrowser }, async () => {
  const { rasterizeHtml } = await import("../dist/services/raster.js");
  const { loadConfig } = await import("../dist/config.js");

  // Derived, not hardcoded. CI raises REMOTION_MCP_PAGE_TIMEOUT_MS on contended
  // runners, and a fixed bound would then fail for a reason that has nothing to
  // do with the behaviour under test. What is asserted is the relationship: a
  // renderer that never yields is bounded by OUR deadline. Before that deadline
  // existed it was bounded only by puppeteer's 180 s protocolTimeout default,
  // and a page containing while(true){} held the tool for 181 s.
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

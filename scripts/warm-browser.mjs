/**
 * Pay the browser's first-launch cost before anything is being timed.
 *
 * On a fresh macOS runner the first launch of /Applications/Google Chrome.app
 * costs roughly 100 seconds - Gatekeeper verifies a large signed app bundle -
 * while every launch after it costs about two. Measured on macos-latest with
 * node 20 on 2026-08-31:
 *
 *   test 15  renders HTML to a real PNG   101,077 ms   <- first
 *   test 16  device_scale_factor            4,589 ms
 *   test 17  a page whose script throws     1,656 ms
 *   test 21  full_page                      3,700 ms
 *
 * That is a one-time operating-system cost, not a rendering cost, so it has no
 * business inside the render deadline. Raising the deadline until it fits would
 * leave a bound that no longer bounds anything - which is how the deadline got
 * to 180 s the first time.
 *
 * Deliberately best-effort: this is a warm-up, not a gate. If no browser is
 * found, or the launch fails, the tests that need one report that themselves
 * and with a better message than this script could.
 */
import { spawnSync } from "node:child_process";

import { locateBrowser } from "../dist/services/browser.js";

const location = await locateBrowser();

if (!location.executablePath) {
  console.log(`warm-browser: no browser to warm (${location.detail}); continuing.`);
  process.exit(0);
}

console.log(`warm-browser: launching ${location.executablePath}`);
const started = Date.now();

// --dump-dom renders about:blank and exits, which is the shortest path that
// still forces the full process launch. shell:false for the same reason every
// other spawn in this project sets it.
const result = spawnSync(
  location.executablePath,
  ["--headless", "--disable-gpu", "--no-sandbox", "--dump-dom", "about:blank"],
  { shell: false, timeout: 300_000, stdio: "ignore" },
);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (result.error) {
  console.log(`warm-browser: launch failed after ${elapsed}s (${result.error.message}); continuing.`);
  process.exit(0);
}

console.log(`warm-browser: warmed in ${elapsed}s (exit ${result.status}).`);

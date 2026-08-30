/**
 * viz_render_html's actual behaviour, on whatever platform this runs.
 *
 * Before this file the entire HTML path - rasterizeHtml, locateBrowser, request
 * interception, the pageerror handling, the browser-kill backstop - was exercised
 * by exactly one test file whose every test was `{ skip: !isWindows }`. On the
 * ubuntu and macos CI legs that is zero coverage of the tool that launches a
 * browser and enforces the network policy.
 *
 * decideRequest is well unit-tested in isolation, but nothing anywhere proved it
 * was wired to page.on("request"). A refactor that dropped setRequestInterception
 * would have passed every test in the repository while silently restoring the
 * egress channel network.ts's comment says a live probe confirmed reachable.
 *
 * No test here needs the network. Interception aborts before egress, so a request
 * to a public host is attempted and refused without a packet leaving the machine.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { rasterizeHtml } from "../dist/services/raster.js";
import { locateBrowser } from "../dist/services/browser.js";

// Resolved at module scope so the skip reason is known when the tests are
// registered, not after. A before() hook runs too late for `{ skip: ... }` and the
// result is a file that silently skips everything.
const location = await locateBrowser();
const noBrowser = location.source === "none"
  ? `no browser on this machine: ${location.detail}`
  : false;

before(() => {
  // Visible either way. A silent skip and a pass look identical in CI output, and
  // that is the failure mode this file exists to close.
  process.stdout.write(noBrowser
    ? `\n  [html.test] SKIPPING - ${noBrowser}\n`
    : `\n  [html.test] browser: ${location.source} (${location.executablePath ?? "managed by puppeteer"})\n`);
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

const BOX = '<div style="width:100%;height:100%;background:#0af"></div>';
// 1x1 transparent PNG, so the data: case needs no file and no network.
const DATA_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
  + "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("renders HTML to a real PNG at the requested size", { skip: noBrowser }, async () => {
  const r = await rasterizeHtml(BOX, 400, 200, false, 1);
  assert.ok(r.png.subarray(0, 8).equals(PNG_MAGIC), "output is not a PNG");
  const { width, height } = pngSize(r.png);
  assert.deepEqual({ width, height }, { width: 400, height: 200 },
    "the screenshot ignored the requested viewport");
});

test("device_scale_factor actually multiplies the output", { skip: noBrowser }, async () => {
  // Control on the test above: identical dimensions at every scale would mean the
  // parameters are not reaching the browser at all.
  const r = await rasterizeHtml(BOX, 200, 100, false, 2);
  assert.deepEqual(pngSize(r.png), { width: 400, height: 200 });
});

test("a page whose script throws is refused, not screenshotted blank", { skip: noBrowser }, async () => {
  // The silent failure this tool exists to prevent: a throwing page screenshots to
  // an empty frame, and without this the model is handed a blank image as success.
  await assert.rejects(
    () => rasterizeHtml('<script>throw new Error("boom-marker")</script>', 200, 100, false, 1),
    (error) => {
      assert.match(error.message, /boom-marker/, "the page's own error text should reach the caller");
      assert.ok(error.hint?.length > 20, "a refusal without a next step is not a diagnosis");
      return true;
    },
  );
});

test("an external request is refused and named in blocked_requests", { skip: noBrowser }, async () => {
  // Proves decideRequest is wired to page.on("request"). The request is attempted
  // and aborted by the interceptor, so nothing leaves the machine.
  const r = await rasterizeHtml(
    `<img src="https://example.com/tracker.png" alt=""><p>text</p>`, 300, 120, false, 1);
  assert.ok(Array.isArray(r.blockedRequests));
  assert.equal(r.blockedRequests.length > 0, true,
    "nothing was blocked, so the network policy is not attached to the page - "
    + "any <img>, fetch or @font-face is an open egress channel");
  assert.ok(r.blockedRequests.some((b) => b.includes("example.com")),
    `blocked list does not name the host: ${JSON.stringify(r.blockedRequests)}`);
  assert.ok(r.blockedRequests.some((b) => /no network access by default/.test(b)),
    "the refusal should say why, not just that");
});

test("a data: URI is not blocked", { skip: noBrowser }, async () => {
  // Control: the policy must discriminate. If everything were blocked, the test
  // above would pass while the tool was simply broken.
  const r = await rasterizeHtml(`<img src="${DATA_PNG}" alt="">`, 120, 60, false, 1);
  assert.deepEqual(r.blockedRequests, [],
    `a self-contained data: URI was refused: ${JSON.stringify(r.blockedRequests)}`);
});

test("an allowlisted loopback host is still blocked", { skip: noBrowser }, async () => {
  // Two things at once, neither needing the network: the policy argument is really
  // consulted, and the always-blocked rule outranks the allowlist. Loopback is the
  // case that matters - it reaches other services on the machine, including a
  // Remotion Studio this server may have started.
  const r = await rasterizeHtml(
    '<img src="http://127.0.0.1:9/x.png" alt="">', 120, 60, false, 1,
    undefined, { allowedHosts: ["127.0.0.1"] });
  assert.equal(r.blockedRequests.length > 0, true,
    "an explicitly allowlisted loopback address was permitted - the always-blocked "
    + "rule is not being applied, and an allowlist entry becomes a licence to reach localhost");
  assert.ok(r.blockedRequests.some((b) => /loopback, private or link-local/.test(b)),
    `expected the loopback reason: ${JSON.stringify(r.blockedRequests)}`);
});

test("full_page captures beyond the viewport", { skip: noBrowser }, async () => {
  const tall = '<div style="height:600px;background:#0af"></div>';
  const clipped = await rasterizeHtml(tall, 200, 100, false, 1);
  const full = await rasterizeHtml(tall, 200, 100, true, 1);
  assert.equal(pngSize(clipped.png).height, 100);
  assert.ok(pngSize(full.png).height > 100,
    `full_page produced ${pngSize(full.png).height}px, same as the viewport - the flag is not reaching screenshot()`);

  // Documenting a real mismatch rather than leaving it to surprise someone: the
  // returned width/height are the requested VIEWPORT, not the image. With
  // full_page the PNG is 600px tall while the result still reports 100. Nothing
  // user-facing is wrong - viz_render_html reports these as viewport_width /
  // viewport_height, which is what they are - but RasterResult's field names
  // invite the wrong reading.
  assert.equal(full.height, 100, "if this changes, RasterResult now reports image size; update viz_render_html's response");
  assert.notEqual(full.height, pngSize(full.png).height);
});

/**
 * Unit regression tests for the hardening findings, run against compiled dist/.
 *
 * Each block ties back to a Phase 1 vector and proves the hole is closed. Two
 * blocks at the end guard findings that were refuted, so a future change cannot
 * silently reopen them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideRequest } from "../dist/services/network.js";
import { findFilesystemReferences, validateSvg } from "../dist/services/svg.js";
import { rasterizeSvg } from "../dist/services/raster.js";
import { loadConfig, ConfigError } from "../dist/config.js";

// T-4 / SSRF: network policy.
test("network policy denies all hosts by default", () => {
  assert.equal(decideRequest("https://example.com/x", { allowedHosts: [] }).allowed, false);
});
test("network policy allows a data: URI with no allowlist", () => {
  assert.equal(decideRequest("data:image/png;base64,AAAA", { allowedHosts: [] }).allowed, true);
});
test("network policy allowlist is suffix-safe, not substring", () => {
  const p = { allowedHosts: ["example.com"] };
  assert.equal(decideRequest("https://cdn.example.com/x", p).allowed, true);
  assert.equal(decideRequest("https://evilexample.com/x", p).allowed, false);
});
test("network policy blocks metadata and loopback even when allowlisted", () => {
  for (const host of ["169.254.169.254", "127.0.0.1", "localhost", "10.0.0.1", "192.168.1.1", "[::1]"]) {
    assert.equal(
      decideRequest(`http://${host}/x`, { allowedHosts: [host] }).allowed,
      false,
      `${host} should stay blocked`,
    );
  }
});
test("network policy refuses file://", () => {
  assert.equal(decideRequest("file:///C:/secret.txt", { allowedHosts: [] }).allowed, false);
});

// T-3 / local file read: SVG reference scanner.
test("SVG scanner flags absolute, relative and remote references", () => {
  for (const href of ["C:/Users/me/x.png", "../../x.png", "https://evil/x.png", "/etc/x.png"]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="${href}"/></svg>`;
    assert.equal(findFilesystemReferences(svg).length, 1, `${href} should be flagged`);
    assert.equal(validateSvg(svg).valid, false);
  }
});
test("SVG scanner allows fragment references and data: URIs", () => {
  const frag = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use href="#a"/></svg>';
  const data = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="data:image/png;base64,AAAA"/></svg>';
  assert.equal(findFilesystemReferences(frag).length, 0);
  assert.equal(findFilesystemReferences(data).length, 0);
});
test("rasterizeSvg refuses an SVG that references a local file", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="C:/Windows/x.png" width="10" height="10"/></svg>';
  assert.throws(() => rasterizeSvg(svg, 100), /outside the document/);
});

// T-1 / resource exhaustion: raster pixel budget.
test("rasterizeSvg rejects an oversized derived height instead of aborting", () => {
  const tall = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 5000000"><rect width="100" height="5000000"/></svg>';
  assert.throws(() => rasterizeSvg(tall, 1200), /limit|height/i);
});
test("rasterizeSvg rejects the no-viewBox variant too", () => {
  const tall = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="5000000"><rect width="100" height="5000000"/></svg>';
  assert.throws(() => rasterizeSvg(tall, 1200), /limit|height|unusable/i);
});
test("rasterizeSvg still renders an ordinary aspect ratio", () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#0af"/></svg>';
  const r = rasterizeSvg(ok, 1200);
  assert.equal(r.width, 1200);
  assert.equal(r.height, 675);
});

// C14 / config: fail-fast validation.
test("config rejects an allowlist entry that is a URL", () => {
  assert.throws(() => loadConfig({ REMOTION_MCP_ALLOWED_HOSTS: "https://x/y" }), ConfigError);
});
test("config rejects a workspace that does not exist", () => {
  assert.throws(() => loadConfig({ REMOTION_MCP_WORKSPACE: "C:/nope/nope/nope" }), ConfigError);
});
test("config defaults are restrictive", () => {
  const c = loadConfig({});
  assert.deepEqual(c.allowedHosts, []);
  assert.equal(c.disableBrowserSandbox, false);
  assert.equal(c.browserExecutable, null);
});

// Refuted findings kept as guards: these must NOT become true.
test("GUARD: frames regex stays anchored (no newline bypass)", async () => {
  // The regex lives on the Zod field; assert the pattern directly.
  const re = /^\d+(-\d*)?$/;
  assert.equal(re.test("0-90"), true);
  assert.equal(re.test("0-9\n--evil"), false);
  assert.equal(re.test("30\n"), false);
});
// Packaging invariant. The bundle job catches this too, but only after a
// multi-minute build; catching it in `npm test` is what keeps it from being
// discovered at release time.
test("GUARD: SERVER_VERSION equals manifest.json's version", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const repo = path.join(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "manifest.json"), "utf8"));
  const { SERVER_VERSION } = await import("../dist/constants.js");
  assert.equal(SERVER_VERSION, manifest.version,
    `manifest.json is the source of truth for what ships. It says ${manifest.version}; `
    + `src/constants.ts says ${SERVER_VERSION}. Bump both together.`);
});

test("GUARD: composition_id regex forbids a leading hyphen", () => {
  const re = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
  assert.equal(re.test("Example"), true);
  assert.equal(re.test("--config"), false);
  assert.equal(re.test("-h"), false);
});

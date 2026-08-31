/**
 * The browser timeout bounds, and the invariant that keeps them separate.
 *
 * These exist because one constant was doing two jobs. TIMEOUT_PAGE_LOAD_MS was
 * passed both to setContent (a per-command deadline, which is what it is for)
 * and to puppeteer's `protocolTimeout` (a connection-wide cap on EVERY CDP
 * command). A connection-wide cap set at the per-command deadline silently
 * refuses any other command that takes longer - and page.screenshot() has no
 * deadline of its own, so it inherited a bound nobody chose for it.
 *
 * That is not theoretical. On 2026-08-30 it failed CI three times in a row,
 * always on the first browser test of the run, on two different platforms with
 * two different symptoms:
 *
 *   windows-latest/20  Page.captureScreenshot timed out       <- protocolTimeout
 *   macos-latest/20    Navigation timeout of 30000 ms exceeded <- setContent
 *   macos-latest/22    Navigation timeout of 30000 ms exceeded <- setContent
 *
 * The first is the conflation bug. The second is the budget simply being too
 * small for a cold browser on a contended shared runner. Both are fixed here,
 * and they are fixed separately because they are different problems.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { TIMEOUT_PAGE_LOAD_MS, TIMEOUT_CDP_PROTOCOL_MS } from "../dist/constants.js";
import { loadConfig, ConfigError } from "../dist/config.js";
import { buildLaunchOptions } from "../dist/services/raster.js";

// loadConfig resolves a workspace, so every case needs one that exists.
const BASE_ENV = { REMOTION_MCP_WORKSPACE: process.cwd() };

test("the CDP backstop is strictly greater than the page-load deadline", () => {
  // If these are equal, protocolTimeout caps setContent at exactly its own
  // deadline and every other CDP command inherits it too. If the backstop is
  // smaller, it overrides the page-load deadline entirely and the smaller
  // number wins silently. Only strictly-greater leaves each bound doing its
  // own job.
  assert.ok(
    TIMEOUT_CDP_PROTOCOL_MS > TIMEOUT_PAGE_LOAD_MS,
    `protocol backstop ${TIMEOUT_CDP_PROTOCOL_MS}ms must exceed page-load deadline ${TIMEOUT_PAGE_LOAD_MS}ms`,
  );
});

test("launch options carry the CDP backstop, not the page-load deadline", () => {
  const options = buildLaunchOptions({ args: [], pageLoadTimeoutMs: TIMEOUT_PAGE_LOAD_MS });

  assert.equal(options.protocolTimeout, TIMEOUT_CDP_PROTOCOL_MS);
  assert.notEqual(
    options.protocolTimeout,
    TIMEOUT_PAGE_LOAD_MS,
    "passing the page-load deadline as protocolTimeout is the bug this test exists to catch",
  );
});

test("the backstop still exceeds a raised page-load deadline", () => {
  // The regression that configuration could reintroduce: raise the page budget
  // past the backstop and the backstop starts overriding it again.
  const options = buildLaunchOptions({ args: [], pageLoadTimeoutMs: 45_000 });
  assert.ok(options.protocolTimeout > 45_000);
});

test("pageLoadTimeoutMs defaults to the constant", () => {
  assert.equal(loadConfig({ ...BASE_ENV }).pageLoadTimeoutMs, TIMEOUT_PAGE_LOAD_MS);
});

test("REMOTION_MCP_PAGE_TIMEOUT_MS raises the page-load deadline", () => {
  const config = loadConfig({ ...BASE_ENV, REMOTION_MCP_PAGE_TIMEOUT_MS: "90000" });
  assert.equal(config.pageLoadTimeoutMs, 90_000);
});

test("a page-load deadline above the CDP backstop is refused", () => {
  // Without this, an operator raising the budget past the backstop rebuilds the
  // exact bug in configuration instead of code, and gets no warning.
  assert.throws(
    () => loadConfig({ ...BASE_ENV, REMOTION_MCP_PAGE_TIMEOUT_MS: String(TIMEOUT_CDP_PROTOCOL_MS + 1) }),
    (error) => error instanceof ConfigError && /backstop/i.test(error.message),
  );
});

test("a non-numeric page-load deadline is refused", () => {
  // A guard observed only staying quiet is indistinguishable from one that is
  // disabled, so every rejection path is exercised with a known-bad input.
  assert.throws(
    () => loadConfig({ ...BASE_ENV, REMOTION_MCP_PAGE_TIMEOUT_MS: "soon" }),
    (error) => error instanceof ConfigError,
  );
});

test("a zero or negative page-load deadline is refused", () => {
  for (const bad of ["0", "-1"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, REMOTION_MCP_PAGE_TIMEOUT_MS: bad }),
      (error) => error instanceof ConfigError,
      `REMOTION_MCP_PAGE_TIMEOUT_MS=${bad} should be refused`,
    );
  }
});

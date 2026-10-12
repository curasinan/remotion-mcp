// Page-load deadline and CDP protocolTimeout backstop must stay separate, with the backstop larger.
import test from "node:test";
import assert from "node:assert/strict";

import { TIMEOUT_PAGE_LOAD_MS, TIMEOUT_CDP_PROTOCOL_MS } from "../dist/constants.js";
import { loadConfig, ConfigError } from "../dist/config.js";
import { buildLaunchOptions } from "../dist/services/raster.js";

// loadConfig resolves a workspace, so every case needs one that exists.
const BASE_ENV = { REMOTION_MCP_WORKSPACE: process.cwd() };

test("the CDP backstop is strictly greater than the page-load deadline", () => {
  // Equal or smaller would let the connection-wide cap override the page-load deadline.
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
  // A raised page budget must not overtake the backstop.
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
  // Config must not be able to push the page budget past the backstop.
  assert.throws(
    () => loadConfig({ ...BASE_ENV, REMOTION_MCP_PAGE_TIMEOUT_MS: String(TIMEOUT_CDP_PROTOCOL_MS + 1) }),
    (error) => error instanceof ConfigError && /backstop/i.test(error.message),
  );
});

test("a non-numeric page-load deadline is refused", () => {
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

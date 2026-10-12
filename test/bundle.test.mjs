// Assertions on the built .mcpb artifact; REQUIRE_BUNDLE=1 makes a missing artifact a failure.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractZip, readEntry, readZipEntries } from "./zip-reader.mjs";

const REPO = path.join(import.meta.dirname, "..");
const REQUIRE_BUNDLE = process.env.REQUIRE_BUNDLE === "1";

// Platforms that must ship a native binary; copied from NATIVE_TARGETS so drift fails here.
const REQUIRED_NATIVE = [
  "@resvg/resvg-js-win32-x64-msvc",
  "@resvg/resvg-js-win32-arm64-msvc",
  "@resvg/resvg-js-darwin-x64",
  "@resvg/resvg-js-darwin-arm64",
  "@resvg/resvg-js-linux-x64-gnu",
  "@resvg/resvg-js-linux-arm64-gnu",
];

/** Which native package satisfies each manifest platform claim. */
const PLATFORM_BINARIES = {
  win32: ["@resvg/resvg-js-win32-x64-msvc", "@resvg/resvg-js-win32-arm64-msvc"],
  darwin: ["@resvg/resvg-js-darwin-x64", "@resvg/resvg-js-darwin-arm64"],
  linux: ["@resvg/resvg-js-linux-x64-gnu", "@resvg/resvg-js-linux-arm64-gnu",
    "@resvg/resvg-js-linux-x64-musl", "@resvg/resvg-js-linux-arm64-musl"],
};

// The zip reader is shared with scripts/verify-bundle-runtime.mjs.

// ------------------------------------------------------------------ fixture
let BUNDLE = null, ENTRIES = null, BUF = null, EXTRACTED = null, MANIFEST = null;

before(() => {
  const candidates = fs.readdirSync(REPO).filter((f) => f.endsWith(".mcpb")).sort();
  // No assertion here: a before() throw skips every test and exits 0; the gate test fails instead.
  if (candidates.length === 0) return;
  BUNDLE = path.join(REPO, candidates[candidates.length - 1]);
  BUF = fs.readFileSync(BUNDLE);
  ENTRIES = readZipEntries(BUF);
  MANIFEST = JSON.parse(readEntry(BUF, ENTRIES.find((e) => e.name === "manifest.json")).toString("utf8"));

  EXTRACTED = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-verify-"));
  extractZip(BUNDLE, EXTRACTED);
});

const skip = () => (BUNDLE ? false : "no .mcpb built (set REQUIRE_BUNDLE=1 to make this a failure)");
const has = (prefix) => ENTRIES.some((e) => e.name.startsWith(prefix));

// ------------------------------------------------------------------ assertions

// The gate: never skipped, so it fails when the build produced no artifact.
test("an artifact exists to verify", () => {
  if (BUNDLE) return;
  assert.equal(REQUIRE_BUNDLE, false,
    "REQUIRE_BUNDLE=1 but no .mcpb exists in the repo root. `npm run bundle` did not produce "
    + "an artifact — that is a build failure, not a reason to skip the verification.");
});

test("every declared platform ships a native binary", { skip: skip() }, () => {
  const missing = REQUIRED_NATIVE.filter(
    (t) => !ENTRIES.some((e) => e.name.startsWith(`node_modules/${t}/`) && e.name.endsWith(".node")),
  );
  assert.deepEqual(missing, [],
    `these platforms have no .node binary in the bundle, so it crashes on them with `
    + `"Failed to load native binding": ${missing.join(", ")}. `
    + `npm ci installs only the build host's platform; scripts/build-bundle.mjs must fetch the rest.`);

  // Positive control: a broken lookup reporting everything present would pass the check above.
  assert.equal(
    ENTRIES.some((e) => e.name.startsWith("node_modules/@resvg/resvg-js-nonexistent-platform/")),
    false,
    "the presence check matched a platform that cannot exist — the lookup is broken, not the bundle",
  );
});

test("manifest platform claims are backed by binaries", { skip: skip() }, () => {
  const unmet = [];
  for (const platform of MANIFEST.compatibility?.platforms ?? []) {
    const needed = PLATFORM_BINARIES[platform];
    if (!needed) { unmet.push(`${platform} (unknown platform in manifest)`); continue; }
    const present = needed.filter((t) => has(`node_modules/${t}/`));
    if (present.length === 0) unmet.push(`${platform} (none of ${needed.join(", ")})`);
  }
  assert.deepEqual(unmet, [], `manifest.json claims these platforms with no binary to back them: ${unmet.join("; ")}`);
});

test("the bundle ships exactly the intended resvg packages — no host-dependent extras", { skip: skip() }, () => {
  // npm installs resvg platform packages per build host, so assert the exact intended set.
  const present = new Set();
  for (const e of ENTRIES) {
    const m = /^node_modules\/(@resvg\/[^/]+)\//.exec(e.name);
    if (m) present.add(m[1]);
  }
  const expected = new Set(["@resvg/resvg-js", ...REQUIRED_NATIVE]);
  const unexpected = [...present].filter((p) => !expected.has(p)).sort();
  const missing = [...expected].filter((p) => !present.has(p)).sort();

  assert.deepEqual(unexpected, [],
    `resvg packages shipped that no decision put there: ${unexpected.join(", ")}. `
    + "These are what npm happened to install on the build host, not what NATIVE_TARGETS "
    + "chose - the shipped package set must not depend on where it was built. "
    + "scripts/build-bundle.mjs prunes to the allowlist after npm ci; check that step.");
  assert.deepEqual(missing, [],
    `intended resvg packages absent from the bundle: ${missing.join(", ")}.`);
});

test("no Bare-runtime packages ship", { skip: skip() }, () => {
  // Bare-runtime packages never load under Node; scan every node_modules level, including nested.
  const bare = new Set();
  for (const e of ENTRIES) {
    const m = /(?:^|\/)node_modules\/(bare-[^/]+)\//.exec(e.name);
    if (m) bare.add(m[1]);
  }
  assert.deepEqual([...bare].sort(), [],
    `Bare-runtime packages shipped: ${[...bare].sort().join(", ")}. Nothing can load these `
    + "under Node - they resolve only behind the \"bare\" imports-map condition - so they are "
    + "dead weight. scripts/build-bundle.mjs prunes them after npm ci; check that step.");

  // Positive control: the same scan shape must find tar-fs in the artifact.
  const control = new Set();
  for (const e of ENTRIES) {
    const m = /(?:^|\/)node_modules\/(tar-[^/]+)\//.exec(e.name);
    if (m) control.add(m[1]);
  }
  assert.ok(control.has("tar-fs"),
    "the component scan did not find tar-fs in the bundle. Either the scan shape no longer "
    + "matches real zip entry names (which makes the bare assertion above inert), or tar-fs "
    + "left the dependency tree - in which case update this control to another package that ships.");
});

test("the linux claim is either backed by musl binaries or documented as glibc-only", { skip: skip() }, () => {
  if (!(MANIFEST.compatibility?.platforms ?? []).includes("linux")) return;
  const musl = ["@resvg/resvg-js-linux-x64-musl", "@resvg/resvg-js-linux-arm64-musl"]
    .filter((t) => has(`node_modules/${t}/`));
  if (musl.length === 2) return;                     // claim is backed by the pair; nothing to document

  // A single musl binary without its sibling comes from the build host, not a decision.
  assert.deepEqual(musl, [],
    `a partial musl set shipped: ${musl.join(", ")}. Either both musl binaries are in `
    + "NATIVE_TARGETS (a decision) or neither is (the current decision) - one alone is "
    + "an accident of the build host.");

  // Only glibc ships because the host app has no musl build, so the docs must state it.
  const doc = fs.readFileSync(path.join(REPO, "docs", "BUNDLE.md"), "utf8");
  assert.match(doc, /glibc/i,
    'The bundle ships only glibc binaries but manifest.json claims "linux" unqualified, and '
    + "docs/BUNDLE.md does not mention the constraint. An Alpine or musl user gets "
    + '"Failed to load native binding" with none of this server\'s diagnostics firing. '
    + "Either document the glibc requirement, or enable the two musl entries in NATIVE_TARGETS.");
});

test("manifest version matches the compiled server version", { skip: skip() }, () => {
  const constants = readEntry(BUF, ENTRIES.find((e) => e.name === "server/constants.js")).toString("utf8");
  const serverVersion = /SERVER_VERSION\s*=\s*["']([^"']+)["']/.exec(constants)?.[1];
  assert.ok(serverVersion, "server/constants.js in the bundle does not export SERVER_VERSION");
  assert.equal(MANIFEST.version, serverVersion,
    `manifest says ${MANIFEST.version}, the bundled server reports ${serverVersion}. `
    + "A bug report would cite one and the running code would be the other. manifest.json is the source of truth.");
});

test("the bundled server starts and its tools match the manifest", { skip: skip() }, async () => {
  // Catches packaging gaps such as a runtime dependency left in devDependencies.
  const entry = path.join(EXTRACTED, "server", "index.js");
  assert.equal(fs.existsSync(entry), true, "server/index.js is missing from the bundle");

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-ws-"));
  const child = spawn("node", [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, REMOTION_MCP_WORKSPACE: ws, REMOTION_MCP_AUDIT_LOG: path.join(ws, "audit.jsonl"),
      REMOTION_MCP_STATE_DIR: path.join(ws, "state") },
  });
  let buf = "", stderr = "";
  const pending = new Map();
  let id = 1;
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); }
    }
  });
  child.stderr.on("data", (c) => { stderr += c; });
  const send = (method, params) => new Promise((res, rej) => {
    const i = id++; pending.set(i, res);
    const t = setTimeout(() => rej(new Error(`timeout on ${method}. server stderr:\n${stderr.slice(-800)}`)), 30_000);
    t.unref?.();
    pending.set(i, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });

  try {
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bundle-test", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const listed = await send("tools/list", {});
    const runtime = (listed.result?.tools ?? []).map((t) => t.name).sort();
    const declared = (MANIFEST.tools ?? []).map((t) => t.name).sort();

    assert.notEqual(runtime.length, 0, `the bundled server listed no tools. stderr:\n${stderr.slice(-800)}`);
    assert.deepEqual(runtime, declared,
      "manifest.json's tool list and the running server disagree. A tool present in code but absent "
      + "from the manifest ships invisible in Claude Desktop's permission UI; the reverse advertises "
      + `one that does not exist.\n  only in manifest: ${declared.filter((t) => !runtime.includes(t)).join(", ") || "(none)"}`
      + `\n  only at runtime:  ${runtime.filter((t) => !declared.includes(t)).join(", ") || "(none)"}`);

    // Positive control: prove the comparison discriminates.
    assert.notDeepEqual(runtime, [...declared, "a_tool_that_does_not_exist"],
      "the tool-list comparison passed against a deliberately wrong list — the assertion is inert");
  } finally {
    child.kill();
  }
});

test("no declared devDependency ships in the bundle", { skip: skip() }, () => {
  // Checks devDependencies the lockfile marks dev:true, i.e. reachable only at build time.
  const declared = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).devDependencies ?? {});
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  const buildTimeOnly = declared.filter((d) => lock.packages?.[`node_modules/${d}`]?.dev === true);
  assert.notEqual(buildTimeOnly.length, 0,
    "no devDependency resolved as build-time-only — the lockfile lookup is wrong, so this test is inert");

  const present = buildTimeOnly.filter((d) => has(`node_modules/${d}/`));
  assert.deepEqual(present, [], `build-time-only packages shipped to users: ${present.join(", ")}. `
    + "Check that scripts/build-bundle.mjs installs with --omit=dev.");

  // Positive control: the lookup must be able to find something that IS there.
  assert.equal(has("node_modules/@modelcontextprotocol/sdk/"), true,
    "the presence check found no MCP SDK — the lookup is broken, so the assertion above is inert");
});

test("the server ships no HTTP transport", { skip: skip() }, () => {
  // Checks server code only; the MCP SDK ships HTTP frameworks transitively.
  const serverFiles = ENTRIES.filter((e) => e.name.startsWith("server/") && e.name.endsWith(".js"));
  assert.notEqual(serverFiles.length, 0, "no server/*.js in the bundle");

  const offenders = serverFiles.filter((e) =>
    /MCP_TRANSPORT|StreamableHTTPServerTransport|SSEServerTransport/.test(readEntry(BUF, e).toString("utf8")));
  assert.deepEqual(offenders.map((e) => e.name), [],
    "the compiled server references an HTTP transport. ADR-1 removed it because this server spawns "
    + "child processes and executes workspace code, and exposing that over a network puts a bearer "
    + "token between the internet and a code-execution surface. Revisit the ADR before restoring it.");
  assert.equal(ENTRIES.some((e) => e.name.startsWith("server/transports/")), false,
    "server/transports/ is back in the bundle; see ADR-1.");
});

test("the bundle carries a lockfile for offline auditing", { skip: skip() }, () => {
  assert.equal(ENTRIES.some((e) => e.name === "node_modules/.package-lock.json"), true,
    "docs/BUNDLE.md tells users to answer \"am I affected by advisory X\" by reading "
    + "node_modules/.package-lock.json out of the zip. It is not there.");
});

test("the bundle is a plausible size", { skip: skip() }, () => {
  const mib = fs.statSync(BUNDLE).size / 1048576;
  assert.ok(mib > 5 && mib < 60, `bundle is ${mib.toFixed(1)} MiB, outside the expected 5-60 MiB range. `
    + "Under 5 MiB usually means the native binaries are missing; over 60 means something unintended was staged.");
});

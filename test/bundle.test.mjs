/**
 * Assertions about the distributable .mcpb.
 *
 * Not wired into `npm test` — these need an artifact that takes minutes to build.
 * Run with `npm run bundle && npm run test:bundle`.
 *
 * Set REQUIRE_BUNDLE=1 (CI does) to turn a missing artifact from a skip into a
 * failure. Without it a broken build step leaves every assertion skipped and the
 * job green, which is the same failure shape as the Windows-only process-leak
 * tests: a suite that cannot distinguish "passed" from "never ran".
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
const REQUIRE_BUNDLE = process.env.REQUIRE_BUNDLE === "1";

/**
 * Platforms that must have a native binary in the bundle.
 *
 * Deliberately duplicated from NATIVE_TARGETS in scripts/build-bundle.mjs rather
 * than imported. If the two drift, that is a change to which machines the bundle
 * works on, and it should fail here rather than be absorbed by a shared constant.
 */
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

// ------------------------------------------------------------------ zip reader
// Pure Node so the test does not depend on unzip/bsdtar being present and behaving
// the same on three platforms.
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, e) {
  if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) throw new Error(`corrupt local header for ${e.name}`);
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}

// ------------------------------------------------------------------ fixture
let BUNDLE = null, ENTRIES = null, BUF = null, EXTRACTED = null, MANIFEST = null;

before(() => {
  const candidates = fs.readdirSync(REPO).filter((f) => f.endsWith(".mcpb")).sort();
  // Deliberately no assertion here. A throw from a before() hook is printed but
  // leaves every test marked "skipped", and the runner then exits 0 because nothing
  // actually failed — a green job on a broken build, which is the exact shape
  // REQUIRE_BUNDLE exists to prevent. The gate is a real test instead; see below.
  if (candidates.length === 0) return;
  BUNDLE = path.join(REPO, candidates[candidates.length - 1]);
  BUF = fs.readFileSync(BUNDLE);
  ENTRIES = readZipEntries(BUF);
  MANIFEST = JSON.parse(readEntry(BUF, ENTRIES.find((e) => e.name === "manifest.json")).toString("utf8"));

  EXTRACTED = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-verify-"));
  for (const e of ENTRIES) {
    if (e.name.endsWith("/")) continue;
    const dest = path.join(EXTRACTED, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntry(BUF, e));
  }
});

const skip = () => (BUNDLE ? false : "no .mcpb built (set REQUIRE_BUNDLE=1 to make this a failure)");
const has = (prefix) => ENTRIES.some((e) => e.name.startsWith(prefix));

// ------------------------------------------------------------------ assertions

// The gate. Never skipped, so it is the one test that can carry a non-zero exit
// code when the build produced nothing. Everything below it skips without an
// artifact; this does not.
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

  // Positive control. Without this, the assertion above also passes if the lookup
  // is broken and reports everything as present.
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

test("the linux claim is either backed by musl binaries or documented as glibc-only", { skip: skip() }, () => {
  if (!(MANIFEST.compatibility?.platforms ?? []).includes("linux")) return;
  const musl = ["@resvg/resvg-js-linux-x64-musl", "@resvg/resvg-js-linux-arm64-musl"]
    .filter((t) => has(`node_modules/${t}/`));
  if (musl.length > 0) return;                       // claim is backed; nothing to document

  // Decision: ship glibc only. A .mcpb runs inside Claude Desktop, which is not
  // distributed for Alpine/musl, so the two musl binaries would add ~8 MB (+41% on
  // a 19.3 MiB bundle) for a platform that cannot run the host application. The
  // claim is narrowed in documentation instead of being backed in bytes.
  //
  // This test is the guard on that decision: if the documentation disappears, the
  // bundle is back to claiming "linux" with nothing behind it. To reverse the
  // decision, enable the two musl entries in NATIVE_TARGETS and this passes by the
  // early return above.
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
  // The real guard against a packaging gap: a runtime dependency left in
  // devDependencies, or a file the include list missed, resolves fine from a
  // checkout and fails only here — where the user would have hit it.
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
  // Derived from package.json and the lockfile, not a hand-written list, so a newly
  // added devDependency cannot quietly escape this check.
  //
  // The test is "purely build-time packages must not ship", not "no name that appears
  // under devDependencies may appear". npm marks a lock entry dev:true only when it is
  // reachable *solely* from devDependencies. @types/node is dev:false here because
  // @types/yauzl needs it and puppeteer-core needs that — so it ships, correctly.
  // Banning it by name would assert a falsehood about how npm resolves and would fail
  // forever for no defect.
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
  // ADR-1 removed the HTTP transport. The invariant is about THIS SERVER'S code,
  // not about node_modules: hono, express and cors are hard dependencies of
  // @modelcontextprotocol/sdk and ship transitively no matter what ADR-1 says.
  // Asserting their absence would fail forever while proving nothing.
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

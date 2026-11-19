// The service's configuration, its startup checks, and startService's lifecycle (design 5.6, global constraints).
// Preflight packs are built at test time and every check is driven through injected PreflightDeps, so these run on
// any platform; the file-mode and environment assertions run on POSIX only.
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fakeRun, makePng } from "./helpers/service-harness.mjs";
import { makeSigningFetch } from "./helpers/signing-client.mjs";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "start.js"))) {
  throw new Error("dist-service/service/start.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const load = (name) => import(pathToFileURL(path.join(SERVICE, name)).href);
const { parseServiceConfig, ConfigError } = await load("config.js");
const { preflight, defaultPreflightDeps, makeRunVersion, VERSION_TIMEOUT_MS } = await load("preflight.js");
const { startService } = await load("start.js");
const { loadPack } = await load("templates.js");
const {
  SERVICE_BODY_CAP_BYTES, SERVICE_PNG_CAP_BYTES, RENDER_STILL_DEADLINE_MS, RENDER_CLI_TIMEOUT_MS, RENDER_KILL_GRACE_MS,
  RENDER_VERIFY_DEADLINE_MS,
} = await load("constants.js");

const GOOD = path.join(REPO, "test", "fixtures", "packs", "good");
const PACK = loadPack(GOOD);
const POSIX = process.platform !== "win32";
const BROWSER = "/opt/chrome-headless-shell/chrome-headless-shell";
const CLI_SCRIPT = "/pack/node_modules/@remotion/cli/remotion-cli.js";
/** Every test has this timeout, so a start or a shutdown that never settles fails with the test's name. */
const TIMED = { timeout: 30_000 };
/** Canonical unpadded base64url, but only 18 bytes: too short. Neither may appear in any error. */
const SENTINELS = { IDENTITY_HMAC_KEY: "SENTINEL-IDENTITY-3b7e00", AUDIT_HMAC_KEY: "SENTINEL-AUDIT-9c2d00000" };
const KEY_NAMES = ["IDENTITY_HMAC_KEY", "AUDIT_HMAC_KEY"];

/** Every wait polls its condition to this deadline. None sleeps a guessed duration. */
const WAIT_MS = 10_000;
const POLL_MS = 10;

async function pollFor(probe, message) {
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) return assert.fail(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function ioTurns() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function latch() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Resolves when `signal` aborts, at once if it already has. */
const abortOf = (signal) => new Promise((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", resolve, { once: true });
});

const freshKey = () => randomBytes(32).toString("base64url");
function baseEnv(extra = {}) {
  return {
    SERVICE_AUDIENCE: "deploy-test", IDENTITY_HMAC_KEY: freshKey(), AUDIT_HMAC_KEY: freshKey(),
    BROWSER_EXECUTABLE: BROWSER, ...extra,
  };
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Asserts `fn` throws a ConfigError naming `name`, and that no key value in `env` appears in its message. */
function assertConfigError(fn, name, env, what = name) {
  let error;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ConfigError, `${what}: expected a ConfigError, got ${error}`);
  assert.equal(error.name, "ConfigError");
  assert.ok(error.message.includes(name), `${what}: the message names ${name}: ${error.message}`);
  for (const key of KEY_NAMES) {
    const value = env[key];
    if (typeof value === "string" && value !== "") {
      assert.equal(error.message.includes(value), false, `${what}: the message prints ${key}'s value`);
    }
  }
  return error;
}

test("parseServiceConfig names the missing variable and never prints a key", () => {
  const env = baseEnv();
  const cfg = parseServiceConfig(env);
  assert.deepEqual({ ...cfg, identityKey: null, auditKey: null }, {
    host: "0.0.0.0", port: 8080, audience: "deploy-test", identityKey: null, auditKey: null,
    auditLogPath: "/var/log/remotion-viz/service-audit.jsonl", packDir: "/pack", browserExecutable: BROWSER,
    slots: 2, skewS: 30, bodyCapBytes: SERVICE_BODY_CAP_BYTES, stillDeadlineMs: RENDER_STILL_DEADLINE_MS,
    pngCapBytes: SERVICE_PNG_CAP_BYTES, tempRoot: path.join(os.tmpdir(), "remotion-viz-service"),
  });
  assert.deepEqual(cfg.identityKey, Buffer.from(env.IDENTITY_HMAC_KEY, "base64url"));
  assert.deepEqual(cfg.auditKey, Buffer.from(env.AUDIT_HMAC_KEY, "base64url"));

  const tempRoot = path.join(os.tmpdir(), "rv-config-test");
  const set = parseServiceConfig(baseEnv({
    SERVICE_HOST: "127.0.0.1", SERVICE_PORT: "65535", AUDIT_LOG_PATH: "/data/audit.jsonl", PACK_DIR: "/srv/pack",
    RENDER_SLOTS: "64", IDENTITY_SKEW_S: "120", RENDER_TEMP_ROOT: tempRoot,
  }));
  assert.deepEqual([set.host, set.port, set.auditLogPath, set.packDir, set.slots, set.skewS, set.tempRoot],
    ["127.0.0.1", 65535, "/data/audit.jsonl", "/srv/pack", 64, 120, tempRoot]);
  const low = parseServiceConfig(baseEnv({ SERVICE_PORT: "0", RENDER_SLOTS: "1", IDENTITY_SKEW_S: "0" }));
  assert.deepEqual([low.port, low.slots, low.skewS], [0, 1, 0]);
  // An empty optional variable counts as unset, as `docker run -e NAME=` leaves it.
  const empty = parseServiceConfig(baseEnv({ SERVICE_HOST: "", SERVICE_PORT: "", RENDER_SLOTS: "", IDENTITY_SKEW_S: "" }));
  assert.deepEqual([empty.host, empty.port, empty.slots, empty.skewS], ["0.0.0.0", 8080, 2, 30]);
  // The caps and the deadline are constants, never read from the environment.
  const ignored = parseServiceConfig(baseEnv({
    SERVICE_BODY_CAP_BYTES: "1", RENDER_STILL_DEADLINE_MS: "999999", SERVICE_PNG_CAP_BYTES: "1",
  }));
  assert.deepEqual([ignored.bodyCapBytes, ignored.stillDeadlineMs, ignored.pngCapBytes],
    [SERVICE_BODY_CAP_BYTES, RENDER_STILL_DEADLINE_MS, SERVICE_PNG_CAP_BYTES]);

  for (const name of ["SERVICE_AUDIENCE", "IDENTITY_HMAC_KEY", "AUDIT_HMAC_KEY", "BROWSER_EXECUTABLE"]) {
    const missing = baseEnv();
    delete missing[name];
    assertConfigError(() => parseServiceConfig(missing), name, missing, `${name} unset`);
    const blank = baseEnv({ [name]: "" });
    assertConfigError(() => parseServiceConfig(blank), name, blank, `${name} empty`);
  }

  for (const name of KEY_NAMES) {
    const sentinel = SENTINELS[name];
    // The sentinel is valid unpadded base64url, so it is refused for its length alone.
    assert.equal(Buffer.from(sentinel, "base64url").toString("base64url"), sentinel);
    assert.ok(Buffer.from(sentinel, "base64url").length < 32);
    const short = baseEnv({ [name]: sentinel });
    const error = assertConfigError(() => parseServiceConfig(short), name, short, `${name} too short`);
    assert.equal(error.message.includes(sentinel), false);
    assert.match(error.message, /32/);

    const thirtyTwo = Buffer.alloc(32, 0xfb);
    const spellings = {
      "padded": `${thirtyTwo.toString("base64url")}=`,
      "standard base64": thirtyTwo.toString("base64"),
      "non-canonical": `${Buffer.alloc(32).toString("base64url").slice(0, -1)}B`,
      "with whitespace": ` ${thirtyTwo.toString("base64url")}`,
    };
    for (const [what, value] of Object.entries(spellings)) {
      const bad = baseEnv({ [name]: value });
      assertConfigError(() => parseServiceConfig(bad), name, bad, `${name} ${what}`);
    }
    // Exactly 32 bytes is enough.
    const exact = parseServiceConfig(baseEnv({ [name]: thirtyTwo.toString("base64url") }));
    assert.deepEqual(name === "IDENTITY_HMAC_KEY" ? exact.identityKey : exact.auditKey, thirtyTwo);
  }

  const badNumbers = {
    SERVICE_PORT: ["65536", "-1", "80.5", "8080abc", "0x50", " 80", "1e3", "NaN"],
    RENDER_SLOTS: ["0", "65", "1.5", "-1", "two", "Infinity"],
    IDENTITY_SKEW_S: ["121", "-1", "NaN", "1.5", "3e1", "30s"],
  };
  for (const [name, values] of Object.entries(badNumbers)) {
    for (const value of values) {
      const bad = baseEnv({ [name]: value });
      assertConfigError(() => parseServiceConfig(bad), name, bad, `${name}=${JSON.stringify(value)}`);
    }
  }
  for (const value of ["relative/renders", path.parse(os.tmpdir()).root]) {
    const bad = baseEnv({ RENDER_TEMP_ROOT: value });
    assertConfigError(() => parseServiceConfig(bad), "RENDER_TEMP_ROOT", bad, `RENDER_TEMP_ROOT=${value}`);
  }
});

test("parseServiceConfig refuses a RENDER_TEMP_ROOT that is, contains or lies inside PACK_DIR or the audit log's directory",
  () => {
    // Two separate trees, so each shape overlaps exactly one of the two.
    const pack = path.resolve("/srv/rv-a/pack");
    const logDir = path.resolve("/var/rv-b/log");
    const envFor = ({ tempRoot, packDir = pack, auditLogPath = path.join(logDir, "service-audit.jsonl") }) =>
      baseEnv({ PACK_DIR: packDir, AUDIT_LOG_PATH: auditLogPath, RENDER_TEMP_ROOT: tempRoot });
    const overlaps = [
      ["PACK_DIR", "is PACK_DIR", { tempRoot: pack }],
      ["PACK_DIR", "contains PACK_DIR", { tempRoot: path.dirname(pack) }],
      ["PACK_DIR", "lies inside PACK_DIR", { tempRoot: path.join(pack, "renders") }],
      ["AUDIT_LOG_PATH", "is the audit log's directory", { tempRoot: logDir }],
      ["AUDIT_LOG_PATH", "contains the audit log's directory", { tempRoot: path.dirname(logDir) }],
      ["AUDIT_LOG_PATH", "lies inside the audit log's directory", { tempRoot: path.join(logDir, "renders") }],
      // The same directories spelled differently: the comparison is on resolved paths.
      ["PACK_DIR", "is PACK_DIR, with a trailing separator and a dot segment", { tempRoot: `${pack}${path.sep}.${path.sep}` }],
      ["AUDIT_LOG_PATH", "is the audit log's directory, through a `..`",
        { tempRoot: `${logDir}${path.sep}..${path.sep}${path.basename(logDir)}` }],
    ];
    for (const [name, what, paths] of overlaps) {
      const bad = envFor(paths);
      const error = assertConfigError(() => parseServiceConfig(bad), "RENDER_TEMP_ROOT", bad, `RENDER_TEMP_ROOT ${what}`);
      assert.ok(error.message.includes(name), `RENDER_TEMP_ROOT ${what}: the message names ${name}: ${error.message}`);
      // The variables are named, never their values.
      for (const value of [pack, logDir, paths.tempRoot, "rv-a", "rv-b", "rv-relative-pack"]) {
        assert.equal(error.message.includes(value), false, `RENDER_TEMP_ROOT ${what}: the message prints ${value}`);
      }
    }

    // A separator boundary: a sibling whose name merely starts with the other's is accepted.
    for (const tempRoot of [`${pack}2`, `${pack}-renders`, path.join(path.dirname(pack), "renders"), `${logDir}2`,
      path.join(path.dirname(logDir), "renders")]) {
      assert.equal(parseServiceConfig(envFor({ tempRoot })).tempRoot, tempRoot, `${tempRoot} is a sibling, not an overlap`);
    }
  });

test("parseServiceConfig refuses a relative BROWSER_EXECUTABLE, PACK_DIR or AUDIT_LOG_PATH, naming only the variable",
  () => {
    // Preflight ran a relative BROWSER_EXECUTABLE from the service's own cwd and passed it, while every render's CLI,
    // whose cwd is the render's work dir, then failed to find it. The other two would follow the cwd as well.
    for (const name of ["BROWSER_EXECUTABLE", "PACK_DIR", "AUDIT_LOG_PATH"]) {
      for (const value of ["rv-relative-path", `.${path.sep}rv-relative-path`, path.join("rv-dir", "rv-relative-path")]) {
        const bad = baseEnv({ [name]: value });
        const error = assertConfigError(() => parseServiceConfig(bad), name, bad, `${name}=${value}`);
        assert.equal(error.message, `${name} must be an absolute path`);
        assert.equal(error.message.includes("rv-"), false, `${name}=${value}: the message prints the value`);
      }
    }
    // Positive controls: absolute values pass through as given.
    const absolute = { BROWSER_EXECUTABLE: path.resolve("/opt/rv-chrome/chrome-headless-shell"),
      PACK_DIR: path.resolve("/srv/rv-pack"), AUDIT_LOG_PATH: path.resolve("/var/rv-log/service-audit.jsonl") };
    const cfg = parseServiceConfig(baseEnv(absolute));
    assert.deepEqual([cfg.browserExecutable, cfg.packDir, cfg.auditLogPath],
      [absolute.BROWSER_EXECUTABLE, absolute.PACK_DIR, absolute.AUDIT_LOG_PATH]);
  });

test("parseServiceConfig refuses the published test-vector key and an audit key equal to the identity key", () => {
  // The key test/vectors/identity-v1.json publishes, so anyone can sign with it.
  const vectors = JSON.parse(fs.readFileSync(path.join(REPO, "test", "vectors", "identity-v1.json"), "utf8"));
  const published = vectors.key_base64url;
  assert.deepEqual(Buffer.from(published, "base64url"), Buffer.alloc(32, 7), "control: the vectors' published key");
  for (const name of KEY_NAMES) {
    const bad = baseEnv({ [name]: published });
    const error = assertConfigError(() => parseServiceConfig(bad), name, bad, `${name} is the published key`);
    assert.equal(error.message, `${name} must not be the published test-vector key`);
  }

  const shared = freshKey();
  const same = baseEnv({ IDENTITY_HMAC_KEY: shared, AUDIT_HMAC_KEY: shared });
  const error = assertConfigError(() => parseServiceConfig(same), "AUDIT_HMAC_KEY", same, "the two keys are one");
  assert.equal(error.message, "AUDIT_HMAC_KEY must differ from IDENTITY_HMAC_KEY");

  // Positive control: two different keys, the bytes kept as decoded.
  const env = baseEnv();
  const cfg = parseServiceConfig(env);
  assert.equal(cfg.identityKey.equals(cfg.auditKey), false);
  assert.deepEqual(cfg.auditKey, Buffer.from(env.AUDIT_HMAC_KEY, "base64url"));
});

test("parseServiceConfig compares keys as HMAC-SHA256 uses them, so a zero-padded or pre-hashed spelling is refused",
  () => {
    // HMAC-SHA256 zero-pads a key of at most 64 bytes to 64, and first hashes a longer key with SHA-256 (RFC 2104).
    // Two keys with the same padded form sign every message alike.
    const b64 = (bytes) => bytes.toString("base64url");
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
    const vector = Buffer.alloc(32, 7);
    const sign = (key) => createHmac("sha256", key).update("rv-message").digest("hex");
    const paddedVectors = [Buffer.concat([vector, Buffer.alloc(1)]), Buffer.concat([vector, Buffer.alloc(32)])];
    for (const padded of paddedVectors) {
      assert.equal(sign(padded), sign(vector), `control: ${padded.length} bytes sign as the published key`);
      for (const name of KEY_NAMES) {
        const bad = baseEnv({ [name]: b64(padded) });
        const what = `${name} is the published key plus ${padded.length - 32} zero byte(s)`;
        const error = assertConfigError(() => parseServiceConfig(bad), name, bad, what);
        assert.equal(error.message, `${name} must not be the published test-vector key`);
      }
    }

    const identity = randomBytes(32);
    const longIdentity = randomBytes(65);
    const sameAsIdentity = [
      ["the identity key plus one zero byte", identity, Buffer.concat([identity, Buffer.alloc(1)])],
      ["the identity key padded to 64 bytes", identity, Buffer.concat([identity, Buffer.alloc(32)])],
      ["the SHA-256 of a 65-byte identity key", longIdentity, sha256(longIdentity)],
      ["a 65-byte identity key, given as the audit key's SHA-256 form padded to 64", longIdentity,
        Buffer.concat([sha256(longIdentity), Buffer.alloc(32)])],
    ];
    for (const [what, identityKey, auditKey] of sameAsIdentity) {
      assert.equal(sign(auditKey), sign(identityKey), `control: ${what} signs as the identity key`);
      const bad = baseEnv({ IDENTITY_HMAC_KEY: b64(identityKey), AUDIT_HMAC_KEY: b64(auditKey) });
      const error = assertConfigError(() => parseServiceConfig(bad), "AUDIT_HMAC_KEY", bad, what);
      assert.equal(error.message, "AUDIT_HMAC_KEY must differ from IDENTITY_HMAC_KEY");
      assert.equal(error.message.includes(b64(auditKey)), false);
    }

    // Positive controls. A 65-byte key is hashed first, so the published key followed by 33 zero bytes is another
    // key; so is a 65-byte key beside a different one, and so are two fresh keys. Each is kept as decoded.
    const longVector = Buffer.concat([vector, Buffer.alloc(33)]);
    assert.notEqual(sign(longVector), sign(vector), "control: a 65-byte key is hashed, not padded");
    const accepted = [
      [longVector, randomBytes(32)],
      [randomBytes(32), longVector],
      [longIdentity, randomBytes(65)],
      [randomBytes(32), randomBytes(32)],
    ];
    for (const [identityKey, auditKey] of accepted) {
      const cfg = parseServiceConfig(baseEnv({ IDENTITY_HMAC_KEY: b64(identityKey), AUDIT_HMAC_KEY: b64(auditKey) }));
      assert.deepEqual([cfg.identityKey, cfg.auditKey], [identityKey, auditKey]);
    }
  });

/**
 * A pack built at test time from the good fixture, with a stand-in CLI and renderer under node_modules. Never
 * committed: the root .gitignore's unanchored `node_modules` and `dist` would drop them on checkout.
 */
function buildPack(t, { renderer = "4.0.458", wrapper = true, cli = true, cliBin = { remotion: "cli.js" },
  cliScript = true, manifest, nested, mutate } = {}) {
  const dir = tmpDir(t, "preflight-");
  fs.cpSync(GOOD, dir, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, "pack-manifest.json"), JSON.stringify(manifest));
  const cliDir = path.join(dir, "node_modules", "@remotion", "cli");
  if (cli) {
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, "package.json"), JSON.stringify({ bin: cliBin }));
    if (cliScript) fs.writeFileSync(path.join(cliDir, "cli.js"), "// a stand-in for the Remotion CLI\n");
  }
  const writeRenderer = (rendererDir, version, withWrapper) => {
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.writeFileSync(path.join(rendererDir, "package.json"), JSON.stringify({ version }));
    if (withWrapper) {
      fs.mkdirSync(path.join(rendererDir, "dist", "linux"), { recursive: true });
      fs.writeFileSync(path.join(rendererDir, "dist", "linux", "wrap-with-setpriv.js"), "// a stand-in\n");
    }
  };
  // The hoisted copy, and optionally a nested one under the CLI, which is the copy the CLI itself loads.
  if (renderer !== null) writeRenderer(path.join(dir, "node_modules", "@remotion", "renderer"), renderer, wrapper);
  if (nested !== undefined) {
    writeRenderer(path.join(cliDir, "node_modules", "@remotion", "renderer"), nested.version, nested.wrapper ?? true);
  }
  mutate?.(dir);
  return { dir, cliScriptPath: path.join(cliDir, "cli.js") };
}

/** PreflightDeps whose every check passes, recording each call. */
function passingDeps(calls = []) {
  return {
    which: (cmd, pathVar) => {
      calls.push(["which", cmd, pathVar]);
      return cmd === "setpriv" ? "/usr/bin/setpriv" : null;
    },
    runVersion: async (file) => {
      calls.push(["runVersion", file]);
      return true;
    },
  };
}

const configFor = (packDir, auditLogPath) => parseServiceConfig(baseEnv({ PACK_DIR: packDir, AUDIT_LOG_PATH: auditLogPath }));

/** The one message for a pack that fails loadPack, whichever of its checks failed. */
const PACK_REFUSED = /^preflight: PACK_DIR: the template pack failed its checks \(manifest, bundle or JSON Schema gate\)$/;

test("preflight refuses each failed check, naming it", TIMED, async (t) => {
  const renderer = /^preflight: @remotion\/renderer: /;
  const cases = [
    ["no setpriv", {}, { which: () => null }, /^preflight: setpriv: not found on PATH$/],
    ["renderer 4.0.457", { renderer: "4.0.457" }, {}, /^preflight: @remotion\/renderer: .*below 4\.0\.458/],
    ["renderer 4.0.99", { renderer: "4.0.99" }, {}, /^preflight: @remotion\/renderer: .*below 4\.0\.458/],
    ["renderer 3.9.999", { renderer: "3.9.999" }, {}, renderer],
    ["a renderer pre-release", { renderer: "4.0.458-rc.1" }, {}, renderer],
    ["no renderer", { renderer: null }, {}, renderer],
    ["no wrap-with-setpriv.js", { wrapper: false }, {}, /^preflight: @remotion\/renderer: .*wrap-with-setpriv\.js/],
    ["a browser that will not run", {}, { runVersion: async () => false }, /^preflight: browser: /],
    ["a missing CLI package", { cli: false }, {}, /^preflight: @remotion\/cli: .*no npx fallback/],
    ["a CLI package without its script", { cliScript: false }, {}, /^preflight: @remotion\/cli: .*no npx fallback/],
    ["a CLI package without a bin", { cliBin: {} }, {}, /^preflight: @remotion\/cli: .*no npx fallback/],
    // One neutral message for every way the pack can fail: it never blames a check that did not fail.
    ["a pack refused by the JSON Schema gate", { manifest: { packHash: "h", remotionVersion: "4.0.458", templates: [] } },
      {}, PACK_REFUSED],
    ["a pack without its manifest", { mutate: (dir) => fs.rmSync(path.join(dir, "pack-manifest.json")) }, {},
      PACK_REFUSED],
    ["a pack without bundle/index.html", { mutate: (dir) => fs.rmSync(path.join(dir, "bundle", "index.html")) }, {},
      PACK_REFUSED],
  ];
  for (const [what, packOptions, depOverrides, expected] of cases) {
    const { dir } = buildPack(t, packOptions);
    const cfg = configFor(dir, path.join(dir, "log", "service-audit.jsonl"));
    await assert.rejects(preflight(cfg, { ...passingDeps(), ...depOverrides }), (err) => {
      assert.match(err.message, expected, what);
      // Only the check's name: never the pack's own text.
      assert.equal(err.message.includes("/templates"), false, `${what}: the pack's text is echoed`);
      assert.equal(err.message.includes(dir), false, `${what}: the pack's path is echoed`);
      return true;
    }, what);
  }

  // AUDIT_LOG_PATH under a regular file.
  const { dir } = buildPack(t);
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "a regular file\n");
  await assert.rejects(preflight(configFor(dir, path.join(blocker, "service-audit.jsonl")), passingDeps()),
    { message: "preflight: AUDIT_LOG_PATH is not writable" });
});

test("preflight checks the @remotion/renderer the CLI resolves: a nested copy under the CLI before the hoisted one",
  TIMED, async (t) => {
    const refusals = [
      ["a nested 4.0.400 beside a hoisted 4.0.458", { renderer: "4.0.458", nested: { version: "4.0.400" } },
        /^preflight: @remotion\/renderer: .*below 4\.0\.458/],
      ["a nested 4.0.458 without the wrapper beside a hoisted 4.0.458 with it",
        { renderer: "4.0.458", nested: { version: "4.0.458", wrapper: false } },
        /^preflight: @remotion\/renderer: .*wrap-with-setpriv\.js/],
    ];
    for (const [what, packOptions, expected] of refusals) {
      const { dir } = buildPack(t, packOptions);
      await assert.rejects(preflight(configFor(dir, path.join(dir, "log", "a.jsonl")), passingDeps()), (err) => {
        assert.match(err.message, expected, what);
        assert.equal(err.message.includes(dir), false, `${what}: the pack's path is echoed`);
        return true;
      }, what);
    }
    // The positive control: the nested copy decides, so a good nested copy passes over a hoisted 4.0.400 without
    // its wrapper.
    const { dir, cliScriptPath } = buildPack(t, { renderer: "4.0.400", wrapper: false, nested: { version: "4.0.458" } });
    const result = await preflight(configFor(dir, path.join(dir, "log", "a.jsonl")), passingDeps());
    assert.deepEqual(result.cli.prefixArgs, [cliScriptPath]);
  });

test("preflight passes with renderer 4.0.458 and 4.1.0 and resolves the CLI's absolute path", TIMED, async (t) => {
  for (const version of ["4.0.458", "4.1.0", "10.0.0"]) {
    const { dir, cliScriptPath } = buildPack(t, { renderer: version });
    const auditLogPath = path.join(dir, "log", "service-audit.jsonl");
    const cfg = configFor(dir, auditLogPath);
    const calls = [];
    const result = await preflight(cfg, passingDeps(calls));
    assert.deepEqual(result.cli, { file: process.execPath, prefixArgs: [cliScriptPath] }, version);
    assert.ok(path.isAbsolute(result.cli.prefixArgs[0]));
    assert.deepEqual(result.pack.manifest.templates.map((tpl) => tpl.id), PACK.manifest.templates.map((tpl) => tpl.id));
    assert.deepEqual(calls, [["which", "setpriv", process.env.PATH ?? ""], ["runVersion", BROWSER]], version);
    assert.equal(fs.existsSync(auditLogPath), true, "the audit check opened the file for appending");
    if (POSIX) assert.equal(fs.statSync(auditLogPath).mode & 0o777, 0o600, "the audit file is created 0600");
  }
  // `bin` may be a string.
  const { dir, cliScriptPath } = buildPack(t, { cliBin: "cli.js" });
  const result = await preflight(configFor(dir, path.join(dir, "log", "a.jsonl")), passingDeps());
  assert.deepEqual(result.cli.prefixArgs, [cliScriptPath]);
  // It never resolves the CLI through resolveRemotionCli, which falls back to npx: neither imported nor called.
  const compiled = fs.readFileSync(path.join(SERVICE, "preflight.js"), "utf8");
  assert.doesNotMatch(compiled, /\bimport\b[^;]*\bresolveRemotionCli\b|\bresolveRemotionCli\s*\(/);
});

test("defaultPreflightDeps scans a PATH value in-process and runs --version", TIMED, async (t) => {
  const { which, runVersion } = defaultPreflightDeps;
  const bin = tmpDir(t, "preflight-bin-");
  const empty = tmpDir(t, "preflight-empty-");
  const tool = path.join(bin, "fake-setpriv");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.join(bin, "a-directory"));
  assert.equal(which("fake-setpriv", [empty, bin].join(path.delimiter)), tool);
  assert.equal(which("fake-setpriv", empty), null);
  assert.equal(which("fake-setpriv", ""), null);
  assert.equal(which("a-directory", bin), null, "a directory is not a command");
  // A relative entry would resolve against the cwd; it is skipped. path.relative cannot build one: across drives
  // (windows-latest checks out on D:, its TEMP is on C:) it returns the absolute target. So the entries are relative
  // by construction, from a cwd inside `bin`, and each is checked to be relative and to reach the tool from there.
  // The window between the two chdir calls is synchronous, so no other test sees the changed cwd.
  const cwd = process.cwd();
  process.chdir(bin);
  try {
    for (const entry of [".", path.join("..", path.basename(bin))]) {
      assert.equal(path.isAbsolute(entry), false, `${entry} is a relative entry`);
      assert.equal(fs.statSync(path.join(entry, "fake-setpriv")).isFile(), true, `${entry} reaches the tool from the cwd`);
      assert.equal(which("fake-setpriv", entry), null, `the relative entry ${entry} is skipped`);
    }
  } finally {
    process.chdir(cwd);
  }
  if (POSIX) {
    fs.writeFileSync(path.join(bin, "not-executable"), "#!/bin/sh\n", { mode: 0o644 });
    assert.equal(which("not-executable", bin), null, "a file without the execute bit is not a command");
  }
  assert.equal(await runVersion(process.execPath), true);
  assert.equal(await runVersion(path.join(empty, "no-such-browser")), false);
});

test("defaultPreflightDeps.runVersion bounds the browser's --version at VERSION_TIMEOUT_MS with SIGKILL", TIMED, async () => {
  // execFile's own options, read off a stand-in: the bound itself is proven on a real process below, with a short one.
  assert.equal(VERSION_TIMEOUT_MS, 30_000);
  const seen = [];
  const realExecFile = childProcess.execFile;
  childProcess.execFile = (file, args, options, callback) => {
    seen.push({ file, args, timeout: options.timeout, killSignal: options.killSignal, shell: options.shell });
    queueMicrotask(() => callback(null, "", ""));
    return undefined;
  };
  // preflight.js imports execFile by name; this makes its binding the stand-in, and later the real one again.
  syncBuiltinESMExports();
  let verdict;
  try {
    verdict = await defaultPreflightDeps.runVersion("/opt/a-browser");
  } finally {
    childProcess.execFile = realExecFile;
    syncBuiltinESMExports();
  }
  assert.equal(verdict, true);
  assert.deepEqual(seen, [{ file: "/opt/a-browser", args: ["--version"], timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL",
    shell: false }]);
});

test("runVersion kills a browser whose --version never exits, once its bound has passed, and counts it as not running",
  { ...TIMED, skip: POSIX ? false : "needs a shell script as the browser; this runs in WSL" }, async (t) => {
    const BOUND_MS = 1_000;
    const runVersion = makeRunVersion(BOUND_MS);
    const dir = tmpDir(t, "preflight-hang-");
    const pidFile = path.join(dir, "pid");
    // It records its pid, then becomes cat on execFile's stdin pipe, which never reaches end of file: it waits without
    // sleeping, and exec keeps the pid, so the recorded process is the one the bound must kill.
    const hangs = path.join(dir, "hangs");
    fs.writeFileSync(hangs, `#!/bin/sh\necho $$ > '${pidFile}'\nexec cat > /dev/null\n`, { mode: 0o755 });
    const quick = path.join(dir, "quick");
    fs.writeFileSync(quick, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(await runVersion(quick), true, "the control: a browser that answers within the bound runs");
    const started = performance.now();
    let settled = false;
    const pending = runVersion(hangs).then((value) => {
      settled = true;
      return value;
    });
    // Should the bound fail, the browser would outlive the test and keep this file's process from exiting, so this
    // kills it. tmpDir's own after hook, which runs first, removes the pid file, so the pid is read before any
    // assertion. Once runVersion has settled, execFile has reaped the browser, and its pid may already belong to
    // another process: it is left alone.
    let pid;
    t.after(() => {
      if (settled || !(pid > 1)) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    });
    let deadline;
    const verdict = await Promise.race([
      pending,
      new Promise((resolve) => { deadline = setTimeout(() => resolve("still waiting"), WAIT_MS); }),
    ]);
    clearTimeout(deadline);
    const tookMs = performance.now() - started;
    pid = await pollFor(() => {
      const recorded = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : NaN;
      return Number.isInteger(recorded) && recorded > 1 ? recorded : undefined;
    }, "the browser never recorded its pid");
    assert.equal(verdict, false, `runVersion was ${verdict} ${Math.round(tookMs)} ms after it began, with a ${BOUND_MS} ms `
      + "bound");
    assert.ok(tookMs >= BOUND_MS - 50, `it settled after ${Math.round(tookMs)} ms, before its ${BOUND_MS} ms bound`);
    await pollFor(() => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch (err) {
        return err.code === "ESRCH" ? true : assert.fail(`process.kill(${pid}, 0) failed with ${err.code}`);
      }
    }, `the browser's process ${pid} is still alive after its bound`);
  });

test("runVersion gives the browser the allowlisted environment, never a key",
  { ...TIMED, skip: POSIX ? false : "needs a shell script as the browser; this runs in WSL" }, async (t) => {
    const dir = tmpDir(t, "preflight-env-");
    const out = path.join(dir, "env.txt");
    const browser = path.join(dir, "browser");
    fs.writeFileSync(browser, `#!/bin/sh\nenv > '${out}'\n[ "$1" = "--version" ] || exit 3\n`, { mode: 0o755 });
    const saved = { IDENTITY_HMAC_KEY: process.env.IDENTITY_HMAC_KEY, AUDIT_HMAC_KEY: process.env.AUDIT_HMAC_KEY };
    t.after(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    // Node's child_process copies this process's NODE_V8_COVERAGE into every child's environment, even an explicit one
    // that leaves it out, so coverage reaches children too. Only a coverage run sets it here, and then only the value
    // this test began with may reach the browser: any other value is a leak. Read before runVersion, so a change it
    // made to process.env would not count.
    const coverage = process.env.NODE_V8_COVERAGE ? `NODE_V8_COVERAGE=${process.env.NODE_V8_COVERAGE}` : undefined;
    process.env.IDENTITY_HMAC_KEY = SENTINELS.IDENTITY_HMAC_KEY;
    process.env.AUDIT_HMAC_KEY = SENTINELS.AUDIT_HMAC_KEY;
    assert.equal(await defaultPreflightDeps.runVersion(browser), true);
    const lines = fs.readFileSync(out, "utf8").split("\n").filter((line) => line.includes("="));
    const allowed = new Set(["PATH", "HOME", "LANG", "NODE_ENV", "TMPDIR", "PWD", "SHLVL", "_"]);
    for (const line of lines) {
      const name = line.slice(0, line.indexOf("="));
      assert.ok(allowed.has(name) || name.startsWith("REMOTION_") || line === coverage, `${name} reached the browser`);
    }
    const text = fs.readFileSync(out, "utf8");
    assert.equal(text.includes("SENTINEL"), false);
    assert.ok(text.includes(`TMPDIR=${os.tmpdir()}`));
  });

/**
 * startService on 127.0.0.1:0 with throwaway keys, an injected preflight (the good pack and a stand-in CLI) and a
 * captured log, plus a signed SDK client. `shutdown()` runs after the test.
 */
async function startFor(t, deps = {}, { tempRoot } = {}) {
  const root = tmpDir(t, "service-start-");
  const renders = tempRoot ?? path.join(root, "renders");
  const env = baseEnv({
    SERVICE_HOST: "127.0.0.1", SERVICE_PORT: "0", PACK_DIR: GOOD, RENDER_TEMP_ROOT: renders,
    AUDIT_LOG_PATH: path.join(root, "log", "service-audit.jsonl"),
  });
  const logs = [];
  const service = await startService(env, {
    preflight: async () => ({ pack: PACK, cli: { file: process.execPath, prefixArgs: [CLI_SCRIPT] } }),
    log: (line) => logs.push(line),
    ...deps,
  });
  t.after(async () => {
    await service.shutdown();
    // Should shutdown leave the server open, the test fails, and this still lets the test process exit.
    service.server.closeAllConnections();
    if (service.server.listening) service.server.close();
  });
  const fetch = makeSigningFetch({ key: Buffer.from(env.IDENTITY_HMAC_KEY, "base64url"), audience: env.SERVICE_AUDIENCE,
    principal: "principal-a", tenant: "tenant-a" });
  const client = new Client({ name: "service-start-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), { fetch }));
  t.after(() => client.close());
  return { service, env, logs, client, tempRoot: renders };
}

const stillCall = () => ({ name: "render_still", arguments: {
  template_id: "scoreboard",
  props: { label: "Final", color: "#1A2B3C", players: [{ name: "Ada", number: 10 }], theme: "dark", opacity: 0.5 },
} });

test("startService empties and recreates RENDER_TEMP_ROOT at mode 0700 before it listens", TIMED, async (t) => {
  const root = tmpDir(t, "service-temp-");
  const stale = path.join(root, "renders");
  fs.mkdirSync(path.join(stale, "r-earlier-run"), { recursive: true });
  fs.writeFileSync(path.join(stale, "r-earlier-run", "props.json"), "{\"label\":\"an earlier caller's props\"}");
  fs.writeFileSync(path.join(stale, "stray"), "x");
  if (POSIX) fs.chmodSync(stale, 0o755);
  // The reset happens before the startup checks, so before the listen: a service that fails a check and restarts
  // in a loop still clears an earlier run's props.
  let atPreflight;
  const s = await startFor(t, {
    preflight: async () => {
      atPreflight = { entries: fs.readdirSync(stale), mode: fs.statSync(stale).mode & 0o777 };
      return { pack: PACK, cli: { file: process.execPath, prefixArgs: [CLI_SCRIPT] } };
    },
  }, { tempRoot: stale });
  assert.equal(s.service.server.listening, true);
  assert.deepEqual(atPreflight.entries, [], "the temp root was emptied before the startup checks and the listen");
  if (POSIX) assert.equal(atPreflight.mode, 0o700);
  assert.deepEqual(fs.readdirSync(stale), [], "no earlier run's props survive a restart");
  if (POSIX) assert.equal(fs.statSync(stale).mode & 0o777, 0o700);

  const absent = path.join(root, "not", "yet", "there");
  await startFor(t, {}, { tempRoot: absent });
  assert.deepEqual(fs.readdirSync(absent), []);
  if (POSIX) assert.equal(fs.statSync(absent).mode & 0o777, 0o700);
});

/** The one message for a RENDER_TEMP_ROOT that exists but is not a plain directory. */
const TEMP_ROOT_REFUSED = "start: RENDER_TEMP_ROOT is a symbolic link or not a directory";

/** Starts the service with `tempRoot`, an injected preflight that counts its calls, and a captured log. */
function startWithTempRoot(t, tempRoot) {
  const root = tmpDir(t, "service-tempcheck-");
  const calls = { preflight: 0 };
  const env = baseEnv({ SERVICE_HOST: "127.0.0.1", SERVICE_PORT: "0", RENDER_TEMP_ROOT: tempRoot,
    AUDIT_LOG_PATH: path.join(root, "log", "service-audit.jsonl") });
  const started = startService(env, { preflight: async () => {
    calls.preflight += 1;
    return { pack: PACK, cli: { file: process.execPath, prefixArgs: [CLI_SCRIPT] } };
  }, log: () => {} });
  // Should the start succeed after all, the test fails, and its server still closes.
  t.after(async () => (await started.catch(() => undefined))?.shutdown());
  return { started, calls };
}

test("startService refuses a RENDER_TEMP_ROOT that is a regular file, and leaves the file alone", TIMED, async (t) => {
  const file = path.join(tmpDir(t, "service-tempfile-"), "renders");
  fs.writeFileSync(file, "not a directory\n");
  const { started, calls } = startWithTempRoot(t, file);
  await assert.rejects(started, { message: TEMP_ROOT_REFUSED });
  assert.equal(calls.preflight, 0, "the start was refused before the startup checks");
  assert.equal(fs.readFileSync(file, "utf8"), "not a directory\n");
});

test("startService refuses a symlinked RENDER_TEMP_ROOT, and its target's contents survive",
  { ...TIMED, skip: POSIX ? false : "a symlink needs privileges on Windows; this runs in WSL" }, async (t) => {
    const root = tmpDir(t, "service-templink-");
    const target = path.join(root, "someone-elses-dir");
    fs.mkdirSync(path.join(target, "sub"), { recursive: true });
    fs.writeFileSync(path.join(target, "keep.txt"), "not the service's to delete\n");
    fs.chmodSync(target, 0o755);
    const link = path.join(root, "renders");
    fs.symlinkSync(target, link);
    const { started, calls } = startWithTempRoot(t, link);
    await assert.rejects(started, { message: TEMP_ROOT_REFUSED });
    assert.equal(calls.preflight, 0, "the start was refused before the startup checks");
    assert.deepEqual(fs.readdirSync(target).sort(), ["keep.txt", "sub"], "the target's contents survive");
    assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "not the service's to delete\n");
    assert.equal(fs.statSync(target).mode & 0o777, 0o755, "the target's mode is untouched");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);

    // A dangling link is refused the same way.
    const dangling = path.join(root, "dangling");
    fs.symlinkSync(path.join(root, "nowhere"), dangling);
    const second = startWithTempRoot(t, dangling);
    await assert.rejects(second.started, { message: TEMP_ROOT_REFUSED });
    assert.equal(fs.existsSync(path.join(root, "nowhere")), false, "nothing was created at the link's target");
  });

test("startService names only the error code when RENDER_TEMP_ROOT cannot be created", TIMED, async (t) => {
  const blocker = path.join(tmpDir(t, "service-tempcode-"), "blocker");
  fs.writeFileSync(blocker, "a regular file\n");
  const { started, calls } = startWithTempRoot(t, path.join(blocker, "renders"));
  await assert.rejects(started, (err) => {
    assert.equal(err.message, "start: RENDER_TEMP_ROOT could not be emptied and recreated (ENOTDIR)");
    return true;
  });
  assert.equal(calls.preflight, 0);
});

test("startService refuses to start on a bad configuration or a failed preflight", TIMED, async (t) => {
  let preflights = 0;
  await assert.rejects(startService({}, { preflight: async () => { preflights += 1; } }), ConfigError);
  assert.equal(preflights, 0, "the configuration is checked first");
  const root = tmpDir(t, "service-refuse-");
  const env = baseEnv({ SERVICE_HOST: "127.0.0.1", SERVICE_PORT: "0", RENDER_TEMP_ROOT: path.join(root, "renders"),
    AUDIT_LOG_PATH: path.join(root, "log", "audit.jsonl") });
  await assert.rejects(startService(env, { preflight: async () => { throw new Error("preflight: setpriv: not found on PATH"); } }),
    { message: "preflight: setpriv: not found on PATH" });
});

test("startService takes its start time once, and refuses a header signed more than one skew before it", TIMED,
  async (t) => {
    const before = Math.floor(Date.now() / 1000);
    const s = await startFor(t);
    // The client connected with headers signed now, so a current header verifies.
    assert.equal((await s.client.listTools()).tools.length, 4);
    const stale = new Client({ name: "service-start-stale", version: "0.0.0" });
    t.after(() => stale.close());
    const fetch = makeSigningFetch({ key: Buffer.from(s.env.IDENTITY_HMAC_KEY, "base64url"),
      audience: s.env.SERVICE_AUDIENCE, principal: "principal-a", tenant: "tenant-a", nowS: before - 31 });
    await assert.rejects(
      stale.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.service.port}/mcp`), { fetch })),
      (err) => /\b401\b/.test(String(err?.message)) || String(err?.code) === "401");
    // Once: 100 s later on the service's clock, a header signed at before + 60 still verifies. A start time read per
    // request would be at least before + 100 by now, and would refuse that header, signed more than one skew earlier,
    // as signed_before_start.
    const real = Date.now();
    t.mock.method(Date, "now", () => real + 100_000);
    assert.ok(Math.floor(Date.now() / 1000) - (before + 60) > 30, "the moved clock is more than one skew past the header");
    const late = new Client({ name: "service-start-late", version: "0.0.0" });
    t.after(() => late.close());
    const lateFetch = makeSigningFetch({ key: Buffer.from(s.env.IDENTITY_HMAC_KEY, "base64url"),
      audience: s.env.SERVICE_AUDIENCE, principal: "principal-a", tenant: "tenant-a", nowS: before + 60 });
    try {
      await late.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.service.port}/mcp`),
        { fetch: lateFetch }));
    } catch (err) {
      assert.fail(`a header signed after the start was refused once the clock had moved on 100 s, so the start time `
        + `was not taken once: ${err?.message}`);
    }
    assert.equal((await late.listTools()).tools.length, 4);
    const auditPath = path.join(path.dirname(s.tempRoot), "log", "service-audit.jsonl");
    // The SDK clients' own GET streams get a 405, which carries no identity and is not audited.
    const refused = fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((e) => e.outcome === "refused");
    assert.deepEqual(refused.map((e) => e.category), ["signed_before_start"]);
  });

// The child imports dist-service, which took 17-19 s under suite load in WSL over /mnt/c, so its deadline is 60 s.
// spawnSync blocks the event loop, so the test's own timeout cannot fire before it returns; it stays above it anyway.
test("the runner prints a configuration error without the key and exits 1", { timeout: 90_000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [path.join(SERVICE, "index.js")], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SERVICE_AUDIENCE: "deploy-test",
      IDENTITY_HMAC_KEY: SENTINELS.IDENTITY_HMAC_KEY },
    encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 1, `exit status: ${result.status}; stderr: ${result.stderr}`);
  assert.equal(result.stderr.trim(), "IDENTITY_HMAC_KEY must decode to at least 32 bytes");
  assert.equal(result.stderr.includes(SENTINELS.IDENTITY_HMAC_KEY), false);
  assert.equal(result.stdout, "");
});

test("startService exits 70 when a cleanup is unverified", TIMED, async (t) => {
  const exits = [];
  const heldEntered = latch();
  let held;
  let calls = 0;
  const unverified = fakeRun({
    cleanup: Promise.resolve({ verified: false, survivors: [4242], cause: "recorded processes still alive: 4242" }),
  });
  const run = async (file, args, options) => {
    calls += 1;
    if (calls > 1) return unverified(file, args, options);
    // The first render stays in flight until something aborts it.
    held = { signal: options.signal, dir: options.cwd };
    heldEntered.resolve();
    await abortOf(options.signal);
    return { exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "",
      cleanup: Promise.resolve({ verified: true, survivors: [] }) };
  };
  const tempRoot = path.join(tmpDir(t, "service-exit-"), "renders");
  const logs = [];
  const exit = (code) => exits.push({
    code, heldAborted: held.signal.aborted, left: fs.readdirSync(tempRoot), logged: [...logs],
  });
  const s = await startFor(t, { run, exit, log: (line) => logs.push(line) }, { tempRoot });

  const pendingHeld = s.client.callTool(stillCall());
  await heldEntered.promise;
  assert.equal(fs.existsSync(path.join(held.dir, "props.json")), true, "the held render's props are on disk");
  fs.writeFileSync(path.join(tempRoot, "stray"), "x");

  const result = await s.client.callTool(stillCall());
  assert.deepEqual(Buffer.from(result.content[0].data, "base64"), makePng(256));
  await pollFor(() => (exits.length > 0 ? true : undefined), "exit was never called");
  assert.equal(exits.length, 1);
  const [at] = exits;
  assert.equal(at.code, 70);
  assert.equal(at.heldAborted, true, "the other in-flight render was aborted before the exit");
  assert.deepEqual(at.left, [], "RENDER_TEMP_ROOT was emptied before the exit, the held render's props included");
  assert.ok(at.logged.some((line) => line.includes("cleanup unverified: recorded processes still alive: 4242")),
    `the cause was logged: ${at.logged.join(" | ")}`);
  assert.ok(at.logged.some((line) => /exiting with code 70/.test(line)), `the exit was logged: ${at.logged.join(" | ")}`);
  const held2 = await pendingHeld;
  assert.equal(held2.structuredContent?.category, "render_failed");
});

test("shutdown aborts in-flight renders, waits for slots to drain, then closes", TIMED, async (t) => {
  const entered = latch();
  const cleanup = latch();
  let signal;
  const run = async (_file, _args, options) => {
    signal = options.signal;
    entered.resolve();
    await abortOf(options.signal);
    return { exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "", cleanup: cleanup.promise };
  };
  const exits = [];
  const s = await startFor(t, { run, exit: (code) => exits.push(code) });
  const pending = s.client.callTool(stillCall());
  await entered.promise;

  let closed = false;
  s.service.server.once("close", () => { closed = true; });
  let resolved = false;
  const done = s.service.shutdown().then(() => { resolved = true; });
  assert.equal(signal.aborted, true, "shutdown aborts the in-flight render at once");
  assert.equal(s.service.server.listening, false, "no new connection is accepted once shutdown starts");
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(s.service.port, "127.0.0.1", () => { socket.destroy(); resolve(); });
    socket.on("error", reject);
  }), { code: "ECONNREFUSED" });
  // The render's processes are not yet verified gone, so its slot is held and shutdown waits.
  await ioTurns();
  assert.equal(resolved, false, "shutdown resolved before the slots drained");
  // The open connection still carries the aborted call's result.
  assert.equal((await pending).structuredContent?.category, "render_failed", "the aborted call still gets its result");
  await ioTurns();
  assert.equal(resolved, false, "shutdown resolved before the slots drained");
  cleanup.resolve({ verified: true, survivors: [] });
  await done;
  assert.equal(closed, true, "the server closed before shutdown resolved");
  assert.deepEqual(exits, [], "a drain in time never calls exit: the runner exits 0 once shutdown resolves");
  assert.equal(s.service.shutdown(), s.service.shutdown(), "shutdown runs once");
});

test("shutdown exits 70 when a slot is still held graceMs + verifyDeadlineMs + 2000 ms after it began", TIMED, async (t) => {
  // Small kill timings, so the bound elapses in about two seconds rather than seventeen. The 2000 ms margin is
  // fixed: it lets the kill's own unverified verdict, which lands after its grace and verification, come first.
  const killTiming = { graceMs: 40, verifyDeadlineMs: 60 };
  const bound = killTiming.graceMs + killTiming.verifyDeadlineMs + 2_000;
  const entered = latch();
  const run = async (_file, _args, options) => {
    entered.resolve();
    await abortOf(options.signal);
    // A cleanup that never settles: the slot is never released, so the render is never verified gone.
    return { exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "", cleanup: new Promise(() => {}) };
  };
  let resolved = false;
  let started;
  const exits = [];
  const exit = (code) => exits.push({ code, resolved, afterMs: performance.now() - started, logged: [...s.logs],
    left: fs.readdirSync(s.tempRoot) });
  const s = await startFor(t, { run, exit, killTiming });
  const pending = s.client.callTool(stillCall());
  await entered.promise;
  const [heldDir] = fs.readdirSync(s.tempRoot);
  assert.equal(fs.existsSync(path.join(s.tempRoot, heldDir, "props.json")), true, "the held render's props are on disk");
  fs.writeFileSync(path.join(s.tempRoot, "stray"), "x");
  started = performance.now();
  const done = s.service.shutdown().then(() => { resolved = true; });
  await pollFor(() => (exits.length > 0 ? true : undefined), "shutdown never called exit with a slot still held");
  const [at] = exits;
  assert.equal(at.code, 70, "an unverified render is never an exit 0");
  assert.equal(at.resolved, false, "exit(70) came before shutdown resolved, so the runner never reaches its exit(0)");
  assert.ok(at.afterMs >= bound - 50, `exit came ${Math.round(at.afterMs)} ms after shutdown began, before the ${bound} ms bound`);
  assert.ok(at.logged.some((line) => /1 render slot\(s\) still held after 2100 ms/.test(line)),
    `the stuck slot was logged before the exit: ${at.logged.join(" | ")}`);
  // As onUnverifiedCleanup does: the held render's cleanup never settles, so nothing else would take its props off disk.
  assert.deepEqual(at.left, [], "RENDER_TEMP_ROOT was emptied before the exit, the held render's props included");
  assert.ok(at.logged.some((line) => /emptying RENDER_TEMP_ROOT and exiting with code 70$/.test(line)),
    `the emptying was logged: ${at.logged.join(" | ")}`);
  await done;
  assert.equal(exits.length, 1);
  assert.equal(s.service.server.listening, false);
  assert.equal((await pending).structuredContent?.category, "render_failed");
});

test("startService passes its log to the audit sink: a failing append is logged once, and so is its recovery", TIMED,
  async (t) => {
    const s = await startFor(t);
    const auditPath = path.join(path.dirname(s.tempRoot), "log", "service-audit.jsonl");
    const auditLines = () => s.logs.filter((line) => line.startsWith("service: audit: "));
    // Appending to a directory fails, as a full volume would.
    fs.rmSync(auditPath, { force: true });
    fs.mkdirSync(auditPath);
    for (let i = 0; i < 3; i += 1) assert.notEqual((await s.client.callTool({ name: "list_templates" })).isError, true);
    assert.deepEqual(auditLines(),
      ["service: audit: appending to AUDIT_LOG_PATH failed (EISDIR): audit lines are dropped until an append succeeds"]);
    fs.rmdirSync(auditPath);
    await s.client.callTool({ name: "list_templates" });
    assert.deepEqual(auditLines().slice(1), ["service: audit: appending to AUDIT_LOG_PATH works again: 3 audit line(s) were dropped"]);
    assert.equal(fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).length, 1, "the next line was appended");
  });

test("renders get the 45 s deadline, the CLI's 60 s --timeout, and the kill's grace and verification deadline that the "
  + "shutdown bound is built from", TIMED, async (t) => {
  // The deadline and the --timeout are the plan's constants, never swapped: the CLI's own timeout must come after
  // the service's deadline. The kill's timings: without an injection, the constants; with one, the injected values.
  // Either way the bound tracks the kill.
  assert.ok(RENDER_STILL_DEADLINE_MS < RENDER_CLI_TIMEOUT_MS, "the deadline must come before the CLI's own timeout");
  const wired = { deadlineMs: RENDER_STILL_DEADLINE_MS, timeout: `--timeout=${RENDER_CLI_TIMEOUT_MS}` };
  for (const [killTiming, expected] of [
    [undefined, { ...wired, graceMs: RENDER_KILL_GRACE_MS, verifyDeadlineMs: RENDER_VERIFY_DEADLINE_MS }],
    [{ graceMs: 40, verifyDeadlineMs: 60 }, { ...wired, graceMs: 40, verifyDeadlineMs: 60 }],
  ]) {
    const seen = [];
    const inner = fakeRun();
    const run = (file, args, options) => {
      const timeouts = args.filter((arg) => arg.startsWith("--timeout="));
      seen.push({ deadlineMs: options.deadlineMs, timeout: timeouts.length === 1 ? timeouts[0] : timeouts,
        graceMs: options.graceMs, verifyDeadlineMs: options.verifyDeadlineMs });
      return inner(file, args, options);
    };
    const s = await startFor(t, killTiming === undefined ? { run } : { run, killTiming });
    const result = await s.client.callTool(stillCall());
    assert.deepEqual(Buffer.from(result.content[0].data, "base64"), makePng(256));
    assert.deepEqual(seen, [expected]);
  }
});

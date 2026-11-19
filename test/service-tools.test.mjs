// The service profile's four tools, their errors and the service audit (design 5.5, 5.8, review focus 4).
// The renders are fake (test/helpers/service-harness.mjs), so every case runs on any platform; the file-mode
// assertions run on POSIX only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectWithClaims, fakeRun, makePng } from "./helpers/service-harness.mjs";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "registry.js"))) {
  throw new Error("dist-service/service/registry.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// Each module directly: index.js is the service's runner, and importing it would start the service.
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const load = (name) => import(pathToFileURL(path.join(SERVICE, name)).href);
const { SERVICE_TOOLS, registerServiceTools } = await load("registry.js");
const { createAuditSink, AUDIT_FAILURE_LOG_INTERVAL_MS } = await load("audit.js");
const { loadPack } = await load("templates.js");
const { RenderSlots } = await load("slots.js");
const {
  SERVICE_PNG_CAP_BYTES, RENDER_STILL_DEADLINE_MS, RENDER_CLI_TIMEOUT_MS, RENDER_KILL_GRACE_MS, RENDER_VERIFY_DEADLINE_MS,
} = await load("constants.js");

const GOOD = path.join(REPO, "test", "fixtures", "packs", "good");
const PACK = loadPack(GOOD);
const SCOREBOARD = PACK.template("scoreboard");
const POSIX = process.platform !== "win32";
/** Never executed: the fake runner only records what it was given. */
const BROWSER = "/opt/chrome-headless-shell/chrome-headless-shell";
const CLI_SCRIPT = "/pack/node_modules/@remotion/cli/remotion-cli.js";
const TURKISH = "Beşiktaş · İstanbul · Şenol Güneş";
const LEAK = "LEAK=/pack/bundle/x C:\\x\\y remotion_init_project";
const LEAK_RE = /[A-Za-z]:\\|\/(pack|app|home|usr|tmp|var|mnt|root)\/|remotion_|viz_|LEAK/;
/** Every test has this timeout, so a render that never settles fails with the test's name. */
const TIMED = { timeout: 30_000 };

const NOW_S = Math.floor(Date.now() / 1000);
const CLAIMS = {
  v: 1, request_id: "req-5d0c", principal: "principal-a", tenant: "tenant-a", aud: "deploy-test",
  tool: "render_still", body_sha256: "0".repeat(64), iat: NOW_S, exp: NOW_S + 60,
};

/** Props the good pack's `scoreboard` accepts. */
const validProps = () => ({
  label: "Final", color: "#1A2B3C", players: [{ name: "Ada", number: 10 }], theme: "dark", opacity: 0.5,
});
const stillArgs = (extra = {}) => ({ template_id: "scoreboard", props: validProps(), ...extra });

/** The two keys' names, set to these sentinels where a test must show the values go nowhere. */
const KEY_SENTINELS = { IDENTITY_HMAC_KEY: "SENTINEL-IDENTITY-3b7e", AUDIT_HMAC_KEY: "SENTINEL-AUDIT-9c2d" };
/** What childEnv may pass: these names, and any REMOTION_* (design 5.6). */
const CHILD_ENV_ALLOWED = new Set(["PATH", "HOME", "LANG", "NODE_ENV", "TMPDIR"]);

/** Sets `vars` in process.env for the rest of the test, and restores every one of them afterwards. */
function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, vars);
}

/** The start of every operator log line the service writes for one call. */
const logPrefix = (tool, category) => `service: ${tool} ${category} request_id=${CLAIMS.request_id}: `;
/** A raw control character, or a line or paragraph separator: none may reach a log line or an error text. */
const RAW_CONTROL = /[\p{Cc}\u2028\u2029]/u;

/** Every wait polls its condition to this deadline. None sleeps a guessed duration. */
const WAIT_MS = 10_000;
const POLL_MS = 10;

/** Polls `probe` until it returns something other than undefined, and fails with `message` at the deadline. */
async function pollFor(probe, message) {
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) return assert.fail(typeof message === "function" ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** A few turns of the event loop: any already-settled promise chain has run by the time it resolves. */
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

/**
 * A server with the four tools over an in-memory client that carries CLAIMS. `ctx.tempRoot` is a fresh directory.
 * Tests swap `ctx.run` between calls; the tools read it on every call.
 */
async function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, "renders");
  fs.mkdirSync(tempRoot);
  const auditKey = randomBytes(32);
  const auditPath = path.join(root, "audit", "service-audit.jsonl");
  const unverified = [];
  // The operator log, captured so no test writes to stderr. A test that needs the stderr default passes log: undefined.
  const logLines = [];
  const ctx = {
    pack: PACK,
    slots: new RenderSlots(2),
    run: fakeRun(),
    cli: { file: process.execPath, prefixArgs: [CLI_SCRIPT] },
    browserExecutable: BROWSER,
    tempRoot,
    audit: createAuditSink(auditPath, auditKey),
    stillDeadlineMs: RENDER_STILL_DEADLINE_MS,
    cliTimeoutMs: RENDER_CLI_TIMEOUT_MS,
    graceMs: RENDER_KILL_GRACE_MS,
    verifyDeadlineMs: RENDER_VERIFY_DEADLINE_MS,
    pngCapBytes: SERVICE_PNG_CAP_BYTES,
    shutdown: new AbortController().signal,
    onUnverifiedCleanup: () => unverified.push({
      workDirs: fs.readdirSync(tempRoot), inUse: ctx.slots.inUse, logged: [...logLines],
    }),
    log: (line) => logLines.push(line),
    ...overrides,
  };
  const server = new McpServer({ name: "service-tools-test", version: "0.0.0" });
  registerServiceTools(server, ctx);
  const client = await connectWithClaims(server, CLAIMS);
  t.after(() => client.close());
  const workDirs = () => fs.readdirSync(tempRoot);
  const auditLines = () => (fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "")
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  return { ctx, server, client, tempRoot, auditPath, auditKey, unverified, logLines, workDirs, auditLines };
}

/** The identity fields every audit line of a call made through `connectWithClaims` carries. */
function assertIdentity(event) {
  assert.equal(event.request_id, CLAIMS.request_id, `${event.tool}: request_id`);
  assert.equal(event.principal, CLAIMS.principal, `${event.tool}: principal`);
  assert.equal(event.tenant, CLAIMS.tenant, `${event.tool}: tenant`);
}

const call = (client, name, args) => client.callTool(args === undefined ? { name } : { name, arguments: args });
const textOf = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

function assertCategory(result, category) {
  assert.equal(result.isError, true, `expected ${category}, got ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(result.structuredContent?.category, category);
  assert.match(textOf(result), new RegExp(`^${category}: `));
}

/** Polls until every slot is free and the temp root holds no work dir. */
async function settled(s) {
  await pollFor(() => (s.ctx.slots.inUse === 0 && s.workDirs().length === 0 ? true : undefined),
    () => `slots in use: ${s.ctx.slots.inUse}; work dirs: ${s.workDirs().join(", ")}`);
}

/** The PNG of a successful render_still. */
function pngOf(result) {
  assert.notEqual(result.isError, true, `render_still failed: ${textOf(result)}`);
  assert.equal(result.content.length, 1);
  const [image] = result.content;
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  return Buffer.from(image.data, "base64");
}

test("tools/list returns exactly SERVICE_TOOLS in order", TIMED, async (t) => {
  const s = await setup(t);
  assert.deepEqual([...SERVICE_TOOLS], ["list_templates", "render_still", "render_video_start", "render_job_status"]);
  assert.ok(Object.isFrozen(SERVICE_TOOLS));
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [...SERVICE_TOOLS]);

  const still = tools.find((tool) => tool.name === "render_still").inputSchema;
  assert.equal(still.additionalProperties, false, "render_still's schema is strict");
  assert.deepEqual(Object.keys(still.properties).sort(), ["frame", "props", "template_id"]);
  assert.deepEqual([...still.required].sort(), ["props", "template_id"]);
  const status = tools.find((tool) => tool.name === "render_job_status").inputSchema;
  assert.deepEqual(Object.keys(status.properties), ["job_id"]);
  for (const name of ["list_templates", "render_video_start"]) {
    assert.deepEqual(tools.find((tool) => tool.name === name).inputSchema.properties ?? {}, {}, `${name} takes nothing`);
  }

  // ajv runs with allErrors off, so invalid_props names the first failing prop, never every one; the description says so.
  const description = tools.find((tool) => tool.name === "render_still").description;
  assert.ok(description.includes("invalid_props (with the first failing JSON pointer)"), description);
  assert.doesNotMatch(description, /pointers of the failing props/);
  // Deviation 2 (ADR-5): arguments the input schema refuses get the SDK's own error, not a category.
  assert.match(description, /arguments that fail this input schema get the SDK's own validation error instead\.$/,
    description);
  const twoBad = await call(s.client, "render_still", stillArgs({ props: { ...validProps(), label: 7, theme: "neon" } }));
  assert.deepEqual(twoBad.structuredContent, { category: "invalid_props", paths: ["/label"] }, "two props fail, one is named");
});

test("render_still's strict schema refuses an unknown argument and runs nothing", TIMED, async (t) => {
  const s = await setup(t);
  let calls = 0;
  s.ctx.run = fakeRun({ onCall: () => { calls += 1; } });
  const result = await call(s.client, "render_still", stillArgs({ tenant: "tenant-b" }));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Input validation error/);
  assert.equal(result.structuredContent, undefined, "the SDK's own error, as the description says, not a category");
  assert.equal(calls, 0);
  // Positive control: the same call without the extra key renders.
  pngOf(await call(s.client, "render_still", stillArgs()));
  assert.equal(calls, 1);
});

test("list_templates works with arguments omitted and returns id, width, height and propsSchema only", TIMED, async (t) => {
  const s = await setup(t);
  const result = await call(s.client, "list_templates");
  assert.notEqual(result.isError, true, textOf(result));
  const expected = PACK.manifest.templates.map((entry) => ({
    id: entry.id, width: entry.width, height: entry.height, propsSchema: entry.propsSchema,
  }));
  assert.deepEqual(result.structuredContent, { templates: expected });
  assert.deepEqual(JSON.parse(textOf(result)), { templates: expected });
  for (const entry of result.structuredContent.templates) {
    assert.deepEqual(Object.keys(entry), ["id", "width", "height", "propsSchema"]);
  }
  assert.deepEqual(PACK.manifest.templates.map((entry) => entry.id), ["scoreboard", "swatch"], "the manifest is untouched");

  // A tool with no input schema gets (extra) alone from the SDK; its audit line still carries the caller's identity.
  const lines = s.auditLines();
  assert.deepEqual(lines.map((e) => [e.tool, e.outcome]), [["list_templates", "ok"]]);
  assertIdentity(lines[0]);
});

test("render_still returns the PNG as image content and removes its work dir", TIMED, async (t) => {
  const s = await setup(t);
  let dirDuringRun;
  s.ctx.run = fakeRun({
    pngBytes: 1_000,
    onCall: (_file, _args, options) => { dirDuringRun = options.cwd; },
  });
  const png = pngOf(await call(s.client, "render_still", stillArgs({ frame: 3 })));
  assert.deepEqual(png, makePng(1_000));
  assert.equal(path.dirname(dirDuringRun), s.tempRoot);
  assert.match(path.basename(dirDuringRun), /^r-/);
  await settled(s);
  assert.equal(fs.existsSync(dirDuringRun), false);
  assert.deepEqual(s.unverified, [], "a verified cleanup never reports");
});

test("boundaries are permitted at the limit and refused one past it", TIMED, async (t) => {
  const s = await setup(t);
  let calls = 0;
  const counting = (opts) => fakeRun({ ...opts, onCall: () => { calls += 1; } });

  s.ctx.run = counting({});
  pngOf(await call(s.client, "render_still", stillArgs({ frame: SCOREBOARD.maxFrames - 1 })));
  assert.equal(calls, 1);
  assertCategory(await call(s.client, "render_still", stillArgs({ frame: SCOREBOARD.maxFrames })), "frame_out_of_range");
  assert.equal(calls, 1, "a frame out of range runs nothing");
  // swatch has maxFrames 1: frame 0 is its only frame.
  assertCategory(await call(s.client, "render_still", { template_id: "swatch", frame: 1, props: { color: "#000000" } }),
    "frame_out_of_range");
  await settled(s);

  // REVIEW FOCUS 4: a PNG of exactly the cap returns; one byte over is refused, its work dir removed, its slot freed.
  s.ctx.run = counting({ pngBytes: SERVICE_PNG_CAP_BYTES });
  const atCap = pngOf(await call(s.client, "render_still", stillArgs()));
  assert.equal(atCap.length, SERVICE_PNG_CAP_BYTES);
  await settled(s);

  s.ctx.run = counting({ pngBytes: SERVICE_PNG_CAP_BYTES + 1 });
  const over = await call(s.client, "render_still", stillArgs());
  assertCategory(over, "output_too_large");
  assert.deepEqual(over.content.filter((c) => c.type === "image"), []);
  await settled(s);
  assert.equal(calls, 3);
});

test("unknown template and invalid props return their category and no render runs", TIMED, async (t) => {
  const s = await setup(t);
  let calls = 0;
  s.ctx.run = fakeRun({ onCall: () => { calls += 1; } });

  assertCategory(await call(s.client, "render_still", { template_id: "nope", props: validProps() }), "unknown_template");
  // An id that is an Object.prototype name is still unknown.
  assertCategory(await call(s.client, "render_still", { template_id: "__proto__", props: {} }), "unknown_template");
  assertCategory(await call(s.client, "render_still", { template_id: "scoreboard", props: { label: "x" } }), "invalid_props");
  assert.equal(calls, 0);
  assert.equal(s.ctx.slots.inUse, 0);
  assert.deepEqual(s.workDirs(), []);
});

test("invalid_props text and structuredContent carry pointers and never the value", TIMED, async (t) => {
  const s = await setup(t);
  const value = "CANARY-91d2-far-too-long";
  const cases = [
    [{ ...validProps(), short: value }, ["/short"]],
    [{ ...validProps(), [value]: 1 }, [`/${value}`]], // the caller's own key is the pointer, never a value
    [{ ...validProps(), players: [{ name: value, number: 500 }] }, ["/players/0/number"]],
    [{ ...validProps(), label: undefined }, ["/label"]],
  ];
  for (const [props, paths] of cases) {
    const result = await call(s.client, "render_still", { template_id: "scoreboard", props });
    assertCategory(result, "invalid_props");
    assert.deepEqual(result.structuredContent, { category: "invalid_props", paths });
    for (const pointer of paths) assert.ok(textOf(result).includes(pointer), `${pointer} in ${textOf(result)}`);
    if (!paths.some((pointer) => pointer.includes(value))) {
      assert.ok(!textOf(result).includes(value), "the value never appears");
      assert.ok(!JSON.stringify(result.structuredContent).includes(value));
    }
    assert.ok(!textOf(result).includes("must"), "no ajv message");
  }
});

test("render_busy when every slot is taken", TIMED, async (t) => {
  const s = await setup(t);
  const gate = latch();
  const bothIn = latch();
  let entered = 0;
  s.ctx.run = fakeRun({
    hold: gate.promise,
    onCall: () => {
      entered += 1;
      if (entered === 2) bothIn.resolve();
      if (entered > 2) gate.resolve(); // a third render that got in fails the assertions below instead of hanging
    },
  });

  const first = call(s.client, "render_still", stillArgs());
  const second = call(s.client, "render_still", stillArgs());
  await bothIn.promise;
  assert.equal(s.ctx.slots.inUse, 2);
  assertCategory(await call(s.client, "render_still", stillArgs()), "render_busy");
  assert.equal(entered, 2, "the refused call ran nothing");
  assert.equal(s.workDirs().length, 2, "the refused call made no work dir");

  gate.resolve();
  pngOf(await first);
  pngOf(await second);
  await settled(s);
  s.ctx.run = fakeRun();
  pngOf(await call(s.client, "render_still", stillArgs()));
  await settled(s);
});

test("render_timeout returns at the deadline while the slot stays held until cleanup settles", TIMED, async (t) => {
  const s = await setup(t);
  const cleanupGate = latch();
  let options;
  s.ctx.run = fakeRun({
    timedOut: true,
    cleanup: cleanupGate.promise.then(() => ({ verified: true, survivors: [] })),
    onCall: (_file, _args, o) => { options = o; },
  });
  assertCategory(await call(s.client, "render_still", stillArgs()), "render_timeout");
  assert.equal(options.deadlineMs, s.ctx.stillDeadlineMs);
  assert.equal(options.graceMs, s.ctx.graceMs);
  assert.equal(options.verifyDeadlineMs, s.ctx.verifyDeadlineMs);

  await ioTurns();
  assert.equal(s.ctx.slots.inUse, 1, "the slot is held while the kill runs");
  assert.equal(s.workDirs().length, 1, "the work dir stays while the kill runs");
  cleanupGate.resolve();
  await settled(s);
  assert.deepEqual(s.unverified, []);
});

test("unverified cleanup calls onUnverifiedCleanup", TIMED, async (t) => {
  const s = await setup(t);
  s.ctx.run = fakeRun({
    cleanup: Promise.resolve({ verified: false, survivors: [4242], cause: "recorded processes still alive: 4242" }),
  });
  pngOf(await call(s.client, "render_still", stillArgs()));
  await pollFor(() => (s.unverified.length > 0 ? true : undefined), "onUnverifiedCleanup was never called");
  await settled(s);
  assert.equal(s.unverified.length, 1);
  assert.deepEqual(s.unverified[0].workDirs, [], "the props were off disk before onUnverifiedCleanup ran");
  assert.equal(s.unverified[0].inUse, 1, "the slot was still held when onUnverifiedCleanup ran");
});

test("the CLI is called with the manifest size, the frame, the pinned browser, a --timeout above the deadline, "
  + "props as a 0600 file, and an allowlisted env", TIMED, async (t) => {
  const sentinels = KEY_SENTINELS;
  // Besides the keys, a name no allowlist rule matches, so a pass-through of process.env shows up below.
  withEnv(t, { ...sentinels, SERVICE_TOOLS_TEST_UNLISTED: "unlisted" });

  const s = await setup(t);
  let seen;
  s.ctx.run = fakeRun({
    onCall: (file, args, options) => {
      const propsFile = path.join(options.cwd, "props.json");
      seen = {
        file, args, options,
        props: JSON.parse(fs.readFileSync(propsFile, "utf8")),
        fileMode: fs.statSync(propsFile).mode & 0o777,
        dirMode: fs.statSync(options.cwd).mode & 0o777,
      };
    },
  });
  const props = validProps();
  pngOf(await call(s.client, "render_still", { template_id: "scoreboard", frame: 12, props }));

  assert.equal(seen.file, s.ctx.cli.file);
  assert.deepEqual(seen.args.slice(0, 1), s.ctx.cli.prefixArgs);
  const argv = seen.args.slice(1);
  assert.deepEqual(argv.slice(0, 4), ["still", PACK.bundleDir, SCOREBOARD.compositionId, "out.png"]);
  for (const flag of [`--width=${SCOREBOARD.width}`, `--height=${SCOREBOARD.height}`, "--frame=12",
    `--browser-executable=${BROWSER}`, "--props=props.json"]) {
    assert.ok(argv.includes(flag), `${flag} in ${argv.join(" ")}`);
  }
  const timeouts = argv.filter((arg) => arg.startsWith("--timeout="));
  assert.deepEqual(timeouts, [`--timeout=${s.ctx.cliTimeoutMs}`], "exactly one --timeout, equal to ctx.cliTimeoutMs");
  assert.ok(s.ctx.cliTimeoutMs > s.ctx.stillDeadlineMs);
  assert.ok(!argv.some((arg) => arg.includes("{") || arg.includes("Final")), "no JSON in argv");

  assert.deepEqual(seen.props, props);
  assert.equal(path.dirname(seen.options.cwd), s.tempRoot);
  assert.equal(seen.options.env.TMPDIR, seen.options.cwd);
  for (const [name, value] of Object.entries(sentinels)) {
    assert.ok(!(name in seen.options.env), `${name} is not passed`);
    assert.ok(!Object.values(seen.options.env).includes(value), `${name}'s value is not passed`);
  }
  for (const name of Object.keys(seen.options.env)) {
    assert.ok(CHILD_ENV_ALLOWED.has(name) || name.startsWith("REMOTION_"), `${name} is not on the allowlist`);
  }
  if (POSIX) {
    assert.equal(seen.fileMode, 0o600);
    assert.equal(seen.dirMode, 0o700);
  }
  await settled(s);
});

test("the run's signal aborts when the service shuts down", TIMED, async (t) => {
  const shutdown = new AbortController();
  const s = await setup(t, { shutdown: shutdown.signal });
  const entered = latch();
  const aborted = latch();
  let signal;
  s.ctx.run = fakeRun({
    aborted: true,
    hold: aborted.promise,
    onCall: (_file, _args, options) => {
      signal = options.signal;
      options.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
    },
  });
  const pending = call(s.client, "render_still", stillArgs());
  await entered.promise;
  assert.equal(signal.aborted, false);
  shutdown.abort();
  // The link is an abort listener, and dispatch is synchronous.
  assert.equal(signal.aborted, true, "the run's signal aborts with the service's shutdown");
  assertCategory(await pending, "render_failed");
  await settled(s);
});

test("each render links to the shutdown signal by one listener, removed once its run settles", TIMED, async (t) => {
  // AbortSignal.any left a record on the long-lived shutdown signal per render that nothing ever reclaimed.
  const shutdown = new AbortController();
  const s = await setup(t, { shutdown: shutdown.signal });
  const listeners = () => getEventListeners(shutdown.signal, "abort").length;
  const baseline = listeners();
  const during = [];
  const record = (_file, _args, options) => during.push({ shutdown: listeners(), aborted: options.signal.aborted });
  // Every way a run settles: a PNG, a failed exit, a timeout, an abort, and a run that throws.
  const runs = [
    fakeRun({ onCall: record }),
    fakeRun({ onCall: record, exitCode: 1 }),
    fakeRun({ onCall: record, timedOut: true }),
    fakeRun({ onCall: record, aborted: true }),
    fakeRun({ onCall: record, throwError: new Error("spawn failed") }),
  ];
  for (let round = 0; round < 3; round += 1) {
    for (const run of runs) {
      s.ctx.run = run;
      await call(s.client, "render_still", stillArgs());
      await settled(s);
    }
  }
  assert.deepEqual(during, Array.from({ length: 15 }, () => ({ shutdown: baseline + 1, aborted: false })),
    "one listener while each run is in flight");
  assert.equal(listeners(), baseline, "every listener is removed once its run settles");

  // A render refused before it runs adds none.
  assertCategory(await call(s.client, "render_still", stillArgs({ frame: SCOREBOARD.maxFrames })), "frame_out_of_range");
  assert.equal(listeners(), baseline);
  // And the shutdown still reaches a render that is in flight.
  const entered = latch();
  let signal;
  s.ctx.run = fakeRun({ aborted: true, hold: entered.promise.then(() => abortOf(signal)),
    onCall: (_file, _args, options) => { signal = options.signal; entered.resolve(); } });
  const pending = call(s.client, "render_still", stillArgs());
  await entered.promise;
  shutdown.abort();
  assert.equal(signal.aborted, true);
  assertCategory(await pending, "render_failed");
  await settled(s);
  assert.equal(listeners(), baseline);
});

test("failures map to categories, and nothing escapes", TIMED, async (t) => {
  const s = await setup(t);
  const writeEmpty = (_file, _args, options) => fs.writeFileSync(path.join(options.cwd, "out.png"), "");
  const modes = [
    ["exit code 1", { exitCode: 1, outputTail: LEAK }, "render_failed"],
    ["killed by a signal", { exitCode: null, signal: "SIGKILL" }, "render_failed"],
    ["no out.png", { noFile: true }, "render_failed"],
    ["an empty out.png", { noFile: true, onCall: writeEmpty }, "render_failed"],
    ["the runner throws", { throwError: new Error(LEAK) }, "internal"],
  ];
  for (const [name, opts, category] of modes) {
    s.ctx.run = fakeRun(opts);
    const result = await call(s.client, "render_still", stillArgs());
    assertCategory(result, category);
    assert.deepEqual(result.content.filter((c) => c.type === "image"), [], name);
    await settled(s);
  }

  // A client that disconnects mid-render: the run aborts, and the server sends nothing back.
  const c = await setup(t);
  const entered = latch();
  const aborted = latch();
  c.ctx.run = fakeRun({
    aborted: true,
    hold: aborted.promise,
    onCall: (_file, _args, options) => {
      options.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
    },
  });
  const transport = c.server.server.transport;
  const sent = [];
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  const pending = call(c.client, "render_still", stillArgs());
  await entered.promise;
  await c.client.close();
  await assert.rejects(pending);
  await settled(c);
  const event = await pollFor(() => c.auditLines().find((e) => e.tool === "render_still"), "no audit line");
  await ioTurns();
  assert.deepEqual(sent.filter((message) => "id" in message), [], "no result to a closed connection");
  // The SDK guarantees the silence above; what the service decided is only in its audit.
  assert.deepEqual(c.auditLines().filter((e) => e.tool === "render_still").map((e) => [e.outcome, e.category]),
    [["error", "render_failed"]], "the aborted call is audited once, as render_failed");
  assertIdentity(event);
});

test("no caller-visible text leaks a path, a tool name or the CLI output", TIMED, async (t) => {
  // Positive control: the regex catches every part of the raw string.
  assert.match(LEAK, LEAK_RE);
  for (const part of LEAK.split(" ")) assert.match(part, LEAK_RE);

  const s = await setup(t);
  const results = [];
  const record = async (label, promise) => results.push([label, await promise]);
  const still = (args) => call(s.client, "render_still", args);

  await record("unknown_template", still({ template_id: "/pack/bundle", props: {} }));
  await record("frame_out_of_range", still(stillArgs({ frame: 10_000 })));
  await record("invalid_props", still({ template_id: "scoreboard", props: { ...validProps(), label: LEAK } }));
  const renders = [
    ["render_timeout", { timedOut: true }],
    ["render_failed", { exitCode: 1 }],
    ["render_failed", { noFile: true }],
    ["internal", { throwError: new Error(LEAK) }],
    ["output_too_large", { pngBytes: SERVICE_PNG_CAP_BYTES + 1 }],
  ];
  for (const [category, opts] of renders) {
    s.ctx.run = fakeRun({ ...opts, outputTail: LEAK });
    await record(category, still(stillArgs()));
    await settled(s); // each slot frees after its response, so the next render is not refused as busy
  }

  const gate = latch();
  const bothIn = latch();
  let entered = 0;
  s.ctx.run = fakeRun({ hold: gate.promise, onCall: () => { entered += 1; if (entered === 2) bothIn.resolve(); } });
  const held = [still(stillArgs()), still(stillArgs())];
  await bothIn.promise;
  await record("render_busy", still(stillArgs()));
  gate.resolve();
  await Promise.all(held);
  await settled(s);

  await record("not_implemented", call(s.client, "render_video_start"));
  await record("not_implemented", call(s.client, "render_job_status", { job_id: "/pack/x" }));

  // A throw outside any render: a pack whose manifest cannot be read.
  const pack = s.ctx.pack;
  s.ctx.pack = { ...pack, manifest: { get templates() { throw new Error(LEAK); } } };
  await record("internal", call(s.client, "list_templates"));
  s.ctx.pack = pack;

  assert.equal(results.length, 12);
  for (const [category, result] of results) {
    assertCategory(result, category);
    assert.doesNotMatch(textOf(result), LEAK_RE, `${category} text: ${textOf(result)}`);
    assert.doesNotMatch(JSON.stringify(result.structuredContent), LEAK_RE, `${category} structuredContent`);
  }
});

test("the audit holds keyed hashes and sizes, and never the payload", TIMED, async (t) => {
  const s = await setup(t);
  const canary = "CANARY-7f3a";
  s.ctx.run = fakeRun({ pngBytes: 2_048 });
  const args = {
    template_id: "scoreboard",
    frame: 2,
    props: { ...validProps(), label: canary, players: [{ name: TURKISH.slice(0, 40), number: 7 }] },
  };
  pngOf(await call(s.client, "render_still", args));
  await call(s.client, "render_still", { template_id: "scoreboard", props: { ...validProps(), short: canary } });
  s.ctx.run = fakeRun({ throwError: new Error(LEAK) });
  await call(s.client, "render_still", stillArgs());
  await settled(s);

  const lines = s.auditLines();
  const ok = lines.filter((e) => e.outcome === "ok");
  assert.equal(ok.length, 1);
  const [event] = ok;
  const json = JSON.stringify(args);
  const hmac = (data) => createHmac("sha256", s.auditKey).update(data).digest("hex");
  assert.equal(event.params_hash, hmac(json));
  assert.equal(event.params_bytes, Buffer.byteLength(json));
  assert.notEqual(event.params_bytes, json.length, "the Turkish props make bytes differ from characters");
  assert.equal(event.result_bytes, 2_048);
  assert.equal(event.result_hash, hmac(makePng(2_048)));
  assert.equal(event.tool, "render_still");
  assert.equal(event.request_id, CLAIMS.request_id);
  assert.equal(event.principal, CLAIMS.principal);
  assert.equal(event.tenant, CLAIMS.tenant);
  assert.equal(typeof event.duration_ms, "number");
  assert.ok(!Number.isNaN(Date.parse(event.ts)));
  assert.equal(event.category, undefined);

  const errors = lines.filter((e) => e.outcome === "error").map((e) => e.category);
  assert.deepEqual(errors, ["invalid_props", "internal"]);

  const file = fs.readFileSync(s.auditPath, "utf8");
  for (const secret of [canary, "Beşiktaş", "Şenol", "LEAK", s.auditKey.toString("hex")]) {
    assert.ok(!file.includes(secret), `${secret} is not in the audit`);
  }
  if (POSIX) assert.equal(fs.statSync(s.auditPath).mode & 0o777, 0o600);
});

test("a failing audit append logs one operator line per streak and one on recovery, rate-limited, never the line",
  TIMED, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-audit-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "audit", "service-audit.jsonl");
    const lines = [];
    let now = 0;
    const sink = createAuditSink(file, randomBytes(32), { log: (line) => lines.push(line), nowMs: () => now });
    const event = { ts: new Date(0).toISOString(), outcome: "ok", request_id: "CANARY-req", principal: "CANARY-p",
      tenant: "CANARY-t", tool: "render_still", params_hash: "ab".repeat(32), params_bytes: 10 };
    // Appending to a directory throws (EISDIR), as appending to a full volume throws ENOSPC. The lines appended so far
    // are counted before the file makes way for the directory.
    let appended = 0;
    const linesInFile = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);
    const fail = () => {
      appended += linesInFile();
      fs.rmSync(file, { force: true });
      fs.mkdirSync(file);
    };
    const heal = () => fs.rmdirSync(file);
    const failed = "service: audit: appending to AUDIT_LOG_PATH failed (EISDIR): audit lines are dropped until an "
      + "append succeeds";
    const back = (n) => `service: audit: appending to AUDIT_LOG_PATH works again: ${n} audit line(s) were dropped`;
    assert.equal(typeof AUDIT_FAILURE_LOG_INTERVAL_MS, "number", "audit.js exports its rate limit");

    sink.record(event);
    assert.deepEqual(lines, [], "a working append logs nothing");
    fail();
    // A flood of failures is one streak and one line.
    for (let i = 0; i < 1_000; i += 1) sink.record(event);
    assert.deepEqual(lines, [failed]);
    heal();
    sink.record(event);
    sink.record(event);
    assert.deepEqual(lines, [failed, back(1_000)], "the recovery is logged once, with what was lost");

    // A volume that flaps within the interval: each streak is counted, none is logged.
    now += AUDIT_FAILURE_LOG_INTERVAL_MS - 1;
    for (let i = 0; i < 50; i += 1) {
      fail();
      sink.record(event);
      sink.record(event);
      heal();
      sink.record(event);
    }
    assert.deepEqual(lines, [failed, back(1_000)], "a flapping volume cannot flood the log");
    // The first append that works once the interval has passed reports what those streaks dropped.
    now += 1;
    sink.record(event);
    assert.deepEqual(lines, [failed, back(1_000), back(100)]);
    sink.record(event);
    assert.equal(lines.length, 3, "nothing is reported twice");
    // Past the interval, a new streak is logged again.
    fail();
    sink.record(event);
    heal();
    sink.record(event);
    assert.deepEqual(lines.slice(3), [failed, back(1)]);

    for (const line of lines) {
      assert.doesNotMatch(line, /CANARY|service-audit|\n/, `the audit line's content or its path: ${line}`);
    }
    // Every append that could succeed did: 1 + 2 + 50 + 1 + 1 + 1.
    assert.equal(appended + linesInFile(), 56);

    // A log that throws changes nothing: record() still never throws.
    const quiet = createAuditSink(path.join(root, "audit"), randomBytes(32), { log: () => { throw new Error("down"); } });
    assert.doesNotThrow(() => quiet.record(event));
  });

test("a failure streak held back by the rate limit is logged once the interval has passed, so the last line is never "
  + "a false recovery", TIMED, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "audit", "service-audit.jsonl");
  const lines = [];
  let now = 0;
  const sink = createAuditSink(file, randomBytes(32), { log: (line) => lines.push(line), nowMs: () => now });
  const event = { ts: new Date(0).toISOString(), outcome: "ok", request_id: "CANARY-req", tool: "list_templates" };
  // Appending to a directory throws EISDIR, as a full volume throws ENOSPC.
  const fail = () => {
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
  };
  const heal = () => fs.rmdirSync(file);
  const failed = "service: audit: appending to AUDIT_LOG_PATH failed (EISDIR): audit lines are dropped until an "
    + "append succeeds";
  const back = (n) => `service: audit: appending to AUDIT_LOG_PATH works again: ${n} audit line(s) were dropped`;
  const SECOND = 1_000;

  // Failed at 0 s, works again at 10 s, failed again at 30 s: inside the interval, so that streak is held back.
  fail();
  sink.record(event);
  now = 10 * SECOND;
  heal();
  sink.record(event);
  now = 30 * SECOND;
  fail();
  sink.record(event);
  assert.deepEqual(lines, [failed, back(1)], "a streak inside the interval is counted, not logged");
  // Still failing, one append per second, up to just before the interval since the last failed line.
  for (now = 31 * SECOND; now < AUDIT_FAILURE_LOG_INTERVAL_MS; now += SECOND) sink.record(event);
  assert.deepEqual(lines, [failed, back(1)], "still inside the interval: nothing more is logged");

  // The interval has passed and the volume still fails: the held-back streak gets its failed line.
  now = AUDIT_FAILURE_LOG_INTERVAL_MS;
  sink.record(event);
  assert.deepEqual(lines, [failed, back(1), failed], "the held-back streak is logged once the interval has passed");
  assert.equal(lines.at(-1), failed, "the operator's last line says appends are failing, not that they work");
  // Only once: an hour more of failing appends adds no line.
  for (let i = 0; i < 3_600; i += 1) {
    now += SECOND;
    sink.record(event);
  }
  assert.deepEqual(lines, [failed, back(1), failed], "one failed line per streak");
  // Its recovery reports every line dropped since the last recovery line: 1 + 29 + 1 + 3 600.
  heal();
  sink.record(event);
  assert.deepEqual(lines, [failed, back(1), failed, back(3_631)]);
  for (const line of lines) assert.doesNotMatch(line, /CANARY|service-audit/, `the event or the path: ${line}`);
});

test("render_video_start and render_job_status return not_implemented", TIMED, async (t) => {
  const s = await setup(t);
  assertCategory(await call(s.client, "render_video_start"), "not_implemented");
  assertCategory(await call(s.client, "render_job_status", { job_id: "job-1" }), "not_implemented");
  const lines = s.auditLines();
  assert.deepEqual(lines.map((e) => [e.tool, e.outcome, e.category]), [
    ["render_video_start", "error", "not_implemented"],
    ["render_job_status", "error", "not_implemented"],
  ]);
  for (const event of lines) assertIdentity(event);
});

test("a throwing onUnverifiedCleanup keeps the slot held and rethrows where nothing catches it", TIMED, async (t) => {
  const thrown = new Error("onUnverifiedCleanup failed before it could exit");
  let calls = 0;
  const s = await setup(t, { onUnverifiedCleanup: () => { calls += 1; throw thrown; } });
  // node:test fails a test on any 'uncaughtException' event. The capture callback receives the exception instead of
  // that event, so this test can assert on it. Only this test sets it, and only for its own duration.
  const uncaught = [];
  process.setUncaughtExceptionCaptureCallback((err) => uncaught.push(err));
  t.after(() => process.setUncaughtExceptionCaptureCallback(null));
  s.ctx.run = fakeRun({
    cleanup: Promise.resolve({ verified: false, survivors: [4242], cause: "recorded processes still alive: 4242" }),
  });
  pngOf(await call(s.client, "render_still", stillArgs()));
  // Whichever comes first: the error surfacing, or the slot freeing (which would be the bug).
  await pollFor(() => (uncaught.length > 0 || s.ctx.slots.inUse === 0 ? true : undefined),
    "the handler's error never surfaced and the slot never freed");
  await ioTurns();
  assert.equal(calls, 1);
  assert.equal(uncaught.length, 1, "the handler's error surfaces as an uncaught exception");
  assert.equal(uncaught[0], thrown);
  assert.equal(s.ctx.slots.inUse, 1, "the slot stays held: the render's processes may still be alive");
  assert.deepEqual(s.workDirs(), [], "the props were off disk first");
  assert.ok(s.logLines.includes(`${logPrefix("render_still", "internal")}cleanup unverified: `
    + "recorded processes still alive: 4242"), s.logLines.join("\n"));
});

test("a work dir that cannot be removed is logged by its error code, never its path", TIMED, async (t) => {
  const s = await setup(t);
  // The injected failure: fs.promises.rm, which tools.js calls through the same object, fails for work dirs only.
  const realRm = fsp.rm;
  t.after(() => { fsp.rm = realRm; });
  const rmOptions = [];
  let failWith;
  fsp.rm = async (target, options) => {
    if (typeof target === "string" && path.dirname(target) === s.tempRoot) {
      rmOptions.push(options);
      if (failWith !== undefined) {
        // As a real one does, the error's message names the path.
        throw Object.assign(new Error(`${failWith}: cannot remove "${target}"`), { code: failWith, path: target });
      }
    }
    return realRm(target, options);
  };
  const leftovers = () => {
    const dirs = s.workDirs();
    for (const dir of dirs) fs.rmSync(path.join(s.tempRoot, dir), { recursive: true, force: true });
    return dirs;
  };
  const freed = () => pollFor(() => (s.ctx.slots.inUse === 0 ? true : undefined), "the slot never freed");

  failWith = "EBUSY";
  pngOf(await call(s.client, "render_still", stillArgs()));
  await freed();
  assert.deepEqual(rmOptions, [{ recursive: true, force: true, maxRetries: 3 }]);
  const [left] = leftovers();
  assert.deepEqual(s.logLines, [`${logPrefix("render_still", "internal")}work dir removal failed: EBUSY`]);
  for (const line of s.logLines) {
    assert.ok(!line.includes(left) && !line.includes(s.tempRoot), `no path in ${line}`);
  }

  // A dir that is already gone is not a failure.
  failWith = "ENOENT";
  pngOf(await call(s.client, "render_still", stillArgs()));
  await freed();
  leftovers();
  assert.equal(s.logLines.length, 1, "ENOENT is not logged");

  // On the unverified path the failure is logged, and onUnverifiedCleanup still runs after it.
  failWith = "EACCES";
  s.ctx.run = fakeRun({ cleanup: Promise.resolve({ verified: false, survivors: [7], cause: "pid 7 alive" }) });
  pngOf(await call(s.client, "render_still", stillArgs()));
  await pollFor(() => (s.unverified.length > 0 ? true : undefined), "onUnverifiedCleanup was skipped after a failed rm");
  leftovers();
  assert.deepEqual(s.unverified[0].logged.slice(1), [
    `${logPrefix("render_still", "internal")}cleanup unverified: pid 7 alive`,
    `${logPrefix("render_still", "internal")}work dir removal failed: EACCES`,
  ]);
});

test("the operator log gets one line per internal throw, render_failed and unverified cleanup; callers see none",
  TIMED, async (t) => {
    withEnv(t, KEY_SENTINELS);
    const s = await setup(t);
    const results = [];
    const still = async () => {
      results.push(await call(s.client, "render_still", stillArgs()));
      await settled(s);
    };

    s.ctx.run = fakeRun({ throwError: new Error("LOGMARK-throw\nsecond line") });
    await still();
    // A bidi override and a zero-width space are format characters (Cf): raw, they would reorder or hide the line.
    const tail = "LOGMARK-tail\r\n\u001b[31mred\u2028back\\slash\u0085\u202eright-to-left\u200b";
    s.ctx.run = fakeRun({ exitCode: 1, outputTail: tail });
    await still();
    // A tail that escapes to far more than the bound: its end is what stays.
    s.ctx.run = fakeRun({ noFile: true, outputTail: `LOGMARK-start${"\u0007".repeat(1_000)}END` });
    await still();
    s.ctx.run = fakeRun({ cleanup: Promise.resolve({ verified: false, survivors: [1], cause: "LOGMARK-cause\n1 alive" }) });
    await still();
    assert.equal(s.unverified.length, 1);
    const pack = s.ctx.pack;
    s.ctx.pack = { ...pack, manifest: { get templates() { throw new Error("LOGMARK-manifest"); } } };
    results.push(await call(s.client, "list_templates"));
    s.ctx.pack = pack;

    const [thrown, failed, bounded, unverified, listed, ...rest] = s.logLines;
    assert.deepEqual(rest, [], s.logLines.join("\n"));
    assert.equal(thrown, `${logPrefix("render_still", "internal")}LOGMARK-throw\\u000asecond line`);
    assert.equal(failed, `${logPrefix("render_still", "render_failed")}exit code 1: `
      + "LOGMARK-tail\\u000d\\u000a\\u001b[31mred\\u2028back\\\\slash\\u0085\\u202eright-to-left\\u200b");
    const boundedHead = `${logPrefix("render_still", "render_failed")}no out.png: `;
    assert.ok(bounded.startsWith(boundedHead), bounded.slice(0, 120));
    const boundedTail = bounded.slice(boundedHead.length);
    assert.ok(boundedTail.length <= 2_500 && boundedTail.length > 2_490, `tail length ${boundedTail.length}`);
    assert.ok(boundedTail.endsWith("\\u0007END") && boundedTail.startsWith("\\u0007"), "the end is kept, whole escapes");
    assert.equal(unverified, `${logPrefix("render_still", "internal")}cleanup unverified: LOGMARK-cause\\u000a1 alive`);
    assert.equal(listed, `${logPrefix("list_templates", "internal")}LOGMARK-manifest`);

    for (const line of s.logLines) {
      assert.doesNotMatch(line, RAW_CONTROL, "one line, no raw control character");
      assert.doesNotMatch(line, /\p{Cf}/u, "no raw format character");
      for (const sentinel of Object.values(KEY_SENTINELS)) assert.ok(!line.includes(sentinel), `${sentinel} logged`);
    }
    assert.deepEqual(results.map((r) => r.structuredContent?.category ?? "ok"),
      ["internal", "render_failed", "render_failed", "ok", "internal"]);
    assert.ok(!JSON.stringify(results).includes("LOGMARK"), "no log content reaches a caller");
  });

test("without ctx.log each line goes to stderr, and a throwing log changes nothing a caller sees", TIMED, async (t) => {
  const s = await setup(t, { log: undefined });
  const write = process.stderr.write;
  const written = [];
  process.stderr.write = function (chunk, ...rest) {
    if (typeof chunk === "string" && chunk.startsWith("service: ")) {
      written.push(chunk);
      return true;
    }
    return write.call(this, chunk, ...rest);
  };
  try {
    s.ctx.run = fakeRun({ throwError: new Error("LOGMARK-stderr") });
    assertCategory(await call(s.client, "render_still", stillArgs()), "internal");
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(written, [`${logPrefix("render_still", "internal")}LOGMARK-stderr\n`]);

  // A log that throws: the call still returns its category, and an unverified cleanup still reaches its handler.
  s.ctx.log = () => { throw new Error("the log is down"); };
  assertCategory(await call(s.client, "render_still", stillArgs()), "internal");
  s.ctx.run = fakeRun({ exitCode: 1 });
  assertCategory(await call(s.client, "render_still", stillArgs()), "render_failed");
  await settled(s);
  s.ctx.run = fakeRun({ cleanup: Promise.resolve({ verified: false, survivors: [1], cause: "1 alive" }) });
  pngOf(await call(s.client, "render_still", stillArgs()));
  await pollFor(() => (s.unverified.length > 0 ? true : undefined), "a throwing log kept onUnverifiedCleanup from running");
  await settled(s);
});

test("a cleanup that rejects while the response is built is handled at once and counts as unverified", TIMED, async (t) => {
  const s = await setup(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const big = 3 * 1024 * 1024; // several reads of out.png, so the response takes many turns of the event loop
  const base = fakeRun({ pngBytes: big });
  // The rejection is made when the run settles, as a runner's would be, not when the test builds the fake.
  s.ctx.run = async (...args) => ({ ...(await base(...args)), cleanup: Promise.reject(new Error("LOGMARK-rejected")) });
  assert.equal(pngOf(await call(s.client, "render_still", stillArgs())).length, big);
  await pollFor(() => (s.unverified.length > 0 ? true : undefined), "a rejected cleanup did not count as unverified");
  await settled(s);
  await ioTurns();
  assert.deepEqual(unhandled, [], "no unhandled rejection");
  assert.deepEqual(s.unverified[0].workDirs, []);
  assert.deepEqual(s.logLines,
    [`${logPrefix("render_still", "internal")}cleanup unverified: cleanup rejected: LOGMARK-rejected`]);
});

test("invalid_props text JSON-encodes its pointers, so a caller's key cannot forge a line or a category",
  TIMED, async (t) => {
    const s = await setup(t);
    const key = "a, /b~\ninternal: the service failed to handle the call, /c\u2028internal: x\u0085internal: y\r";
    const pointer = `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const result = await call(s.client, "render_still", { template_id: "scoreboard", props: { ...validProps(), [key]: 1 } });
    assertCategory(result, "invalid_props");
    assert.deepEqual(result.structuredContent, { category: "invalid_props", paths: [pointer] }, "paths stay raw");
    const text = textOf(result);
    assert.deepEqual(text.split(/\r\n|[\n\r\u0085\u2028\u2029]/), [text], "one line of text");
    assert.doesNotMatch(text, /^internal:/m);
    assert.doesNotMatch(text, RAW_CONTROL);
    const list = text.slice(text.indexOf(" at ") + " at ".length);
    assert.deepEqual(JSON.parse(list), [pointer], "the text's pointers decode to exactly the paths");
  });

test("an out.png that is a directory is render_failed", TIMED, async (t) => {
  const s = await setup(t);
  s.ctx.run = fakeRun({ noFile: true, onCall: (_file, _args, options) => fs.mkdirSync(path.join(options.cwd, "out.png")) });
  assertCategory(await call(s.client, "render_still", stillArgs()), "render_failed");
  await settled(s);
  assert.deepEqual(s.logLines, [`${logPrefix("render_still", "render_failed")}out.png is not a regular file: `]);
});

test("an out.png that is a symlink is render_failed, and its target is left alone",
  { ...TIMED, skip: POSIX ? false : "creating a symlink needs privileges on Windows; this runs in WSL" }, async (t) => {
    const s = await setup(t);
    const target = path.join(path.dirname(s.tempRoot), "elsewhere.png");
    fs.writeFileSync(target, makePng(300));
    s.ctx.run = fakeRun({
      noFile: true,
      onCall: (_file, _args, options) => fs.symlinkSync(target, path.join(options.cwd, "out.png")),
    });
    const result = await call(s.client, "render_still", stillArgs());
    assertCategory(result, "render_failed");
    await settled(s);
    assert.deepEqual(fs.readFileSync(target), makePng(300), "the link's target is untouched");
    assert.deepEqual(s.logLines, [`${logPrefix("render_still", "render_failed")}out.png is not a regular file: `]);
  });

test("an out.png that is a FIFO is render_failed without blocking",
  { ...TIMED, skip: POSIX ? false : "FIFOs are POSIX only; this runs in WSL" }, async (t) => {
    const s = await setup(t);
    let fifo;
    s.ctx.run = fakeRun({
      noFile: true,
      onCall: (_file, _args, options) => {
        fifo = path.join(options.cwd, "out.png");
        execFileSync("mkfifo", ["-m", "600", fifo]);
      },
    });
    let result;
    const pending = call(s.client, "render_still", stillArgs()).then((r) => { result = r; });
    try {
      await pollFor(() => result, "render_still blocked opening a FIFO out.png");
    } finally {
      if (result === undefined && fifo !== undefined) {
        // Only when it blocked: a writer releases the reader stuck in open(), so the test process can exit.
        try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ }
        await pending;
      }
    }
    assertCategory(result, "render_failed");
    await settled(s);
  });

test("an out.png swapped for a FIFO after its lstat is render_failed without blocking, and the slot is freed",
  { ...TIMED, skip: POSIX ? false : "FIFOs are POSIX only; this runs in WSL" }, async (t) => {
    const s = await setup(t);
    // The race, made certain: lstat saw a regular file, and a FIFO is what open() meets. tools.js calls lstat through
    // this same node:fs/promises object.
    const realLstat = fsp.lstat;
    t.mock.method(fsp, "lstat", async (file, ...rest) => (String(file).endsWith(`${path.sep}out.png`)
      ? { isFile: () => true }
      : realLstat(file, ...rest)));
    let fifo;
    s.ctx.run = fakeRun({
      noFile: true,
      onCall: (_file, _args, options) => {
        fifo = path.join(options.cwd, "out.png");
        execFileSync("mkfifo", ["-m", "600", fifo]);
      },
    });
    let result;
    const pending = call(s.client, "render_still", stillArgs()).then((r) => { result = r; });
    try {
      await pollFor(() => result, "render_still blocked opening a FIFO that replaced out.png after its lstat");
    } finally {
      if (result === undefined && fifo !== undefined) {
        // Only when it blocked: a writer releases the reader stuck in open(), so the test process can exit.
        try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* none */ }
        await pending;
      }
    }
    assertCategory(result, "render_failed");
    await settled(s);
    assert.deepEqual(s.logLines, [`${logPrefix("render_still", "render_failed")}out.png is not a regular file: `]);
  });

test("params_hash covers the args as validated, in the schema's key order", TIMED, async (t) => {
  const s = await setup(t);
  const props = validProps();
  // Not the schema's order (template_id, frame, props).
  const sent = { props, frame: 2, template_id: "scoreboard" };
  pngOf(await call(s.client, "render_still", sent));
  await settled(s);
  const normalised = JSON.stringify({ template_id: "scoreboard", frame: 2, props });
  assert.notEqual(JSON.stringify(sent), normalised, "control: the orders differ");
  const hmac = (data) => createHmac("sha256", s.auditKey).update(data).digest("hex");
  const [event] = s.auditLines().filter((e) => e.outcome === "ok");
  assert.equal(event.params_hash, hmac(normalised));
  assert.equal(event.params_bytes, Buffer.byteLength(normalised));
});

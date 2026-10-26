// The service profile's four tools, their errors and the service audit (design 5.5, 5.8, review focus 4).
// The renders are fake (test/helpers/service-harness.mjs), so every case runs on any platform; the file-mode
// assertions run on POSIX only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectWithClaims, fakeRun, makePng } from "./helpers/service-harness.mjs";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "index.js"))) {
  throw new Error("dist-service/service/index.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const {
  SERVICE_TOOLS, registerServiceTools, createAuditSink, loadPack, RenderSlots,
  SERVICE_PNG_CAP_BYTES, RENDER_STILL_DEADLINE_MS, RENDER_CLI_TIMEOUT_MS, RENDER_KILL_GRACE_MS, RENDER_VERIFY_DEADLINE_MS,
} = await import(pathToFileURL(path.join(SERVICE, "index.js")).href);

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
    onUnverifiedCleanup: () => unverified.push({ workDirs: fs.readdirSync(tempRoot), inUse: ctx.slots.inUse }),
    ...overrides,
  };
  const server = new McpServer({ name: "service-tools-test", version: "0.0.0" });
  registerServiceTools(server, ctx);
  const client = await connectWithClaims(server, CLAIMS);
  t.after(() => client.close());
  const workDirs = () => fs.readdirSync(tempRoot);
  const auditLines = () => (fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "")
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  return { ctx, server, client, tempRoot, auditPath, auditKey, unverified, workDirs, auditLines };
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
});

test("render_still's strict schema refuses an unknown argument and runs nothing", TIMED, async (t) => {
  const s = await setup(t);
  let calls = 0;
  s.ctx.run = fakeRun({ onCall: () => { calls += 1; } });
  const result = await call(s.client, "render_still", stillArgs({ tenant: "tenant-b" }));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Input validation error/);
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
});

test("the CLI is called with the manifest size, the frame, the pinned browser, a --timeout above the deadline, "
  + "props as a 0600 file, and an allowlisted env", TIMED, async (t) => {
  const saved = { IDENTITY_HMAC_KEY: process.env.IDENTITY_HMAC_KEY, AUDIT_HMAC_KEY: process.env.AUDIT_HMAC_KEY };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const sentinels = { IDENTITY_HMAC_KEY: "SENTINEL-IDENTITY-3b7e", AUDIT_HMAC_KEY: "SENTINEL-AUDIT-9c2d" };
  Object.assign(process.env, sentinels);

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
  assert.equal(timeouts.length, 1);
  assert.ok(Number(timeouts[0].slice("--timeout=".length)) > s.ctx.stillDeadlineMs);
  assert.ok(!argv.some((arg) => arg.includes("{") || arg.includes("Final")), "no JSON in argv");

  assert.deepEqual(seen.props, props);
  assert.equal(path.dirname(seen.options.cwd), s.tempRoot);
  assert.equal(seen.options.env.TMPDIR, seen.options.cwd);
  for (const [name, value] of Object.entries(sentinels)) {
    assert.ok(!(name in seen.options.env), `${name} is not passed`);
    assert.ok(!Object.values(seen.options.env).includes(value), `${name}'s value is not passed`);
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
  // AbortSignal.any propagates synchronously.
  assert.equal(signal.aborted, true, "the run's signal aborts with the service's shutdown");
  assertCategory(await pending, "render_failed");
  await settled(s);
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
  await pollFor(() => (c.auditLines().some((e) => e.tool === "render_still") ? true : undefined), "no audit line");
  await ioTurns();
  assert.deepEqual(sent.filter((message) => "id" in message), [], "no result to a closed connection");
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

test("render_video_start and render_job_status return not_implemented", TIMED, async (t) => {
  const s = await setup(t);
  assertCategory(await call(s.client, "render_video_start"), "not_implemented");
  assertCategory(await call(s.client, "render_job_status", { job_id: "job-1" }), "not_implemented");
  assert.deepEqual(s.auditLines().map((e) => [e.tool, e.outcome, e.category]), [
    ["render_video_start", "error", "not_implemented"],
    ["render_job_status", "error", "not_implemented"],
  ]);
});

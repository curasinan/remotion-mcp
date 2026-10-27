// The service's HTTP root (design 5.2, review focus 3): route, body cap, identity before any server, one fresh server
// and transport per POST, cancellation on a closed connection, ignored tenant fields, and the refusal audit.
// The renders are fake (test/helpers/service-harness.mjs), so every case runs on any platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fakeRun, makePng } from "./helpers/service-harness.mjs";
import { makeSigningFetch } from "./helpers/signing-client.mjs";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "http.js"))) {
  throw new Error("dist-service/service/http.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const load = (name) => import(pathToFileURL(path.join(SERVICE, name)).href);
const { createServiceHandler } = await load("http.js");
const { signIdentity } = await load("identity.js");
const { loadPack } = await load("templates.js");
const { RenderSlots } = await load("slots.js");
const { createAuditSink } = await load("audit.js");
const {
  REQUEST_ID_META_KEY, IDENTITY_HEADER, SERVICE_BODY_CAP_BYTES, SERVICE_PNG_CAP_BYTES, RENDER_STILL_DEADLINE_MS,
  RENDER_CLI_TIMEOUT_MS, RENDER_KILL_GRACE_MS, RENDER_VERIFY_DEADLINE_MS,
} = await load("constants.js");

const GOOD = path.join(REPO, "test", "fixtures", "packs", "good");
const PACK = loadPack(GOOD);
/** Never executed: the fake runner only records what it was given. */
const BROWSER = "/opt/chrome-headless-shell/chrome-headless-shell";
const CLI_SCRIPT = "/pack/node_modules/@remotion/cli/remotion-cli.js";
/** Every test has this timeout, so a request that never settles fails with the test's name. */
const TIMED = { timeout: 30_000 };

const NOW = Math.floor(Date.now() / 1000);
/** Generated per run, never a published key. */
const KEY = randomBytes(32);
const AUD = "deploy-test";
const PRINCIPAL = "principal-a";
const TENANT = "tenant-a";
const TOOL_NAMES = ["list_templates", "render_still", "render_video_start", "render_job_status"];

/** Props the good pack's `scoreboard` accepts. */
const validProps = () => ({
  label: "Final", color: "#1A2B3C", players: [{ name: "Ada", number: 10 }], theme: "dark", opacity: 0.5,
});
const stillArgs = () => ({ template_id: "scoreboard", props: validProps() });

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
 * The handler on 127.0.0.1:0 with the good pack, a fake runner and the fixed clock. Servers are counted through
 * `createServer`. Each release of a render slot is counted, so a test can show a slot frees exactly once.
 */
async function setup(t, { clock = { nowS: () => NOW, startedAtS: NOW - 600 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, "renders");
  fs.mkdirSync(tempRoot);
  const auditPath = path.join(root, "audit", "service-audit.jsonl");
  const logLines = [];
  const slots = new RenderSlots(2);
  let releases = 0;
  const acquire = slots.tryAcquire.bind(slots);
  slots.tryAcquire = () => {
    const release = acquire();
    if (release === null) return null;
    return () => {
      releases += 1;
      release();
    };
  };
  const ctx = {
    pack: PACK,
    slots,
    run: fakeRun(),
    cli: { file: process.execPath, prefixArgs: [CLI_SCRIPT] },
    browserExecutable: BROWSER,
    tempRoot,
    audit: createAuditSink(auditPath, randomBytes(32)),
    stillDeadlineMs: RENDER_STILL_DEADLINE_MS,
    cliTimeoutMs: RENDER_CLI_TIMEOUT_MS,
    graceMs: RENDER_KILL_GRACE_MS,
    verifyDeadlineMs: RENDER_VERIFY_DEADLINE_MS,
    pngCapBytes: SERVICE_PNG_CAP_BYTES,
    shutdown: new AbortController().signal,
    onUnverifiedCleanup: () => assert.fail("no test here reports an unverified cleanup"),
    // The operator log, captured so no test writes to stderr.
    log: (line) => logLines.push(line),
  };
  const cfg = {
    host: "127.0.0.1", port: 0, audience: AUD, identityKey: KEY, auditKey: randomBytes(32), auditLogPath: auditPath,
    packDir: GOOD, browserExecutable: BROWSER, slots: 2, skewS: 30, bodyCapBytes: SERVICE_BODY_CAP_BYTES,
    stillDeadlineMs: RENDER_STILL_DEADLINE_MS, pngCapBytes: SERVICE_PNG_CAP_BYTES, tempRoot,
  };
  let servers = 0;
  const handler = createServiceHandler(ctx, cfg, {
    clock,
    createServer: () => {
      servers += 1;
      return new McpServer({ name: "service-http-test", version: "0.0.0" });
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  const auditLines = () => (fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "")
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  return {
    ctx, port, url: new URL(`http://127.0.0.1:${port}/mcp`), auditPath, auditLines, logLines, tempRoot,
    servers: () => servers, releases: () => releases, workDirs: () => fs.readdirSync(tempRoot),
  };
}

/** The real SDK client over Streamable HTTP, every POST signed by the gateway stand-in. */
async function connectClient(t, s, { onSigned } = {}) {
  const fetch = makeSigningFetch({ key: KEY, audience: AUD, principal: PRINCIPAL, tenant: TENANT, nowS: () => NOW,
    onSigned });
  const client = new Client({ name: "service-http-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(s.url, { fetch }));
  t.after(() => client.close());
  return client;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A JSON-RPC request as the gateway forwards it, with its `request_id` in `_meta`. */
function rpc(method, params = {}, requestId = randomUUID()) {
  return { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { ...params._meta, [REQUEST_ID_META_KEY]: requestId } } };
}

/** The claims the gateway would sign for `message` over `body`, with `overrides` applied. */
function claimsFor(message, body, overrides = {}) {
  const tool = message.method === "tools/call" ? message.params.name : message.method;
  return {
    v: 1, request_id: message.params._meta[REQUEST_ID_META_KEY], principal: PRINCIPAL, tenant: TENANT, aud: AUD,
    tool, body_sha256: sha256(body), iat: NOW, exp: NOW + 60, ...overrides,
  };
}

/** `message`'s exact bytes and a header signed over them with `signIdentity`. */
function signed(message, overrides = {}, key = KEY) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return { body, header: signIdentity(claimsFor(message, body, overrides), key) };
}

/**
 * Sends raw bytes with node:http, as a gateway forwards them. With `chunked` the body goes in 64 KiB pieces with
 * Transfer-Encoding: chunked and no Content-Length. Resolves with the status, the headers and the whole body.
 */
function rawRequest(s, { method = "POST", urlPath = "/mcp", body, header, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    if (header !== undefined) headers[IDENTITY_HEADER] = header;
    if (body !== undefined) {
      if (chunked) headers["transfer-encoding"] = "chunked";
      else headers["content-length"] = String(body.length);
    }
    const req = http.request({ host: "127.0.0.1", port: s.port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) {
      if (chunked) for (let at = 0; at < body.length; at += 65_536) req.write(body.subarray(at, at + 65_536));
      else req.write(body);
    }
    req.end();
  });
}

/** The JSON-RPC messages of an SSE response body. */
function sseMessages(body) {
  return body.toString("utf8").split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

/** A tools/list message of exactly `size` bytes, padded inside a `_meta` string, and signed over those bytes. */
function paddedList(size) {
  const message = rpc("tools/list", { _meta: { pad: "" } });
  const empty = Buffer.byteLength(JSON.stringify(message), "utf8");
  message.params._meta.pad = "a".repeat(size - empty);
  const request = signed(message);
  assert.equal(request.body.length, size);
  return request;
}

function assertEmptyRefusal(response, status, what) {
  assert.equal(response.status, status, `${what}: status`);
  assert.equal(response.body.length, 0, `${what}: the body is empty`);
}

/** The PNG of a successful render_still. */
function pngOf(result) {
  assert.notEqual(result.isError, true, `render_still failed: ${JSON.stringify(result).slice(0, 300)}`);
  const [image] = result.content;
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  return Buffer.from(image.data, "base64");
}

test("a signed SDK client completes initialize, tools/list and render_still and gets a PNG", TIMED, async (t) => {
  const s = await setup(t);
  let posts = 0;
  const client = await connectClient(t, s, { onSigned: () => { posts += 1; } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  const png = pngOf(await client.callTool({ name: "render_still", arguments: stillArgs() }));
  assert.deepEqual(png, makePng(256));

  assert.ok(posts >= 4, `initialize, notifications/initialized, tools/list and tools/call are POSTs (saw ${posts})`);
  assert.equal(s.servers(), posts, "one fresh server for each signed POST, and none for anything else");
  // The tool saw the verified claims as authInfo: its audit line carries them.
  const ok = s.auditLines().filter((e) => e.outcome === "ok" && e.tool === "render_still");
  assert.equal(ok.length, 1);
  assert.equal(ok[0].principal, PRINCIPAL);
  assert.equal(ok[0].tenant, TENANT);
  assert.match(ok[0].request_id, /^[0-9a-f-]{36}$/);
  await pollFor(() => (s.ctx.slots.inUse === 0 && s.workDirs().length === 0 ? true : undefined), "the render settled");
});

test("GET and DELETE get 405, any other path gets 404, and the SDK client still works", TIMED, async (t) => {
  const s = await setup(t);
  for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
    const response = await rawRequest(s, { method });
    assertEmptyRefusal(response, 405, `${method} /mcp`);
    assert.equal(response.headers.allow, "POST", `${method} /mcp: Allow`);
  }
  const { body, header } = signed(rpc("tools/list"));
  for (const urlPath of ["/", "/mcp/", "/MCP", "/mcpx", "/mcp/x", "/other", "//other/mcp"]) {
    assertEmptyRefusal(await rawRequest(s, { urlPath, body, header }), 404, `POST ${urlPath}`);
  }
  assertEmptyRefusal(await rawRequest(s, { method: "GET", urlPath: "/other" }), 404, "GET /other: the path decides first");
  assert.equal(s.servers(), 0, "no refused request created a server");
  assert.equal(s.auditLines().filter((e) => e.outcome !== "refused").length, 0);

  // The SDK client opens a GET stream after initialize, takes the 405, and carries on.
  const client = await connectClient(t, s);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
});

test("a JSON-RPC batch gets 400, runs nothing and creates no server", TIMED, async (t) => {
  const s = await setup(t);
  let runs = 0;
  s.ctx.run = fakeRun({ onCall: () => { runs += 1; } });
  const first = rpc("tools/call", { name: "render_still", arguments: stillArgs() });
  const batch = [first, { ...rpc("tools/call", { name: "render_still", arguments: stillArgs() }), id: 2 }];
  const body = Buffer.from(JSON.stringify(batch), "utf8");
  const header = signIdentity(claimsFor(first, body), KEY);
  assertEmptyRefusal(await rawRequest(s, { body, header }), 400, "a batch");
  await ioTurns();
  assert.equal(runs, 0, "no render ran");
  assert.equal(s.servers(), 0, "no server was created");
  assert.equal(s.ctx.slots.inUse, 0);
});

test("a body of exactly 262144 bytes is accepted and 262145 gets 413, including chunked without Content-Length",
  TIMED, async (t) => {
    const s = await setup(t);
    assert.equal(SERVICE_BODY_CAP_BYTES, 262_144);
    for (const chunked of [false, true]) {
      const how = chunked ? "chunked" : "with Content-Length";
      const atCap = await rawRequest(s, { ...paddedList(SERVICE_BODY_CAP_BYTES), chunked });
      assert.equal(atCap.status, 200, `${how}: the body at the cap is accepted`);
      const [reply] = sseMessages(atCap.body);
      assert.deepEqual(reply.result.tools.map((tool) => tool.name), TOOL_NAMES, `${how}: tools/list ran`);

      const over = await rawRequest(s, { ...paddedList(SERVICE_BODY_CAP_BYTES + 1), chunked });
      assertEmptyRefusal(over, 413, `${how}: one byte over the cap`);
    }
    assert.equal(s.servers(), 2, "only the two bodies at the cap created a server");
    const refused = s.auditLines().filter((e) => e.outcome === "refused");
    assert.deepEqual(refused.map((e) => [e.category, e.http_status]), [["body_too_large", 413], ["body_too_large", 413]]);
  });

test("each identity refusal gets 401 with an empty body and creates no server", TIMED, async (t) => {
  const s = await setup(t);
  let runs = 0;
  s.ctx.run = fakeRun({ onCall: () => { runs += 1; } });
  const call = () => rpc("tools/call", { name: "render_still", arguments: stillArgs() });
  const cases = [
    ["missing", () => ({ body: signed(call()).body })],
    ["malformed", () => ({ body: signed(call()).body, header: "not-a-header" })],
    ["unsupported_version", () => signed(call(), { v: 2 })],
    ["bad_signature", () => signed(call(), {}, randomBytes(32))],
    ["wrong_audience", () => signed(call(), { aud: "deploy-other" })],
    ["not_yet_valid", () => signed(call(), { iat: NOW + 31, exp: NOW + 91 })],
    ["expired", () => signed(call(), { iat: NOW - 120, exp: NOW - 31 })],
    ["ttl_too_long", () => signed(call(), { exp: NOW + 121 })],
    ["body_mismatch", () => ({ ...signed(call()), body: Buffer.from(JSON.stringify(call()), "utf8") })],
    ["tool_mismatch", () => signed(call(), { tool: "list_templates" })],
    ["request_id_mismatch", () => signed(call(), { request_id: randomUUID() })],
  ];
  for (const [reason, build] of cases) {
    assertEmptyRefusal(await rawRequest(s, build()), 401, reason);
    // The audit names the check that refused, so each case is known to reach the check it is about.
    assert.equal(s.auditLines().at(-1).category, reason, `${reason}: the refusal's reason`);
  }

  // A service that has just started refuses a header signed more than one skew before its start.
  const fresh = await setup(t, { clock: { nowS: () => NOW, startedAtS: NOW } });
  assertEmptyRefusal(await rawRequest(fresh, signed(call(), { iat: NOW - 31, exp: NOW + 29 })), 401,
    "signed_before_start");
  assert.equal(fresh.auditLines().at(-1).category, "signed_before_start");

  await ioTurns();
  assert.equal(runs, 0, "no render ran");
  assert.equal(s.servers() + fresh.servers(), 0, "no refused request created a server");
});

test("a replayed request id gets 401 and the first request had succeeded", TIMED, async (t) => {
  const s = await setup(t);
  const request = signed(rpc("tools/list"));
  const first = await rawRequest(s, request);
  assert.equal(first.status, 200);
  const [reply] = sseMessages(first.body);
  assert.deepEqual(reply.result.tools.map((tool) => tool.name), TOOL_NAMES);

  assertEmptyRefusal(await rawRequest(s, request), 401, "the replay");
  assert.equal(s.auditLines().at(-1).category, "replayed");
  assert.equal(s.servers(), 1, "only the first request created a server");
});

test("two concurrent render_still calls overlap", TIMED, async (t) => {
  const s = await setup(t);
  const bothIn = latch();
  let entered = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const inner = fakeRun({ hold: bothIn.promise });
  s.ctx.run = async (...args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    entered += 1;
    if (entered === 2) bothIn.resolve();
    try {
      return await inner(...args);
    } finally {
      inFlight -= 1;
    }
  };
  const client = await connectClient(t, s);
  const results = await Promise.all([
    client.callTool({ name: "render_still", arguments: stillArgs() }),
    client.callTool({ name: "render_still", arguments: stillArgs() }),
  ]);
  for (const result of results) assert.deepEqual(pngOf(result), makePng(256));
  assert.equal(maxInFlight, 2, "both renders were in flight at once");
});

test("REVIEW FOCUS 3: closing the client connection mid-render aborts the run; the slot frees after cleanup",
  TIMED, async (t) => {
    const s = await setup(t);
    const entered = latch();
    const cleanup = latch();
    let signal;
    let workDir;
    s.ctx.run = async (_file, _args, options) => {
      signal = options.signal;
      workDir = options.cwd;
      entered.resolve();
      await new Promise((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      // As runRenderProcess does: the result settles at the abort, and cleanup settles once the processes are gone.
      return { exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "", cleanup: cleanup.promise };
    };
    const client = await connectClient(t, s);
    const pending = client.callTool({ name: "render_still", arguments: stillArgs() }).then(() => "resolved", () => "rejected");
    await entered.promise;
    assert.equal(signal.aborted, false);
    assert.equal(s.ctx.slots.inUse, 1);

    await client.close();
    await pollFor(() => (signal.aborted ? true : undefined), "the closed connection never aborted the render");
    assert.equal(await pending, "rejected", "the closed client gets no result");

    // The render's processes are not yet verified gone: the slot stays held and the work dir stays.
    await ioTurns();
    assert.equal(s.ctx.slots.inUse, 1, "the slot is held until cleanup settles");
    assert.equal(s.releases(), 0);
    assert.equal(fs.existsSync(workDir), true);

    cleanup.resolve({ verified: true, survivors: [] });
    await pollFor(() => (s.ctx.slots.inUse === 0 ? true : undefined), "the slot never freed after cleanup");
    await ioTurns();
    assert.equal(s.releases(), 1, "the slot freed exactly once");
    assert.deepEqual(s.workDirs(), [], "the work dir is removed");
    // The aborted call is still audited, as render_failed.
    const audited = await pollFor(() => s.auditLines().find((e) => e.tool === "render_still"), "the call was never audited");
    assert.equal(audited.outcome, "error");
    assert.equal(audited.category, "render_failed");
  });

test("a tenant field in _meta or in tool arguments has no effect and is audited as a violation with field paths only",
  TIMED, async (t) => {
    const VALUE = "tenant-evil-7f3a9c";
    const violations = (s) => s.auditLines().filter((e) => e.outcome === "violation");

    // _meta.tenant on render_still.
    const meta = await setup(t);
    const metaClient = await connectClient(t, meta);
    const png = pngOf(await metaClient.callTool({ name: "render_still", arguments: stillArgs(), _meta: { tenant: VALUE } }));
    assert.deepEqual(png, makePng(256), "the render ran as if the field were absent");
    assert.equal(violations(meta).length, 1);
    const [metaEvent] = violations(meta);
    assert.deepEqual(metaEvent.fields, ["_meta.tenant"]);
    assert.equal(metaEvent.tenant, TENANT, "the audited tenant is the claims' tenant");
    assert.equal(metaEvent.principal, PRINCIPAL);
    assert.equal(metaEvent.tool, "render_still");
    const ok = meta.auditLines().find((e) => e.outcome === "ok" && e.tool === "render_still");
    assert.equal(ok.tenant, TENANT);

    // arguments.tenant on list_templates, which declares no input schema and so ignores its arguments.
    const args = await setup(t);
    const argsClient = await connectClient(t, args);
    const listed = await argsClient.callTool({ name: "list_templates", arguments: { tenant: VALUE } });
    assert.notEqual(listed.isError, true);
    assert.deepEqual(listed.structuredContent.templates.map((tpl) => tpl.id), PACK.manifest.templates.map((tpl) => tpl.id));
    assert.equal(violations(args).length, 1);
    const [argsEvent] = violations(args);
    assert.deepEqual(argsEvent.fields, ["arguments.tenant"]);
    assert.equal(argsEvent.tenant, TENANT);
    assert.equal(argsEvent.tool, "list_templates");

    // team and team_id count too, in both places, in one event; a nested key does not.
    const both = await setup(t);
    const bothClient = await connectClient(t, both);
    await bothClient.callTool({ name: "list_templates", arguments: { team: VALUE, team_id: VALUE }, _meta: { team: VALUE } });
    await bothClient.callTool({ name: "list_templates", arguments: { filter: { tenant: VALUE } } });
    assert.deepEqual(violations(both).map((e) => e.fields), [["_meta.team", "arguments.team", "arguments.team_id"]]);

    for (const s of [meta, args, both]) {
      assert.equal(fs.readFileSync(s.auditPath, "utf8").includes(VALUE), false, "the value appears nowhere in the audit");
    }
  });

test("HTTP-level refusals are audited with outcome refused, the reason as category and http_status, and no claims fields",
  TIMED, async (t) => {
    const s = await setup(t);
    const list = () => signed(rpc("tools/list"));
    const batchBody = Buffer.from(JSON.stringify([rpc("tools/list"), rpc("tools/list")]), "utf8");
    const parseBody = Buffer.from("{\"jsonrpc\":\"2.0\",", "utf8");
    const sentFor = (body) => signIdentity({ ...claimsFor(rpc("tools/list"), body) }, KEY);
    const requests = [
      [{ urlPath: "/other", ...list() }, 404, "not_found"],
      [{ method: "GET" }, 405, "method_not_allowed"],
      [paddedList(SERVICE_BODY_CAP_BYTES + 1), 413, "body_too_large"],
      [{ ...list(), header: undefined }, 401, "missing"],
      [signed(rpc("tools/list"), {}, randomBytes(32)), 401, "bad_signature"],
      [{ body: parseBody, header: sentFor(parseBody) }, 400, "parse"],
      [{ body: batchBody, header: sentFor(batchBody) }, 400, "batch"],
    ];
    for (const [request, status] of requests) assertEmptyRefusal(await rawRequest(s, request), status, `HTTP ${status}`);

    const events = s.auditLines();
    assert.equal(events.length, requests.length);
    events.forEach((event, i) => {
      const [, status, category] = requests[i];
      assert.equal(event.outcome, "refused");
      assert.equal(event.category, category);
      assert.equal(event.http_status, status);
      assert.match(event.ts, /^\d{4}-\d\d-\d\dT/);
      for (const field of ["request_id", "principal", "tenant", "tool", "fields"]) {
        assert.equal(Object.hasOwn(event, field), false, `${category}: no ${field}`);
      }
    });
    assert.equal(s.servers(), 0);
  });

// The image's HEALTHCHECK (design 5.2, 10): dist-service/service/healthcheck.js sends GET /mcp to 127.0.0.1 on
// SERVICE_PORT and exits 0 only on the 405 the service answers it with. Each case spawns the built script, as Docker
// does, against a server in this process, so every case runs on any platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fakeRun } from "./helpers/service-harness.mjs";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
const HEALTHCHECK = path.join(SERVICE, "healthcheck.js");
if (!fs.existsSync(HEALTHCHECK)) {
  throw new Error("dist-service/service/healthcheck.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const load = (name) => import(pathToFileURL(path.join(SERVICE, name)).href);
const { createServiceHandler } = await load("http.js");
const { loadPack } = await load("templates.js");
const { RenderSlots } = await load("slots.js");
const { createAuditSink } = await load("audit.js");
const {
  SERVICE_BODY_CAP_BYTES, SERVICE_PNG_CAP_BYTES, RENDER_STILL_DEADLINE_MS, RENDER_CLI_TIMEOUT_MS,
  RENDER_KILL_GRACE_MS, RENDER_VERIFY_DEADLINE_MS,
} = await load("constants.js");

const PACK = loadPack(path.join(REPO, "test", "fixtures", "packs", "good"));
/** Never executed: the fake runner spawns nothing. */
const BROWSER = "/opt/chrome-headless-shell/chrome-headless-shell";
/** The healthcheck's own request timeout. */
const PROBE_TIMEOUT_MS = 3_000;
/** Every test has this timeout, so a probe that never exits fails with the test's name. */
const TIMED = { timeout: 20_000 };

/** Runs the healthcheck with SERVICE_PORT set, and resolves with its exit code and how long it ran. */
function probe(port) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [HEALTHCHECK], {
      env: { ...process.env, SERVICE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output, ms: performance.now() - started }));
  });
}

/** `server` listening on 127.0.0.1 at a free port, closed after the test. */
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return server.address().port;
}

test("it exits 0 against a live createServiceHandler, and its GET writes no audit line", TIMED, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "healthcheck-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, "renders");
  fs.mkdirSync(tempRoot);
  const auditPath = path.join(root, "audit", "service-audit.jsonl");
  const ctx = {
    pack: PACK, slots: new RenderSlots(2), run: fakeRun(),
    cli: { file: process.execPath, prefixArgs: ["/pack/node_modules/@remotion/cli/remotion-cli.js"] },
    browserExecutable: BROWSER, tempRoot, audit: createAuditSink(auditPath, randomBytes(32)),
    stillDeadlineMs: RENDER_STILL_DEADLINE_MS, cliTimeoutMs: RENDER_CLI_TIMEOUT_MS, graceMs: RENDER_KILL_GRACE_MS,
    verifyDeadlineMs: RENDER_VERIFY_DEADLINE_MS, pngCapBytes: SERVICE_PNG_CAP_BYTES,
    shutdown: new AbortController().signal,
    onUnverifiedCleanup: () => assert.fail("the healthcheck starts no render"),
    log: () => {},
  };
  const cfg = {
    host: "127.0.0.1", port: 0, audience: "deploy-test", identityKey: randomBytes(32), auditKey: randomBytes(32),
    auditLogPath: auditPath, packDir: PACK.dir, browserExecutable: BROWSER, slots: 2, skewS: 30,
    bodyCapBytes: SERVICE_BODY_CAP_BYTES, stillDeadlineMs: RENDER_STILL_DEADLINE_MS,
    pngCapBytes: SERVICE_PNG_CAP_BYTES, tempRoot,
  };
  const port = await listen(t, http.createServer(createServiceHandler(ctx, cfg)));

  const result = await probe(port);
  assert.equal(result.code, 0, `exit code (output: ${result.output})`);
  assert.equal(fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "", "", "no audit line");
});

test("it exits 1 when nothing listens on SERVICE_PORT", TIMED, async () => {
  // A port that was free a moment ago, now closed again.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const result = await probe(port);
  assert.equal(result.code, 1, `exit code (output: ${result.output})`);
});

test("it exits 1 on any status but 405, and sends GET /mcp", TIMED, async (t) => {
  const seen = [];
  for (const status of [200, 404, 401, 500]) {
    const port = await listen(t, http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(status, { "content-length": "0" });
      res.end();
    }));
    const result = await probe(port);
    assert.equal(result.code, 1, `HTTP ${status}: exit code (output: ${result.output})`);
  }
  assert.deepEqual(seen, ["GET /mcp", "GET /mcp", "GET /mcp", "GET /mcp"]);

  // The positive control on the same kind of server: a 405 is the only success.
  const port = await listen(t, http.createServer((req, res) => {
    res.writeHead(405, { allow: "POST", "content-length": "0" });
    res.end();
  }));
  assert.equal((await probe(port)).code, 0, "HTTP 405");
});

test("it exits 1 at its 3 s timeout when the server never answers", TIMED, async (t) => {
  let received = false;
  // Accepts the request and never answers it.
  const port = await listen(t, http.createServer(() => { received = true; }));

  const result = await probe(port);
  assert.equal(result.code, 1, `exit code (output: ${result.output})`);
  assert.ok(received, "the request reached the server");
  // Not before its timeout, so it never gives up on a slow but live service early, and well before Docker's own.
  assert.ok(result.ms >= PROBE_TIMEOUT_MS - 50, `it gave up after ${Math.round(result.ms)} ms`);
  assert.ok(result.ms < PROBE_TIMEOUT_MS + 5_000, `it ran for ${Math.round(result.ms)} ms`);
});

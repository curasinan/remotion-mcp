// Drives a derived image (the service image plus the fixture pack) directly over HTTP, with this repository's test
// signing client standing in for the owner's gateway (test/helpers/signing-client.mjs). The owner's gateway is not
// in it, so this is not a test of the backend -> gateway -> service path: it proves the image, from a signed request
// to a PNG, and what the image does with a bad request, a stuck render and a crashed one.
//
//   node scripts/image-e2e.mjs <derived image>        (after `npm ci` and `npm run build:service`)
//
// It starts one container with throwaway keys and waits for its HEALTHCHECK to report healthy. Then, in that one
// container:
//   1. render_still swatch with fixtures/pack/props/turkish.json returns a 1280 x 720 PNG
//   2. a replay of case 1's exact request gets 401
//   3. a forged header gets 401, and the genuine header on the same body gets 200
//   6. the audit log has case 1's ok line, both refusals, and no string value from the props
//   4. render_still slow gets render_timeout, after the deadline, and leaves no process behind
//   5. a CLI killed mid-render gives render_failed, and leaves no process behind
//   7. Turkish glyphs render as glyphs, not as the tofu an unrenderable label gives
// Every case runs, each failure says what was missing, and it exits 1 if any failed (2 if it could not start).
//
// The orphan scan reads /proc/<pid>/cmdline for every numeric pid through `docker exec <c> node -e <SCAN>`: the image
// has no ps, and a process's comm is cut to 15 characters. Every case that renders (1, 4, 5 and 7) takes a baseline
// first, and after each render polls until nothing new survives. A survivor is any pid not in the case's baseline
// that is not 1, not the service and not the scan itself. A scan whose docker exec fails fails its case; it never
// counts as empty.
//
// Nothing waits unbounded: every docker call is killed after its own bound, every raw POST times out, and every MCP
// call has its own timeout, so a hung exec or a request that is never answered fails its case.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { IDENTITY_HEADER, REQUEST_ID_META_KEY, makeSigningFetch, signClaims } from "../test/helpers/signing-client.mjs";

const REPO = path.join(import.meta.dirname, "..");
const CONSTANTS = path.join(REPO, "dist-service", "service", "constants.js");
const image = process.argv[2];
if (image === undefined || image.startsWith("-")) {
  console.error("usage: node scripts/image-e2e.mjs <derived image>");
  process.exit(2);
}
if (!fs.existsSync(CONSTANTS)) {
  console.error("image-e2e: dist-service/service/constants.js does not exist. Run `npm run build:service` first.");
  process.exit(2);
}
const { RENDER_STILL_DEADLINE_MS, RENDER_KILL_GRACE_MS, RENDER_VERIFY_DEADLINE_MS } =
  await import(pathToFileURL(CONSTANTS).href);

const AUDIENCE = "e2e";
const PRINCIPAL = "e2e-principal";
const TENANT = "e2e-tenant";
const AUDIT_LOG = "/var/log/remotion-viz/service-audit.jsonl";
const CHROME = "chrome-headless-shell";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** How long the container may take to report healthy. */
const HEALTHY_WAIT_MS = 120_000;
/** A render_still call's own timeout: the 45 s deadline, then the kill's grace. */
const CALL_TIMEOUT_MS = 120_000;
/** How long a render's processes may take to be gone once its result is in. */
const GONE_WAIT_MS = 20_000;
/** How long the CLI and Chrome may take to appear. */
const START_WAIT_MS = 30_000;
/**
 * How long a render_still is retried while it gets render_busy. A slot stays held until its render's processes are
 * verified gone, which is the kill's grace and verification after the result, so a case can start while an earlier
 * case's cleanup still holds a slot.
 */
const BUSY_WAIT_MS = RENDER_KILL_GRACE_MS + RENDER_VERIFY_DEADLINE_MS + 5_000;
/** How long one docker CLI call may run before it is killed. `docker run -d` gets HEALTHY_WAIT_MS. */
const DOCKER_CALL_MS = 30_000;
/** How long a raw POST to /mcp may wait for its answer, body included. */
const POST_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
/** A pixel counts as ink when its brightest channel reaches this: the swatch draws white text on black. */
const INK_THRESHOLD = 128;
// Measured on the derived image: not yet. The first passing run records its ink counts here.

/**
 * Lists every process in /proc as JSON. No double quote and no backslash, so it survives every platform's argv
 * quoting on its way through `docker exec`. A process that exits mid-read (ENOENT, ESRCH) is skipped; any other
 * read error is thrown, so the exec exits non-zero and fails the case rather than reading as a shorter list.
 * scripts/walk-only-proof.mjs's processes() reads /proc the same way: a fix here belongs there too.
 */
const SCAN = "const fs=require('fs');const out=[];for(const n of fs.readdirSync('/proc')){"
  + "if(!/^[0-9]+$/.test(n))continue;try{const s=fs.readFileSync('/proc/'+n+'/stat','utf8');"
  + "const f=s.slice(s.lastIndexOf(')')+2).split(' ');"
  + "const c=fs.readFileSync('/proc/'+n+'/cmdline','utf8').split(String.fromCharCode(0)).filter(Boolean).join(' ');"
  + "out.push({pid:Number(n),ppid:Number(f[1]),state:f[0],cmdline:c})}"
  + "catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}}"
  + "console.log(JSON.stringify({self:process.pid,procs:out}))";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line) => console.log(`image-e2e: ${line}`);

/**
 * Runs the docker CLI. Rejects on a non-zero exit, naming the command and its stderr, unless `allowFail`. A call
 * still running after `timeoutMs` is killed, and rejects naming the command: a hung exec fails its case.
 */
function docker(args, { env = {}, allowFail = false, timeoutMs = DOCKER_CALL_MS } = {}) {
  const what = `docker ${args.slice(0, 3).join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${what} did not finish within ${timeoutMs} ms, and was killed`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) {
        reject(new Error(`${what} exited ${code}: ${stderr.trim()}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/** Polls the async `probe` until it returns something other than undefined, or throws `message()` at the deadline. */
async function pollFor(probe, waitMs, message) {
  const until = performance.now() + waitMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() >= until) throw new Error(await message());
    await delay(POLL_MS);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const failures = [];
/** Runs one case. A failure is recorded with what was missing, and the next case still runs. */
async function step(name, fn) {
  const started = performance.now();
  try {
    await fn();
    say(`PASS ${name} (${Math.round(performance.now() - started)} ms)`);
  } catch (err) {
    failures.push(name);
    console.error(`image-e2e: FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- The container -----------------------------------------------------------------------------------------------

const container = `rv-e2e-${randomUUID().slice(0, 8)}`;
const identityKey = randomBytes(32);
// Passed by name, so the keys reach docker through its environment and never appear in an argv.
const keyEnv = {
  IDENTITY_HMAC_KEY: identityKey.toString("base64url"), AUDIT_HMAC_KEY: randomBytes(32).toString("base64url"),
};

/** Every process in the container, without the scan's own. A failed exec or unreadable output throws. */
async function scan() {
  const { stdout } = await docker(["exec", container, "node", "-e", SCAN]);
  const { self, procs } = JSON.parse(stdout);
  return procs.filter((p) => p.pid !== self);
}
let servicePid;
const pidsOf = (procs) => new Set(procs.map((p) => p.pid));
const survivorsOf = (procs, baseline) =>
  procs.filter((p) => !baseline.has(p.pid) && p.pid !== 1 && p.pid !== servicePid);
/**
 * Each process as its pid, state and cmdline, cut to 200 characters: Chrome's run to kilobytes. A copy of
 * scripts/walk-only-proof.mjs's describe(): a fix here belongs there too.
 */
const describe = (procs) => procs.map((p) => `${p.pid} [${p.state}] ${(p.cmdline || "(no cmdline)").slice(0, 200)}`)
  .join("; ");
/**
 * Chrome: a process whose argv[0] is the browser. Never a match anywhere in the cmdline, since the CLI's own carries
 * `--browser-executable=<path>/chrome-headless-shell`. A copy of scripts/walk-only-proof.mjs's isLiveChrome(): a
 * fix here belongs there too.
 */
const isChrome = (p) => p.state !== "Z" && p.cmdline.split(" ")[0].split("/").pop() === CHROME;

/** Polls the scan until nothing new survives, to GONE_WAIT_MS, and fails listing the survivors' cmdlines. */
async function assertNoSurvivors(baseline, what) {
  let last = [];
  await pollFor(async () => {
    last = survivorsOf(await scan(), baseline);
    return last.length === 0 ? true : undefined;
  }, GONE_WAIT_MS, () => `${what}: processes survived ${GONE_WAIT_MS} ms after the result: ${describe(last)}`);
}

async function containerState() {
  const { stdout } = await docker(["inspect", "--format", "{{json .State}}", container]);
  return JSON.parse(stdout);
}

let created = false;
async function startContainer() {
  created = true; // a run that fails may still have created it, and rm -f tolerates one that does not exist
  await docker([
    "run", "-d", "--name", container, "-p", "127.0.0.1::8080",
    // Probe every second until the first success, then at the image's own interval, so probes seldom overlap a scan.
    "--health-start-period=120s", "--health-start-interval=1s",
    "-e", `SERVICE_AUDIENCE=${AUDIENCE}`, "-e", "IDENTITY_HMAC_KEY", "-e", "AUDIT_HMAC_KEY", image,
  ], { env: keyEnv, timeoutMs: HEALTHY_WAIT_MS });
  await pollFor(async () => {
    const state = await containerState();
    if (!state.Running) throw new Error(`the container stopped with exit code ${state.ExitCode} before it was healthy`);
    const status = state.Health?.Status;
    if (status === "unhealthy") {
      throw new Error(`the healthcheck reported unhealthy: ${JSON.stringify(state.Health.Log?.at(-1) ?? {})}`);
    }
    return status === "healthy" ? true : undefined;
  }, HEALTHY_WAIT_MS, () => `the container was not healthy within ${HEALTHY_WAIT_MS} ms`);
  const { stdout } = await docker(["port", container, "8080/tcp"]);
  const published = stdout.split("\n").map((line) => line.trim()).find((line) => line.startsWith("127.0.0.1:"));
  check(published !== undefined, `no 127.0.0.1 port is published for 8080/tcp: ${stdout.trim()}`);
  const procs = await scan();
  const service = procs.filter((p) => p.ppid === 1 && p.cmdline.includes("dist-service/service/index.js"));
  check(service.length === 1, `expected one service process under PID 1, found: ${describe(procs)}`);
  servicePid = service[0].pid;
  return Number(published.slice(published.lastIndexOf(":") + 1));
}

// --- Requests ----------------------------------------------------------------------------------------------------

/** The PNG of a successful render_still, or a failure naming what came back. */
function pngOf(result) {
  check(result.isError !== true, `render_still failed: ${JSON.stringify(result).slice(0, 300)}`);
  const [item] = result.content ?? [];
  check(item?.type === "image" && item.mimeType === "image/png", `no image/png content: ${JSON.stringify(item)}`);
  return Buffer.from(item.data, "base64");
}

/** A failed call's category. */
function categoryOf(result) {
  check(result.isError === true, `the call succeeded: ${JSON.stringify(result).slice(0, 300)}`);
  return result.structuredContent?.category;
}

/** One raw POST to /mcp, as a gateway forwards it. Resolves with the status, or rejects at POST_TIMEOUT_MS. */
async function post(url, body, header) {
  try {
    const response = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(POST_TIMEOUT_MS), headers: {
      accept: "application/json, text/event-stream", "content-type": "application/json", [IDENTITY_HEADER]: header,
    } });
    await response.arrayBuffer();
    return response.status;
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new Error(`POST ${url} was not answered within ${POST_TIMEOUT_MS} ms`, { cause: err });
    }
    throw err;
  }
}

let client;
/**
 * render_still, retried while it gets render_busy (whose contract is "retry later") until BUSY_WAIT_MS. Resolves with
 * the result and how long the attempt that produced it took.
 */
async function still(templateId, props) {
  const until = performance.now() + BUSY_WAIT_MS;
  for (;;) {
    const started = performance.now();
    const result = await client.callTool({ name: "render_still", arguments: { template_id: templateId, props } },
      undefined, { timeout: CALL_TIMEOUT_MS });
    const ms = performance.now() - started;
    if (result.structuredContent?.category !== "render_busy" || performance.now() >= until) return { result, ms };
    await delay(POLL_MS);
  }
}

/** A swatch render's decoded pixels. */
async function renderSwatch(props) {
  const { result } = await still("swatch", props);
  const png = PNG.sync.read(pngOf(result));
  check(png.width === 1280 && png.height === 720, `the swatch decoded as ${png.width} x ${png.height}`);
  return png;
}

const inkAt = (data, pos) => Math.max(data[pos], data[pos + 1], data[pos + 2]) >= INK_THRESHOLD;
function inkCount(png) {
  let ink = 0;
  for (let pos = 0; pos < png.data.length; pos += 4) if (inkAt(png.data, pos)) ink += 1;
  return ink;
}

/** Every string anywhere in a JSON value. */
function stringsIn(value) {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringsIn);
}

// --- The cases ---------------------------------------------------------------------------------------------------

async function main() {
  const port = await startContainer();
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  say(`container ${container} healthy on ${url.href}, service pid ${servicePid}`);

  const signed = [];
  client = new Client({ name: "image-e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, {
    fetch: makeSigningFetch({ key: identityKey, audience: AUDIENCE, principal: PRINCIPAL, tenant: TENANT,
      onSigned: (s) => signed.push(s) }),
  }));
  const turkish = JSON.parse(fs.readFileSync(path.join(REPO, "fixtures", "pack", "props", "turkish.json"), "utf8"));
  let first;
  await step("1 render_still swatch with props/turkish.json returns a 1280 x 720 PNG", async () => {
    const baseline = pidsOf(await scan());
    const png = pngOf((await still("swatch", turkish)).result);
    check(png.subarray(0, 8).equals(PNG_SIGNATURE), `the first eight bytes are ${png.subarray(0, 8).toString("hex")}`);
    check(png.toString("latin1", 12, 16) === "IHDR", "the first chunk is not IHDR");
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    check(width === 1280 && height === 720, `IHDR says ${width} x ${height}`);
    first = signed.findLast((s) => s.claims.tool === "render_still");
    check(first !== undefined, "the signing client saw no render_still request");
    // A successful render leaves nothing behind either. Otherwise its leftover would sit in case 4's baseline, unseen.
    await assertNoSurvivors(baseline, "after the swatch render");
  });

  await step("2 a replayed request id gets 401", async () => {
    check(first !== undefined, "case 1 left no request to replay");
    const status = await post(url, first.body, signClaims(first.claims, identityKey));
    check(status === 401, `the replay of case 1's exact request got ${status}`);
  });

  await step("3 a forged header gets 401", async () => {
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: { [REQUEST_ID_META_KEY]: randomUUID() } } };
    const body = JSON.stringify(message);
    const now = Math.floor(Date.now() / 1000);
    const claims = { v: 1, request_id: message.params._meta[REQUEST_ID_META_KEY], principal: PRINCIPAL,
      tenant: TENANT, aud: AUDIENCE, tool: "tools/list", body_sha256: createHash("sha256").update(body).digest("hex"),
      iat: now, exp: now + 60 };
    const genuine = signClaims(claims, identityKey);
    // Another tenant's claims under the genuine signature.
    const forgedClaims = Buffer.from(JSON.stringify({ ...claims, tenant: "another-tenant" })).toString("base64url");
    const forged = `${forgedClaims}.${genuine.split(".")[1]}`;
    const status = await post(url, body, forged);
    check(status === 401, `the forged header got ${status}`);
    // The control: a refused request does not use up its id, and the genuine header on the same body is accepted.
    const control = await post(url, body, genuine);
    check(control === 200, `the genuine header on the same body got ${control}`);
  });

  await step("6 the audit log has case 1's ok line and both refusals, and none of the props' strings", async () => {
    check(first !== undefined, "case 1 left no request_id to look for");
    const wanted = {
      [`an ok line for request_id ${first.claims.request_id}`]: (e) => e.outcome === "ok"
        && e.tool === "render_still" && e.request_id === first.claims.request_id,
      "a refused line for the replay (replayed, 401)": (e) => e.outcome === "refused" && e.category === "replayed"
        && e.http_status === 401,
      "a refused line for the forged header (bad_signature, 401)": (e) => e.outcome === "refused"
        && e.category === "bad_signature" && e.http_status === 401,
    };
    let text = "";
    let missing = [];
    await pollFor(async () => {
      text = (await docker(["exec", container, "cat", AUDIT_LOG])).stdout;
      const events = text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
      missing = Object.entries(wanted).filter(([, match]) => !events.some(match)).map(([what]) => what);
      return missing.length === 0 ? true : undefined;
    }, 10_000, () => `the audit log lacks ${missing.join("; ")}`);
    for (const value of stringsIn(turkish)) {
      // As written, and as JSON would escape it.
      for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) {
        check(!text.includes(form), `the audit log contains the props value ${JSON.stringify(form)}`);
      }
    }
    // A truncated, re-normalised or \u-escaped value passes the check above, so this one needs no list of values.
    // An audit line is ts, outcome, tool, category, JSON pointer fields, numbers and hex hashes (src/service/audit.ts),
    // plus the ids this script signs: PRINCIPAL, TENANT and the signing client's UUIDs. All printable ASCII, and
    // JSON.stringify writes a \u escape only for a control character or a lone surrogate, which none of them holds.
    // So any other character, or any \u, is something the audit took from a payload.
    const lines = text.split("\n");
    const unprintable = lines.findIndex((line) => /[^ -~]/.test(line));
    check(unprintable === -1, `the audit log's line ${unprintable + 1} holds a character outside printable ASCII: `
      + lines[unprintable]?.slice(0, 200));
    const escaped = lines.findIndex((line) => line.includes("\\u"));
    check(escaped === -1, `the audit log's line ${escaped + 1} holds a \\u escape: ${lines[escaped]?.slice(0, 200)}`);
  });

  await step("4 render_still slow gets render_timeout after the deadline and leaves no process", async () => {
    const baseline = pidsOf(await scan());
    let settled;
    const call = still("slow", {}).then((done) => { settled = done; }, (error) => { settled = { error }; });
    // The scan's positive control: it does see the render's Chrome, before the deadline.
    let seen = [];
    await pollFor(async () => {
      check(settled === undefined, "the call settled before the scan saw Chrome");
      seen = survivorsOf(await scan(), baseline);
      return seen.some(isChrome) ? true : undefined;
    }, BUSY_WAIT_MS + RENDER_STILL_DEADLINE_MS,
    () => `the scan found no new ${CHROME} process before the deadline; new: ${describe(seen)}`);
    await call;
    check(settled.error === undefined, `the call threw: ${settled.error}`);
    const category = categoryOf(settled.result);
    check(category === "render_timeout", `the category was ${category}`);
    check(settled.ms >= RENDER_STILL_DEADLINE_MS,
      `the result arrived after ${Math.round(settled.ms)} ms, before the ${RENDER_STILL_DEADLINE_MS} ms deadline`);
    await assertNoSurvivors(baseline, "after render_timeout");
  });

  await step("5 a CLI killed mid-render gives render_failed and leaves no process", async () => {
    const baseline = pidsOf(await scan());
    let settled;
    const call = still("slow", {}).then((done) => { settled = done; }, (error) => { settled = { error }; });
    // The CLI is the service's own child. Chrome is waited for too, so the kill lands mid-render.
    let seen = [];
    const cliPid = await pollFor(async () => {
      check(settled === undefined, "the call settled before the CLI and Chrome were up");
      seen = survivorsOf(await scan(), baseline);
      const cli = seen.find((p) => p.ppid === servicePid && p.state !== "Z" && p.cmdline.includes("@remotion/cli"));
      return cli !== undefined && seen.some(isChrome) ? cli.pid : undefined;
    }, START_WAIT_MS, () => `the CLI and ${CHROME} were not both up within ${START_WAIT_MS} ms; new: ${describe(seen)}`);
    // The image has no /usr/bin/kill: this is the shell's builtin.
    const killed = await docker(["exec", "-u", "0", container, "sh", "-c", `kill -KILL ${cliPid}`], { allowFail: true });
    check(killed.code === 0, `kill -KILL ${cliPid} exited ${killed.code}: ${killed.stderr.trim()}`);
    await call;
    check(settled.error === undefined, `the call threw: ${settled.error}`);
    const category = categoryOf(settled.result);
    check(category === "render_failed", `the category was ${category}`);
    await assertNoSurvivors(baseline, "after the CLI was killed");
  });

  await step("7 Turkish glyphs render, unlike tofu", async () => {
    const baseline = pidsOf(await scan());
    const glyphs = await renderSwatch({ label: "ŞşİığĞüÜ", color: "#000000" });
    await assertNoSurvivors(baseline, "after the Turkish render");
    const tofu = await renderSwatch({ label: "\u{10FFFD}".repeat(8), color: "#000000" });
    await assertNoSurvivors(baseline, "after the tofu render");
    const glyphInk = inkCount(glyphs);
    const tofuInk = inkCount(tofu);
    check(tofuInk > 0, "the tofu render has no ink, so it cannot show what a missing glyph looks like");
    check(glyphInk > 0, "the Turkish render has no ink");
    // includeAA: every pixel that differs counts, anti-aliased or not.
    const diff = new Uint8Array(glyphs.data.length);
    const changed = pixelmatch(glyphs.data, tofu.data, diff, 1280, 720, { threshold: 0.1, includeAA: true,
      diffMask: true });
    let differAtTofuInk = 0;
    for (let pos = 0; pos < tofu.data.length; pos += 4) {
      if (inkAt(tofu.data, pos) && diff[pos + 3] !== 0) differAtTofuInk += 1;
    }
    say(`glyph ink ${glyphInk}, tofu ink ${tofuInk}, changed pixels ${changed}, `
      + `differing at the tofu's ink ${differAtTofuInk}`);
    check(differAtTofuInk * 2 >= tofuInk, `the Turkish render differs from the tofu render at only ${differAtTofuInk} `
      + `of the tofu's ${tofuInk} ink pixels: its glyphs look like tofu`);
  });

  await step("the service is still running and healthy", async () => {
    const state = await containerState();
    check(state.Running && state.Restarting === false, `the container is not running (exit code ${state.ExitCode})`);
    check(state.Health?.Status === "healthy", `its health is ${state.Health?.Status}`);
  });
  await client.close();
}

let crashed = false;
try {
  await main();
} catch (err) {
  crashed = true;
  console.error(`image-e2e: could not run the cases: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (created) {
    if (crashed || failures.length > 0) {
      const logs = await docker(["logs", "--tail", "200", container], { allowFail: true }).catch(() => undefined);
      if (logs?.code === 0) console.error(`image-e2e: the container's last log lines:\n${logs.stdout}${logs.stderr}`);
    }
    // A container left running still holds the throwaway keys, so a failed removal is said out loud. The verdict
    // stays what the cases made it.
    const removed = await docker(["rm", "-f", container], { allowFail: true })
      .catch((err) => ({ code: undefined, stderr: err instanceof Error ? err.message : String(err) }));
    if (removed.code !== 0) {
      console.error(`image-e2e: WARNING: could not remove the container ${container}`
        + `${removed.code === undefined ? "" : ` (docker rm -f exited ${removed.code})`}: ${removed.stderr.trim()}. `
        + `Remove it yourself with: docker rm -f ${container}`);
    }
  }
}
if (crashed) process.exit(2);
say(failures.length === 0 ? "every case passed" : `${failures.length} case(s) failed: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);

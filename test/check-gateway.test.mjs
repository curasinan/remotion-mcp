// scripts/check-gateway.mjs against test/helpers/reference-gateway.mjs. The reference gateway, with no faults, keeps
// docs/CONTRACT-gateway.md and passes every check. Each fault that breaks an obligation must fail the check that covers
// it, with a diagnosis that names the cause; each that differs in a way the contract allows must still pass. Everything
// runs in this process, on 127.0.0.1, on any platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import {
  DEFAULT_SLOW_MS, describeRecord, diagnoseIdentity, parseListen, readCallerHeaders, readKey, runCheck, startStandIn,
  UsageError,
} from "../scripts/check-gateway.mjs";
import { startReferenceGateway } from "./helpers/reference-gateway.mjs";
import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

if (!fs.existsSync(path.join(import.meta.dirname, "..", "dist-service", "service", "http.js"))) {
  throw new Error("dist-service/service/http.js does not exist. Run `npm run build:service` first; the checker runs "
    + "the compiled service handler.");
}

const AUD = "gateway-check-test";
/** Every test has this timeout, so a check that never settles fails with the test's name. */
const TIMED = { timeout: 60_000 };
/** A caller credential that must never reach the deployment, or the checker's output. */
const SECRET = `Bearer ${randomBytes(12).toString("hex")}`;
/** The checks, in the order runCheck reports them. */
const CHECK_IDS = ["initialize", "initialized-notification", "second-session", "tools-list", "tools-call", "arguments",
  "caller-identity", "slow-answer", "sse-streaming", "disconnect", "stray-requests", "headers", "caller-credentials"];
/** A short slow render that still streams: the stand-in writes its marker every 100 ms while it runs. */
const SLOW = { skipSlow: false, slowMs: 1_500, markerMs: 100 };

/**
 * Runs the checker against a reference gateway with `faults`. Without `options` it skips the slow render and the
 * disconnect probe, which each fault test turns back on only when it is about them. Returns the results by id.
 */
async function check(t, faults = {}, options = {}) {
  const key = randomBytes(32);
  const gateway = await startReferenceGateway({ key, audience: AUD, faults });
  t.after(() => gateway.close());
  // A 200 ms quiet window at the end, not the CLI's 1 s: the hedge fault's copy follows its request after 30 ms.
  const results = await runCheck({ gatewayUrl: gateway.url, key, audience: AUD, skipSlow: true, skipDisconnect: true,
    quietMs: 200, callerHeaders: { authorization: SECRET }, onListening: (url) => gateway.setUpstream(url),
    ...options });
  assert.ok(!JSON.stringify(results).includes(SECRET), "a caller credential reached the checker's output");
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

/** Asserts `result` failed with a detail matching `pattern`. */
function assertFailed(result, pattern) {
  assert.equal(result?.status, "fail", `expected a failure, got ${JSON.stringify(result)}`);
  assert.ok(result.details.some((line) => pattern.test(line)), `no detail matches ${pattern}: ${result.details}`);
}

test("a gateway that keeps the contract passes every check", TIMED, async (t) => {
  const results = await check(t, {}, { ...SLOW, skipDisconnect: false });
  assert.deepEqual(Object.keys(results), CHECK_IDS);
  for (const result of Object.values(results)) assert.equal(result.status, "pass", JSON.stringify(result));
  assert.match(results["sse-streaming"].details[0], /marker reached the caller .* before the render ended/);
  assert.match(results["slow-answer"].title, /shorter than the default 58\.0 s/);
});

test("the default slow render stays under the contract's 60 s and over the service's own slowest answer", () => {
  // A gateway whose upstream timeout is exactly 60 s keeps the contract, so it must get its answer. The service answers
  // render_timeout at its 45 s deadline and finishes the kill in the background.
  assert.ok(DEFAULT_SLOW_MS < 60_000 && DEFAULT_SLOW_MS > 45_000, String(DEFAULT_SLOW_MS));
});

const ALLOWED_DIFFERENCES = [
  ["gives its callers a session id and requires it", { sessionful: true }],
  ["answers notifications itself", { answerNotifications: true }],
  ["refuses a caller that sends its own X-Render-Identity", { rejectCallerIdentity: true }],
  ["hides two tools from tools/list", { filterTools: true }],
  ["refuses a caller's X-Render-Identity with a JSON-RPC error", { refuseIdentityJsonRpc: true }],
  ["re-frames SSE with lone CRs", { crLineEndings: true }],
];
for (const [name, faults] of ALLOWED_DIFFERENCES) {
  test(`a gateway that ${name} fails no check`, TIMED, async (t) => {
    const results = await check(t, faults);
    for (const result of Object.values(results)) assert.notEqual(result.status, "fail", JSON.stringify(result));
  });
}

test("a gateway that answers notifications itself leaves _meta in notifications unchecked, and says so", TIMED,
  async (t) => {
    const results = await check(t, { answerNotifications: true });
    assert.equal(results["initialized-notification"].status, "inconclusive");
    assert.match(results["initialized-notification"].details[0], /answered the notification itself/);
  });

test("a gateway that hides tools passes tools/list, naming what the caller did not get", TIMED, async (t) => {
  const results = await check(t, { filterTools: true });
  assert.ok(results["tools-list"].details.some((line) => /did not get render_video_start, render_job_status/.test(line)));
});

test("a gateway that refuses a caller's X-Render-Identity itself passes that check", TIMED, async (t) => {
  const results = await check(t, { rejectCallerIdentity: true });
  assert.equal(results["caller-identity"].status, "pass");
  assert.match(results["caller-identity"].details[0], /refused the call itself, HTTP 400/);
});

const SIGNING_FAULTS = [
  ["a padded claims part", { paddedClaims: true }, /= padding, from a padded encoder/],
  ["a hash of the caller's body", { hashCallerBody: true }, /before the gateway injected _meta/],
  ["the key's text as the HMAC key", { keyAsText: true }, /base64url text as the HMAC key/],
  ["a signature over the claims JSON", { signJson: true }, /claims JSON, not its base64url encoding/],
  ["a clock 45 s ahead", { clockOffsetS: 45 }, /iat is 4[45] s ahead/],
  ["a clock 200 s behind", { clockOffsetS: -200 }, /exp was 1[34]\d s ago/],
  ["a 300 s lifetime", { ttlS: 300 }, /exp - iat is 300 s; the most is 120/],
  ["a clock 45 s behind and a 120 s lifetime", { clockOffsetS: -45, ttlS: 120 }, /gateway's clock is about 4\d s behind/],
  ["its header set twice", { duplicateOwnIdentity: true }, /the gateway sets the header twice/],
];
for (const [name, faults, pattern] of SIGNING_FAULTS) {
  test(`a gateway that signs with ${name} fails initialize, and says why`, TIMED, async (t) => {
    const results = await check(t, faults);
    assertFailed(results.initialize, pattern);
    assertFailed(results["tools-list"], pattern);
  });
}

test("a gateway that injects no _meta into notifications fails only the notification", TIMED, async (t) => {
  const results = await check(t, { noMetaOnNotifications: true });
  assert.equal(results.initialize.status, "pass");
  assertFailed(results["initialized-notification"], /no params\._meta\["io\.github\.curasinan\/request_id"\]/);
  assert.equal(results["tools-list"].status, "pass");
});

test("a gateway that reuses a request_id passes once, then is refused as a replay", TIMED, async (t) => {
  const results = await check(t, { reuseRequestId: true });
  assert.equal(results.initialize.status, "pass");
  assertFailed(results["initialized-notification"], /already accepted once: the gateway reused it/);
  // One constant id for everything is not one derived from the caller's id or body.
  assert.ok(!results["second-session"].details.some((line) => /derives request_id/.test(line)));
});

test("a gateway that derives request_id from the caller's JSON-RPC id fails the second session's handshake", TIMED,
  async (t) => {
    const results = await check(t, { requestIdFromJsonRpcId: true });
    assert.equal(results.initialize.status, "pass");
    assert.equal(results["tools-list"].status, "pass");
    assertFailed(results["second-session"], /derives request_id from the caller's JSON-RPC id or body/);
  });

const CALLER_IDENTITY_FAULTS = [
  ["forwards the caller's X-Render-Identity beside its own", { passCallerIdentity: true },
    /forwards the caller's header as well as its own/],
  ["forwards the caller's X-Render-Identity instead of its own", { substituteCallerIdentity: true },
    /forwarded it instead of signing its own/],
  ["adopts the caller's own _meta request_id", { adoptCallerRequestId: true },
    /adopted the caller's own _meta request_id/],
  ["lets the caller's _meta override its request_id", { callerMetaWins: true }, /is the caller's own value: it overrode/],
];
for (const [name, faults, pattern] of CALLER_IDENTITY_FAULTS) {
  test(`a gateway that ${name} fails that check alone, and says why`, TIMED, async (t) => {
    const results = await check(t, faults);
    assertFailed(results["caller-identity"], pattern);
    assert.equal(results["tools-list"].status, "pass");
  });
}

const HEADER_FAULTS = [
  ["accept without text/event-stream", { accept: "application/json" }, /accept is "application\/json"/],
  ["a text/plain content-type", { contentType: "text/plain" }, /content-type is "text\/plain"/],
  ["an unsupported protocol version", { protocolVersion: "2099-01-01" }, /"2099-01-01"/],
  ["two content-type headers", { duplicateContentType: true }, /"application\/json, application\/json"/],
];
for (const [name, faults, pattern] of HEADER_FAULTS) {
  test(`a gateway that sends ${name} fails the header check, and the calls the service refuses`, TIMED, async (t) => {
    const results = await check(t, faults);
    assertFailed(results.headers, pattern);
    assertFailed(results["tools-list"], pattern);
  });
}

const CREDENTIAL_FAULTS = [
  ["forwards it", { forwardCallerHeaders: true }, /the caller's authorization reached the deployment in header authorization\./],
  ["renames it", { renameCallerAuth: true }, /reached the deployment in header x-forwarded-authorization/],
  ["sends it after its own", { appendCallerAuth: true }, /reached the deployment in header authorization/],
  ["copies it into _meta", { credentialInMeta: true }, /reached the deployment in the forwarded body/],
  ["puts it in the upstream URL", { credentialInQuery: true }, /reached the deployment in the request URL/],
  ["signs it as the principal", { principalFromCaller: true }, /reached the deployment in the identity claims' principal/],
];
for (const [name, faults, pattern] of CREDENTIAL_FAULTS) {
  test(`a gateway that takes the caller's credential and ${name} fails that check, naming headers, never values`,
    TIMED, async (t) => {
      const results = await check(t, faults);
      assertFailed(results["caller-credentials"], pattern);
    });
}

test("a gateway that buffers the answer fails streaming, though the answer arrives", TIMED, async (t) => {
  const results = await check(t, { buffer: true }, SLOW);
  assertFailed(results["sse-streaming"], /only after the render had ended: the gateway buffers the answer/);
  assert.equal(results["slow-answer"].status, "pass");
});

for (const heartbeatText of ["gateway heartbeat", "keepalive"]) {
  test(`a gateway that writes its own ": ${heartbeatText}" while it buffers the answer still fails streaming`, TIMED,
    async (t) => {
      const results = await check(t, { ownHeartbeat: true, heartbeatText }, SLOW);
      assertFailed(results["sse-streaming"], /only after the render had ended/);
    });
}

test("a gateway that turns the SSE answer into one JSON body fails streaming, though the answer arrives", TIMED,
  async (t) => {
    const results = await check(t, { jsonAnswer: true }, SLOW);
    assertFailed(results["sse-streaming"], /one application\/json answer, after the render had ended/);
    assert.equal(results["slow-answer"].status, "pass");
  });

test("a gateway that sends each request twice with the same header fails, naming the replay", TIMED, async (t) => {
  const results = await check(t, { hedge: true }, SLOW);
  // The image did arrive: the slow answer fails for the refused copy alone, not for a reply it never got.
  assert.ok(!results["slow-answer"].details.some((line) => /held no reply/.test(line)));
  const failed = Object.values(results).filter((r) => r.status === "fail");
  assert.ok(failed.some((r) => r.details.some((line) => / replayed: /.test(line))), JSON.stringify(failed));
  assert.ok(failed.some((r) => r.details.some((line) => /new request_id and a new signature/.test(line))));
});

test("a render that ends before the first marker leaves streaming unjudged, and says why", TIMED, async (t) => {
  // No markerMs: the stand-in writes its marker every 15 s, as the SDK its keep-alive, and the gateway cuts the render
  // at 0.5 s.
  const results = await check(t, { timeoutMs: 500 }, { skipSlow: false, slowMs: 1_500 });
  assert.equal(results["sse-streaming"].status, "inconclusive");
  assert.match(results["sse-streaming"].details[0], /before the stand-in's first marker \(every 15\.0 s\)/);
});

test("a gateway whose upstream timeout is shorter than the render fails the slow answer", TIMED, async (t) => {
  const results = await check(t, { timeoutMs: 500 }, SLOW);
  assertFailed(results["slow-answer"], /closed the deployment's request after .*before the render finished/);
});

test("a gateway that keeps the upstream request open after its caller leaves fails the disconnect check",
  TIMED, async (t) => {
    const results = await check(t, { keepUpstreamOnDisconnect: true },
      { skipDisconnect: false, disconnectDeadlineMs: 1_000 });
    assertFailed(results.disconnect, /still open 1\.0 s later/);
  });

test("a gateway that notices a disconnect only on its next write fails the disconnect check", TIMED, async (t) => {
  // The test probe writes into the slow render's stream only, so the disconnect probe's stays quiet, as a real one's.
  const results = await check(t, { detectDisconnectOnWrite: true },
    { skipDisconnect: false, disconnectDeadlineMs: 1_000, markerMs: 100 });
  assertFailed(results.disconnect, /still open 1\.0 s later/);
});

test("a gateway that cannot be reached fails initialize and skips the rest", TIMED, async () => {
  // A port that was free a moment ago: nothing listens on it.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const results = await runCheck({ gatewayUrl: `http://127.0.0.1:${port}/mcp`, key: randomBytes(32), audience: AUD });
  assert.deepEqual(results.map((r) => [r.id, r.status]), [["initialize", "fail"], ["rest", "skip"]]);
  assert.match(results[0].details[0], /could not reach the gateway/);
});

test("readKey takes the service's key rules, and refuses the published vector key", () => {
  const fresh = randomBytes(32).toString("base64url");
  assert.deepEqual(readKey({ IDENTITY_HMAC_KEY: fresh }), Buffer.from(fresh, "base64url"));
  assert.throws(() => readKey({}), (err) => err instanceof UsageError && /is not set/.test(err.message));
  assert.throws(() => readKey({ IDENTITY_HMAC_KEY: `${fresh}=` }), /not unpadded base64url/);
  assert.throws(() => readKey({ IDENTITY_HMAC_KEY: randomBytes(31).toString("base64url") }), /at least 32/);
  assert.throws(() => readKey({ IDENTITY_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url") }), /published/);
  // HMAC zero-pads a key to 64 bytes, so the vector key with a trailing zero byte is the same key.
  assert.throws(() => readKey({ IDENTITY_HMAC_KEY: Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(1)])
    .toString("base64url") }), /published/);
});

test("readCallerHeaders refuses a value fetch would refuse, without ever showing it", () => {
  for (const bad of ["Bearer abc\ndef", "Bearer abc\r\nx: y", "Bearer abc\u0000def"]) {
    assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: JSON.stringify({ authorization: bad }) }),
      (err) => err instanceof UsageError && /"authorization"/.test(err.message) && !err.message.includes("abc"));
  }
});

test("readCallerHeaders tells a bad name, a reserved name, and a short value apart", () => {
  assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: '{"bad name":"Bearer abcdefgh"}' }),
    /"bad name", which is not a valid header name/);
  assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: '{"transfer-encoding":"chunked-x"}' }), /may not set/);
  for (const short of ["", "   ", "Bearer"]) {
    assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: JSON.stringify({ authorization: short }) }),
      (err) => err instanceof UsageError && /shorter than 8 characters/.test(err.message));
  }
});

test("readCallerHeaders takes a JSON object of strings, and refuses the headers the checks depend on", () => {
  assert.deepEqual(readCallerHeaders({}), {});
  assert.deepEqual(readCallerHeaders({ GATEWAY_CHECK_HEADERS: '{"Authorization":"Bearer x"}' }),
    { authorization: "Bearer x" });
  assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: "Bearer x" }), /not JSON/);
  assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: '{"a":1}' }), /string values/);
  assert.throws(() => readCallerHeaders({ GATEWAY_CHECK_HEADERS: '{"X-Render-Identity":"x"}' }), /may not set/);
});

test("parseListen reads host:port, an IPv6 host in brackets, and refuses anything else", () => {
  assert.deepEqual(parseListen("0.0.0.0:8787"), { host: "0.0.0.0", port: 8787 });
  assert.deepEqual(parseListen("[::1]:0"), { host: "::1", port: 0 });
  for (const bad of ["8787", "host:", "host:70000", "::1:8787"]) assert.throws(() => parseListen(bad), UsageError);
});

// Refusals the reference gateway's faults do not produce, each with what the gateway did wrong.
const KEY = randomBytes(32);
const sign = (claims, key = KEY) => {
  const part = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${part}.${createHmac("sha256", key).update(part).digest("base64url")}`;
};
const BODY = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":'
  + '{"io.github.curasinan/request_id":"r-2"}}}', "utf8");
const CLAIMS = { v: 1, request_id: "r-1", principal: "p", tenant: "t", aud: "other", tool: "tools/call",
  body_sha256: createHash("sha256").update(BODY).digest("hex").toUpperCase(), iat: 1_800_000_000, exp: 1_800_000_060 };
const diagnose = (refusal, header, extra = {}) => diagnoseIdentity({ refusal, header, rawBody: BODY, key: KEY,
  audience: AUD, nowS: 1_800_000_000, startedAtS: 1_800_000_100, ...extra });

const DIAGNOSES = [
  ["missing", undefined, /no X-Render-Identity header/],
  ["wrong_audience", sign(CLAIMS), /aud is "other", but this deployment's audience is "gateway-check-test"/],
  ["tool_mismatch", sign(CLAIMS), /tool is "tools\/call", but the message's method is "tools\/list"/],
  ["request_id_mismatch", sign(CLAIMS), /is "r-2", but the claims' request_id is "r-1"/],
  ["body_mismatch", sign(CLAIMS), /uppercase hex/],
  ["body_mismatch", sign({ ...CLAIMS, body_sha256: createHash("sha256").update(BODY).digest("base64") }), /is base64/],
  ["signed_before_start", sign(CLAIMS), /100 s before this stand-in started/],
  ["unsupported_version", sign({ ...CLAIMS, v: 2 }), /v is 2; contract v1 needs 1/],
  ["bad_signature", sign(CLAIMS, randomBytes(32)), /does not match with IDENTITY_HMAC_KEY/],
  ["malformed", `${sign(CLAIMS)}=`, /signature ends in = padding/],
  ["malformed", `${sign(CLAIMS).split(".")[0]}.${"A".repeat(42)}`, /42 characters/],
  ["malformed", sign({ ...CLAIMS, iat: 1.5, tenant: null }), /tenant is null, not a string; iat is 1\.5/],
  ["malformed", "a.b.c", /2 dots/],
  ["batch", sign(CLAIMS), /JSON array, a batch/],
];
for (const [refusal, header, pattern] of DIAGNOSES) {
  test(`a ${refusal} refusal is explained: ${pattern}`, () => {
    assert.match(diagnose(refusal, header), pattern);
  });
}

test("a body re-serialised after signing is explained", () => {
  const spaced = Buffer.from('{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }', "utf8");
  const compact = Buffer.from(JSON.stringify(JSON.parse(spaced.toString("utf8"))), "utf8");
  const claims = { ...CLAIMS, body_sha256: createHash("sha256").update(compact).digest("hex") };
  assert.match(diagnose("body_mismatch", sign(claims), { rawBody: spaced }), /re-serialised the body after signing/);
});

/** A stand-in on 127.0.0.1:0 that hands each finished record to the test. */
async function standInWithRecords(t) {
  const records = [];
  const standIn = await startStandIn({ key: KEY, audience: AUD, onRecord: (record) => records.push(record) });
  t.after(() => standIn.close());
  const done = async (count) => {
    for (const deadline = performance.now() + 10_000; records.length < count;) {
      if (performance.now() >= deadline) assert.fail(`only ${records.length} of ${count} records finished`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return records;
  };
  return { standIn, done };
}

test("a request whose body never ends is never reported as verified, and does not crash the stand-in", TIMED,
  async (t) => {
    const { standIn, done } = await standInWithRecords(t);
    const { port } = new URL(standIn.url);
    for (const header of ["", `x-render-identity: ${sign({ ...CLAIMS, aud: AUD })}\r\n`]) {
      const socket = net.connect(Number(port), "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(`POST /mcp HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\n${header}`
        + "content-length: 100\r\n\r\n{\"jsonrpc\"");
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.destroy();
    }
    for (const record of await done(2)) {
      const line = describeRecord(record, standIn);
      assert.equal(line.ok, false);
      assert.match(line.text, /the deployment never answered: the body never ended/);
    }
  });

test("the SDK client's own GET stream, refused with 405, is reported as expected", TIMED, async (t) => {
  const { standIn, done } = await standInWithRecords(t);
  const res = await fetch(standIn.url, { headers: { accept: "text/event-stream" } });
  assert.equal(res.status, 405);
  const [record] = await done(1);
  const line = describeRecord(record, standIn);
  assert.equal(line.ok, true);
  assert.match(line.text, /405, as the contract answers the SDK client's own GET stream/);
});

test("iat and exp in milliseconds are named as such, not as a clock problem", () => {
  const ms = { ...CLAIMS, aud: AUD, iat: 1_800_000_000_000, exp: 1_800_000_060_000 };
  for (const refusal of ["not_yet_valid", "ttl_too_long"]) {
    assert.match(diagnose(refusal, sign(ms)), /look like milliseconds: the contract counts whole seconds/);
  }
});

test("a body cut at the caller's Content-Length is named as such", () => {
  const caller = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', "utf8");
  const forwarded = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{}}}', "utf8");
  const claims = { ...CLAIMS, body_sha256: createHash("sha256").update(forwarded).digest("hex") };
  assert.match(diagnose("body_mismatch", sign(claims), { rawBody: forwarded.subarray(0, caller.length), sentBody: caller }),
    /cut at the caller's Content-Length/);
});

test("signed_before_start blames the clock only for a message the checker sent", () => {
  const old = sign({ ...CLAIMS, aud: AUD, iat: 1_799_999_900, exp: 1_800_000_000 });
  assert.match(diagnose("signed_before_start", old, { sentBody: BODY }), /gateway's clock is about 100 s behind/);
  assert.match(diagnose("signed_before_start", old), /resent a header it signed earlier, or its clock is about 100 s/);
});

test("a request the deployment is still handling is never reported as answered", async (t) => {
  const { standIn } = await standInWithRecords(t);
  const line = describeRecord({ done: false, method: "POST", url: "/mcp", rawHeaders: [] }, standIn);
  assert.equal(line.ok, false);
  assert.match(line.text, /still handling it when the checker stopped waiting/);
});

test("a stand-in that cannot listen says so as a usage error, and leaves no temporary directory", async (t) => {
  const { standIn } = await standInWithRecords(t);
  const { port } = new URL(standIn.url);
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("gateway-check-")).length;
  await assert.rejects(startStandIn({ key: KEY, audience: AUD, port: Number(port) }),
    (err) => err instanceof UsageError && /cannot listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/.test(err.message));
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("gateway-check-")).length;
  assert.equal(after, before);
});

/** A credential with the characters encoders change: + / and = padding, as base64 API keys and Basic auth carry. */
const B64_SECRET = `Basic ${Buffer.from(`user:${randomBytes(18).toString("base64")}+/=`).toString("base64")}`;

test("a credential percent-encoded in the URL, or JSON-escaped in the body, is still found, and never printed",
  TIMED, async (t) => {
    for (const [faults, place] of [[{ credentialInQuery: true }, /in the request URL/],
      [{ credentialInMeta: true, escapeSlashes: true }, /in the forwarded body/]]) {
      const results = await check(t, faults, { callerHeaders: { authorization: B64_SECRET } });
      assertFailed(results["caller-credentials"], place);
      const output = JSON.stringify(results);
      const token = B64_SECRET.split(" ")[1];
      for (const form of [token, encodeURIComponent(token), token.replaceAll("/", "\\/")]) {
        assert.ok(!output.includes(form), "a spelling of the credential reached the checker's output");
      }
    }
  });

test("a body cut at the caller's Content-Length is judged as that call's, with the cause named", TIMED, async (t) => {
  const results = await check(t, { truncateToCallerLength: true });
  assertFailed(results.initialize, /cut at the caller's Content-Length/);
  assert.ok(!results.initialize.details.some((line) => /nothing reached the deployment/.test(line)));
});

test("a gateway's own health checks, by any method or path, fail nothing, the disconnect check included", TIMED,
  async (t) => {
    for (const healthCheck of [{ method: "HEAD", path: "/mcp" }, { method: "GET", path: "/" }]) {
      const results = await check(t, { healthCheck }, { skipDisconnect: false });
      for (const result of Object.values(results)) assert.notEqual(result.status, "fail", JSON.stringify(result));
      assert.equal(results.disconnect.status, "pass", JSON.stringify(results.disconnect));
      assert.equal(results["stray-requests"].status, "pass");
    }
  });

test("a gateway that resets its caller after the deployment answered is not called unreachable", TIMED, async (t) => {
  const results = await check(t, { resetInitialize: true });
  assertFailed(results.initialize, /closed the connection without an answer/);
  assert.equal(results.initialize.details[0].startsWith("initialize: verified"), true);
  assert.equal(results["tools-list"].status, "pass");
});

test("a streamed answer that lost its content-type passes streaming, and says what it lost", TIMED, async (t) => {
  const results = await check(t, { dropContentType: true }, SLOW);
  assert.equal(results["sse-streaming"].status, "pass", JSON.stringify(results["sse-streaming"]));
  assert.match(results["sse-streaming"].details[0], /lost its content-type/);
});

test("a notification the gateway forwards after answering its caller is judged as the first session's", TIMED,
  async (t) => {
    // Forwarded 1.2 s after the 202, past the 1 s the checker waits for a first record; the quiet window catches it.
    const results = await check(t, { deferNotificationsMs: 1_200 }, { quietMs: 1_000 });
    assert.equal(results["initialized-notification"].status, "pass", JSON.stringify(results["initialized-notification"]));
    assert.match(results["initialized-notification"].details.at(-1), /forwarded the notification afterwards/);
    assert.equal(results["second-session"].status, "pass", JSON.stringify(results["second-session"]));
  });

test("the CLI refuses a --gateway that is not http(s), or that carries a password, without printing it", TIMED,
  async () => {
    const run = promisify(execFile);
    const env = { ...process.env, IDENTITY_HMAC_KEY: randomBytes(32).toString("base64url") };
    const script = path.join(import.meta.dirname, "..", "scripts", "check-gateway.mjs");
    for (const [url, pattern] of [["ftp://host/mcp", /must be http or https/],
      ["http://user:pa55word@127.0.0.1:9/mcp", /carries a user name or password/]]) {
      const outcome = await run(process.execPath, [script, "--gateway", url], { env }).then(() => assert.fail("exit 0"),
        (err) => err);
      assert.equal(outcome.code, 2);
      assert.match(outcome.stderr, pattern);
      assert.ok(!`${outcome.stdout}${outcome.stderr}`.includes("pa55word"));
    }
  });

test("a whole run leaves no timer or socket behind, so its process exits on its own", TIMED, async () => {
  const checker = pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "check-gateway.mjs")).href;
  const helper = pathToFileURL(path.join(import.meta.dirname, "helpers", "reference-gateway.mjs")).href;
  const source = [
    "import { randomBytes } from \"node:crypto\";",
    `const { runCheck } = await import(${JSON.stringify(checker)});`,
    `const { startReferenceGateway } = await import(${JSON.stringify(helper)});`,
    "const key = randomBytes(32);",
    "const gateway = await startReferenceGateway({ key, audience: \"exit\", faults: JSON.parse(process.argv[1]) });",
    "const results = await runCheck({ gatewayUrl: gateway.url, key, audience: \"exit\", skipSlow: false, slowMs: 1500,",
    "  markerMs: 100, quietMs: 200, onListening: (url) => gateway.setUpstream(url) });",
    "await gateway.close();",
    "console.log(results.map((result) => result.status).join(\" \"));",
  ].join("\n");
  // The disconnect probe runs too: a buffering gateway's own heartbeat once outlived the caller who disconnected.
  await Promise.all([{}, { ownHeartbeat: true }].map(async (faults) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(faults)]);
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const printed = new Promise((resolve) => child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) resolve();
    }));
    await Promise.race([printed, exited]);
    // The run is over: a process with nothing left to do exits well within 10 s.
    let timer;
    const code = await Promise.race([exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("running"), 10_000);
      })]);
    clearTimeout(timer);
    if (code === "running") child.kill();
    assert.equal(code, 0, `${JSON.stringify(faults)}: ${code === "running" ? "still running 10 s after the run"
      : `exit ${code}`}; ${stderr}`);
    assert.match(stdout, /^(\w+ ){12}\w+\r?\n$/, `${JSON.stringify(faults)}: ${stdout}`);
  }));
});

#!/usr/bin/env node
// Checks a gateway against docs/CONTRACT-gateway.md from the outside, the way a deployment sees it.
//
//   IDENTITY_HMAC_KEY=<test key> node scripts/check-gateway.mjs --gateway <url> [options]
//   IDENTITY_HMAC_KEY=<test key> node scripts/check-gateway.mjs --serve [options]
//
// The checker is a stand-in deployment. It runs the service's own request handler from dist-service/ (the route, the
// body cap, the verifier, the replay set, the SDK transport and the four tools) in front of a fake renderer, and
// listens on --listen. Configure a test route in the gateway that signs for --audience with IDENTITY_HMAC_KEY and
// forwards to http://<listen>/mcp. The checker then sends MCP requests to the gateway at --gateway, as a backend
// would, and reports, check by check, what reached the deployment and why a refused request was refused.
//
// With --serve it only listens, and prints one line for each request that reaches it, so a real backend can be run
// through the gateway against it.
//
// Run `npm run build:service` first. Exit status: 0 when every check passed, 1 when a check failed, 2 for a usage or
// setup error, 3 when no check failed but one was inconclusive.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, URLSearchParams } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import zlib from "node:zlib";

import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE_DIR = path.join(REPO, "dist-service", "service");
/** The stand-in's templates: the test pack the service tests use, so render_still validates real props. */
const FIXTURE_PACK = path.join(REPO, "test", "fixtures", "packs", "good");

export const DEFAULT_LISTEN = "127.0.0.1:8787";
export const DEFAULT_AUDIENCE = "gateway-check";
/**
 * How long the slow render takes. The contract asks for upstream timeouts of at least 60 s, so a gateway with exactly
 * 60 s must pass: the render stays under it. The service's own slowest answer is shorter still: at its 45 s deadline it
 * answers render_timeout at once and finishes the kill in the background (src/service/render-process.ts, halt).
 */
export const DEFAULT_SLOW_MS = 58_000;
/**
 * The SDK's SSE keep-alive interval (@modelcontextprotocol/sdk server/sseKeepAlive.js, DEFAULT_SSE_KEEP_ALIVE_MS). The
 * stand-in writes its own marker into the slow render's stream at the same interval, so the stream's quiet stretches
 * stay as long as a real deployment's.
 */
const KEEPALIVE_MS = 15_000;
/** How long the gateway has to answer any request but the slow render, and how much longer than the render that one. */
const ANSWER_DEADLINE_MS = 30_000;
/** How long a caller's disconnect may take to reach the deployment as a closed connection. */
export const DISCONNECT_DEADLINE_MS = 10_000;
/** How long the checker waits for a render to start, and for the stand-in to finish a request it has received. */
const SETTLE_MS = 10_000;
/**
 * How long the checker polls for a request to reach the stand-in after the gateway has already answered its caller.
 * Past it, the request counts as not forwarded "within 1 s", and the doc says so.
 */
const EMPTY_MS = 1_000;
/** A render that waits for its connection to close gives up after this long, so nothing outlives a broken run. */
const HANG_CAP_MS = 300_000;
const POLL_MS = 20;

/** The contract's constants. The stand-in itself reads the same values from dist-service. */
const IDENTITY_HEADER = "x-render-identity";
const REQUEST_ID_META_KEY = "io.github.curasinan/request_id";
const MAX_TTL_S = 120;
const SKEW_S = 30;
const SERVICE_TOOLS = ["list_templates", "render_still", "render_video_start", "render_job_status"];
/** A render_still label that starts with this selects a fake render: `gwcheck:<kind>:<nonce>[:<ms>]`. */
const PROBE_PREFIX = "gwcheck:";
/**
 * Headers GATEWAY_CHECK_HEADERS may not set: the ones the checker sets itself, so they cannot change what is checked,
 * and the connection-level ones fetch refuses.
 */
const RESERVED_HEADERS = ["accept", "content-type", "content-length", "mcp-protocol-version", "mcp-session-id",
  IDENTITY_HEADER, "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "expect", "te", "trailer"];
/** fetch error codes that mean no connection to the gateway could be set up at all. */
const SETUP_FAILURES = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_INVALID_ARG"];
/** A credential shorter than this would match unrelated header text when the checker searches for it. */
const MIN_CREDENTIAL_CHARS = 8;
/** The published test-vector key (test/vectors/identity-v1.json). A deployment refuses it, and so does the checker. */
const PUBLISHED_VECTOR_KEY = Buffer.alloc(32, 7);

/** A mistake in how the checker was started: printed without a stack, exit status 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
const now = () => performance.now();
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Polls `probe` until it returns something other than undefined, or returns undefined at the deadline. */
async function pollFor(probe, deadlineMs) {
  const deadline = now() + deadlineMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

/** Whether two keys sign alike under HMAC-SHA256, compared as HMAC uses them (src/service/config.ts, sameHmacKey). */
function sameHmacKey(a, b) {
  const block = (k) => {
    const out = Buffer.alloc(64);
    (k.length > 64 ? createHash("sha256").update(k).digest() : k).copy(out);
    return out;
  };
  return block(a).equals(block(b));
}

/** IDENTITY_HMAC_KEY, by the service's rules: unpadded base64url of at least 32 bytes, never the published key. */
export function readKey(env) {
  const encoded = env.IDENTITY_HMAC_KEY;
  if (encoded === undefined || encoded === "") {
    throw new UsageError("IDENTITY_HMAC_KEY is not set. Generate a test key, configure it in the gateway for the "
      + "checker's audience, and put it in this environment:\n"
      + "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"");
  }
  const key = Buffer.from(encoded, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || key.toString("base64url") !== encoded) {
    throw new UsageError("IDENTITY_HMAC_KEY is not unpadded base64url.");
  }
  if (key.length < 32) throw new UsageError(`IDENTITY_HMAC_KEY decodes to ${key.length} bytes; it must be at least 32.`);
  if (sameHmacKey(key, PUBLISHED_VECTOR_KEY)) {
    throw new UsageError("IDENTITY_HMAC_KEY is the published test-vector key. Generate a fresh test key.");
  }
  return key;
}

/**
 * GATEWAY_CHECK_HEADERS: a JSON object of the headers a backend sends the gateway, such as its credential. They go
 * on every request to the gateway and are never printed. The headers the checks depend on are refused.
 */
export function readCallerHeaders(env) {
  const raw = env.GATEWAY_CHECK_HEADERS;
  if (raw === undefined || raw === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("GATEWAY_CHECK_HEADERS is not JSON. Give a JSON object of header names and string values.");
  }
  if (!isRecord(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
    throw new UsageError("GATEWAY_CHECK_HEADERS must be a JSON object of header names and string values.");
  }
  const headers = {};
  for (const [name, value] of Object.entries(parsed)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower)) {
      throw new UsageError(`GATEWAY_CHECK_HEADERS has "${name}", which is not a valid header name.`);
    }
    if (RESERVED_HEADERS.includes(lower)) {
      throw new UsageError(`GATEWAY_CHECK_HEADERS may not set ${lower}: the checker or fetch sets it.`);
    }
    // fetch would refuse it later with a message that quotes the value; refuse it here, naming the header only.
    let normalised;
    try {
      normalised = new Headers([[lower, value]]).get(lower);
    } catch {
      throw new UsageError(`GATEWAY_CHECK_HEADERS has a value for "${lower}" that is not a valid header value, such as `
        + "one with a line break or a NUL inside it. The value is not shown.");
    }
    // The checker searches everything the deployment receives for each value: an empty or short one would match
    // unrelated text, such as a TOKEN variable that was never set.
    if (normalised.length < MIN_CREDENTIAL_CHARS) {
      throw new UsageError(`GATEWAY_CHECK_HEADERS has a value for "${lower}" shorter than ${MIN_CREDENTIAL_CHARS} `
        + "characters. Give the caller's real credential. The value is not shown.");
    }
    headers[lower] = normalised;
  }
  return headers;
}

/** `host:port`, with an IPv6 host in brackets. */
export function parseListen(text) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(text);
  const port = match ? Number(match[3]) : Number.NaN;
  if (!match || !(port >= 0 && port <= 65_535)) {
    throw new UsageError(`--listen must be host:port, such as ${DEFAULT_LISTEN} or [::1]:8787; got ${text}`);
  }
  return { host: match[1] ?? match[2], port };
}

/** The compiled service module `name`, or a UsageError when dist-service/ is not built. */
async function loadService(name) {
  const file = path.join(SERVICE_DIR, name);
  if (!fs.existsSync(file)) throw new UsageError("dist-service/ is not built. Run `npm run build:service` first.");
  // pathToFileURL, not a bare path: import() of a Windows absolute path throws.
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------------------------------------------
// Diagnosis: why a request the stand-in refused was refused, in terms of what the gateway did
// ---------------------------------------------------------------------------------------------------------------

/** The claims a header carries, decoded without trusting them, or a description of why they cannot be read. */
export function decodeClaims(header) {
  if (typeof header !== "string") return { error: "no header" };
  const dot = header.indexOf(".");
  if (dot < 0) return { error: "no dot" };
  try {
    const claims = JSON.parse(Buffer.from(header.slice(0, dot), "base64url").toString("utf8"));
    return isRecord(claims) ? { claims } : { error: "the claims are not a JSON object" };
  } catch {
    return { error: "the claims part does not decode to JSON" };
  }
}

const describeValue = (value) => (value === undefined ? "missing" : JSON.stringify(value));

/**
 * What is wrong with a header the verifier called `malformed`, as the gateway would fix it. `callerIdentity` is the
 * X-Render-Identity the checker itself sent the gateway for this message, if it sent one.
 */
function diagnoseMalformed(header, callerIdentity) {
  if (callerIdentity !== undefined && header === callerIdentity) {
    return "the deployment received the caller's own X-Render-Identity unchanged: the gateway forwarded it instead of "
      + "signing its own. Drop the caller's, and sign.";
  }
  if (header.includes(", ")) {
    return callerIdentity !== undefined && header.includes(callerIdentity)
      ? "the deployment received two X-Render-Identity values, joined with a comma: the gateway forwards the caller's "
        + "header as well as its own. Drop the caller's."
      : "the deployment received two X-Render-Identity values, joined with a comma: the gateway sets the header twice. "
        + "Set it once.";
  }
  const parts = header.split(".");
  if (parts.length !== 2) return `the header has ${parts.length - 1} dots; it needs exactly one.`;
  const [claimsPart, signaturePart] = parts;
  const padded = "a padded encoder, such as Go's base64.URLEncoding, Java's Base64.getUrlEncoder() or Python's "
    + "urlsafe_b64encode";
  if (claimsPart.includes("=")) {
    return `the claims part ends in = padding, from ${padded}. Strip the = before signing, and sign the string you send.`;
  }
  if (signaturePart.includes("=")) return `the signature ends in = padding, from ${padded}. Strip the =.`;
  if (/[+/]/.test(header)) return "the header uses standard base64 (+ and /); the contract asks for base64url (- and _).";
  if (!/^[A-Za-z0-9_-]+$/.test(claimsPart) || !/^[A-Za-z0-9_-]*$/.test(signaturePart)) {
    return "a part has characters outside base64url, such as whitespace.";
  }
  if (signaturePart.length !== 43) {
    return `the signature is ${signaturePart.length} characters; an HMAC-SHA256 signature in base64url is 43.`;
  }
  if (Buffer.from(signaturePart, "base64url").toString("base64url") !== signaturePart) {
    return "the signature's last character is not the canonical spelling: encode the digest with a standard encoder.";
  }
  const decoded = decodeClaims(header);
  if (decoded.error) return `${decoded.error}.`;
  const c = decoded.claims;
  const problems = [];
  for (const field of ["request_id", "principal", "tenant", "aud", "tool", "body_sha256"]) {
    if (typeof c[field] !== "string") problems.push(`${field} is ${describeValue(c[field])}, not a string`);
  }
  for (const field of ["v", "iat", "exp"]) {
    if (!Number.isInteger(c[field])) problems.push(`${field} is ${describeValue(c[field])}, not a whole number`);
  }
  return problems.length > 0 ? `${problems.join("; ")}.` : "the verifier refused its shape.";
}

/** What the gateway signed instead, when the signature does not match the claims part with this key. */
function diagnoseSignature(header, key) {
  const [claimsPart, signaturePart] = header.split(".");
  const matches = (text, k = key) => hmac(k, text).toString("base64url") === signaturePart;
  const padding = "=".repeat((4 - (claimsPart.length % 4)) % 4);
  if (padding && matches(claimsPart + padding)) {
    return "the signature covers the claims part with its = padding, but the header sends it without: sign the "
      + "exact string you send.";
  }
  const json = Buffer.from(claimsPart, "base64url").toString("utf8");
  if (matches(json)) return "the signature covers the claims JSON, not its base64url encoding: sign the claims part.";
  if (matches(claimsPart, Buffer.from(key.toString("base64url"), "utf8"))) {
    return "the gateway uses the key's base64url text as the HMAC key. Decode it to its bytes first.";
  }
  return "the signature does not match with IDENTITY_HMAC_KEY: check that the gateway signs this audience with the "
    + "same key.";
}

/** What `body_sha256` covers instead of the bytes that reached the deployment. */
function diagnoseBody(claims, rawBody, sentBody) {
  const declared = String(claims.body_sha256);
  const digest = createHash("sha256").update(rawBody).digest();
  // Exactly the caller's length, though the gateway made the body longer when it injected _meta: the caller's
  // Content-Length was forwarded with the rewritten body, and the deployment stopped reading there.
  if (sentBody !== undefined && rawBody.length === sentBody.length && !rawBody.equals(sentBody)) {
    return "the body was cut at the caller's Content-Length: the gateway forwarded it with the rewritten, longer body. "
      + "Recompute Content-Length after rewriting the body, or drop it.";
  }
  if (declared.toLowerCase() === digest.toString("hex")) return "body_sha256 is uppercase hex; it must be lowercase.";
  if (declared === digest.toString("base64") || declared === digest.toString("base64url")) {
    return "body_sha256 is base64; it must be lowercase hex.";
  }
  if (sentBody !== undefined && declared === sha256Hex(sentBody)) {
    return "body_sha256 is the hash of the caller's body, before the gateway injected _meta. Hash and sign the "
      + "rewritten bytes the gateway forwards.";
  }
  try {
    if (declared === sha256Hex(Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8"))), "utf8"))) {
      return "the body that reached the deployment is not the one the gateway hashed: it re-serialised the body "
        + "after signing. Forward the exact bytes you hash.";
    }
  } catch {
    // Not JSON: the generic answer below applies.
  }
  return "body_sha256 is not the SHA-256 of the bytes that reached the deployment. Forward the exact bytes you hash.";
}

/** The claims' `tool` for a message: `params.name` for a tools/call, the method for anything else. */
function toolOf(message) {
  if (!isRecord(message) || typeof message.method !== "string") return undefined;
  if (message.method !== "tools/call") return message.method;
  return isRecord(message.params) ? message.params.name : undefined;
}

/**
 * One sentence on why the stand-in refused a request: `refusal` is the verifier's reason, `header` and `rawBody` what
 * reached it. `sentBody`, `callerIdentity` and `callerMetaId` are what the checker sent the gateway for that message,
 * if known: its bytes, its own X-Render-Identity, and its own _meta request id.
 */
export function diagnoseIdentity({ refusal, header, rawBody, sentBody, callerIdentity, callerMetaId, key, audience,
  nowS, startedAtS }) {
  const decoded = decodeClaims(header);
  const c = decoded.claims ?? {};
  // Seconds since the epoch are about 1.8e9 now; milliseconds are about 1.8e12.
  const milliseconds = c.iat > 1e11 || c.exp > 1e11;
  const unit = "iat and exp look like milliseconds: the contract counts whole seconds since the epoch.";
  let message;
  try {
    message = JSON.parse(rawBody.toString("utf8"));
  } catch {
    message = undefined;
  }
  switch (refusal) {
    case "missing":
      return "no X-Render-Identity header reached the deployment.";
    case "malformed":
      return diagnoseMalformed(header, callerIdentity);
    case "unsupported_version":
      return `v is ${describeValue(c.v)}; contract v1 needs 1.`;
    case "bad_signature":
      return diagnoseSignature(header, key);
    case "wrong_audience":
      return `aud is ${describeValue(c.aud)}, but this deployment's audience is "${audience}".`;
    case "not_yet_valid":
      if (milliseconds) return unit;
      return `iat is ${c.iat - nowS} s ahead of this machine's clock; up to ${SKEW_S} s is allowed. Check the `
        + "gateway's clock.";
    case "expired":
      if (milliseconds) return unit;
      return `exp was ${nowS - c.exp} s ago by this machine's clock; up to ${SKEW_S} s is allowed. Check the gateway's `
        + "clock, and sign each request when it is forwarded.";
    case "ttl_too_long":
      if (milliseconds) return unit;
      return `exp - iat is ${c.exp - c.iat} s; the most is ${MAX_TTL_S}.`;
    case "signed_before_start": {
      // The checker sent this message moments ago, so a header that fits it was signed for it: the gateway's clock is
      // behind. A message the checker did not send, as under --serve, may also carry an old header resent.
      if (sentBody !== undefined) {
        return `iat is ${nowS - c.iat} s behind this machine's clock, for a message the checker had just sent: the `
          + `gateway's clock is about ${nowS - c.iat} s behind. A deployment refuses such headers for about `
          + `${nowS - c.iat - SKEW_S} s after every restart. Sync the gateway's clock.`;
      }
      return `iat is ${startedAtS - c.iat} s before this stand-in started: the gateway resent a header it signed `
        + `earlier, or its clock is about ${nowS - c.iat} s behind this machine's.`;
    }
    case "body_mismatch":
      return diagnoseBody(c, rawBody, sentBody);
    case "parse":
      return "the forwarded body is not JSON.";
    case "batch":
      return "the gateway forwarded a JSON array, a batch. Forward one message per request.";
    case "tool_mismatch": {
      const where = message?.method === "tools/call" ? "params.name" : "method";
      return `tool is ${describeValue(c.tool)}, but the message's ${where} is ${describeValue(toolOf(message))}.`;
    }
    case "request_id_mismatch": {
      const meta = isRecord(message?.params) ? message.params._meta : undefined;
      const id = isRecord(meta) ? meta[REQUEST_ID_META_KEY] : undefined;
      if (id === undefined) {
        return `the message has no params._meta["${REQUEST_ID_META_KEY}"]. Inject _meta into every message, `
          + "initialize and notifications included.";
      }
      if (callerMetaId !== undefined && id === callerMetaId) {
        return `params._meta["${REQUEST_ID_META_KEY}"] is the caller's own value: it overrode the one the gateway `
          + "injected. Inject the gateway's value over the caller's.";
      }
      return `params._meta["${REQUEST_ID_META_KEY}"] is ${describeValue(id)}, but the claims' request_id is `
        + `${describeValue(c.request_id)}.`;
    }
    case "replayed":
      return `request_id ${describeValue(c.request_id)} was already accepted once: the gateway reused it. Every `
        + "request, a retry included, needs a new request_id and a new signature.";
    default:
      return `refused as ${refusal}.`;
  }
}

/** Why the SDK or the router refused a request whose identity, if it got that far, verified. */
function diagnoseTransport(record) {
  const { status } = record;
  if (status === 404) return `the gateway forwarded to ${record.url}; the deployment serves only POST /mcp.`;
  if (status === 405) return `the gateway forwarded a ${record.method}; the deployment serves only POST /mcp.`;
  if (status === 413) return "the forwarded body is over the 262 144-byte cap.";
  if (status === 406) {
    return `accept is ${describeValue(sdkHeader(record, "accept"))}; it must list application/json and text/event-stream.`;
  }
  if (status === 415) {
    return `content-type is ${describeValue(sdkHeader(record, "content-type"))}; it must be one content-type, `
      + "application/json.";
  }
  const version = sdkHeader(record, "mcp-protocol-version");
  if (status === 400 && version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return `mcp-protocol-version is "${version}", which the service's SDK does not support.`;
  }
  return `the deployment answered ${status}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in deployment
// ---------------------------------------------------------------------------------------------------------------

/** A valid 1x1 PNG, the fake renderer's output. */
const PNG = (() => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))]);
})();

/** Resolves true when `signal` aborts first, false when `ms` pass first. */
function waitUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(true);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A stand-in for runRenderProcess that spawns nothing. The render's props pick what it does: a label
 * `gwcheck:slow:<nonce>:<ms>` waits `ms`, `gwcheck:hang:<nonce>` waits until its connection closes, and anything else
 * renders at once. Each probe's start, finish and abort are recorded under its nonce.
 */
function fakeRenderer(renders) {
  return async (_file, args, options) => {
    let label = "";
    try {
      const props = JSON.parse(fs.readFileSync(path.join(options.cwd, "props.json"), "utf8"));
      if (typeof props?.label === "string") label = props.label;
    } catch {
      // No readable props: an ordinary render.
    }
    const [kind, nonce, ms] = label.startsWith(PROBE_PREFIX) ? label.slice(PROBE_PREFIX.length).split(":") : [];
    const render = { kind, startedAt: now(), finishedAt: undefined, abortedAt: undefined };
    if (nonce !== undefined) renders.set(nonce, render);
    const waitMs = kind === "slow" ? Math.min(Number(ms) || 0, HANG_CAP_MS) : kind === "hang" ? HANG_CAP_MS : 0;
    const cleanup = Promise.resolve({ verified: true, survivors: [] });
    if (waitMs > 0 && await waitUnlessAborted(waitMs, options.signal)) {
      render.abortedAt = now();
      return { exitCode: null, signal: null, timedOut: false, aborted: true, outputTail: "", cleanup };
    }
    render.finishedAt = now();
    const at = args.indexOf("still");
    fs.writeFileSync(path.join(options.cwd, args[at + 3]), PNG);
    return { exitCode: 0, signal: null, timedOut: false, aborted: false, outputTail: "", cleanup };
  };
}

/**
 * Starts the stand-in deployment on `host:port`: the service's own handler with the fixture pack and the fake renderer.
 * Every request becomes a record: its method, URL, raw headers and raw body as they arrived, the verifier's refusal if
 * any, the tool's audited outcome, and the status the stand-in answered. `onRecord(record)` sees each one once the
 * stand-in has answered it; with `keepRecords: false`, as --serve runs it, no record is kept after that.
 *
 * Into the slow render's stream the stand-in writes `marker`, an SSE comment with a nonce no gateway can know, every
 * `markerMs` (default 15 s, the SDK's own keep-alive interval, so the stream's quiet stretches stay as long as a real
 * deployment's). Only that marker proves the deployment's bytes streamed. A short `markerMs` is for the checker's tests.
 */
export async function startStandIn({ key, audience, host = "127.0.0.1", port = 0, markerMs = KEEPALIVE_MS, onRecord,
  keepRecords = true } = {}) {
  const { createServiceHandler } = await loadService("http.js");
  const { loadPack } = await loadService("templates.js");
  const { RenderSlots } = await loadService("slots.js");
  const C = await loadService("constants.js");
  if (C.REQUEST_ID_META_KEY !== REQUEST_ID_META_KEY || C.IDENTITY_HEADER !== IDENTITY_HEADER
    || C.IDENTITY_MAX_TTL_S !== MAX_TTL_S || C.IDENTITY_SKEW_S !== SKEW_S) {
    throw new UsageError("dist-service/ was built from a different contract than this checker. Rebuild it.");
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-check-"));
  const shutdown = new AbortController();
  const current = new AsyncLocalStorage();
  const marker = `gateway-check ${randomBytes(8).toString("hex")}`;
  const records = [];
  let seq = 0;
  const renders = new Map();
  const logLines = [];
  const auditKey = randomBytes(32);
  const ctx = {
    pack: loadPack(FIXTURE_PACK),
    slots: new RenderSlots(4),
    run: fakeRenderer(renders),
    cli: { file: process.execPath, prefixArgs: ["remotion-cli.js"] },
    browserExecutable: "/nonexistent/chrome-headless-shell",
    tempRoot,
    // The verifier's refusals and the tools' outcomes, attached to the request they belong to.
    audit: {
      record: (event) => current.getStore()?.audit.push(event),
      hash: (data) => createHmac("sha256", auditKey).update(data).digest("hex"),
    },
    stillDeadlineMs: HANG_CAP_MS,
    cliTimeoutMs: HANG_CAP_MS + 1,
    graceMs: C.RENDER_KILL_GRACE_MS,
    verifyDeadlineMs: C.RENDER_VERIFY_DEADLINE_MS,
    pngCapBytes: C.SERVICE_PNG_CAP_BYTES,
    shutdown: shutdown.signal,
    onUnverifiedCleanup: () => {},
    log: (line) => logLines.push(line),
  };
  const startedAtS = Math.floor(Date.now() / 1000);
  const cfg = { host, port, audience, identityKey: key, auditKey, auditLogPath: path.join(tempRoot, "audit.jsonl"),
    packDir: FIXTURE_PACK, browserExecutable: ctx.browserExecutable, slots: 4, skewS: C.IDENTITY_SKEW_S,
    bodyCapBytes: C.SERVICE_BODY_CAP_BYTES, stillDeadlineMs: ctx.stillDeadlineMs, pngCapBytes: ctx.pngCapBytes,
    tempRoot };
  const handler = createServiceHandler(ctx, cfg, {
    clock: { nowS: () => Math.floor(Date.now() / 1000), startedAtS },
  });

  const server = http.createServer((req, res) => {
    seq += 1;
    // receivedAtMs is the wall clock the verifier reads; receivedAt the monotonic one the checker's timings use.
    const record = { seq, receivedAt: now(), receivedAtMs: Date.now(), method: req.method, url: req.url,
      rawHeaders: [...req.rawHeaders], chunks: [], bytes: 0, audit: [], status: undefined, done: false };
    if (keepRecords) records.push(record);
    // A second reader of the body: the handler attaches its own in this same turn, so both see every chunk.
    req.on("data", (chunk) => {
      record.bytes += chunk.length;
      if (record.bytes <= 2 * C.SERVICE_BODY_CAP_BYTES) record.chunks.push(chunk);
    });
    let probe;
    const writeHead = res.writeHead;
    res.writeHead = function writeHeadAndMark(...args) {
      const result = writeHead.apply(this, args);
      // Only the slow render's stream: the disconnect probe's stays as quiet as a real deployment's.
      const slow = Buffer.concat(record.chunks).includes(`${PROBE_PREFIX}slow:`);
      if (slow && JSON.stringify(args).includes("text/event-stream")) {
        probe = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(`: ${marker}\n\n`);
        }, markerMs);
      }
      return result;
    };
    res.once("close", () => {
      clearInterval(probe);
      // Whether the handler answered at all, and whether the body arrived in full: a body cut off is never answered.
      record.answered = res.headersSent;
      record.complete = req.complete;
      record.status = res.headersSent ? res.statusCode : undefined;
      record.closedAt = now();
      record.rawBody = Buffer.concat(record.chunks);
      delete record.chunks;
      try {
        record.message = JSON.parse(record.rawBody.toString("utf8"));
      } catch {
        record.message = undefined;
      }
      const refused = record.audit.find((event) => event.outcome === "refused");
      record.refusal = refused?.category;
      record.toolOutcome = record.audit.find((event) => event.tool !== undefined && event.outcome !== "refused");
      record.done = true;
      onRecord?.(record);
    });
    current.run(record, () => handler(req, res));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (err) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw ["EADDRINUSE", "EADDRNOTAVAIL", "EACCES"].includes(err?.code)
      ? new UsageError(`the stand-in cannot listen on ${host}:${port} (${err.code}). Pick another --listen.`) : err;
  }
  const address = server.address();
  const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${shownHost}:${address.port}/mcp`,
    audience, key, startedAtS, records, renders, logLines, marker, markerMs,
    /**
     * Every record from index `from` on, once each is done, but those in `except`. Waits up to SETTLE_MS for those
     * still open, and up to EMPTY_MS for a first one, in case the gateway answers its caller before it forwards.
     */
    settle: async (from, except = new Set()) => {
      const start = now();
      await pollFor(() => {
        const recent = records.slice(from);
        if (recent.length === 0) return now() - start >= EMPTY_MS ? true : undefined;
        return recent.every((r) => r.done || except.has(r)) ? true : undefined;
      }, SETTLE_MS);
      return records.slice(from);
    },
    /**
     * Resolves once no new POST has arrived for `ms`, or after SETTLE_MS: late copies and retries land by then. Other
     * traffic, such as a health check every few seconds, never ends a quiet stretch.
     */
    quiet: async (ms) => {
      const posts = () => records.filter((r) => r.method === "POST").length;
      let count = posts();
      let since = now();
      await pollFor(() => {
        if (posts() !== count) {
          count = posts();
          since = now();
        }
        return now() - since >= ms ? true : undefined;
      }, SETTLE_MS);
    },
    close: async () => {
      shutdown.abort();
      await new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Every value a request carried for header `name`, joined with ", " as the SDK's transport sees them: it builds its
 * Headers from the raw header lines, while node:http keeps only the first of a duplicated content-type or authorization.
 */
function sdkHeader(record, name) {
  const values = [];
  for (let i = 0; i < record.rawHeaders.length; i += 2) {
    if (record.rawHeaders[i].toLowerCase() === name) values.push(record.rawHeaders[i + 1]);
  }
  return values.length === 0 ? undefined : values.join(", ");
}

/**
 * One line on a record's outcome, for --serve and for check details. `sent` describes what the checker sent the gateway
 * for this message, if anything: `body`, and the caller's own `identity` header and `_meta` request id.
 */
export function describeRecord(record, standIn, sent = {}) {
  const what = record.message?.method === "tools/call" ? `tools/call ${toolOf(record.message)}`
    : record.message?.method ?? `${record.method} ${record.url}`;
  if (record.method === "GET" && record.status === 405) {
    return { ok: true, text: `${what}: 405, as the contract answers the SDK client's own GET stream, which the client `
      + "tolerates" };
  }
  if (!record.done) {
    return { ok: false, text: `${what}: the deployment was still handling it when the checker stopped waiting: the `
      + "gateway answered its caller without waiting for the deployment's answer, and without closing its request." };
  }
  // The verifier judged the request by the clock when it arrived, and so does the diagnosis.
  const arrivedS = Math.floor(record.receivedAtMs / 1000);
  if (record.refusal !== undefined && record.refusal !== "body_too_large") {
    const why = diagnoseIdentity({ refusal: record.refusal, header: sdkHeader(record, IDENTITY_HEADER),
      rawBody: record.rawBody, sentBody: sent.body, callerIdentity: sent.identity, callerMetaId: sent.metaId,
      key: standIn.key, audience: standIn.audience, nowS: arrivedS, startedAtS: standIn.startedAtS });
    return { ok: false, text: `${what}: refused ${record.status} ${record.refusal}: ${why}` };
  }
  if (!record.answered) {
    return { ok: false, text: `${what}: the deployment never answered: ${record.complete
      ? "the gateway closed the connection before it could."
      : "the body never ended. The gateway closed the connection mid-body, or sent a Content-Length longer than the "
        + "body."}` };
  }
  if (record.status >= 400) return { ok: false, text: `${what}: ${diagnoseTransport(record)}` };
  const claims = decodeClaims(sdkHeader(record, IDENTITY_HEADER)).claims ?? {};
  const offset = claims.iat - arrivedS;
  const outcome = record.toolOutcome?.outcome === "error" ? `, tool error ${record.toolOutcome.category}` : "";
  return { ok: true, claims, text: `${what}: verified, ${record.status}${outcome}; principal "${claims.principal}", `
    + `tenant "${claims.tenant}", ttl ${claims.exp - claims.iat} s, iat ${offset >= 0 ? "+" : ""}${offset} s from this `
    + "machine's clock" };
}

// ---------------------------------------------------------------------------------------------------------------
// The caller: sends MCP requests to the gateway as a backend would
// ---------------------------------------------------------------------------------------------------------------

/**
 * An incremental SSE reader: each event's JSON-RPC message goes to `onMessage`, and each comment line's text to
 * `onComment`, with the time the chunk that completed it arrived. Lines may end in CRLF, LF or a lone CR, as the SSE
 * grammar allows; a CR at the end of a chunk waits for the next one, which may start with its LF, or for `end`.
 */
function makeSseParser(onMessage, onComment) {
  let buffer = "";
  let carry = "";
  return (text, at, end = false) => {
    const joined = carry + text;
    carry = !end && joined.endsWith("\r") ? "\r" : "";
    buffer += (carry ? joined.slice(0, -1) : joined).replace(/\r\n?/g, "\n");
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) return;
      const lines = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      for (const line of lines) if (line.startsWith(":")) onComment(line.slice(1).trim(), at);
      const data = lines.filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data === "") continue;
      try {
        onMessage(JSON.parse(data), at);
      } catch {
        // Not JSON: not a JSON-RPC message.
      }
    }
  };
}

/**
 * POSTs one JSON-RPC message to the gateway and reads the answer as it arrives. Returns the status, the session id the
 * gateway gave, when the headers, the first body bytes, each SSE comment and the matching reply arrived, every message,
 * and any error. `unreachable` is set when no connection could be made at all. The whole answer must arrive within
 * `deadlineMs`. Never throws, and never puts a header value in an error: only a network error's code.
 */
async function post(url, message, { callerHeaders, protocolVersion, sessionId, extraHeaders = {}, signal,
  deadlineMs = ANSWER_DEADLINE_MS } = {}) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const headers = { ...callerHeaders, "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }), ...extraHeaders };
  const out = { body, sentAt: now(), messages: [], comments: [] };
  const deadline = AbortSignal.timeout(deadlineMs);
  const both = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  const late = `the gateway sent no complete answer within ${seconds(deadlineMs)}`;
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal: both });
  } catch (err) {
    const cause = err?.cause;
    if (deadline.aborted) {
      out.error = late;
    } else if (err?.name === "AbortError") {
      out.error = "aborted";
    } else {
      const code = cause?.code ?? cause?.errors?.[0]?.code;
      const why = code ?? (typeof cause?.message === "string" ? cause.message : "no cause given");
      // Only a connection that could not be set up means the gateway was never reached: a reset after the request
      // went out is the gateway's answer, of a kind.
      out.unreachable = SETUP_FAILURES.includes(code) || /^ERR_TLS_|^CERT_|SSL/.test(String(code))
        || why === "bad port";
      out.error = out.unreachable ? `the checker could not reach the gateway: ${why}`
        : `the gateway closed the connection without an answer: ${why}`;
    }
    out.endAt = now();
    return out;
  }
  out.headersAt = now();
  out.status = response.status;
  out.contentType = response.headers.get("content-type") ?? "";
  out.sessionId = response.headers.get("mcp-session-id") ?? undefined;
  const decoder = new TextDecoder();
  const isSse = out.contentType.includes("text/event-stream");
  const parse = makeSseParser((msg, at) => {
    out.messages.push(msg);
    if (isRecord(msg) && msg.id === message.id && out.reply === undefined) {
      out.reply = msg;
      out.replyAt = at;
    }
  }, (text, at) => out.comments.push({ text, at }));
  // A non-SSE body is read for its JSON too, and for SSE comments in it: a gateway that streams the deployment's
  // bytes but drops their content-type still carries the stand-in's marker.
  let text = "";
  const comments = isSse ? undefined : makeSseParser(() => {}, (comment, at) => out.comments.push({ text: comment, at }));
  try {
    if (response.body !== null) {
      for await (const chunk of response.body) {
        const at = now();
        out.firstByteAt ??= at;
        const piece = decoder.decode(chunk, { stream: true });
        if (isSse) parse(piece, at);
        else {
          text += piece;
          comments(piece, at);
        }
      }
    }
  } catch (err) {
    out.error = deadline.aborted ? late : err?.name === "AbortError" ? "aborted" : "the answer's stream was cut off";
  }
  out.endAt = now();
  const rest = decoder.decode();
  if (isSse) {
    parse(rest, out.endAt, true);
  } else {
    text += rest;
    comments(rest, out.endAt, true);
  }
  if (!isSse && text !== "") {
    try {
      const msg = JSON.parse(text);
      out.messages.push(msg);
      if (isRecord(msg) && msg.id === message.id) {
        out.reply = msg;
        out.replyAt = out.endAt;
      }
    } catch {
      // Not JSON: no reply.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------------------

const pass = (id, title, details = []) => ({ id, status: "pass", title, details });
const fail = (id, title, details = []) => ({ id, status: "fail", title, details });
const inconclusive = (id, title, details = []) => ({ id, status: "inconclusive", title, details });
const skip = (id, title, details = []) => ({ id, status: "skip", title, details });

/** The JSON-RPC reply the caller got, or a JSON-RPC error the gateway sent with no id. */
const replyOf = (res) => res.reply ?? res.messages.find((m) => isRecord(m) && isRecord(m.error));

/** What the caller got back, in one phrase. */
function describeAnswer(res) {
  if (res.error !== undefined && res.status === undefined) return res.error;
  const reply = replyOf(res);
  const what = reply === undefined ? "no JSON-RPC reply"
    : reply.error !== undefined ? `JSON-RPC error ${reply.error.code} ${JSON.stringify(reply.error.message)}`
      : "a result";
  return `HTTP ${res.status} with ${what}${res.error ? `, then ${res.error}` : ""}`;
}

/** The claims a record's identity header carries, unverified, or undefined. */
const claimsOf = (record) => decodeClaims(sdkHeader(record, IDENTITY_HEADER)).claims;

/**
 * Judges one call: did its message reach the deployment, did it verify, did the deployment answer it, and did the
 * caller get the answer? Only a POST carrying this very message counts, matched by its JSON-RPC id, or by its method
 * when a gateway rewrites ids, or else a POST in this call's window whose body does not parse (cut short, compressed
 * or otherwise mangled on the way); other traffic, such as a health check, is left for the stray check.
 * Every record it counts is marked `judged`. A second request for the same call that the deployment refused, a retry
 * or a hedge with the same header, fails the call. `accept(res, record, claims)` returns an error string when the
 * caller's answer is wrong. `notForwarded(res)` may judge a call the gateway answered itself. `sent` is passed to
 * describeRecord, and `onPrimary(record)` sees the record judged.
 */
function judge(id, title, res, recs, standIn, { accept = () => undefined, notForwarded, sent = {}, onPrimary } = {}) {
  const sentMessage = JSON.parse(res.body.toString("utf8"));
  const posts = recs.filter((r) => r.method === "POST");
  const byId = posts.filter((r) => sentMessage.id !== undefined && r.message?.id === sentMessage.id);
  const byMethod = posts.filter((r) => r.message?.method === sentMessage.method);
  const mangled = posts.filter((r) => !r.done || !isRecord(r.message));
  const matching = byId.length > 0 ? byId : byMethod.length > 0 ? byMethod : mangled;
  if (matching.length === 0) {
    if (res.status === undefined) return fail(id, title, [`${res.error}.`]);
    const own = notForwarded?.(res);
    if (own !== undefined) return own;
    if (posts.length > 0 || standIn.records.some((r) => r.judged)) {
      return fail(id, title, [`the gateway answered this message itself, ${describeAnswer(res)}, and no request `
        + `carrying it reached the deployment within ${seconds(EMPTY_MS)}.`]);
    }
    return fail(id, title, [`nothing reached the deployment; the gateway itself answered ${describeAnswer(res)}. Is `
      + `its route for audience "${standIn.audience}" pointed at ${standIn.url}?`]);
  }
  for (const r of matching) r.judged = true;
  const [primary, ...extras] = matching;
  onPrimary?.(primary);
  const outcome = describeRecord(primary, standIn, { body: res.body, ...sent });
  const details = [outcome.text];
  const refusedExtras = extras.map((r) => describeRecord(r, standIn, { body: res.body, ...sent })).filter((d) => !d.ok);
  if (extras.length > 0) details.push(`the gateway sent the deployment ${matching.length} requests for this one call.`);
  if (refusedExtras.length > 0) {
    return fail(id, title, [...details, ...refusedExtras.map((d) => `another of them: ${d.text}`), "A retry or a "
      + "copy of a request needs a new request_id and a new signature."]);
  }
  if (!outcome.ok) return fail(id, title, details);
  const wrong = accept(res, primary, outcome.claims);
  if (wrong !== undefined) return fail(id, title, [...details, `the caller got ${describeAnswer(res)}: ${wrong}`]);
  return pass(id, title, details);
}

/** The header checks, over every POST that reached the deployment, on the values as the SDK's transport sees them. */
function judgeHeaders(records) {
  const problems = [];
  for (const record of records) {
    const where = `request ${record.seq} (${record.message?.method ?? record.method})`;
    const accept = sdkHeader(record, "accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      problems.push(`${where}: accept is ${describeValue(sdkHeader(record, "accept"))}; forward both `
        + "application/json and text/event-stream.");
    }
    const type = sdkHeader(record, "content-type");
    if ((type ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
      problems.push(`${where}: content-type is ${describeValue(type)}; forward one content-type, application/json.`);
    }
    const version = sdkHeader(record, "mcp-protocol-version");
    if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      problems.push(`${where}: mcp-protocol-version "${version}" is not one the service's SDK supports `
        + `(${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}); send none or one of those.`);
    }
  }
  const title = "every forwarded request has the accept, content-type and mcp-protocol-version the service needs";
  if (records.length === 0) return inconclusive("headers", title, ["no request reached the deployment."]);
  return problems.length === 0 ? pass("headers", title, [`${records.length} requests checked.`])
    : fail("headers", title, problems);
}

/**
 * What the checker searches for, for each caller credential: the whole value and the token after its scheme, each in
 * every spelling it can take on the way: as is, JSON-escaped (with and without an escaped slash), and percent-encoded
 * as a path or as a query value.
 */
function credentialNeedles(callerHeaders) {
  return Object.entries(callerHeaders).map(([name, value]) => {
    const token = value.includes(" ") ? value.slice(value.lastIndexOf(" ") + 1) : "";
    const forms = (n) => {
      const json = JSON.stringify(n).slice(1, -1);
      return [n, json, json.replace(/\//g, "\\/"), encodeURIComponent(n), new URLSearchParams({ n }).toString().slice(2)];
    };
    const needles = [value, ...(token.length >= MIN_CREDENTIAL_CHARS ? [token] : [])].flatMap(forms);
    return { name, needles: [...new Set(needles)] };
  });
}

/** Replaces every caller credential in `text`, in every spelling, so no output can print one, whatever a gateway echoes. */
export function makeRedactor(callerHeaders) {
  const needles = credentialNeedles(callerHeaders).flatMap((c) => c.needles).sort((a, b) => b.length - a.length);
  return (text) => needles.reduce((out, needle) => out.split(needle).join("<credential>"), String(text));
}

/** Every string inside a parsed JSON value, so a credential is found whatever escapes the body used. */
function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsIn(v, out);
    }
  }
  return out;
}

/** A URL in every decoded spelling: as received, percent-decoded, and with its query decoded the form way. */
function urlForms(url) {
  const forms = [url];
  try {
    forms.push(decodeURIComponent(url));
  } catch {
    // Not percent-decodable as a whole: the query below may still be.
  }
  const query = url.indexOf("?");
  if (query >= 0) for (const [k, v] of new URLSearchParams(url.slice(query + 1))) forms.push(k, v);
  return forms;
}

/**
 * Whether a caller credential reached the deployment: in any header, in the request URL, in the body, or signed into
 * the identity claims, whole or as the token after its scheme. Places only: values are never printed.
 */
function judgeCredentials(records, callerHeaders) {
  const title = "the caller's credentials do not reach the deployment, anywhere in the request";
  const credentials = credentialNeedles(callerHeaders);
  if (credentials.length === 0) return skip("caller-credentials", title, ["GATEWAY_CHECK_HEADERS is not set."]);
  if (records.length === 0) return inconclusive("caller-credentials", title, ["no request reached the deployment."]);
  const leaks = [];
  for (const { name, needles } of credentials) {
    const hit = (text) => typeof text === "string" && needles.some((n) => text.includes(n));
    const places = new Set();
    for (const record of records) {
      for (let i = 0; i < record.rawHeaders.length; i += 2) {
        if (hit(record.rawHeaders[i + 1])) places.add(`header ${record.rawHeaders[i].toLowerCase()}`);
      }
      if (urlForms(record.url).some(hit)) places.add("the request URL");
      if (record.rawBody !== undefined && (hit(record.rawBody.toString("utf8")) || stringsIn(record.message).some(hit))) {
        places.add("the forwarded body");
      }
      for (const [field, value] of Object.entries(claimsOf(record) ?? {})) {
        if (hit(value)) places.add(`the identity claims' ${field}`);
      }
    }
    if (places.size > 0) leaks.push(`the caller's ${name} reached the deployment in ${[...places].join(", ")}`);
  }
  if (leaks.length === 0) return pass("caller-credentials", title, [`checked ${credentials.map((c) => c.name).join(", ")}.`]);
  return fail("caller-credentials", title, [...leaks.map((leak) => `${leak}.`), "A deployment's operator holding it "
    + "could call the gateway as that caller, which one key per deployment exists to prevent. Keep the caller's "
    + "credentials at the gateway; a claim such as principal is the gateway's id for the caller, never the key."]);
}

/**
 * Whether the slow render's stream reached the caller as it ran. Only the stand-in's marker counts, an SSE comment
 * with a nonce no gateway can know, so a gateway that writes bytes of its own while it holds the deployment's back,
 * its own `: keepalive` included, still fails.
 */
function judgeStreaming(res, render, standIn) {
  const title = "SSE is streamed, not buffered";
  const endedAt = render?.finishedAt ?? render?.abortedAt;
  if (endedAt === undefined || res.headersAt === undefined) {
    return inconclusive("sse-streaming", title, ["the slow render did not run to an end the caller saw, so streaming "
      + "could not be judged."]);
  }
  const marks = res.comments.filter((c) => c.text === standIn.marker);
  const early = marks.find((c) => c.at < endedAt);
  if (early !== undefined) {
    const typed = res.contentType.includes("text/event-stream") ? "" : ` The answer lost its content-type on the way `
      + `(${describeValue(res.contentType)}); forward text/event-stream.`;
    return pass("sse-streaming", title, [`the stand-in's marker reached the caller ${seconds(endedAt - early.at)} `
      + `before the render ended.${typed}`]);
  }
  if (marks.length > 0) {
    return fail("sse-streaming", title, ["the stand-in's marker reached the caller only after the render had ended: "
      + "the gateway buffers the answer. Stream it as it arrives."]);
  }
  if (res.status < 200 || res.status >= 300) {
    return inconclusive("sse-streaming", title, [`the caller got HTTP ${res.status} instead of the stream, so `
      + "streaming could not be judged."]);
  }
  // One JSON answer, all of it after the render ended: the gateway collected the event stream into it.
  if (!res.contentType.includes("text/event-stream") && (res.firstByteAt === undefined || res.firstByteAt >= endedAt)) {
    return fail("sse-streaming", title, [`the caller got one ${res.contentType || "untyped"} answer, after the render `
      + "had ended, instead of the event stream: the gateway buffers the SSE answer into one. Stream it as it arrives."]);
  }
  if (endedAt - render.startedAt < standIn.markerMs) {
    return inconclusive("sse-streaming", title, [`the render ended ${seconds(endedAt - render.startedAt)} after it `
      + `started, before the stand-in's first marker (every ${seconds(standIn.markerMs)}), so streaming could not be `
      + "judged."]);
  }
  return inconclusive("sse-streaming", title, [`none of the stand-in's markers, SSE comments it writes every `
    + `${seconds(standIn.markerMs)}, reached the caller: the gateway buffers the answer, or drops SSE comments. Forward `
    + "the stream unbuffered and unchanged."]);
}

/**
 * The records no check accounted for. A POST the deployment refused, or never answered, fails: a retry or a copy the
 * gateway sent with the same header, for example. Anything else, such as a health check by any method or path that the
 * router answered 404 or 405, is listed, never failed.
 */
function judgeStrays(records, standIn) {
  const title = "nothing reached the deployment that no call accounts for and the deployment refused";
  const strays = records.filter((r) => !r.judged && !(r.method === "GET" && r.status === 405));
  const described = strays.map((r) => ({ record: r, line: describeRecord(r, standIn) }));
  const bad = described.filter(({ record, line }) => record.method === "POST" && !line.ok);
  if (bad.length > 0) {
    return fail("stray-requests", title, [...bad.map(({ line }) => line.text), "The gateway sent these on its own, "
      + "such as a retry or a copy of a request. Each needs a new request_id and a new signature."]);
  }
  return pass("stray-requests", title, strays.length === 0 ? ["every request belongs to a call."]
    : described.map(({ line }) => `no call accounts for this one, and it is not a refused POST: ${line.text}`));
}

const renderStill = (id, props) => ({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "render_still", arguments: { template_id: "scoreboard", props } } });
const probeProps = (label) => ({ label, color: "#1A2B3C", players: [], theme: "dark", opacity: 0.5 });
/** Text a gateway must pass through untouched: Turkish, an emoji, quotes, a backslash and markup. */
const ECHO_PROPS = Object.freeze({ label: "Şampiyon ığüşöç İ \"–\" \\ 🏆 <&>", color: "#1A2B3C",
  players: [{ name: "Çağla Öztürk", number: 10 }, { name: "José 日本", number: 7 }], theme: "dark", opacity: 0.5,
  short: "ÇĞİ" });
/** initialize as an SDK client sends it: id 0, the client's latest protocol version. */
const INITIALIZE = Object.freeze({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
  protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "gateway-check", version: "1" } } });
const INITIALIZED = Object.freeze({ jsonrpc: "2.0", method: "notifications/initialized" });

/**
 * Runs every check against the gateway at `gatewayUrl`, with the stand-in on `host:port`. `onListening(url)` runs
 * once the stand-in listens, before the first request, and `onStandIn(standIn)` gets the stand-in, so an interrupted
 * run can close it. Returns the results, in order, with every caller credential replaced in their text. The stand-in
 * is closed at the end. `markerMs`, `quietMs`, `skipDisconnect` and a short `slowMs` are for the checker's own tests.
 */
export async function runCheck({ gatewayUrl, key, audience = DEFAULT_AUDIENCE, host = "127.0.0.1", port = 0,
  callerHeaders = {}, skipSlow = false, slowMs = DEFAULT_SLOW_MS, skipDisconnect = false,
  disconnectDeadlineMs = DISCONNECT_DEADLINE_MS, markerMs, quietMs = EMPTY_MS, onListening, onStandIn,
  log = () => {} }) {
  const standIn = await startStandIn({ key, audience, host, port, markerMs });
  onStandIn?.(standIn);
  const redact = makeRedactor(callerHeaders);
  const results = [];
  try {
    await onListening?.(standIn.url);
    // Numbered as an SDK client numbers them: initialize is 0.
    let counter = 0;
    const nextId = () => (counter += 1);
    const nonce = () => randomBytes(4).toString("hex");
    let protocolVersion;
    let sessionId;
    let hangRequestId;
    // The disconnect probe's request, when the gateway never closed it: the final wait does not wait for it.
    const leftOpen = new Set();
    const send = async (message, options = {}) => {
      const from = standIn.records.length;
      const res = await post(gatewayUrl, message, { callerHeaders, protocolVersion, sessionId, ...options });
      return { res, recs: await standIn.settle(from) };
    };
    const record = (result) => {
      const clean = { ...result, title: redact(result.title), details: result.details.map(redact) };
      results.push(clean);
      log(clean);
    };
    const info = (title) => log({ status: "info", title: redact(title), details: [] });
    const initializeResult = (res) => {
      const result = res.reply?.result;
      return isRecord(result) && typeof result.protocolVersion === "string" ? result : undefined;
    };
    const notificationAnswered = (res, rec) => (rec.status === 202 && res.status >= 200 && res.status < 300 ? undefined
      : `the deployment answered ${rec.status} and the caller got ${res.status}; a notification gets 202, and the `
        + "caller a 2xx.");

    // 1. initialize, with no protocol version header yet, as an SDK client sends it.
    const first = {};
    let step = await send(INITIALIZE, { protocolVersion: undefined, sessionId: undefined });
    record(judge("initialize", "initialize reaches the deployment, signed, and its result reaches the caller",
      step.res, step.recs, standIn, { accept: (res) => (initializeResult(res) ? undefined : "no initialize result."),
        onPrimary: (rec) => { first.initialize = rec; } }));
    if (step.res.unreachable && step.recs.length === 0) {
      record(skip("rest", "every other check", ["the gateway could not be reached at all."]));
      return results;
    }
    // An SDK client sends the version it negotiated, and any session id it was given, on every later request.
    protocolVersion = initializeResult(step.res)?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
    sessionId = step.res.sessionId;

    // 2. The initialized notification: no id, so the gateway must inject _meta into a notification too.
    const notificationTitle = "notifications/initialized reaches the deployment, signed";
    const notificationFrom = standIn.records.length;
    step = await send(INITIALIZED);
    const notificationOptions = { accept: notificationAnswered, onPrimary: (rec) => { first.notification = rec; } };
    let notification = judge("initialized-notification", notificationTitle, step.res, step.recs, standIn, {
      ...notificationOptions,
      notForwarded: (res) => (res.status >= 200 && res.status < 300 ? inconclusive("initialized-notification",
        notificationTitle, [`the gateway answered the notification itself, HTTP ${res.status}, and nothing reached the `
          + `deployment within ${seconds(EMPTY_MS)}, so _meta in notifications could not be checked.`]) : undefined),
    });
    if (notification.status === "inconclusive") {
      // A gateway may answer a notification at once and forward it later. Wait for quiet before the second session
      // sends the same bytes, so a late arrival is judged as this session's, not as the next one's.
      await standIn.quiet(quietMs);
      const late = standIn.records.slice(notificationFrom);
      if (late.some((r) => r.method === "POST")) {
        notification = judge("initialized-notification", notificationTitle, step.res, late, standIn, notificationOptions);
        notification.details.push("the gateway answered its caller first, and forwarded the notification afterwards.");
      }
    }
    record(notification);

    // 3. A second session opens with the same bytes, as every SDK client does: initialize with id 0, then the same
    // notification. A request_id derived from the caller's id or body would repeat, and be refused as a replay.
    const secondTitle = "a second session's identical handshake verifies too: request_id is minted per request";
    const second = [];
    const derived = [];
    const sameAsFirst = (kind) => (rec) => {
      // Accepted the first time, and refused now as a replay of that very request_id: the id came from the bytes.
      const before = first[kind];
      if (before?.done && before.refusal === undefined && before.status < 400 && rec.refusal === "replayed"
        && claimsOf(rec)?.request_id === claimsOf(before)?.request_id) derived.push(kind);
    };
    let res2 = await send(INITIALIZE, { protocolVersion: undefined, sessionId: undefined });
    second.push(judge("second-session", secondTitle, res2.res, res2.recs, standIn, {
      accept: (res) => (initializeResult(res) ? undefined : "no initialize result."), onPrimary: sameAsFirst("initialize") }));
    const secondSession = res2.res.sessionId;
    res2 = await send(INITIALIZED, { sessionId: secondSession });
    second.push(judge("second-session", secondTitle, res2.res, res2.recs, standIn, {
      accept: notificationAnswered, onPrimary: sameAsFirst("notification"),
      notForwarded: (res) => (res.status >= 200 && res.status < 300
        ? pass("second-session", secondTitle, ["the gateway answered the notification itself."]) : undefined) }));
    const secondDetails = second.flatMap((r) => r.details);
    if (second.every((r) => r.status === "pass")) {
      record(pass("second-session", secondTitle, secondDetails));
    } else {
      // Only when the first session's two different messages verified, with different ids: a gateway that reuses one
      // constant id for everything was already told so, and derives nothing from the bytes.
      const distinct = results.find((r) => r.id === "initialized-notification")?.status === "pass";
      record(fail("second-session", secondTitle, [...secondDetails, ...(derived.length > 0 && distinct ? ["the same bytes from a "
        + "new session got the request_id the first session's were accepted with: the gateway derives request_id from "
        + "the caller's JSON-RPC id or body. Mint a fresh request_id for every request."] : [])]));
    }

    // 4. tools/list.
    step = await send({ jsonrpc: "2.0", id: nextId(), method: "tools/list", params: {} });
    let missingTools = [];
    const toolsList = judge("tools-list", "tools/list reaches the deployment, signed, and its tools reach the caller",
      step.res, step.recs, standIn, { accept: (res) => {
        const tools = res.reply?.result?.tools;
        if (!Array.isArray(tools)) return "no tools in the result.";
        missingTools = SERVICE_TOOLS.filter((name) => !tools.some((tool) => tool?.name === name));
        return undefined;
      } });
    if (missingTools.length > 0 && toolsList.status === "pass") {
      toolsList.details.push(`the caller did not get ${missingTools.join(", ")}: the gateway filters tools/list.`);
    }
    record(toolsList);

    // 5. tools/call list_templates: the claims' tool is params.name, not the method.
    step = await send({ jsonrpc: "2.0", id: nextId(), method: "tools/call",
      params: { name: "list_templates", arguments: {} } });
    record(judge("tools-call", "tools/call list_templates reaches the deployment, signed with tool = params.name",
      step.res, step.recs, standIn, { accept: (res) => (Array.isArray(res.reply?.result?.structuredContent?.templates)
        ? undefined : "no templates in the result.") }));

    // 6. render_still with text that must survive the gateway's rewrite byte for byte.
    step = await send(renderStill(nextId(), ECHO_PROPS));
    record(judge("arguments", "render_still's arguments reach the deployment unchanged, and its image reaches the caller",
      step.res, step.recs, standIn, { accept: (res, rec) => {
        const received = rec.message?.params?.arguments;
        if (!isDeepStrictEqual(received, { template_id: "scoreboard", props: ECHO_PROPS })) {
          return `the deployment received different arguments: ${JSON.stringify(received)}.`;
        }
        return res.reply?.result?.content?.[0]?.type === "image" ? undefined : "no image in the result.";
      } }));

    // 7. A caller that sends its own X-Render-Identity and its own _meta request_id: the gateway must sign afresh,
    // with a request_id it minted, and never forward the caller's header.
    const identityTitle = "a caller's own X-Render-Identity and _meta request_id never reach the deployment as such";
    const forged = `${Buffer.from("{}").toString("base64url")}.${hmac(randomBytes(32), "forged").toString("base64url")}`;
    const callerMetaId = `caller-${nonce()}`;
    step = await send({ jsonrpc: "2.0", id: nextId(), method: "tools/list",
      params: { _meta: { [REQUEST_ID_META_KEY]: callerMetaId } } }, { extraHeaders: { [IDENTITY_HEADER]: forged } });
    record(judge("caller-identity", identityTitle, step.res, step.recs, standIn, {
      sent: { identity: forged, metaId: callerMetaId },
      accept: (_res, _rec, claims) => (claims?.request_id === callerMetaId ? "the gateway adopted the caller's own "
        + "_meta request_id. Mint a request_id of its own for every request." : undefined),
      // Refusing the call outright also keeps the caller's header away from the deployment.
      notForwarded: (res) => ((res.status >= 400 && res.status < 500) || isRecord(replyOf(res)?.error)
        ? pass("caller-identity", identityTitle, [`the gateway refused the call itself, ${describeAnswer(res)}, so the `
          + "caller's header never reached the deployment."]) : undefined),
    }));

    // 8 and 9. A slow render: does its answer arrive at all, and did the stand-in's marker arrive while it ran?
    if (skipSlow) {
      record(skip("slow-answer", `an answer that takes ${seconds(DEFAULT_SLOW_MS)} reaches the caller`, ["--skip-slow."]));
      record(skip("sse-streaming", "SSE is streamed, not buffered", ["--skip-slow."]));
    } else {
      const id = nonce();
      info(`waiting ${seconds(slowMs)} for the slow render`);
      step = await send(renderStill(nextId(), probeProps(`${PROBE_PREFIX}slow:${id}:${slowMs}`)),
        { deadlineMs: slowMs + ANSWER_DEADLINE_MS });
      const render = standIn.renders.get(id);
      const { res } = step;
      const delivered = judge("slow-answer", "", res, step.recs, standIn, {
        accept: (r) => (r.reply?.result?.content?.[0]?.type === "image" ? undefined : "no image in the result.") });
      const slowTitle = `an answer that takes ${seconds(slowMs)} reaches the caller${slowMs < DEFAULT_SLOW_MS
        ? ` (shorter than the default ${seconds(DEFAULT_SLOW_MS)}: run with the default to check the obligation)` : ""}`;
      const raise = "Raise its upstream timeouts to at least 60 s.";
      if (delivered.status === "pass") {
        record(pass("slow-answer", slowTitle, [`the image arrived after ${seconds(res.replyAt - res.sentAt)}.`]));
      } else if (render === undefined) {
        record(fail("slow-answer", slowTitle, [...delivered.details, "the slow render never started."]));
      } else if (render.finishedAt === undefined && render.abortedAt === undefined) {
        record(fail("slow-answer", slowTitle, [...delivered.details, "the render was still running when the gateway "
          + "answered its caller: it gave up on the deployment without closing its request. " + raise]));
      } else if (render.finishedAt === undefined) {
        record(fail("slow-answer", slowTitle, [...delivered.details, `the gateway closed the deployment's request after `
          + `${seconds(render.abortedAt - render.startedAt)}, before the render finished. ${raise}`]));
      } else if (replyOf(res) !== undefined) {
        record(fail("slow-answer", slowTitle, delivered.details));
      } else if (res.error === undefined && res.endAt >= render.finishedAt) {
        record(fail("slow-answer", slowTitle, [...delivered.details, "the answer arrived in full once the render had "
          + `finished, but held no reply the checker could read (content-type ${describeValue(res.contentType)}). `
          + "Forward the deployment's answer unchanged."]));
      } else {
        const cut = res.endAt === undefined ? "" : ` The caller's answer ended after ${seconds(res.endAt - res.sentAt)}.`;
        record(fail("slow-answer", slowTitle, [...delivered.details, `the render finished, but its answer did not `
          + `reach the caller.${cut} ${raise}`]));
      }
      record(judgeStreaming(res, render, standIn));
    }

    // 10. A caller that disconnects mid-render: the gateway must close its upstream request, which stops the render.
    const disconnectTitle = "a caller's disconnect closes the deployment's request, stopping its render";
    if (skipDisconnect) {
      record(skip("disconnect", disconnectTitle));
    } else {
      const id = nonce();
      const controller = new AbortController();
      const from = standIn.records.length;
      let answered = false;
      const pending = post(gatewayUrl, renderStill(nextId(), probeProps(`${PROBE_PREFIX}hang:${id}`)),
        { callerHeaders, protocolVersion, sessionId, signal: controller.signal }).finally(() => {
        answered = true;
      });
      // The render; or null once the caller's own request has finished, or the deployment has answered the request
      // that carries this probe, without starting it. Any other traffic, such as a health check, does not count.
      const probeDone = () => standIn.records.slice(from).some((r) => r.done && r.rawBody?.includes(id));
      const started = await pollFor(() => standIn.renders.get(id) ?? (answered || probeDone() ? null : undefined),
        SETTLE_MS);
      if (!started) {
        controller.abort();
        const res = await pending;
        const recs = await standIn.settle(from);
        const why = started === undefined ? [`the render had not started ${seconds(SETTLE_MS)} after the call.`]
          : judge("disconnect", disconnectTitle, res, recs, standIn).details;
        record(inconclusive("disconnect", disconnectTitle, ["the render never started, so the disconnect could not be "
          + "tested.", ...why]));
      } else {
        // The header arrived with the request, long before the record closes.
        const hangRecord = standIn.records.slice(from).find((r) => claimsOf(r)?.tool === "render_still");
        if (hangRecord !== undefined) hangRecord.judged = true;
        hangRequestId = hangRecord === undefined ? undefined : claimsOf(hangRecord).request_id;
        const abortAt = now();
        controller.abort();
        await pending;
        const stopped = await pollFor(() => started.abortedAt, disconnectDeadlineMs);
        if (stopped === undefined && hangRecord !== undefined) leftOpen.add(hangRecord);
        record(stopped === undefined
          ? fail("disconnect", disconnectTitle, [`the caller disconnected, but the deployment's request was still open `
            + `${seconds(disconnectDeadlineMs)} later. Close the upstream connection as soon as the caller's closes: `
            + "the deployment may write nothing for 15 s."])
          : pass("disconnect", disconnectTitle, [`the render stopped ${seconds(stopped - abortAt)} after the caller `
            + "disconnected."]));
      }
    }

    // 11 to 13. Over everything that reached the deployment, once it has gone quiet: a copy or a retry the gateway
    // sends a moment after a call has been answered still lands, and counts.
    await standIn.quiet(quietMs);
    const all = await standIn.settle(0, leftOpen);
    record(judgeStrays(all, standIn));
    record(judgeHeaders(all.filter((r) => r.method === "POST")));
    record(judgeCredentials(all, callerHeaders));
    // The disconnect probe's own render ends as render_failed (aborted), as it should: that line is not news.
    const expected = (line) => hangRequestId !== undefined && line.includes(hangRequestId) && line.includes("aborted");
    for (const line of standIn.logLines.filter((l) => !expected(l))) info(`deployment log: ${line}`);
    return results;
  } finally {
    await standIn.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------------------------

const USAGE = `Usage:
  IDENTITY_HMAC_KEY=<test key> node scripts/check-gateway.mjs --gateway <url> [options]
  IDENTITY_HMAC_KEY=<test key> node scripts/check-gateway.mjs --serve [options]

Stands in for a deployment on --listen, and checks the gateway against docs/CONTRACT-gateway.md.
Configure a test route in the gateway that signs for --audience with IDENTITY_HMAC_KEY and forwards
to http://<listen>/mcp, then run this with --gateway set to the URL a backend would call.

Options:
  --gateway <url>     the gateway URL a backend calls, routed to this checker
  --listen <h:p>      where the stand-in deployment listens (default ${DEFAULT_LISTEN})
  --audience <id>     the stand-in's audience, the aud the gateway signs (default ${DEFAULT_AUDIENCE})
  --serve             only listen, and print one line per request, until Ctrl-C
  --skip-slow         skip the ${DEFAULT_SLOW_MS / 1000} s render that checks streaming and upstream timeouts
  --json              print the results as JSON

Environment:
  IDENTITY_HMAC_KEY       the test key the gateway signs this audience with (unpadded base64url, >= 32 bytes)
  GATEWAY_CHECK_HEADERS   optional JSON object of the credential headers a backend sends the gateway,
                          such as {"authorization": "Bearer ..."}; never printed, and checked never
                          to reach the deployment

Exit status: 0 every check passed, 1 a check failed, 2 usage or setup error, 3 a check was inconclusive.`;

const MARK = { pass: "PASS", fail: "FAIL", inconclusive: "????", skip: "SKIP", info: "    " };

function printResult(result) {
  console.log(`${MARK[result.status]}  ${result.title}`);
  for (const line of result.details ?? []) console.log(`      ${line}`);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, strict: true, options: {
      gateway: { type: "string" }, listen: { type: "string" }, audience: { type: "string" },
      serve: { type: "boolean" }, "skip-slow": { type: "boolean" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    } }).values;
  } catch (err) {
    throw new UsageError(`${err.message}\n\n${USAGE}`);
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (!parsed.serve && parsed.gateway === undefined) throw new UsageError(`Give --gateway <url> or --serve.\n\n${USAGE}`);
  if (parsed.serve && parsed.gateway !== undefined) throw new UsageError("--serve and --gateway do not go together.");
  if (parsed.gateway !== undefined) {
    let url;
    try {
      url = new URL(parsed.gateway);
    } catch {
      throw new UsageError("--gateway is not a URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new UsageError("--gateway must be http or https.");
    // The URL is printed: a credential in it would be too. Put it in GATEWAY_CHECK_HEADERS instead.
    if (url.username !== "" || url.password !== "") {
      throw new UsageError("--gateway carries a user name or password. Send credentials in GATEWAY_CHECK_HEADERS.");
    }
  }
  const key = readKey(process.env);
  const callerHeaders = readCallerHeaders(process.env);
  const { host, port } = parseListen(parsed.listen ?? DEFAULT_LISTEN);
  const audience = parsed.audience ?? DEFAULT_AUDIENCE;

  const redact = makeRedactor(callerHeaders);
  const wildcard = ["0.0.0.0", "::"].includes(host) ? " (every interface: point the gateway at this machine's address)" : "";
  if (parsed.serve) {
    // Each record is printed and dropped, so a long run holds no request history.
    const standIn = await startStandIn({ key, audience, host, port, keepRecords: false, onRecord: (record) => {
      try {
        const line = describeRecord(record, standIn);
        console.log(redact(`#${record.seq} ${line.ok ? "ok  " : "FAIL"} ${line.text}`));
      } catch (err) {
        console.log(`#${record.seq} ???? the checker could not describe this request: ${redact(err?.message)}`);
      }
    } });
    console.log(`Stand-in deployment listening on ${standIn.url}${wildcard}, audience "${audience}". Ctrl-C stops it.`);
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await standIn.close();
    return 0;
  }

  // Ctrl-C mid-run, during the 58 s render say, still closes the stand-in and removes its temp dir.
  let running;
  const interrupt = () => {
    void Promise.resolve(running?.close()).finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const banner = (url) => {
    if (parsed.json) return;
    console.log(`Gateway check, contract v1\n  gateway:    ${parsed.gateway}\n  deployment: ${url}${wildcard}, `
      + `audience "${audience}"\n`);
  };
  const results = await runCheck({ gatewayUrl: parsed.gateway, key, audience, host, port, callerHeaders,
    skipSlow: parsed["skip-slow"] === true, onListening: banner, onStandIn: (standIn) => { running = standIn; },
    log: parsed.json ? () => {} : printResult });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  const count = (status) => results.filter((r) => r.status === status).length;
  if (parsed.json) {
    console.log(JSON.stringify({ contract: 1, results }, null, 2));
  } else {
    console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("inconclusive")} inconclusive, `
      + `${count("skip")} skipped.`);
  }
  return count("fail") > 0 ? 1 : count("inconclusive") > 0 ? 3 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.error(err instanceof UsageError ? `check-gateway: ${err.message}` : err);
    process.exitCode = 2;
  });
}

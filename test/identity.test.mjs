// The gateway identity header and the replay cache (design 5.2 steps 3-6, 5.3; docs/CONTRACT-gateway.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "identity.js"))) {
  throw new Error("dist-service/service/identity.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const { signIdentity, verifyIdentityHeader, checkClaimsAgainstMessage, toolOf, ReplayCache, verifyRequest } =
  await import(pathToFileURL(path.join(SERVICE, "identity.js")).href);
const CONSTANTS = await import(pathToFileURL(path.join(SERVICE, "constants.js")).href);
const { REQUEST_ID_META_KEY, IDENTITY_SKEW_S, IDENTITY_MAX_TTL_S } = CONSTANTS;

// The published throwaway vector key. Any other key a test needs is generated at runtime.
const KEY = Buffer.alloc(32, 7);
const AUD = "dep-a";
const NOW = 1_800_000_000;
// The shipped defaults, which "the service constants have the values the plan fixes" pins.
const SKEW = IDENTITY_SKEW_S;
const MAX_TTL = IDENTITY_MAX_TTL_S;
const VECTORS = path.join(REPO, "test", "vectors", "identity-v1.json");

const ALL_REFUSALS = ["missing", "malformed", "unsupported_version", "bad_signature", "wrong_audience",
  "not_yet_valid", "expired", "ttl_too_long", "signed_before_start", "body_mismatch",
  "tool_mismatch", "request_id_mismatch", "replayed"];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A tools/call message as the gateway forwards it, with its request id injected into `_meta`. */
function message({ name = "render_still", requestId = "r-1" } = {}) {
  return {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: {
      name,
      arguments: { template_id: "scoreboard", props: { title: "Beşiktaş" } },
      _meta: { [REQUEST_ID_META_KEY]: requestId },
    },
  };
}
const bodyOf = (msg) => Buffer.from(JSON.stringify(msg), "utf8");
const BODY = bodyOf(message());

/** The base claims for `body`, with `over` applied. */
function claims(over = {}, body = BODY) {
  return { v: 1, request_id: "r-1", principal: "k-1", tenant: "t-1", aud: AUD, tool: "render_still",
    body_sha256: sha256(body), iat: NOW, exp: NOW + 60, ...over };
}

/** `p "." HMAC(key, p)` over a claims part exactly as given; node:crypto alone, not signIdentity. */
const signPart = (p, key = KEY) => `${p}.${createHmac("sha256", key).update(p).digest("base64url")}`;
const signText = (text, key = KEY) => signPart(Buffer.from(text, "utf8").toString("base64url"), key);
const sign = (c, key = KEY) => signText(JSON.stringify(c), key);

function options(over = {}) {
  return { key: KEY, audience: AUD, nowS: NOW, skewS: SKEW, maxTtlS: MAX_TTL, startedAtS: NOW - 600, ...over };
}

const refused401 = (reason) => ({ ok: false, status: 401, reason });

test("the service constants have the values the plan fixes", () => {
  const fixed = {
    IDENTITY_HEADER: "x-render-identity",
    REQUEST_ID_META_KEY: "io.github.curasinan/request_id",
    IDENTITY_SKEW_S: 30,
    IDENTITY_MAX_TTL_S: 120,
    SERVICE_BODY_CAP_BYTES: 262_144,
    SERVICE_PNG_CAP_BYTES: 4_194_304,
    RENDER_STILL_DEADLINE_MS: 45_000,
    RENDER_CLI_TIMEOUT_MS: 60_000,
    RENDER_KILL_GRACE_MS: 5_000,
    RENDER_VERIFY_DEADLINE_MS: 10_000,
    RENDER_SLOTS_DEFAULT: 2,
    MIN_REMOTION_RENDERER: "4.0.458",
  };
  const shipped = Object.fromEntries(Object.keys(fixed).map((name) => [name, CONSTANTS[name]]));
  assert.deepEqual(shipped, fixed, "dist-service/service/constants.js no longer ships the plan's values");
});

test("a valid request verifies", () => {
  const c = claims();
  const header = sign(c);
  assert.equal(signIdentity(c, KEY), header,
    "signIdentity does not produce base64url(claims) \".\" base64url(HMAC-SHA256(key, base64url(claims)))");
  assert.deepEqual(verifyIdentityHeader(header, BODY, options()), { ok: true, claims: c });
  assert.deepEqual(verifyRequest(header, BODY, options(), new ReplayCache(SKEW)),
    { ok: true, claims: c, message: message() });
});

// Every row breaks exactly one rule. `signedBody` is what body_sha256 covers; `sentBody` is what arrives.
// FLIPPED changes one letter of "scoreboard", so it stays valid JSON with a different hash.
const FLIPPED = Buffer.from(BODY);
FLIPPED[BODY.indexOf("scoreboard")] ^= 0x01;
const R2_BODY = bodyOf(message({ requestId: "r-2" }));
const REFUSAL_ROWS = [
  { reason: "missing", call: "header", header: undefined },
  { reason: "malformed", call: "header", header: "a-header-with-no-dot" },
  { reason: "unsupported_version", call: "header", claims: { v: 2 } },
  { reason: "bad_signature", call: "header", key: randomBytes(32) },
  { reason: "wrong_audience", call: "header", claims: { aud: "dep-b" } },
  { reason: "not_yet_valid", call: "header", claims: { iat: NOW + 31, exp: NOW + 90 } },
  { reason: "expired", call: "header", claims: { iat: NOW - 91, exp: NOW - 31 } },
  { reason: "ttl_too_long", call: "header", claims: { exp: NOW + 121 } },
  { reason: "signed_before_start", call: "header", options: { startedAtS: NOW - 10 },
    claims: { iat: NOW - 41, exp: NOW + 60 } },
  { reason: "body_mismatch", call: "header", signedBody: BODY, sentBody: FLIPPED },
  { reason: "tool_mismatch", call: "request", claims: { tool: "list_templates" } },
  { reason: "request_id_mismatch", call: "request", sentBody: R2_BODY },
  { reason: "replayed", call: "request" },
];

test("each refusal reason is produced by its own case", () => {
  assert.deepEqual(REFUSAL_ROWS.map((r) => r.reason), ALL_REFUSALS, "the table must cover every reason once");
  // The body_mismatch row breaks only the body hash: the changed body is still a valid JSON message.
  assert.notEqual(sha256(FLIPPED), sha256(BODY));
  assert.doesNotThrow(() => JSON.parse(FLIPPED.toString("utf8")),
    "the body_mismatch body must stay valid JSON, or through verifyRequest it also breaks the parse rule");
  for (const row of REFUSAL_ROWS) {
    const sent = row.sentBody ?? BODY;
    const header = "header" in row ? row.header : sign(claims(row.claims, row.signedBody ?? sent), row.key);
    const o = options(row.options);
    if (row.call === "header") {
      assert.deepEqual(verifyIdentityHeader(header, sent, o), { ok: false, reason: row.reason }, row.reason);
      continue;
    }
    const cache = new ReplayCache(SKEW);
    if (row.reason === "replayed") {
      assert.equal(verifyRequest(header, sent, o, cache).ok, true, "the first of two identical requests must pass");
    }
    assert.deepEqual(verifyRequest(header, sent, o, cache), refused401(row.reason), row.reason);
  }
});

test("malformed headers never throw", () => {
  const good = sign(claims());
  const [p, s] = good.split(".");
  const noTenant = claims();
  delete noTenant.tenant;

  // A signature that decodes to the same 32 bytes as `s`: the last character's two spare bits are set.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const nonCanonical = s.slice(0, 42) + ALPHABET[ALPHABET.indexOf(s[42]) + 1];
  assert.ok(Buffer.from(nonCanonical, "base64url").equals(Buffer.from(s, "base64url")),
    "positive control: Node's decoder must read both spellings as the same bytes, or that row proves nothing");

  const cases = [
    ["claims that are not JSON", signText("not json")],
    ["claims that are a JSON array", signText(JSON.stringify([claims()]))],
    ["claims that are JSON null", signText("null")],
    ["a missing field", sign(noTenant)],
    ["iat as a string", sign(claims({ iat: "1" }))],
    ["iat NaN, which JSON encodes as null", sign(claims({ iat: NaN }))],
    ["exp not a whole number", sign(claims({ exp: NOW + 60.5 }))],
    ["v as a string", sign(claims({ v: "1" }))],
    ["tool not a string", sign(claims({ tool: 5 }))],
    ["a 42-character signature", `${p}.${s.slice(0, 42)}`],
    ["a 44-character signature", `${p}.${s}A`],
    ["a non-base64url character in the signature", `${p}.${s.slice(0, 42)}+`],
    ["a non-base64url character in the claims, correctly signed", signPart(`${p}!`)],
    ["padding on the claims, correctly signed", signPart(`${p}=`)],
    ["a non-canonical signature encoding", `${p}.${nonCanonical}`],
    ["three dot-separated parts", `${good}.${s}`],
    ["an empty header", ""],
    ["an empty claims part", `.${s}`],
    ["an empty signature part", `${p}.`],
    ["an array, as node:http types a header", [good]],
  ];
  for (const [name, header] of cases) {
    let result;
    assert.doesNotThrow(() => { result = verifyIdentityHeader(header, BODY, options()); }, name);
    assert.deepEqual(result, { ok: false, reason: "malformed" }, name);
  }
});

/** The time rules in their documented order, restated so each case can prove what it breaks. */
const TIME_RULES = [
  ["not_yet_valid", (c, o) => o.nowS < c.iat - o.skewS],
  ["expired", (c, o) => o.nowS > c.exp + o.skewS],
  ["ttl_too_long", (c, o) => c.exp - c.iat > o.maxTtlS],
  ["signed_before_start", (c, o) => c.iat < o.startedAtS - o.skewS],
];

test("time rules report the first failing rule in order", () => {
  const cases = [
    [{ iat: NOW + 31, exp: NOW - 31 }, {}],
    [{ iat: NOW + 31, exp: NOW + 152 }, {}],
    [{ iat: NOW - 200, exp: NOW - 31 }, {}],
    [{ iat: NOW - 91, exp: NOW - 31 }, { startedAtS: NOW - 10 }],
    // Breaks both ttl_too_long and signed_before_start.
    [{ iat: NOW - 41, exp: NOW + 80 }, { startedAtS: NOW - 10 }],
  ];
  for (const [over, optOver] of cases) {
    const c = claims(over);
    const o = options(optOver);
    const broken = TIME_RULES.filter(([, breaks]) => breaks(c, o)).map(([name]) => name);
    assert.equal(broken.length, 2, `case ${JSON.stringify(over)} must break two rules, breaks ${broken}`);
    assert.deepEqual(verifyIdentityHeader(sign(c), BODY, o), { ok: false, reason: broken[0] },
      `breaks ${broken.join(" and ")}`);
  }
});

/** Every header rule after the shape check, in the documented order, restated like TIME_RULES. */
const HEADER_RULES = [
  ["unsupported_version", (k) => k.c.v !== 1],
  ["bad_signature", (k) => k.key !== KEY],
  ["wrong_audience", (k) => k.c.aud !== AUD],
  ...TIME_RULES.map(([name, breaks]) => [name, (k) => breaks(k.c, k.o)]),
  ["body_mismatch", (k) => sha256(k.sent) !== k.c.body_sha256],
];
const OTHER_KEY = randomBytes(32);
// Each case breaks exactly two rules. The scripts/make-identity-vectors.mjs block "Two-rule cases" mirrors it.
const PAIR_CASES = [
  { claims: { v: 2 }, key: OTHER_KEY },
  { claims: { aud: "dep-b" }, key: OTHER_KEY },
  { claims: { aud: "dep-b", iat: NOW + 31, exp: NOW + 90 } },
  { claims: { iat: NOW + 31, exp: NOW - 31 } },
  { claims: { iat: NOW - 200, exp: NOW - 31 } },
  { claims: { iat: NOW - 41, exp: NOW + 80 }, options: { startedAtS: NOW - 10 } },
  { claims: { iat: NOW - 41, exp: NOW + 60 }, options: { startedAtS: NOW - 10 }, sent: FLIPPED },
  // Not an adjacent pair: it pins the body hash after ttl_too_long as well as after signed_before_start.
  { claims: { exp: NOW + 121 }, sent: FLIPPED },
];

test("every adjacent pair of header checks is pinned by a two-rule case", () => {
  const pinned = new Set();
  for (const row of PAIR_CASES) {
    const k = { c: claims(row.claims), o: options(row.options), key: row.key ?? KEY, sent: row.sent ?? BODY };
    const broken = HEADER_RULES.filter(([, breaks]) => breaks(k)).map(([name]) => name);
    const label = `${JSON.stringify(row.claims)} breaks ${broken.join(" and ")}`;
    assert.equal(broken.length, 2, `${label}: a case must break exactly two rules`);
    const header = sign(k.c, k.key);
    assert.deepEqual(verifyIdentityHeader(header, k.sent, k.o), { ok: false, reason: broken[0] }, label);
    assert.deepEqual(verifyRequest(header, k.sent, k.o, new ReplayCache(SKEW)), refused401(broken[0]), label);
    pinned.add(`${broken[0]} > ${broken[1]}`);
  }
  for (let i = 0; i + 1 < HEADER_RULES.length; i += 1) {
    const pair = `${HEADER_RULES[i][0]} > ${HEADER_RULES[i + 1][0]}`;
    assert.ok(pinned.has(pair), `no two-rule case pins ${pair}`);
  }
});

test("the checks run in the documented order", () => {
  // Header checks: each case breaks its own rule plus the rules of every case below it.
  const otherKey = randomBytes(32);
  const late = { iat: NOW - 91, exp: NOW - 31 }; // expired
  const header = (over, key = KEY) => verifyIdentityHeader(sign(claims(over), key), FLIPPED, options());
  assert.deepEqual(header({ v: 2, aud: "dep-b", ...late }, otherKey), { ok: false, reason: "unsupported_version" });
  assert.deepEqual(header({ aud: "dep-b", ...late }, otherKey), { ok: false, reason: "bad_signature" });
  assert.deepEqual(header({ aud: "dep-b", ...late }), { ok: false, reason: "wrong_audience" });
  assert.deepEqual(header(late), { ok: false, reason: "expired" });
  assert.deepEqual(header({}), { ok: false, reason: "body_mismatch" });

  // Request checks: identity, then parse, then the claims against the message, then replay.
  const notJson = Buffer.from("{not json", "utf8");
  assert.deepEqual(verifyRequest(sign(claims()), notJson, options(), new ReplayCache(SKEW)),
    refused401("body_mismatch"), "a signed body replaced by one that is not JSON fails the body hash before the parse");
  assert.deepEqual(verifyRequest(sign(claims({}, notJson), otherKey), notJson, options(), new ReplayCache(SKEW)),
    refused401("bad_signature"));
  const batch = bodyOf([message({ name: "list_templates", requestId: "r-2" })]);
  assert.deepEqual(verifyRequest(sign(claims({}, batch)), batch, options(), new ReplayCache(SKEW)),
    { ok: false, status: 400, reason: "batch" });
  assert.deepEqual(verifyRequest(sign(claims({ tool: "list_templates" }, R2_BODY)), R2_BODY, options(),
    new ReplayCache(SKEW)), refused401("tool_mismatch"));
  const cache = new ReplayCache(SKEW);
  assert.equal(verifyRequest(sign(claims()), BODY, options(), cache).ok, true);
  assert.deepEqual(verifyRequest(sign(claims({ tool: "list_templates" })), BODY, options(), cache),
    refused401("tool_mismatch"), "a reused id that also fails the message check reports the message check");
});

test("REVIEW FOCUS 1: skew boundaries are inclusive at 30 s", () => {
  const at = (over) => verifyRequest(sign(claims(over)), BODY, options(), new ReplayCache(SKEW));
  assert.equal(at({ iat: NOW + 30, exp: NOW + 90 }).ok, true, "signed 30 s in the future must pass");
  assert.deepEqual(at({ iat: NOW + 31, exp: NOW + 91 }), refused401("not_yet_valid"));
  assert.equal(at({ iat: NOW - 90, exp: NOW - 30 }).ok, true, "expired 30 s ago must pass");
  assert.deepEqual(at({ iat: NOW - 91, exp: NOW - 31 }), refused401("expired"));
});

test("REVIEW FOCUS 5: the start-time rule refuses inside the exp window and is inclusive at the boundary", () => {
  const o = options({ startedAtS: NOW - 10 });
  const at = (iat) => verifyRequest(sign(claims({ iat, exp: NOW + 60 })), BODY, o, new ReplayCache(SKEW));
  assert.deepEqual(at(NOW - 41), refused401("signed_before_start"),
    "a header signed before startedAt - skew must be refused although exp is still 60 s away");
  assert.equal(at(NOW - 40).ok, true, "a header signed exactly at startedAt - skew must pass");
});

test("a request that fails a later check does not enter the replay cache", () => {
  const cache = new ReplayCache(SKEW);
  const r9 = bodyOf(message({ requestId: "r-9" }));
  assert.deepEqual(verifyRequest(sign(claims({ request_id: "r-9", tool: "list_templates" }, r9)), r9, options(), cache),
    refused401("tool_mismatch"));
  const notJson = Buffer.from("{not json", "utf8");
  assert.deepEqual(verifyRequest(sign(claims({ request_id: "r-9" }, notJson)), notJson, options(), cache),
    { ok: false, status: 400, reason: "parse" });

  const valid = sign(claims({ request_id: "r-9" }, r9));
  assert.equal(verifyRequest(valid, r9, options(), cache).ok, true,
    "r-9 was refused earlier, so it must not count as seen");
  // Positive control: this cache does record a request that passes.
  assert.deepEqual(verifyRequest(valid, r9, options(), cache), refused401("replayed"));
});

test("400/parse for a non-JSON body and 400/batch for an array body, both after a valid signature", () => {
  const notJson = Buffer.from("{not json", "utf8");
  const batch = bodyOf([message()]);
  assert.deepEqual(verifyRequest(sign(claims({}, notJson)), notJson, options(), new ReplayCache(SKEW)),
    { ok: false, status: 400, reason: "parse" });
  assert.deepEqual(verifyRequest(sign(claims({}, batch)), batch, options(), new ReplayCache(SKEW)),
    { ok: false, status: 400, reason: "batch" });
});

test("the replay cache forgets an id only after exp plus skew", () => {
  const cache = new ReplayCache(SKEW);
  assert.equal(cache.seen("r-1", NOW), false, "an id never remembered");
  cache.remember("r-1", NOW + 60, NOW);
  assert.equal(cache.seen("r-1", NOW), true);
  assert.equal(cache.seen("r-1", NOW + 90), true, "exp + skew is still inside the window");
  assert.equal(cache.seen("r-1", NOW + 91), false, "one second past exp + skew");

  // remember() prunes. At exactly exp + skew an entry must survive, or a replay at that second passes.
  cache.remember("r-2", NOW + 120, NOW + 90);
  assert.equal(cache.seen("r-1", NOW + 90), true, "remember() pruned an entry at exactly exp + skew");
  // One second later r-1 is gone even for an earlier clock reading; r-2 is still live and stays.
  cache.remember("r-3", NOW + 200, NOW + 91);
  assert.equal(cache.seen("r-1", NOW), false, "remember() did not prune an entry past exp + skew");
  assert.equal(cache.seen("r-2", NOW + 91), true, "remember() pruned an entry still inside its window");
});

// Values that are not a whole number of seconds. Each option also gets its good value as a string.
const NOT_WHOLE_SECONDS = [NaN, undefined, null, Infinity, -Infinity, 1.5];
const show = (value) => (typeof value === "string" ? JSON.stringify(value) : String(value));

test("bad verifier options fail closed: a refusal or a throw, never ok", () => {
  const good = options();
  // The rule each bad option fails, after the header's own checks 1 to 5 pass. A row's `claims` is a header
  // the bad value would let through if its guard were missing; the base header already fails those values.
  const rows = [];
  for (const [name, reason] of [
    ["nowS", "not_yet_valid"],
    ["skewS", "not_yet_valid"],
    ["maxTtlS", "ttl_too_long"],
    ["startedAtS", "signed_before_start"],
  ]) {
    for (const bad of [...NOT_WHOLE_SECONDS, good[name] + 0.5, String(good[name])]) rows.push({ name, bad, reason });
  }
  rows.push(
    { name: "skewS", bad: -1, reason: "not_yet_valid", claims: { iat: NOW - 1, exp: NOW + 59 } },
    { name: "maxTtlS", bad: 0, reason: "ttl_too_long", claims: { exp: NOW } },
    { name: "maxTtlS", bad: -1, reason: "ttl_too_long", claims: { exp: NOW - 1 } },
  );
  for (const { name, bad, reason, claims: over } of rows) {
    const label = `${name} = ${show(bad)}`;
    const header = sign(claims(over));
    assert.equal(verifyIdentityHeader(header, BODY, good).ok, true, `positive control for ${label}: good options verify`);
    const o = options({ [name]: bad });
    let result;
    assert.doesNotThrow(() => { result = verifyIdentityHeader(header, BODY, o); }, `verifyIdentityHeader, ${label}`);
    assert.deepEqual(result, { ok: false, reason }, `verifyIdentityHeader, ${label}`);
    if (name === "skewS") {
      // A ReplayCache only holds a valid skew, so a bad skewS is always a mismatch with the cache's.
      assert.throws(() => verifyRequest(header, BODY, o, new ReplayCache(SKEW)), /skew/, `verifyRequest, ${label}`);
    } else {
      assert.deepEqual(verifyRequest(header, BODY, o, new ReplayCache(SKEW)), refused401(reason),
        `verifyRequest, ${label}`);
    }
  }

  // The probes that verified before this rule existed.
  const header = sign(claims());
  const longExpired = sign(claims({ iat: NOW - 10_050, exp: NOW - 9_990 }));
  assert.deepEqual(verifyIdentityHeader(longExpired, BODY, options({ skewS: NaN })),
    { ok: false, reason: "not_yet_valid" }, "skewS NaN let a header that expired 9990 s ago verify");
  const cache = new ReplayCache(SKEW);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(verifyRequest(header, BODY, options({ nowS: NaN }), cache), refused401("not_yet_valid"),
      "nowS NaN accepted the same request twice");
  }
  const preStartLong = sign(claims({ iat: NOW - 700, exp: NOW + 60 }));
  assert.deepEqual(verifyIdentityHeader(preStartLong, BODY, options({ startedAtS: undefined, maxTtlS: NaN })),
    { ok: false, reason: "ttl_too_long" }, "startedAtS undefined with maxTtlS NaN accepted a pre-start, over-long header");
  const farFuture = sign(claims({ iat: NOW + 100_000, exp: NOW + 100_060 }));
  assert.deepEqual(verifyIdentityHeader(farFuture, BODY, options({ skewS: Infinity })),
    { ok: false, reason: "not_yet_valid" }, "skewS Infinity accepted every header");
});

test("the replay cache refuses a bad skew and fails closed on a bad clock reading", () => {
  for (const bad of [...NOT_WHOLE_SECONDS, -1, "30"]) {
    assert.throws(() => new ReplayCache(bad), RangeError, `new ReplayCache(${show(bad)}) must throw`);
  }
  assert.equal(new ReplayCache(0).skewS, 0, "positive control: a skew of 0 is allowed");
  const cache = new ReplayCache(SKEW);
  for (const bad of [...NOT_WHOLE_SECONDS, String(NOW)]) {
    assert.equal(cache.seen("r-never", bad), true, `seen() at nowS ${show(bad)} must fail closed`);
    assert.throws(() => cache.remember("r-x", NOW + 60, bad), RangeError, `remember() at nowS ${show(bad)}`);
    assert.throws(() => cache.remember("r-x", bad, NOW), RangeError, `remember() with expS ${show(bad)}`);
  }
  // Positive controls: good readings work, and the refused remember() calls stored nothing.
  assert.equal(cache.seen("r-never", NOW), false);
  assert.equal(cache.seen("r-x", NOW), false, "a refused remember() must not store its id");
  cache.remember("r-x", NOW + 60, NOW);
  assert.equal(cache.seen("r-x", NOW), true);
});

test("verifyRequest throws when the replay cache's skew differs from the verifier's", () => {
  const cache = new ReplayCache(30);
  assert.equal(cache.skewS, 30);
  assert.throws(() => { cache.skewS = 60; }, TypeError, "a cache's skewS must be read-only");
  const header = sign(claims());
  // A wiring bug, not a request outcome: it throws whatever the request, before any check.
  for (const h of [header, undefined]) {
    assert.throws(() => verifyRequest(h, BODY, options({ skewS: 60 }), cache), /skew.*\b30\b.*\b60\b/,
      "a cache with skew 30 under options with skewS 60 drops ids while their headers still verify");
  }
  // Positive controls: matching skews verify, and the throws left the cache untouched.
  assert.equal(verifyRequest(header, BODY, options({ skewS: 30 }), cache).ok, true);
  const wide = new ReplayCache(60);
  assert.equal(verifyRequest(header, BODY, options({ skewS: 60 }), wide).ok, true);
  assert.deepEqual(verifyRequest(header, BODY, options({ skewS: 60, nowS: NOW + 100 }), wide), refused401("replayed"),
    "with both skews at 60, a replay at NOW + 100 is still refused");
});

test("within a process the verifier's time never moves backward", () => {
  const request = (id, over = {}) => {
    const body = bodyOf(message({ requestId: id }));
    return [sign(claims({ request_id: id, ...over }, body)), body];
  };
  const [a, aBody] = request("r-A"); // iat NOW, exp NOW + 60
  const [b, bBody] = request("r-B", { iat: NOW + 200, exp: NOW + 260 });
  const [c, cBody] = request("r-C", { iat: NOW + 200, exp: NOW + 260 });
  const [d, dBody] = request("r-D", { iat: NOW + 5, exp: NOW + 65 });

  const cache = new ReplayCache(SKEW);
  assert.equal(verifyRequest(a, aBody, options(), cache).ok, true);
  assert.equal(verifyRequest(b, bBody, options({ nowS: NOW + 200 }), cache).ok, true,
    "r-B is valid at NOW + 200, and remembering it drops r-A");
  assert.deepEqual(verifyRequest(a, aBody, options({ nowS: NOW + 5 }), cache), refused401("expired"),
    "after a clock step back to NOW + 5, a replay of the dropped r-A must be judged at NOW + 200");
  // The verifier stays at NOW + 200 until the clock passes it.
  assert.equal(verifyRequest(c, cBody, options({ nowS: NOW + 5 }), cache).ok, true);
  assert.deepEqual(verifyRequest(b, bBody, options({ nowS: NOW + 5 }), cache), refused401("replayed"));
  assert.deepEqual(verifyRequest(d, dBody, options({ nowS: NOW + 5 }), cache), refused401("expired"),
    "a header signed on the stepped-back clock is refused until that clock catches up");
  // verifyIdentityHeader keeps no state: on its own, at NOW + 5, r-A's header verifies.
  assert.equal(verifyIdentityHeader(a, aBody, options({ nowS: NOW + 5 })).ok, true);

  // Positive control: a clock that only moves forward behaves exactly as before.
  const forward = new ReplayCache(SKEW);
  assert.equal(verifyRequest(a, aBody, options(), forward).ok, true);
  assert.deepEqual(verifyRequest(a, aBody, options({ nowS: NOW + 90 }), forward), refused401("replayed"));
  assert.deepEqual(verifyRequest(a, aBody, options({ nowS: NOW + 91 }), forward), refused401("expired"));
  assert.equal(verifyRequest(b, bBody, options({ nowS: NOW + 200 }), forward).ok, true);
  assert.deepEqual(verifyRequest(b, bBody, options({ nowS: NOW + 290 }), forward), refused401("replayed"));
});

test("toolOf maps tools/call to params.name and anything else to method", () => {
  assert.equal(toolOf(message()), "render_still");
  assert.equal(toolOf({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), "initialize");
  assert.equal(toolOf({ jsonrpc: "2.0", method: "notifications/initialized" }), "notifications/initialized");
  assert.equal(toolOf({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { name: "x" } }), "tools/list");
  for (const m of [
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 5 } },
    { jsonrpc: "2.0", id: 1, result: {} },
    { method: 7 },
    null, 5, "tools/call", [message()],
  ]) {
    assert.equal(toolOf(m), null, JSON.stringify(m));
  }
  // checkClaimsAgainstMessage uses it, and a message without a tool never matches.
  assert.deepEqual(checkClaimsAgainstMessage(claims(), { jsonrpc: "2.0", id: 1, method: "tools/call" }),
    { ok: false, reason: "tool_mismatch" });
});

test("every vector in test/vectors/identity-v1.json produces its declared verdict", () => {
  const file = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
  assert.equal(file.key_base64url, KEY.toString("base64url"), "the vectors must be signed with the published throwaway key");
  const declared = new Set();
  let bodyOnlyMismatch = 0;
  for (const v of file.vectors) {
    assert.deepEqual(Object.keys(v).sort(), ["name", "options", "steps"], v.name);
    assert.equal(v.options.skewS, IDENTITY_SKEW_S, `${v.name}: the vectors use the shipped skew`);
    assert.equal(v.options.maxTtlS, IDENTITY_MAX_TTL_S, `${v.name}: the vectors use the shipped TTL cap`);
    const cache = new ReplayCache(v.options.skewS);
    v.steps.forEach((step, i) => {
      const body = Buffer.from(step.body_base64, "base64");
      const got = verifyRequest(step.header ?? undefined, body, { key: KEY, ...v.options }, cache);
      const verdict = got.ok ? { ok: true } : { ok: false, status: got.status, reason: got.reason };
      assert.deepEqual(verdict, step.expected, `${v.name}, step ${i + 1}`);
      declared.add(step.expected.ok ? "ok" : `${step.expected.status}/${step.expected.reason}`);
      if (step.expected.reason === "body_mismatch") {
        try {
          if (!Array.isArray(JSON.parse(body.toString("utf8")))) bodyOnlyMismatch += 1;
        } catch {
          // A body that is not JSON also breaks the parse rule; that vector pins the order, not the hash alone.
        }
      }
    });
  }
  const required = [...ALL_REFUSALS.map((r) => `401/${r}`), "400/parse", "400/batch", "ok"];
  assert.deepEqual([...declared].sort(), required.sort(), "the vectors must cover every verdict");
  assert.ok(bodyOnlyMismatch > 0,
    "some body_mismatch vector must carry a valid JSON message, so that it breaks the body hash alone");
});

test("the vectors pin the canonical-encoding rules a gateway port must reproduce", () => {
  const { vectors } = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
  const parts = vectors.flatMap((v) => v.steps)
    .filter((s) => s.expected.reason === "malformed" && typeof s.header === "string")
    .map((s) => s.header.split("."))
    .filter((p) => p.length === 2);
  const hmacOf = (p) => createHmac("sha256", KEY).update(p).digest();
  // Node's decoder reads a padded part as the unpadded one, so only the alphabet rule refuses this header.
  assert.ok(parts.some(([p, s]) => /=$/.test(p) && s === hmacOf(p).toString("base64url")
      && Buffer.from(p, "base64url").equals(Buffer.from(p.replace(/=+$/, ""), "base64url"))),
  "no malformed vector carries a padded claims part signed over the padded text");
  // The right 32 bytes, spelled with spare bits set: only the canonical-spelling rule refuses this one.
  assert.ok(parts.some(([p, s]) => /^[A-Za-z0-9_-]{43}$/.test(s) && s !== hmacOf(p).toString("base64url")
      && Buffer.from(s, "base64url").equals(hmacOf(p))),
  "no malformed vector carries a non-canonical spelling of the right signature");
});

test("test/vectors/identity-v1.json is byte for byte what scripts/make-identity-vectors.mjs writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-vectors-"));
  try {
    const out = path.join(dir, "identity-v1.json");
    const run = spawnSync(process.execPath, [path.join(REPO, "scripts", "make-identity-vectors.mjs"), out],
      { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const generated = fs.readFileSync(out);
    const committed = fs.readFileSync(VECTORS);
    if (!generated.equals(committed)) {
      const g = generated.toString("utf8").split("\n");
      const c = committed.toString("utf8").split("\n");
      let line = 0;
      while (line < Math.max(g.length, c.length) && g[line] === c[line]) line += 1;
      assert.fail(`test/vectors/identity-v1.json differs from the generator's output from line ${line + 1}. `
        + "Edit scripts/make-identity-vectors.mjs, never the JSON, then run "
        + "`node scripts/make-identity-vectors.mjs test/vectors/identity-v1.json`.");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scripts/sign-identity.mjs signs with the key from the environment, refuses a missing, short or padded one, "
  + "and never prints it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sign-identity-"));
  try {
    const claimsFile = path.join(dir, "claims.json");
    const bodyFile = path.join(dir, "body.json");
    const c = claims();
    const withoutHash = { ...c };
    delete withoutHash.body_sha256; // the signer fills it from the body file
    fs.writeFileSync(claimsFile, JSON.stringify(withoutHash));
    fs.writeFileSync(bodyFile, BODY);
    const run = (encodedKey) => {
      const env = { ...process.env };
      delete env.IDENTITY_HMAC_KEY;
      if (encodedKey !== undefined) env.IDENTITY_HMAC_KEY = encodedKey;
      return spawnSync(process.execPath, [path.join(REPO, "scripts", "sign-identity.mjs"), claimsFile, bodyFile],
        { env, encoding: "utf8" });
    };
    /** The key's spellings a leak could take: base64url, and base64 without its padding. */
    const spellings = (bytes) => [bytes.toString("base64url"), bytes.toString("base64").replace(/=+$/, "")];

    const key = randomBytes(32);
    const signed = run(key.toString("base64url"));
    assert.equal(signed.status, 0, signed.stderr);
    assert.deepEqual(verifyIdentityHeader(signed.stdout.trim(), BODY, options({ key })), { ok: true, claims: c },
      "the signer's header must verify under the same key, with body_sha256 taken from the body file");
    for (const spelling of spellings(key)) {
      assert.ok(!signed.stdout.includes(spelling), "the signer printed its key on stdout");
      assert.ok(!signed.stderr.includes(spelling), "the signer printed its key on stderr");
    }

    const none = run(undefined);
    assert.equal(none.status, 2, "no key: the signer must refuse");
    assert.equal(none.stdout, "", "no key: the signer must print no header");

    for (const [name, encoded] of [
      ["a 16-byte key", randomBytes(16).toString("base64url")],
      ["a 31-byte key", randomBytes(31).toString("base64url")],
      ["a padded key", `${randomBytes(32).toString("base64url")}=`],
    ]) {
      const result = run(encoded);
      assert.equal(result.status, 2, `${name}: the signer must refuse`);
      assert.equal(result.stdout, "", `${name}: the signer must print no header`);
      for (const spelling of spellings(Buffer.from(encoded, "base64url"))) {
        assert.ok(!result.stderr.includes(spelling), `${name}: the signer must never print the key`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GUARD: the constants module refuses a CLI timeout that does not exceed the render deadline", async () => {
  const src = fs.readFileSync(path.join(SERVICE, "constants.js"), "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, "");
  const load = (text) => import(`data:text/javascript,${encodeURIComponent(text)}`);
  // Positive control: the module as built loads through the same data: URL route.
  const built = await load(src);
  assert.ok(built.RENDER_CLI_TIMEOUT_MS > built.RENDER_STILL_DEADLINE_MS);
  const equal = src.replace(/(RENDER_CLI_TIMEOUT_MS = )[0-9_]+;/, "$145_000;");
  assert.notEqual(equal, src, "could not find RENDER_CLI_TIMEOUT_MS in dist-service/service/constants.js");
  await assert.rejects(load(equal), /RENDER_CLI_TIMEOUT_MS \(45000\) must exceed RENDER_STILL_DEADLINE_MS/);
});

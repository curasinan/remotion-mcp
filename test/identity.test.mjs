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
const { REQUEST_ID_META_KEY } = await import(pathToFileURL(path.join(SERVICE, "constants.js")).href);

// The published throwaway vector key. Any other key a test needs is generated at runtime.
const KEY = Buffer.alloc(32, 7);
const AUD = "dep-a";
const NOW = 1_800_000_000;
const SKEW = 30;
const MAX_TTL = 120;

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
const FLIPPED = Buffer.from(BODY);
FLIPPED[20] ^= 0x01;
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
  const file = JSON.parse(fs.readFileSync(path.join(REPO, "test", "vectors", "identity-v1.json"), "utf8"));
  assert.equal(file.key_base64url, KEY.toString("base64url"), "the vectors must be signed with the published throwaway key");
  const declared = new Set();
  for (const v of file.vectors) {
    assert.deepEqual(Object.keys(v).sort(), ["name", "options", "steps"], v.name);
    const cache = new ReplayCache(v.options.skewS);
    v.steps.forEach((step, i) => {
      const got = verifyRequest(step.header ?? undefined, Buffer.from(step.body_base64, "base64"),
        { key: KEY, ...v.options }, cache);
      const verdict = got.ok ? { ok: true } : { ok: false, status: got.status, reason: got.reason };
      assert.deepEqual(verdict, step.expected, `${v.name}, step ${i + 1}`);
      declared.add(step.expected.ok ? "ok" : `${step.expected.status}/${step.expected.reason}`);
    });
  }
  const required = [...ALL_REFUSALS.map((r) => `401/${r}`), "400/parse", "400/batch", "ok"];
  assert.deepEqual([...declared].sort(), required.sort(), "the vectors must cover every verdict");
});

test("scripts/sign-identity.mjs signs with the key from the environment, and refuses a missing or short one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sign-identity-"));
  try {
    const key = randomBytes(32);
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

    const signed = run(key.toString("base64url"));
    assert.equal(signed.status, 0, signed.stderr);
    assert.deepEqual(verifyIdentityHeader(signed.stdout.trim(), BODY, options({ key })), { ok: true, claims: c },
      "the signer's header must verify under the same key, with body_sha256 taken from the body file");

    const shortKey = randomBytes(16).toString("base64url");
    for (const [name, result] of [["no key", run(undefined)], ["a 16-byte key", run(shortKey)]]) {
      assert.equal(result.status, 2, `${name}: the signer must refuse`);
      assert.equal(result.stdout, "", `${name}: the signer must print no header`);
      assert.ok(!result.stderr.includes(shortKey), `${name}: the signer must never print the key`);
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

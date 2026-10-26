#!/usr/bin/env node
// Writes the identity-header test vectors (docs/CONTRACT-gateway.md).
//
//   node scripts/make-identity-vectors.mjs test/vectors/identity-v1.json
//
// Independent of the implementation on purpose: it imports nothing from src/ or dist-service/,
// builds every header with node:crypto alone, and every expected verdict below is declared by
// hand. Nothing here asks the verifier what it thinks. The output is deterministic.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outPath = process.argv[2];
if (!outPath || process.argv.length !== 3) {
  console.error("usage: node scripts/make-identity-vectors.mjs <outPath>");
  process.exit(2);
}

// The published throwaway key, 32 bytes of 0x07. It protects nothing; no deployment may use it.
const KEY = Buffer.alloc(32, 7);
const NOW = 1_800_000_000;
const AUD = "dep-a";
const META_KEY = "io.github.curasinan/request_id";
const OPTIONS = { audience: AUD, nowS: NOW, skewS: 30, maxTtlS: 120, startedAtS: NOW - 600 };

const OK = { ok: true };
const refused = (status, reason) => ({ ok: false, status, reason });

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64url = (text) => Buffer.from(text, "utf8").toString("base64url");
/** `p "." base64url(HMAC-SHA256(key, p))` over the claims part exactly as given. */
const signPart = (p) => `${p}.${createHmac("sha256", KEY).update(p).digest("base64url")}`;
const signText = (claimsText) => signPart(b64url(claimsText));

function body(method, params) {
  return Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), "utf8");
}
/** A render_still call as the gateway forwards it; the non-ASCII prop makes byte-exact hashing matter. */
function call({ name = "render_still", requestId = "r-1" } = {}) {
  return body("tools/call", {
    name,
    arguments: { template_id: "scoreboard", props: { title: "Beşiktaş · İstanbul" } },
    _meta: { [META_KEY]: requestId },
  });
}
const CALL = call();

function claims(over = {}, bodyBytes = CALL) {
  return { v: 1, request_id: "r-1", principal: "k-1", tenant: "t-1", aud: AUD, tool: "render_still",
    body_sha256: sha256Hex(bodyBytes), iat: NOW, exp: NOW + 60, ...over };
}
const header = (over, bodyBytes = CALL) => signText(JSON.stringify(claims(over, bodyBytes)));

const step = (h, bodyBytes, expected) => ({ header: h, body_base64: bodyBytes.toString("base64"), expected });
const vector = (name, steps, options = {}) => ({ name, options: { ...OPTIONS, ...options }, steps });

const VALID = header({});
const [VALID_P, VALID_SIG] = VALID.split(".");

// A forgery made without any key: the valid signature with one bit changed.
const forgedSig = Buffer.from(VALID_SIG, "base64url");
forgedSig[0] ^= 0x01;

// The same claims value, spelled with whitespace, under the compact spelling's signature.
const SPACED = JSON.stringify(claims(), null, 2);

const FLIPPED = Buffer.from(CALL);
FLIPPED[20] ^= 0x01;

const LIST = body("tools/list", { _meta: { [META_KEY]: "r-1" } });
const R2 = call({ requestId: "r-2" });
const NO_META = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "render_still", arguments: { template_id: "scoreboard", props: {} } } }), "utf8");
const R9 = call({ requestId: "r-9" });
const NOT_JSON = Buffer.from("{\"jsonrpc\":\"2.0\",", "utf8");
const BATCH = Buffer.from(JSON.stringify([JSON.parse(CALL.toString("utf8"))]), "utf8");

const vectors = [
  vector("ok: a render_still call", [step(VALID, CALL, OK)]),
  vector("ok: a method other than tools/call is its own tool", [step(header({ tool: "tools/list" }, LIST), LIST, OK)]),
  vector("ok: signed 30 s in the future, at the skew edge", [step(header({ iat: NOW + 30, exp: NOW + 90 }), CALL, OK)]),
  vector("ok: expired 30 s ago, at the skew edge", [step(header({ iat: NOW - 90, exp: NOW - 30 }), CALL, OK)]),
  vector("ok: exp - iat of exactly 120 s", [step(header({ iat: NOW - 60, exp: NOW + 60 }), CALL, OK)]),
  vector("ok: signed exactly at startedAt - skew", [step(header({ iat: NOW - 40, exp: NOW + 60 }), CALL, OK)],
    { startedAtS: NOW - 10 }),
  vector("ok: claims JSON with whitespace, signed as sent", [step(signText(SPACED), CALL, OK)]),

  vector("missing: no header", [step(null, CALL, refused(401, "missing"))]),
  vector("malformed: no dot", [step(VALID_P, CALL, refused(401, "malformed"))]),
  vector("malformed: three dot-separated parts", [step(`${VALID}.${VALID_SIG}`, CALL, refused(401, "malformed"))]),
  vector("malformed: a 42-character signature", [step(`${VALID_P}.${VALID_SIG.slice(0, 42)}`, CALL,
    refused(401, "malformed"))]),
  vector("malformed: claims that are a JSON array", [step(signText(JSON.stringify([claims()])), CALL,
    refused(401, "malformed"))]),
  vector("malformed: iat as a string", [step(header({ iat: String(NOW) }), CALL, refused(401, "malformed"))]),
  vector("unsupported_version: v 2", [step(header({ v: 2 }), CALL, refused(401, "unsupported_version"))]),
  vector("bad_signature: a forged signature", [step(`${VALID_P}.${forgedSig.toString("base64url")}`, CALL,
    refused(401, "bad_signature"))]),
  vector("bad_signature: the claims re-encoded after signing", [step(`${b64url(SPACED)}.${VALID_SIG}`, CALL,
    refused(401, "bad_signature"))]),
  vector("wrong_audience: aud dep-b", [step(header({ aud: "dep-b" }), CALL, refused(401, "wrong_audience"))]),
  vector("not_yet_valid: signed 31 s in the future", [step(header({ iat: NOW + 31, exp: NOW + 90 }), CALL,
    refused(401, "not_yet_valid"))]),
  vector("expired: expired 31 s ago", [step(header({ iat: NOW - 91, exp: NOW - 31 }), CALL,
    refused(401, "expired"))]),
  vector("ttl_too_long: exp - iat of 121 s", [step(header({ exp: NOW + 121 }), CALL, refused(401, "ttl_too_long"))]),
  vector("signed_before_start: signed before a restart, inside its exp window",
    [step(header({ iat: NOW - 41, exp: NOW + 60 }), CALL, refused(401, "signed_before_start"))],
    { startedAtS: NOW - 10 }),
  vector("body_mismatch: one body byte changed after signing", [step(VALID, FLIPPED, refused(401, "body_mismatch"))]),
  vector("tool_mismatch: claims tool list_templates for a render_still call",
    [step(header({ tool: "list_templates" }), CALL, refused(401, "tool_mismatch"))]),
  vector("request_id_mismatch: the _meta id is r-2", [step(header({}, R2), R2, refused(401, "request_id_mismatch"))]),
  vector("request_id_mismatch: no _meta id injected", [step(header({}, NO_META), NO_META,
    refused(401, "request_id_mismatch"))]),
  vector("replayed: the same request twice", [step(VALID, CALL, OK), step(VALID, CALL, refused(401, "replayed"))]),
  vector("replayed: a refused request does not enter the replay set", [
    step(header({ request_id: "r-9", tool: "list_templates" }, R9), R9, refused(401, "tool_mismatch")),
    step(header({ request_id: "r-9" }, R9), R9, OK),
    step(header({ request_id: "r-9" }, R9), R9, refused(401, "replayed")),
  ]),
  vector("parse: a body that is not JSON, validly signed", [step(header({}, NOT_JSON), NOT_JSON,
    refused(400, "parse"))]),
  vector("batch: an array body, validly signed", [step(header({}, BATCH), BATCH, refused(400, "batch"))]),
];

const names = new Set(vectors.map((v) => v.name));
if (names.size !== vectors.length) throw new Error("two vectors share a name");

const file = {
  _comment: "Identity header test vectors, contract v1 (docs/CONTRACT-gateway.md). Generated by "
    + "scripts/make-identity-vectors.mjs: edit the script, not this file. Every header is signed with the "
    + "published throwaway key Buffer.alloc(32, 7), 32 bytes of 0x07, given as key_base64url. It protects "
    + "nothing and must never be a deployment's key. Run each vector with a fresh replay cache and its steps "
    + "in order. header null means no header; body_base64 is standard base64 of the exact body bytes.",
  key_base64url: KEY.toString("base64url"),
  vectors,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${outPath}`);

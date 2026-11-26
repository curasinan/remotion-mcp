// A gateway stand-in for the service tests and scripts/image-e2e.mjs: a `fetch` that signs every POST the way the
// owner's gateway does (docs/CONTRACT-gateway.md). A helper module, not a test file, so it is in neither test list in
// package.json.
//
// Independent of the implementation on purpose, like scripts/make-identity-vectors.mjs: it imports nothing from src/
// or dist-service/ and signs with node:crypto alone, so a bug in the service's own signIdentity cannot cancel out.
import { createHash, createHmac, randomUUID } from "node:crypto";

/** The `params._meta` key the gateway puts its `request_id` under. The contract fixes it. */
export const REQUEST_ID_META_KEY = "io.github.curasinan/request_id";
/** The identity header. Header names are case-insensitive; node:http lowercases them. */
export const IDENTITY_HEADER = "x-render-identity";

/** `base64url(claims) "." base64url(HMAC-SHA256(key, base64url(claims)))`. */
export function signClaims(claims, key) {
  const claimsPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${claimsPart}.${createHmac("sha256", key).update(claimsPart).digest("base64url")}`;
}

/** The claims' `tool` for a message: `params.name` for a tools/call, the method for anything else. */
export function toolOf(message) {
  if (message.method !== "tools/call") return message.method;
  return message.params?.name;
}

/**
 * A `fetch` that, for each POST:
 * 1. parses the body,
 * 2. sets `params._meta[REQUEST_ID_META_KEY]` to a fresh UUID,
 * 3. re-serializes the body,
 * 4. sets X-Render-Identity over the final bytes, with the message's tool.
 * Anything else (the SDK client's GET and DELETE) passes through unsigned.
 *
 * `key` is a Buffer. `nowS` is a function returning whole seconds, or a number (default: the wall clock). `ttlS` is
 * `exp - iat` (default 60). `onSigned({ claims, body })`, if given, sees each signed request.
 */
export function makeSigningFetch({ key, audience, principal, tenant, nowS, ttlS = 60, onSigned }) {
  if (!Buffer.isBuffer(key)) throw new TypeError("makeSigningFetch: key must be a Buffer");
  const clock = typeof nowS === "function" ? nowS
    : typeof nowS === "number" ? () => nowS
      : () => Math.floor(Date.now() / 1000);
  return async (url, init = {}) => {
    if (String(init.method ?? "GET").toUpperCase() !== "POST") return fetch(url, init);
    if (typeof init.body !== "string") throw new TypeError("makeSigningFetch: a POST body must be a string");
    const message = JSON.parse(init.body);
    if (typeof message !== "object" || message === null || Array.isArray(message) || typeof message.method !== "string") {
      throw new TypeError("makeSigningFetch signs one JSON-RPC request or notification per POST");
    }
    const requestId = randomUUID();
    const params = message.params ?? {};
    message.params = { ...params, _meta: { ...(params._meta ?? {}), [REQUEST_ID_META_KEY]: requestId } };
    const body = JSON.stringify(message);
    const iat = clock();
    const claims = {
      v: 1, request_id: requestId, principal, tenant, aud: audience, tool: toolOf(message),
      body_sha256: createHash("sha256").update(body, "utf8").digest("hex"), iat, exp: iat + ttlS,
    };
    onSigned?.({ claims, body });
    const headers = new Headers(init.headers);
    headers.set(IDENTITY_HEADER, signClaims(claims, key));
    return fetch(url, { ...init, headers, body });
  };
}

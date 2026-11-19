/**
 * Verifies the gateway's X-Render-Identity header and keeps the replay set (design 5.2 steps 3-6, 5.3).
 * The contract is docs/CONTRACT-gateway.md. Nothing here reads the clock: `nowS` comes from the caller.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { REQUEST_ID_META_KEY } from "./constants.js";

export interface IdentityClaims {
  v: 1; request_id: string; principal: string; tenant: string; aud: string;
  tool: string; body_sha256: string; iat: number; exp: number;
}

export type IdentityRefusal = "missing" | "malformed" | "unsupported_version" | "bad_signature" | "wrong_audience"
  | "not_yet_valid" | "expired" | "ttl_too_long" | "signed_before_start" | "body_mismatch"
  | "tool_mismatch" | "request_id_mismatch" | "replayed";

export type VerifyResult = { ok: true; claims: IdentityClaims } | { ok: false; reason: IdentityRefusal };

export type RequestVerdict =
  | { ok: true; claims: IdentityClaims; message: unknown }
  | { ok: false; status: 401; reason: IdentityRefusal }
  | { ok: false; status: 400; reason: "parse" | "batch" };

export interface VerifyOptions {
  key: Buffer; audience: string; nowS: number; skewS: number;
  maxTtlS: number; startedAtS: number;
}

/** An HMAC-SHA256 digest is 32 bytes: 43 base64url characters, unpadded. */
const SIGNATURE_PART = /^[A-Za-z0-9_-]{43}$/;
const CLAIMS_PART = /^[A-Za-z0-9_-]+$/;

const STRING_FIELDS = ["request_id", "principal", "tenant", "aud", "tool", "body_sha256"] as const;
const INTEGER_FIELDS = ["v", "iat", "exp"] as const;

type Shaped = Omit<IdentityClaims, "v"> & { v: number };

const refuse = (reason: IdentityRefusal): VerifyResult => ({ ok: false, reason });

/** A time option or clock reading: a whole number of seconds. NaN, undefined, Infinity, 1.5 and "30" are not. */
const isWholeSeconds = (value: unknown): value is number => Number.isSafeInteger(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hmac(claimsPart: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(claimsPart).digest();
}

/** `base64url(claims) "." base64url(HMAC-SHA256(key, base64url(claims)))`. */
export function signIdentity(claims: IdentityClaims, key: Buffer): string {
  const claimsPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${claimsPart}.${hmac(claimsPart, key).toString("base64url")}`;
}

/** The nine claims with their types checked, or null. Extra fields are dropped. */
function shapeOf(claimsPart: string): Shaped | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  for (const field of STRING_FIELDS) if (typeof parsed[field] !== "string") return null;
  for (const field of INTEGER_FIELDS) if (!Number.isInteger(parsed[field])) return null;
  const p = parsed as unknown as Shaped;
  return { v: p.v, request_id: p.request_id, principal: p.principal, tenant: p.tenant, aud: p.aud,
    tool: p.tool, body_sha256: p.body_sha256, iat: p.iat, exp: p.exp };
}

/** Header-level checks, in the contract's order. Never throws on any header or body. */
export function verifyIdentityHeader(header: string | undefined, rawBody: Buffer, o: VerifyOptions): VerifyResult {
  if (header === undefined) return refuse("missing");
  if (typeof header !== "string") return refuse("malformed");

  const parts = header.split(".");
  if (parts.length !== 2) return refuse("malformed");
  const [claimsPart, signaturePart] = parts as [string, string];
  if (!CLAIMS_PART.test(claimsPart) || !SIGNATURE_PART.test(signaturePart)) return refuse("malformed");
  // Node's decoder ignores the last character's two spare bits; only the canonical spelling is accepted.
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 32 || signature.toString("base64url") !== signaturePart) return refuse("malformed");
  const c = shapeOf(claimsPart);
  if (c === null) return refuse("malformed");

  if (c.v !== 1) return refuse("unsupported_version");
  // The signature covers the claims part exactly as received; there is no canonical JSON step.
  if (!timingSafeEqual(hmac(claimsPart, o.key), signature)) return refuse("bad_signature");
  if (c.aud !== o.audience) return refuse("wrong_audience");
  // Each time rule is written in its accepting form and also requires the options it reads to be whole
  // seconds (the skew non-negative, the TTL cap positive), so a bad option fails its rule instead of passing.
  const clockOk = isWholeSeconds(o.nowS) && isWholeSeconds(o.skewS) && o.skewS >= 0;
  if (!(clockOk && o.nowS >= c.iat - o.skewS)) return refuse("not_yet_valid");
  if (!(o.nowS <= c.exp + o.skewS)) return refuse("expired");
  if (!(isWholeSeconds(o.maxTtlS) && o.maxTtlS > 0 && c.exp - c.iat <= o.maxTtlS)) return refuse("ttl_too_long");
  // The replay set lives in memory, so a header signed before this process started could be a replay.
  if (!(isWholeSeconds(o.startedAtS) && c.iat >= o.startedAtS - o.skewS)) return refuse("signed_before_start");
  if (createHash("sha256").update(rawBody).digest("hex") !== c.body_sha256) return refuse("body_mismatch");

  return { ok: true, claims: { ...c, v: 1 } };
}

/** `params.name` for a tools/call, the method for anything else; null when the message has neither. */
export function toolOf(message: unknown): string | null {
  if (!isRecord(message) || typeof message.method !== "string") return null;
  if (message.method !== "tools/call") return message.method;
  const params = message.params;
  return isRecord(params) && typeof params.name === "string" ? params.name : null;
}

/** The claims' `tool`, then their `request_id`, against the parsed message. */
export function checkClaimsAgainstMessage(claims: IdentityClaims, message: unknown): VerifyResult {
  if (toolOf(message) !== claims.tool) return refuse("tool_mismatch");
  const params = isRecord(message) ? message.params : undefined;
  const meta = isRecord(params) ? params._meta : undefined;
  const requestId = isRecord(meta) ? meta[REQUEST_ID_META_KEY] : undefined;
  if (requestId !== claims.request_id) return refuse("request_id_mismatch");
  return { ok: true, claims };
}

/** The request ids this process has accepted, each kept until its header could no longer verify. */
export class ReplayCache {
  readonly #skewS: number;
  readonly #expiry = new Map<string, number>();
  /** The largest clock reading this cache has been given. */
  #highWaterS: number | undefined;

  constructor(skewS: number) {
    if (!isWholeSeconds(skewS) || skewS < 0) {
      throw new RangeError(`ReplayCache: skewS must be a non-negative whole number of seconds, got ${String(skewS)}`);
    }
    this.#skewS = skewS;
  }

  /** The skew this cache keeps ids for. verifyRequest requires it to equal the verifier's own. */
  get skewS(): number {
    return this.#skewS;
  }

  /**
   * Records a clock reading and returns the cache's time, the largest reading it has been given. A reading
   * that is not whole seconds is returned unchanged and not recorded, so every check it feeds refuses.
   */
  advance(nowS: number): number {
    if (!isWholeSeconds(nowS)) return nowS;
    if (this.#highWaterS === undefined || nowS > this.#highWaterS) this.#highWaterS = nowS;
    return this.#highWaterS;
  }

  /**
   * True while `nowS <= exp + skew`, the last second the remembered header still verifies.
   * Fails closed: a clock reading that is not whole seconds counts every id as seen.
   */
  seen(requestId: string, nowS: number): boolean {
    if (!isWholeSeconds(nowS)) return true;
    this.advance(nowS);
    const exp = this.#expiry.get(requestId);
    return exp !== undefined && nowS <= exp + this.#skewS;
  }

  /** Records an accepted id, first dropping every entry whose header can no longer verify. */
  remember(requestId: string, expS: number, nowS: number): void {
    if (!isWholeSeconds(expS) || !isWholeSeconds(nowS)) {
      throw new RangeError("ReplayCache.remember: expS and nowS must be whole numbers of seconds");
    }
    this.advance(nowS);
    for (const [id, exp] of this.#expiry) {
      if (nowS > exp + this.#skewS) this.#expiry.delete(id);
    }
    this.#expiry.set(requestId, expS);
  }
}

/**
 * Design 5.2 steps 3-6: identity, parse, identity against the body, then replay.
 * Throws, before any check, when the cache's skew is not the options' skew: that is a wiring bug, not a
 * request outcome, and it would drop ids from the replay set while their headers still verify.
 */
export function verifyRequest(header: string | undefined, rawBody: Buffer, options: VerifyOptions,
  cache: ReplayCache): RequestVerdict {
  if (cache.skewS !== options.skewS) {
    throw new Error(`verifyRequest: the replay cache keeps ids for a skew of ${cache.skewS} s, but the options `
      + `give skewS ${String(options.skewS)}; build both from one setting`);
  }
  // Within one process the verifier's time never moves backward: after a backward clock step it stays at
  // the latest reading, so an id the cache has already dropped cannot verify again (docs/CONTRACT-gateway.md).
  const o: VerifyOptions = { ...options, nowS: cache.advance(options.nowS) };

  const identity = verifyIdentityHeader(header, rawBody, o);
  if (!identity.ok) return { ok: false, status: 401, reason: identity.reason };

  let message: unknown;
  try {
    message = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, status: 400, reason: "parse" };
  }
  if (Array.isArray(message)) return { ok: false, status: 400, reason: "batch" };

  const bound = checkClaimsAgainstMessage(identity.claims, message);
  if (!bound.ok) return { ok: false, status: 401, reason: bound.reason };

  const { request_id: requestId, exp } = identity.claims;
  if (cache.seen(requestId, o.nowS)) return { ok: false, status: 401, reason: "replayed" };
  // Only now, with every other check passed, does the id enter the replay set.
  cache.remember(requestId, exp, o.nowS);
  return { ok: true, claims: identity.claims, message };
}

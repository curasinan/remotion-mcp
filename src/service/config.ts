/**
 * The service's configuration, read from the environment once at start (design 5.3, the brief's table). Keys come
 * from the environment only. No error here ever prints a variable's value, so a key can never reach a log.
 */

import os from "node:os";
import path from "node:path";

import {
  IDENTITY_MAX_TTL_S, IDENTITY_SKEW_S, RENDER_SLOTS_DEFAULT, RENDER_STILL_DEADLINE_MS, SERVICE_BODY_CAP_BYTES,
  SERVICE_PNG_CAP_BYTES,
} from "./constants.js";

export interface ServiceConfig { host: string; port: number; audience: string; identityKey: Buffer;
  auditKey: Buffer; auditLogPath: string; packDir: string; browserExecutable: string; slots: number;
  skewS: number; bodyCapBytes: number; stillDeadlineMs: number; pngCapBytes: number; tempRoot: string }

/** A configuration the service must not start with. The message names the variable and its rule, never its value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The fewest bytes either HMAC key may decode to. */
const MIN_KEY_BYTES = 32;
/**
 * The throwaway key test/vectors/identity-v1.json publishes (`key_base64url`, 32 bytes of 0x07). Anyone can sign
 * with it, so neither key may be it.
 */
const PUBLISHED_VECTOR_KEY = Buffer.alloc(32, 7);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^\d{1,6}$/;
const MAX_SLOTS = 64;

/** A variable's value, with an empty string counted as unset, as `docker run -e NAME=` leaves it. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}

/**
 * A whole number in `min..max`, written as plain digits, or `fallback` when unset. NaN, 1.5, 1e3, 0x50 and " 80"
 * are refused: a NaN skew would turn the verifier's expiry checks off.
 */
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = read(env, name);
  if (value === undefined) return fallback;
  const parsed = DIGITS.test(value) ? Number(value) : Number.NaN;
  if (!(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max)) {
    throw new ConfigError(`${name} must be a whole number in ${min}..${max}`);
  }
  return parsed;
}

/**
 * An HMAC key: unpadded base64url in its one canonical spelling, decoding to at least 32 bytes. Node's decoder skips
 * characters outside the alphabet and ignores a last character's spare bits, so both are checked before trusting it.
 */
function key(env: NodeJS.ProcessEnv, name: string): Buffer {
  const value = required(env, name);
  const decoded = Buffer.from(value, "base64url");
  if (!BASE64URL.test(value) || decoded.toString("base64url") !== value) {
    throw new ConfigError(`${name} must be unpadded base64url`);
  }
  if (decoded.length < MIN_KEY_BYTES) throw new ConfigError(`${name} must decode to at least ${MIN_KEY_BYTES} bytes`);
  // The decoded bytes, never the spelling.
  if (decoded.equals(PUBLISHED_VECTOR_KEY)) throw new ConfigError(`${name} must not be the published test-vector key`);
  return decoded;
}

/**
 * A path variable, or `fallback` when unset. It must be absolute: preflight checks it from the service's own cwd,
 * while each render's CLI runs with its cwd in the render's work dir, so a relative path would pass one and fail the
 * other.
 */
function absolutePath(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = fallback === undefined ? required(env, name) : read(env, name) ?? fallback;
  if (!path.isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path`);
  return value;
}

/**
 * Whether `inner` is `outer` or lies inside it. Both are resolved first, and path.relative compares them whole
 * segment by whole segment, so `/pack2` is not inside `/pack`.
 */
function within(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The directory renders work in. startService empties it at every start, and an unverified cleanup empties it again,
 * so it must be absolute (a relative one would follow the cwd), never a filesystem root, and never the same as, above
 * or inside PACK_DIR or the audit log's directory: emptying it would delete the pack or the audit log.
 */
function tempRoot(env: NodeJS.ProcessEnv, packDir: string, auditLogPath: string): string {
  const value = read(env, "RENDER_TEMP_ROOT") ?? path.join(os.tmpdir(), "remotion-viz-service");
  if (!path.isAbsolute(value) || path.parse(value).root === path.resolve(value)) {
    throw new ConfigError("RENDER_TEMP_ROOT must be an absolute path that is not a filesystem root");
  }
  const guarded = [["PACK_DIR", packDir], ["the directory of AUDIT_LOG_PATH", path.dirname(auditLogPath)]] as const;
  for (const [name, dir] of guarded) {
    if (within(value, dir) || within(dir, value)) {
      throw new ConfigError(`RENDER_TEMP_ROOT must not be, contain or lie inside ${name}`);
    }
  }
  return value;
}

/** Reads the configuration, or throws a ConfigError naming the first variable that is missing or bad. */
export function parseServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const auditLogPath = absolutePath(env, "AUDIT_LOG_PATH", "/var/log/remotion-viz/service-audit.jsonl");
  const packDir = absolutePath(env, "PACK_DIR", "/pack");
  const host = read(env, "SERVICE_HOST") ?? "0.0.0.0";
  const port = integer(env, "SERVICE_PORT", 8080, 0, 65_535);
  const audience = required(env, "SERVICE_AUDIENCE");
  const identityKey = key(env, "IDENTITY_HMAC_KEY");
  const auditKey = key(env, "AUDIT_HMAC_KEY");
  // Its own key (DEPLOY.md): whoever holds the audit key to check the audit's hashes must not be able to sign
  // identity headers with it.
  if (auditKey.equals(identityKey)) throw new ConfigError("AUDIT_HMAC_KEY must differ from IDENTITY_HMAC_KEY");
  return {
    host,
    port,
    audience,
    identityKey,
    auditKey,
    auditLogPath,
    packDir,
    browserExecutable: absolutePath(env, "BROWSER_EXECUTABLE"),
    slots: integer(env, "RENDER_SLOTS", RENDER_SLOTS_DEFAULT, 1, MAX_SLOTS),
    // Never above the TTL cap: the replay set keeps an id for exp + skew, and the verifier needs a whole number.
    skewS: integer(env, "IDENTITY_SKEW_S", IDENTITY_SKEW_S, 0, IDENTITY_MAX_TTL_S),
    // Constants, never read from the environment, so constants.ts's check that the CLI's --timeout exceeds the
    // deadline keeps holding.
    bodyCapBytes: SERVICE_BODY_CAP_BYTES,
    stillDeadlineMs: RENDER_STILL_DEADLINE_MS,
    pngCapBytes: SERVICE_PNG_CAP_BYTES,
    tempRoot: tempRoot(env, packDir, auditLogPath),
  };
}

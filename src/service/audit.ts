/**
 * The service's own audit (design 5.8): one JSON line per event, at a path the deployer chooses. It records ids,
 * the outcome, the category, the duration, and keyed hashes and sizes of the params and the result. Never a payload,
 * a raw argument value or a verbatim error message. The local-dev audit (src/services/audit.ts) is separate.
 */

import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * One audit line. `params_hash` and `params_bytes` cover `JSON.stringify` of a tool's arguments as the SDK passes
 * them on after zod validation, not as the caller sent them: the schema's keys in the schema's order (for
 * render_still: template_id, frame, props), whatever order the request used. `result_hash` and `result_bytes`
 * cover the decoded image bytes and the UTF-8 text of an ok result, in content order.
 */
export interface ServiceAuditEvent { ts: string; outcome: "ok" | "error" | "refused" | "violation";
  request_id?: string; principal?: string; tenant?: string; tool?: string; category?: string;
  fields?: string[]; http_status?: number; duration_ms?: number;
  params_hash?: string; params_bytes?: number; result_hash?: string; result_bytes?: number }

export interface AuditSink { record(e: ServiceAuditEvent): void;
  /** Hex HMAC-SHA256 of `data` under the sink's key. */
  hash(data: string | Uint8Array): string }

/** A sink appending to `file`. The service's preflight has already checked that `file` can be opened for appending. */
export function createAuditSink(file: string, key: Buffer): AuditSink {
  // A copy, so a caller that later zeroes or reuses its buffer cannot change the key.
  const hmacKey = Buffer.from(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // record() swallows the failure that follows; the preflight is what refuses an unwritable path.
  }
  return {
    record(e) {
      // Auditing must never be the reason a tool call fails.
      try {
        fs.appendFileSync(file, `${JSON.stringify(e)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Swallowed, as src/services/audit.ts does.
      }
    },
    hash(data) {
      return createHmac("sha256", hmacKey).update(data).digest("hex");
    },
  };
}

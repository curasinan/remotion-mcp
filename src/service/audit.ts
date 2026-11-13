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

export interface AuditSinkOptions {
  /** The operator's log, as startService's; stderr when unset. */
  log?: (line: string) => void;
  /** Tests only: the clock the rate limit reads, in milliseconds. */
  nowMs?: () => number;
}

/**
 * The least time between two "append failed" lines. A volume that flips between full and not, under a flood of
 * calls, would otherwise log a line pair per call. A streak that starts sooner is counted, and logged only if it is
 * still failing once the interval has passed.
 */
export const AUDIT_FAILURE_LOG_INTERVAL_MS = 60_000;

/** An error's code, never its message, which names the path. */
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" ? code : "no error code";
}

/**
 * A sink appending to `file`. The service's preflight has already checked that `file` can be opened for appending.
 * A failing append never fails the call, but the operator hears of it: one log line when a streak of failures starts,
 * one when an append works again, saying how many lines were dropped. Both name the variable and the error code, never
 * the path or anything from the audit line. A streak that starts within AUDIT_FAILURE_LOG_INTERVAL_MS of the last
 * "append failed" line is not logged at its start. Its first failing append once the interval has passed logs it; a
 * streak that ends sooner has its dropped lines reported by the first append that works once the interval has passed.
 */
export function createAuditSink(file: string, key: Buffer, options: AuditSinkOptions = {}): AuditSink {
  // A copy, so a caller that later zeroes or reuses its buffer cannot change the key.
  const hmacKey = Buffer.from(key);
  const nowMs = options.nowMs ?? ((): number => performance.now());
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  /** Never throws: diagnostics never decide what a call does. */
  const note = (line: string): void => {
    try {
      log(line);
    } catch {
      // The audit, and the call, go on without it.
    }
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // record() logs the failure that follows; the preflight is what refuses an unwritable path.
  }

  let failing = false;
  /** Whether the current, or the last, streak's start was logged. */
  let logged = false;
  /** Lines dropped since the last recovery line. */
  let dropped = 0;
  let lastFailureLineAt = Number.NEGATIVE_INFINITY;
  const reportDropped = (): void => {
    note(`service: audit: appending to AUDIT_LOG_PATH works again: ${dropped} audit line(s) were dropped`);
    dropped = 0;
  };

  return {
    record(e) {
      try {
        fs.appendFileSync(file, `${JSON.stringify(e)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (err) {
        // Auditing must never be the reason a tool call fails.
        dropped += 1;
        // A streak already logged stays quiet. One the interval held back is logged by its first append once the
        // interval has passed, so the operator's last line never says appends work while they still fail.
        if (failing && logged) return;
        failing = true;
        const now = nowMs();
        logged = now - lastFailureLineAt >= AUDIT_FAILURE_LOG_INTERVAL_MS;
        if (logged) {
          lastFailureLineAt = now;
          note(`service: audit: appending to AUDIT_LOG_PATH failed (${errnoOf(err)}): audit lines are dropped until `
            + "an append succeeds");
        }
        return;
      }
      if (failing) {
        failing = false;
        if (logged) reportDropped();
      } else if (dropped > 0 && nowMs() - lastFailureLineAt >= AUDIT_FAILURE_LOG_INTERVAL_MS) {
        // Streaks the interval held back.
        reportDropped();
      }
    },
    hash(data) {
      return createHmac("sha256", hmacKey).update(data).digest("hex");
    },
  };
}

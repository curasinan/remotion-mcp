/**
 * Durable, size-bounded audit log.
 *
 * The stderr logging in log.ts is captured by the client and not visible to the
 * operator. This persists the same events to a JSONL file the operator (or a
 * dashboard generator) can read back. Two-segment size rotation keeps the total
 * bounded without an O(file) rewrite on every append.
 *
 * The `decision` field is always "observe" today; it is the seam where a future
 * enforcement layer would record "allow"/"block". Free detail lives in `detail`
 * so a future redaction pass (for a hosted deployment) has one place to rewrite.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

export interface AuditEvent {
  ts: string;
  event: "tool_call" | "tool_result" | "tool_rejected" | "tool_failed" | "network_block";
  tool?: string;
  outcome?: "ok" | "error";
  duration_ms?: number;
  decision: "observe" | "allow" | "block";
  category?: string;
  detail?: Record<string, unknown>;
}

const DEFAULT_READ_LIMIT = 5_000;

function segments(): { current: string; previous: string; capPerSegment: number } {
  const config = loadConfig();
  return {
    current: config.auditLogPath,
    previous: `${config.auditLogPath}.1`,
    capPerSegment: Math.floor(config.auditMaxBytes / 2),
  };
}

export function getAuditLogPath(): string {
  return loadConfig().auditLogPath;
}

export function recordAuditEvent(
  event: Omit<AuditEvent, "ts" | "decision"> & { decision?: AuditEvent["decision"] },
): void {
  // Auditing must never be the reason a tool call fails.
  try {
    const record: AuditEvent = { ts: new Date().toISOString(), decision: "observe", ...event };
    const line = `${JSON.stringify(record)}\n`;
    const { current, previous, capPerSegment } = segments();
    fs.mkdirSync(path.dirname(current), { recursive: true });

    let size = 0;
    try {
      size = fs.statSync(current).size;
    } catch {
      size = 0;
    }
    if (size + Buffer.byteLength(line, "utf8") > capPerSegment) {
      try {
        fs.renameSync(current, previous);
      } catch {
        // First rotation ever (current does not exist yet), or the target is
        // locked. Either way, fall through and append to a fresh current.
      }
    }
    fs.appendFileSync(current, line, "utf8");
  } catch {
    // Swallow: logging must never break a tool call.
  }
}

export function readAuditEvents(limit = DEFAULT_READ_LIMIT): AuditEvent[] {
  const { current, previous } = segments();
  const lines: string[] = [];
  for (const seg of [previous, current]) {
    try {
      lines.push(...fs.readFileSync(seg, "utf8").split("\n").filter((line) => line.trim() !== ""));
    } catch {
      // Segment absent; nothing to add.
    }
  }
  const events: AuditEvent[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // Skip a corrupt line (e.g. a write torn by a crash mid-append).
    }
  }
  return events;
}

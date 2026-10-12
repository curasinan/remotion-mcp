/** Durable JSONL audit log with two-segment size rotation. */

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
        // No current segment yet, or target locked; append to current anyway.
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

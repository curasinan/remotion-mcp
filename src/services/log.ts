/**
 * Structured logging and a tool-call audit trail.
 *
 * Everything goes to stderr as one JSON object per line. stdout carries the
 * JSON-RPC stream and must stay clean, and one-object-per-line is what log
 * collectors expect. There was no audit trail before: nothing recorded which
 * tool ran, with what, or how it ended, so an incident had nothing to read.
 *
 * Arguments are summarised, not dumped. props_json and svg/html source can be
 * large and can carry content the operator has no reason to keep verbatim in a
 * log; recording their size is enough to reconstruct what happened.
 */

interface LogFields {
  [key: string]: unknown;
}

function emit(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const record = { level, event, ...fields };
  // A logger must never be the reason a tool call fails.
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Give up silently rather than throw out of a finally block.
  }
}

export const log = {
  info: (event: string, fields: LogFields = {}): void => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}): void => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}): void => emit("error", event, fields),
};

/**
 * Reduce a tool's arguments to something safe and small to log.
 *
 * Scalars are kept; long strings become a length so their content never lands
 * in the log; objects and arrays are noted by shape.
 */
export function summariseArguments(input: unknown): LogFields {
  if (input === null || typeof input !== "object") return { value: describe(input) };
  const summary: LogFields = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    summary[key] = describe(value);
  }
  return summary;
}

function describe(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 64 ? `<string:${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (value !== null && typeof value === "object") return "<object>";
  return value;
}

/** Structured JSON-lines logging to stderr, since stdout carries the JSON-RPC stream. */

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

/** Reduces tool arguments to a small, content-free summary for logging. */
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

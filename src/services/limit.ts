/**
 * Concurrency limits for the expensive paths.
 *
 * MCP clients batch tool calls, and nothing serialised them: the stdio
 * transport dispatches each incoming request without awaiting the last, so five
 * concurrent viz_render_html calls launched five browsers. Measured, that was
 * 50 extra chrome processes and 34 s of wall clock for work that takes about
 * two seconds serially.
 *
 * Requests wait for a slot rather than failing immediately, because a model
 * batching three renders wants three images, not two errors. The queue is
 * bounded, though: past that depth the honest answer is that the server is
 * saturated, and saying so beats holding a request until the client gives up.
 */

import { ToolInputError } from "../types.js";

export interface LimiterOptions {
  /** How many may run at once. */
  concurrency: number;
  /** How many may wait. Beyond this, callers are refused. */
  queueDepth: number;
  /** Used in the refusal message, e.g. "HTML screenshot". */
  label: string;
}

export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly options: LimiterOptions) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.options.concurrency) {
      if (this.waiting.length >= this.options.queueDepth) {
        throw new ToolInputError(
          `Too many ${this.options.label} operations are already in flight (${this.active} running, ${this.waiting.length} queued).`,
          "Wait for the current ones to finish and try again. Running these in parallel is slower than running them one at a time, because each one already uses the whole machine.",
        );
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  /** Exposed for tests and diagnostics. */
  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }
}

/**
 * One browser at a time. Chrome sizes itself to the machine, so a second
 * concurrent instance competes with the first rather than adding throughput.
 */
export const browserLimiter = new Limiter({
  concurrency: 1,
  queueDepth: 4,
  label: "HTML screenshot",
});

/**
 * Remotion renders are already internally parallel - the CLI takes its own
 * --concurrency and spawns a browser per worker - so this bounds how many of
 * those fleets exist, not how many cores are used.
 */
export const cliLimiter = new Limiter({
  concurrency: 2,
  queueDepth: 6,
  label: "Remotion CLI",
});

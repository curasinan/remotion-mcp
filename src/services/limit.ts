/** Bounded-queue concurrency limits for browser and Remotion CLI work. */

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
          "concurrency",
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

/** One browser at a time; a second Chrome instance competes rather than adds throughput. */
export const browserLimiter = new Limiter({
  concurrency: 1,
  queueDepth: 4,
  label: "HTML screenshot",
});

/** Bounds concurrent Remotion CLI runs, each of which is already internally parallel. */
export const cliLimiter = new Limiter({
  concurrency: 2,
  queueDepth: 6,
  label: "Remotion CLI",
});

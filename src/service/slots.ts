/**
 * Render slots: one global count of running renders, with no queue (design 5.5 step 2, ADR-7). A render
 * holds its slot until every process it started is gone, so the caller releases it from `cleanup`.
 */
export class RenderSlots {
  readonly #capacity: number;
  #inUse = 0;
  #drainWaiters: (() => void)[] = [];

  constructor(capacity: number) {
    // NaN would never compare as full, so every render would be admitted.
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RenderSlots: capacity must be a whole number >= 1, got ${String(capacity)}`);
    }
    this.#capacity = capacity;
  }

  /** Takes a slot, or returns null when none is free. The release frees it once; later calls do nothing. */
  tryAcquire(): (() => void) | null {
    if (this.#inUse >= this.#capacity) return null;
    this.#inUse += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#inUse -= 1;
      if (this.#inUse === 0) {
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  get inUse(): number {
    return this.#inUse;
  }

  /** Resolves when no slot is held: at once if none is, otherwise when the last one is released. */
  drained(): Promise<void> {
    if (this.#inUse === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }
}

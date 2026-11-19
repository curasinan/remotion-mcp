/** The service's one reading of the wall clock, shared by start.ts and http.ts. */

/** Whole seconds of the wall clock, as the gateway signs `iat` and `exp`. */
export const wallClockS = (): number => Math.floor(Date.now() / 1000);

/** The `remotion still` argv, shared by the local-dev tool and the service profile. */

import { assertSafePositional } from "./exec.js";

export interface StillArgvOptions {
  source: string;             // entry point (local-dev) or bundle dir (service); positional
  compositionId: string;      // positional
  output: string;             // positional, relative to the CLI's cwd
  frame: number;
  scale?: number;
  propsJson?: string;         // local-dev only: --props=<json>
  propsFile?: string;         // service only:   --props=<file>
  width?: number;             // service: --width=
  height?: number;            // service: --height=
  browserExecutable?: string; // service: --browser-executable=
  timeoutMs?: number;         // service: --timeout= (Remotion's Node-side wait); integer 7000..2147483647
}

/** Smallest `--timeout` accepted, in milliseconds. */
const MIN_TIMEOUT_MS = 7_000;

/** Largest `--timeout` accepted: Node's timer ceiling, 2^31 - 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * No caller argument reaches these checks, only a bug in the calling code, so a broken one
 * throws a plain Error. A ToolInputError would report the bug as a caller refusal.
 */
function invariant(holds: boolean, rule: string): void {
  if (!holds) throw new Error(`buildStillArgv invariant broken: ${rule}.`);
}

/** A size the CLI reads as a plain positive integer; 1e21 would print as `1e+21`. */
function isPositiveSafeInteger(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** Builds the argv after `cli.prefixArgs`; service options follow `--log` and `--props`. */
export function buildStillArgv(o: StillArgvOptions): string[] {
  assertSafePositional(o.source, "entry point or bundle");
  assertSafePositional(o.compositionId, "composition id");
  assertSafePositional(o.output, "output path");

  invariant(o.propsJson === undefined || o.propsFile === undefined,
    "propsJson and propsFile are mutually exclusive");
  // Negative frames stay allowed: local-dev documents -1 as the last frame.
  invariant(Number.isInteger(o.frame), "frame must be an integer");
  invariant(o.width === undefined || isPositiveSafeInteger(o.width),
    "width must be a positive integer");
  invariant(o.height === undefined || isPositiveSafeInteger(o.height),
    "height must be a positive integer");
  const timeoutOk = o.timeoutMs === undefined
    || (Number.isInteger(o.timeoutMs) && o.timeoutMs >= MIN_TIMEOUT_MS && o.timeoutMs <= MAX_TIMEOUT_MS);
  invariant(timeoutOk, `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);

  const args = ["still", o.source, o.compositionId, o.output, `--frame=${o.frame}`];
  if (o.scale !== undefined) args.push(`--scale=${o.scale}`);
  args.push("--image-format=png", "--overwrite", "--log=info");

  if (o.propsJson !== undefined) args.push(`--props=${o.propsJson}`);
  if (o.propsFile !== undefined) args.push(`--props=${o.propsFile}`);
  if (o.width !== undefined) args.push(`--width=${o.width}`);
  if (o.height !== undefined) args.push(`--height=${o.height}`);
  if (o.browserExecutable !== undefined) args.push(`--browser-executable=${o.browserExecutable}`);
  if (o.timeoutMs !== undefined) args.push(`--timeout=${o.timeoutMs}`);
  return args;
}

/** The `remotion still` argv, shared by the local-dev tool and the service profile. */

import { assertSafePositional } from "./exec.js";
import { ToolInputError } from "../types.js";

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
  timeoutMs?: number;         // service: --timeout= (Remotion's Node-side wait); integer >= 7000
}

/** Smallest `--timeout` accepted, in milliseconds. */
const MIN_TIMEOUT_MS = 7_000;

/** Builds the argv after `cli.prefixArgs`; service options follow `--log` and `--props`. */
export function buildStillArgv(o: StillArgvOptions): string[] {
  assertSafePositional(o.source, "entry point or bundle");
  assertSafePositional(o.compositionId, "composition id");
  assertSafePositional(o.output, "output path");

  if (o.propsJson !== undefined && o.propsFile !== undefined) {
    throw new ToolInputError(
      "Props were given both inline and as a file.",
      "Pass propsJson or propsFile, not both.",
    );
  }
  if (o.timeoutMs !== undefined && (!Number.isInteger(o.timeoutMs) || o.timeoutMs < MIN_TIMEOUT_MS)) {
    throw new ToolInputError(
      `The render timeout must be a whole number of milliseconds, at least ${MIN_TIMEOUT_MS}.`,
      `Pass an integer timeoutMs of ${MIN_TIMEOUT_MS} or more.`,
    );
  }

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

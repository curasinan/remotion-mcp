/** Zod fragments reused across tool input schemas. */

import { z } from "zod";
import { ResponseFormat } from "../types.js";

/** Rejects paths with a segment starting with "-", which the Remotion CLI would parse as an option. */
export function hasNoFlagLikeSegment(value: string): boolean {
  return !value.split(/[/]/).some((segment) => segment.startsWith("-"));
}

export const FLAG_LIKE_MESSAGE =
  "No part of the path may begin with '-'. The Remotion CLI would read it as a command-line option instead of a path.";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable");

export const projectDirField = z
  .string()
  .min(1)
  .max(500)
  .refine(hasNoFlagLikeSegment, FLAG_LIKE_MESSAGE)
  .default(".")
  .describe(
    "Remotion project directory, relative to the workspace root (e.g. 'tactics-video'). Defaults to the workspace root itself.",
  );

export const entryPointField = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/,
    "entry_point may contain only letters, digits, dot, underscore, hyphen and path separators, and may not begin with '-' or a separator",
  )
  .refine(hasNoFlagLikeSegment, FLAG_LIKE_MESSAGE)
  .optional()
  .describe(
    "Entry point relative to project_dir (e.g. 'src/index.ts'). Omit to auto-detect; auto-detection tries src/index.ts, src/index.tsx, remotion/index.ts and a few others.",
  );

export const compositionIdField = z
  .string()
  .min(1, "composition_id is required")
  .max(200)
  .regex(
    /^[A-Za-z0-9._][A-Za-z0-9._-]*$/,
    "composition_id may contain only letters, digits, dot, underscore and hyphen, and may not begin with a hyphen",
  )
  .refine(
    (id) => id !== "." && id !== "..",
    "composition_id may not be '.' or '..'",
  )
  .describe("Composition id as registered in Root.tsx, e.g. 'HaramballDefense'");

export const propsJsonField = z
  .string()
  .max(200_000)
  .optional()
  .describe(
    'Input props as a serialized JSON object, e.g. \'{"team":"home","speed":2}\'. Must parse as JSON.',
  );

/** An output file path relative to the workspace root, with the argv-safety check applied. */
export function outputPathField(description: string) {
  return z
    .string()
    .min(1)
    .max(500)
    .refine(hasNoFlagLikeSegment, FLAG_LIKE_MESSAGE)
    .describe(description);
}

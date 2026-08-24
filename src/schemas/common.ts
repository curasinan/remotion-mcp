/**
 * Zod fragments reused across tool input schemas.
 */

import { z } from "zod";
import { ResponseFormat } from "../types.js";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable");

export const projectDirField = z
  .string()
  .min(1)
  .max(500)
  .default(".")
  .describe(
    "Remotion project directory, relative to the workspace root (e.g. 'tactics-video'). Defaults to the workspace root itself.",
  );

export const entryPointField = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe(
    "Entry point relative to project_dir (e.g. 'src/index.ts'). Omit to auto-detect; auto-detection tries src/index.ts, src/index.tsx, remotion/index.ts and a few others.",
  );

export const compositionIdField = z
  .string()
  .min(1, "composition_id is required")
  .max(200)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "composition_id may contain only letters, digits, dot, underscore and hyphen",
  )
  .describe("Composition id as registered in Root.tsx, e.g. 'HaramballDefense'");

export const propsJsonField = z
  .string()
  .max(200_000)
  .optional()
  .describe(
    'Input props as a serialized JSON object, e.g. \'{"team":"home","speed":2}\'. Must parse as JSON.',
  );

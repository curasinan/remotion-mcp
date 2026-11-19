/** Entry-point resolution for a Remotion project, shared by both tool profiles. */

import fs from "node:fs";
import path from "node:path";
import { findEntryPoint } from "./environment.js";
import { assertSafePositional } from "./exec.js";
import { displayPath, resolveInWorkspace } from "./paths.js";
import { ToolInputError } from "../types.js";

/** Resolve the entry point for a project, or explain why it could not be found. */
export function requireEntryPoint(projectDir: string, explicit?: string): string {
  if (explicit) {
    const absolute = resolveInWorkspace(path.join(displayPath(projectDir), explicit));
    if (!fs.existsSync(absolute)) {
      throw new ToolInputError(
        `Entry point '${explicit}' does not exist inside the project.`,
        `Looked at '${displayPath(absolute)}'. Call remotion_check_environment to see which entry points were auto-detected.`,
      );
    }
    assertSafePositional(explicit, "entry point");
    return explicit;
  }

  const detected = findEntryPoint(projectDir);
  if (!detected) {
    throw new ToolInputError(
      "No Remotion entry point could be auto-detected.",
      "Create src/index.ts containing `registerRoot(RemotionRoot)`, or pass entry_point explicitly.",
    );
  }
  assertSafePositional(detected, "entry point");
  return detected;
}

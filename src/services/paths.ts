/** Path resolution confined to the configured workspace root. */

import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "../constants.js";
import { ToolInputError } from "../types.js";

const REAL_WORKSPACE_ROOT: string = (() => {
  try {
    return fs.realpathSync(path.resolve(WORKSPACE_ROOT));
  } catch {
    return path.resolve(WORKSPACE_ROOT);
  }
})();

export function getWorkspaceRoot(): string {
  return REAL_WORKSPACE_ROOT;
}

/** Resolves `candidate` in the workspace, following existing symlinks, and rejects escapes. */
export function resolveInWorkspace(candidate: string): string {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new ToolInputError(
      "Path is empty.",
      "Pass a path relative to the workspace root, for example 'my-video' or 'my-video/src/index.ts'.",
    );
  }

  if (candidate.includes("\0")) {
    throw new ToolInputError(
      "Path contains a null byte.",
      "Remove the null byte from the path argument.",
      "path_traversal",
    );
  }

  const absolute = path.resolve(REAL_WORKSPACE_ROOT, candidate);
  const canonical = canonicalizeExistingPrefix(absolute);
  const relative = path.relative(REAL_WORKSPACE_ROOT, canonical);

  const escapes =
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);

  if (escapes) {
    throw new ToolInputError(
      `Path '${candidate}' resolves outside the workspace root.`,
      `The workspace root is '${REAL_WORKSPACE_ROOT}'. Either pass a path inside it, or restart the server with REMOTION_MCP_WORKSPACE set to a directory that contains your project.`,
      "path_traversal",
    );
  }

  return canonical;
}

/** Resolve the longest existing prefix through symlinks, then re-append the rest. */
function canonicalizeExistingPrefix(absolute: string): string {
  let existing = absolute;
  const trailing: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    return path.join(fs.realpathSync(existing), ...trailing);
  } catch {
    return absolute;
  }
}

/** Resolve a path that must already exist and be a directory. */
export function resolveExistingDirectory(candidate: string): string {
  const resolved = resolveInWorkspace(candidate);
  if (!fs.existsSync(resolved)) {
    throw new ToolInputError(
      `Directory '${candidate}' does not exist.`,
      `Resolved to '${displayPath(resolved)}' inside the workspace. Create it first, or call remotion_init_project to scaffold a new Remotion project there.`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new ToolInputError(
      `'${candidate}' is a file, not a directory.`,
      "Pass the project directory, not a file inside it.",
    );
  }
  return resolved;
}

/** Creates an output file's parent directory, then re-checks it is inside the workspace. */
export function ensureParentDirectory(filePath: string): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });

  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync(parent);
  } catch {
    // Cannot be resolved: refuse rather than write somewhere unverified.
    throw new ToolInputError(
      `The directory for '${displayPath(filePath)}' could not be resolved.`,
      "Check that the path is writable and does not contain a broken link.",
      "path_traversal",
    );
  }

  const relative = path.relative(REAL_WORKSPACE_ROOT, canonicalParent);
  const escapes =
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);

  if (escapes) {
    throw new ToolInputError(
      `The directory for '${displayPath(filePath)}' resolves outside the workspace root.`,
      `It points at '${canonicalParent}'. A link in the path leads out of '${REAL_WORKSPACE_ROOT}'.`,
      "path_traversal",
    );
  }
}

/** Display a path relative to the workspace root when possible. */
export function displayPath(absolute: string): string {
  const relative = path.relative(REAL_WORKSPACE_ROOT, absolute);
  return relative === "" ? "." : relative;
}

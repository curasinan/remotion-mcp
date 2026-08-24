/**
 * Path resolution confined to the configured workspace root.
 *
 * Every filesystem argument that reaches a tool handler passes through here.
 * This is the single choke point that prevents an argument like
 * "../../../etc/passwd" from escaping the directory the user opted into.
 */

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

/**
 * Resolve `candidate` against the workspace root and assert it stays inside.
 * Symlinks are resolved for path components that already exist, so a symlink
 * pointing outside the workspace is rejected rather than silently followed.
 */
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
      `Resolved to '${resolved}'. Create it first, or call remotion_init_project to scaffold a new Remotion project there.`,
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

/** Ensure the parent directory of an output file exists. */
export function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Display a path relative to the workspace root when possible. */
export function displayPath(absolute: string): string {
  const relative = path.relative(REAL_WORKSPACE_ROOT, absolute);
  return relative === "" ? "." : relative;
}

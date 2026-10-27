/**
 * The file-level rules of scripts/build-pack.mjs (docs/CONTRACT-pack.md): the pack's hash, where package.json puts
 * Remotion, and which output dir build-pack may replace. They live here, not in the CLI, so tests can import them
 * without running a build.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** What build-pack writes into the output dir; an existing output dir may hold nothing else, as it is replaced. */
const OUTPUTS = new Set(["pack-manifest.json", "bundle", "package.json", "package-lock.json"]);

/** A failure that names every problem found; build-pack prints each on its own line and exits 1. */
export class PackBuildError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "PackBuildError";
    this.problems = problems;
  }
}

/** Throws a PackBuildError naming `problems`. */
export function fail(...problems) {
  throw new PackBuildError(problems);
}

/**
 * `sha256:` and the hex SHA-256 over every file under `dir`: for each, sorted by its relative path (`/`-separated,
 * compared by UTF-16 code unit, never by locale), the path, a NUL, the byte length, a NUL, then the bytes. The
 * lengths make the framing unambiguous. Anything that is neither a file nor a directory is refused.
 */
export function hashBundle(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.push([childRel, childAbs]);
      else fail(`bundle/${childRel}: neither a file nor a directory`);
    }
  };
  walk(dir, "");
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = crypto.createHash("sha256");
  for (const [rel, abs] of files) {
    const bytes = fs.readFileSync(abs);
    hash.update(`${rel}\0${bytes.length}\0`, "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Where package.json puts the packages the derived image needs at runtime. It installs with `npm ci --omit=dev`,
 * and the service runs the pack's own CLI and renderer, so remotion and every @remotion/* package belong under
 * dependencies, and @remotion/cli and @remotion/renderer must be there.
 */
export function dependencyProblems(pkg) {
  const dependencies = pkg.dependencies ?? {};
  const isRemotion = (name) => name === "remotion" || name.startsWith("@remotion/");
  const names = new Set(["@remotion/cli", "@remotion/renderer",
    ...Object.keys(pkg.devDependencies ?? {}).filter(isRemotion)]);
  return [...names].filter((name) => !Object.hasOwn(dependencies, name))
    .map((name) => `package.json: ${name} must be under dependencies (the derived image runs npm ci --omit=dev)`);
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Empties the output dir, or creates it. It is replaced wholesale, so it must not be the project dir or contain it,
 * and an existing one may hold only what build-pack writes: a mistyped --out never removes anything else.
 */
export function prepareOutDir(outDir, projectDir) {
  if (isInside(projectDir, outDir)) fail(`output dir ${outDir}: must not be the project dir or contain it`);
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) fail(`output dir ${outDir}: exists and is not a directory`);
    const strangers = fs.readdirSync(outDir).filter((name) => !OUTPUTS.has(name));
    if (strangers.length > 0) {
      fail(`output dir ${outDir}: holds ${strangers.join(", ")}, which build-pack did not write; remove it or choose another --out`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
}

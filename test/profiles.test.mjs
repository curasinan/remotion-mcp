// The stdio build must never contain service-profile or gateway code; see ADR-4.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const REPO = path.join(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist");
const SRC = path.join(REPO, "src");

// The trees that belong to the HTTP service profile and must stay out of dist/.
const FORBIDDEN_SEGMENTS = ["service", "gateway"];

/** Every path under dir, relative to it, with forward slashes. */
function walk(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    return d.isDirectory() ? [rel, ...walk(path.join(dir, d.name), rel)] : [rel];
  });
}

/**
 * The src/ modules tsc would compile, and so emit, for a program rooted at entry
 * alone, as paths relative to src/. Asks the compiler rather than parsing
 * imports: it ignores import-shaped text inside strings, and it counts
 * type-only imports, whose targets tsc still puts in the program and emits.
 */
function importClosure(entry) {
  const configPath = path.join(REPO, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, REPO);
  const program = ts.createProgram({ rootNames: [entry], options });
  const srcPrefix = SRC.split(path.sep).join("/") + "/";
  return program.getSourceFiles()
    .map((f) => f.fileName)
    .filter((f) => f.startsWith(srcPrefix))
    .map((f) => f.slice(srcPrefix.length))
    .sort();
}

test("the stdio build excludes the service and gateway trees", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "tsconfig.json"), "utf8"));
  for (const glob of ["src/service/**", "gateway/**"]) {
    assert.ok(cfg.exclude?.includes(glob),
      `tsconfig.json does not exclude '${glob}' (exclude is ${JSON.stringify(cfg.exclude)}). `
      + "Without it the stdio build compiles that tree into dist/, and scripts/build-bundle.mjs "
      + "copies dist/ into the .mcpb wholesale.");
  }
});

test("dist/ contains no service or gateway output", () => {
  assert.ok(fs.existsSync(path.join(DIST, "index.js")),
    "dist/index.js does not exist, so there is no build to check. Run `npm run build` first; "
    + "a missing build must not pass this test.");
  const paths = walk(DIST);

  // Positive control: a walker that does not recurse would pass the check below vacuously.
  assert.ok(paths.includes("services/paths.js"),
    `the walk of dist/ did not reach services/paths.js (found ${paths.length} paths), so it is not `
    + "recursing and the check below is inert.");

  // Compare the name before its first dot, so dist/service/, dist/gateway.js and
  // dist/service.d.ts all count, while the existing dist/services/ does not.
  const offenders = paths.filter((p) =>
    p.split("/").some((segment) => FORBIDDEN_SEGMENTS.includes(segment.split(".")[0])));
  assert.deepEqual(offenders, [],
    `the stdio build emitted service-profile or gateway output: ${offenders.join(", ")}. `
    + "That code would ship in the .mcpb and fail test/bundle.test.mjs's \"the server ships no "
    + "HTTP transport\". Check tsconfig.json's exclude, and that nothing under src/ outside "
    + "src/service/ imports from it. If the build was clean, delete dist/ and rebuild: tsc "
    + "never removes stale output.");
});

test("entrypoint.ts is a leaf: nothing in its import closure is under src/tools/", () => {
  const entry = path.join(SRC, "services", "entrypoint.ts");
  assert.ok(fs.existsSync(entry),
    "src/services/entrypoint.ts does not exist: requireEntryPoint has not been lifted out of "
    + "src/tools/project.ts, so the service profile cannot reuse it without compiling "
    + "remotion_init_project and remotion_list_compositions into its build.");

  // Positive control: from the stdio root the walker must reach a tool module, or it is inert.
  const fromRoot = importClosure(path.join(SRC, "index.ts"));
  assert.ok(fromRoot.includes("tools/project.ts"),
    `the import walk from src/index.ts did not reach tools/project.ts (found ${fromRoot.join(", ")}), `
    + "so it is not following imports and the check below proves nothing.");

  const reached = importClosure(entry);
  const offenders = reached.filter((p) => p.startsWith("tools/"));
  assert.deepEqual(offenders, [],
    `src/services/entrypoint.ts reaches ${offenders.join(", ")} through its imports `
    + `(closure: ${reached.join(", ")}). Anything that imports it would compile those tool `
    + "modules, and their registerTool calls, into the service build.");
});

test("render.ts reaches no other tool module", () => {
  // render.ts imported requireEntryPoint from project.ts, dragging two forbidden tools into any reuse.
  const reached = importClosure(path.join(SRC, "tools", "render.ts"));
  const others = reached.filter((p) => p.startsWith("tools/") && p !== "tools/render.ts");
  assert.deepEqual(others, [],
    `src/tools/render.ts reaches ${others.join(", ")} through its imports. It should take `
    + "requireEntryPoint from src/services/entrypoint.ts, not from src/tools/project.ts.");
});

test("project.ts re-exports the one requireEntryPoint rather than a copy", async () => {
  const leafJs = path.join(DIST, "services", "entrypoint.js");
  assert.ok(fs.existsSync(leafJs),
    "dist/services/entrypoint.js does not exist. Run `npm run build`, or the function has not been lifted.");
  // pathToFileURL, not a bare path: import() of a Windows absolute path throws.
  const leaf = await import(pathToFileURL(leafJs).href);
  const tools = await import(pathToFileURL(path.join(DIST, "tools", "project.js")).href);
  assert.equal(typeof leaf.requireEntryPoint, "function", "dist/services/entrypoint.js exports no requireEntryPoint");
  assert.equal(tools.requireEntryPoint, leaf.requireEntryPoint,
    "src/tools/project.ts exports a different requireEntryPoint from the leaf's. Two copies "
    + "means two argv-injection guards that can drift apart; re-export the leaf's instead.");
});

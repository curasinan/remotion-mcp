// The stdio build must never contain service-profile or gateway code; see ADR-4.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO = path.join(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist");

// The trees that belong to the HTTP service profile and must stay out of dist/.
const FORBIDDEN_SEGMENTS = ["service", "gateway"];

/** Every path under dir, relative to it, with forward slashes. */
function walk(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    return d.isDirectory() ? [rel, ...walk(path.join(dir, d.name), rel)] : [rel];
  });
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

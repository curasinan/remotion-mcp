/**
 * Fail the build when the distributable grows unexpectedly.
 *
 * The number this protects is not aesthetic: NATIVE_TARGETS in build-bundle.mjs
 * fetches six platform binaries, and the two musl entries are commented out
 * behind a deliberate ~8 MB decision. A gate here means that decision gets made
 * again explicitly rather than discovered in a release.
 */
import fs from "node:fs";
import path from "node:path";

const baselinePath = new URL("./bundle-size-baseline.json", import.meta.url);
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

// Look for every .mcpb in cwd, not just the first. build-bundle.mjs names its
// output deterministically from manifest.json (`${name}-${version}.mcpb`), so a
// clean build only ever leaves one behind. But this script also runs by hand
// against a working tree that isn't clean - a bundle from a version that was
// since bumped, left over from an earlier local build, is exactly the kind of
// file readdirSync().find() would silently pick if it happened to sort first.
// That would measure the wrong file and pass or fail for the wrong reason, so
// ambiguity is treated as a hard failure instead of a guess.
const candidates = fs
  .readdirSync(process.cwd(), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".mcpb"))
  .map((e) => e.name);

if (candidates.length === 0) {
  console.error("No .mcpb in the working directory. Run `npm run bundle` first.");
  process.exit(1);
}
if (candidates.length > 1) {
  console.error(
    `Found ${candidates.length} .mcpb files in the working directory, can't tell which one to measure:\n` +
      candidates.map((n) => `  ${n}`).join("\n") +
      `\n\nRemove the stale one(s) - likely left over from a build at a different version - and re-run.`,
  );
  process.exit(1);
}
const bundle = candidates[0];

const bytes = fs.statSync(path.resolve(bundle)).size;
const ceiling = Math.round(baseline.bytes * (1 + baseline.tolerancePercent / 100));
const mib = (n) => (n / 1048576).toFixed(2) + " MiB";

console.log(`bundle   ${bundle}  ${mib(bytes)}`);
console.log(`baseline ${baseline.file}  ${mib(baseline.bytes)}  (recorded ${baseline.recordedAt})`);
console.log(`ceiling  ${mib(ceiling)}  (+${baseline.tolerancePercent}%)`);

if (bytes > ceiling) {
  console.error(
    `\nBundle exceeded the ceiling by ${mib(bytes - ceiling)}.\n` +
      `If the growth is intended - enabling the musl targets, for example - update\n` +
      `scripts/bundle-size-baseline.json in the same commit and say why.`,
  );
  process.exit(1);
}
console.log("\nWithin budget.");

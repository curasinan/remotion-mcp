// Fails when the .mcpb exceeds the size in scripts/bundle-size-baseline.json plus tolerance.
import fs from "node:fs";
import path from "node:path";

const baselinePath = new URL("./bundle-size-baseline.json", import.meta.url);
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

// Fail rather than guess when the working directory holds more than one .mcpb.
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

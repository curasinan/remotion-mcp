/**
 * Write one version into every file that must state it.
 *
 * package.json, manifest.json and src/constants.ts SERVER_VERSION are three
 * statements of one fact. test/unit.test.mjs fails on drift and
 * scripts/build-bundle.mjs refuses to build on it, so a release tool that
 * updates one of them produces an unbuildable tag.
 *
 * Validates everything before writing anything: a half-applied version bump is
 * worse than a refused one.
 */
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`Expected a bare semver like 1.2.3, got '${version ?? ""}'.`);
  process.exit(1);
}

const cwd = process.cwd();
const pkgPath = path.join(cwd, "package.json");
const manifestPath = path.join(cwd, "manifest.json");
const constantsPath = path.join(cwd, "src", "constants.ts");

const constants = fs.readFileSync(constantsPath, "utf8");
const pattern = /(export const SERVER_VERSION = ")([^"]+)(";)/;
if (!pattern.test(constants)) {
  console.error(
    `${constantsPath} has no 'export const SERVER_VERSION = "..."' line.\n` +
      `Refusing rather than skipping it: a silent skip here ships a version mismatch.`,
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

pkg.version = version;
manifest.version = version;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(constantsPath, constants.replace(pattern, `$1${version}$3`));

console.log(`version ${version} written to package.json, manifest.json, src/constants.ts`);

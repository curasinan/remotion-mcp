// Writes one version to package.json, manifest.json, package-lock.json and src/constants.ts.
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
const lockPath = path.join(cwd, "package-lock.json");
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

if (!fs.existsSync(lockPath)) {
  console.error(
    `${lockPath} does not exist.\n` +
      `Refusing rather than skipping it: a lockfile left at the previous version means every\n` +
      `checkout of the released tag carries a lockfile that disagrees with the package it locks.`,
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

// npm 7+ also stores the root version in packages[""]; refuse a packages map without it.
if (lock.packages && !lock.packages[""]) {
  console.error(
    `${lockPath} has a packages map but no packages[""] root entry.\n` +
      `npm always writes both; refusing to half-sync a mangled lockfile. Regenerate it with npm install.`,
  );
  process.exit(1);
}

pkg.version = version;
manifest.version = version;
lock.version = version;
if (lock.packages) lock.packages[""].version = version;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
fs.writeFileSync(constantsPath, constants.replace(pattern, `$1${version}$3`));

console.log(`version ${version} written to package.json, manifest.json, package-lock.json, src/constants.ts`);

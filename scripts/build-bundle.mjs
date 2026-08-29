#!/usr/bin/env node
/**
 * Build the distributable .mcpb bundle, reproducibly.
 *
 * This is the step that produced remotion-viz-1.0.0.mcpb, written down. It was a
 * manual sequence living in one person's shell history: stage a directory, fetch
 * every platform's @resvg/resvg-js prebuilt, then `mcpb pack`. Nothing in version
 * control produced it, so nothing verified it either — the shipped 1.0.0 bundle
 * still carries @hono/node-server, a dependency ADR-1 removed.
 *
 * Why the packer and not `zip`: the mcpb CLI validates manifest.json against the
 * bundle spec. A hand-rolled zip would produce an artifact that looks right and
 * fails at install time on a user's machine. If the packer is unavailable this
 * script fails; it never falls back.
 *
 * Why every platform's native binary: @resvg/resvg-js resolves its .node addon
 * through optionalDependencies, so `npm ci` on the build host installs exactly
 * ONE platform. A bundle built that way loads only on machines matching the
 * builder. The six below are what manifest.json's compatibility.platforms claims.
 *
 * Usage:
 *   node scripts/build-bundle.mjs [--allow-version-drift] [--out <file>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Extract an npm tarball, stripping its leading `package/`.
 *
 * Done in-process rather than by shelling out to tar. GNU tar as shipped with Git
 * Bash reads an absolute Windows path as a remote host spec and fails with
 * "Cannot connect to C: resolve failed"; bsdtar wants different flags again. A
 * 40-line ustar reader has no platform variance at all, and this script has to
 * produce identical output on the three platforms the bundle targets.
 */
function extractNpmTarball(tgzPath, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const written = [];
  let offset = 0;
  let pendingLongName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;                       // end-of-archive
    const rawName = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeField = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const body = buf.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") { pendingLongName = body.toString("utf8").replace(/\0.*$/, ""); continue; }
    if (type === "x" || type === "g") {                            // PAX header
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"));
      if (m) pendingLongName = m[1];
      continue;
    }
    let name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    if (type !== "0" && type !== "\0" && type !== "5") continue;   // skip links/devices

    const rel = name.replace(/^package\//, "");                    // strip npm's wrapper
    if (!rel || rel !== path.normalize(rel).split(path.sep).join("/") || rel.startsWith("..")) {
      throw new Error(`refusing to extract suspicious tar entry '${name}'`);
    }
    const dest = path.join(destDir, rel);
    if (type === "5") { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    written.push(rel);
  }
  if (written.length === 0) throw new Error(`tarball ${path.basename(tgzPath)} contained no files`);
  return written;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(REPO, "build");

/**
 * Every platform whose prebuilt must be in the bundle.
 *
 * Deliberately duplicated in test/bundle.test.mjs rather than shared: if these two
 * lists drift, that is a change to what ships on which machines, and it should
 * fail a test rather than be absorbed silently by a common import.
 */
const NATIVE_TARGETS = [
  "@resvg/resvg-js-win32-x64-msvc",
  "@resvg/resvg-js-win32-arm64-msvc",
  "@resvg/resvg-js-darwin-x64",
  "@resvg/resvg-js-darwin-arm64",
  "@resvg/resvg-js-linux-x64-gnu",
  "@resvg/resvg-js-linux-arm64-gnu",
  // Alpine/musl. manifest.json claims "linux" unqualified, which these two would
  // make true. Enabling them adds ~8 MB. See test "linux claim does not silently
  // exclude musl" — either turn these on or narrow the manifest's claim.
  // "@resvg/resvg-js-linux-x64-musl",
  // "@resvg/resvg-js-linux-arm64-musl",
];

const argv = process.argv.slice(2);
const allowVersionDrift = argv.includes("--allow-version-drift");
const outFlag = argv.indexOf("--out");

const log = (m) => process.stdout.write(`${m}\n`);
function die(message, remedy) {
  process.stderr.write(`\nbuild-bundle: ${message}\n\n  ${remedy}\n\n`);
  process.exit(1);
}

/**
 * npm ships its CLI as a plain script next to the node binary. Spawning that
 * directly keeps shell:false working on Windows, where spawning npm.cmd without a
 * shell throws EINVAL synchronously — the same reason services/exec.ts resolves
 * the Remotion CLI to a .js rather than a bin shim.
 */
function npmCli() {
  const bundled = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundled)) return { file: process.execPath, prefix: [bundled] };
  return { file: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
}

function run(file, args, cwd, label) {
  const r = spawnSync(file, args, {
    cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (r.error) die(`${label} could not start: ${r.error.message}`, "Check that Node and npm are on PATH.");
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
    die(`${label} exited with code ${r.status}.\n\n${tail}`, "Fix the error above, then re-run `npm run bundle`.");
  }
  return `${r.stdout ?? ""}`;
}

// ---------------------------------------------------------------- 1. read inputs
const manifestPath = path.join(REPO, "manifest.json");
if (!fs.existsSync(manifestPath)) die("manifest.json is missing.", "It is the source of truth for the bundle. Restore it.");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

const distConstants = path.join(REPO, "dist", "constants.js");
if (!fs.existsSync(distConstants)) die("dist/ is not built.", "Run `npm run build` first.");
const serverVersion = /SERVER_VERSION\s*=\s*["']([^"']+)["']/.exec(fs.readFileSync(distConstants, "utf8"))?.[1];
if (!serverVersion) die("Could not read SERVER_VERSION from dist/constants.js.", "The export moved or was renamed; update this script's path.");

// ---------------------------------------------------------------- 2. fail fast
if (manifest.version !== serverVersion) {
  const msg = `manifest.json says version ${manifest.version}, the compiled server reports ${serverVersion}.`;
  if (!allowVersionDrift) {
    die(msg, `A bundle whose manifest and server disagree is unsupportable — a bug report cites one version and the code is the other. `
      + `manifest.json is the source of truth: set SERVER_VERSION in src/constants.ts to ${manifest.version}, rebuild, and re-run. `
      + `Use --allow-version-drift for a local experiment; CI must never pass it.`);
  }
  log(`  WARNING: ${msg} (--allow-version-drift)`);
}

for (const f of ["icon.png", "README.md"]) {
  if (!fs.existsSync(path.join(REPO, f))) {
    die(`${f} is missing from the repository, but manifest.json references it.`,
      `It exists in an already-shipped .mcpb (they are zips). Recover it and commit it — `
      + `a file that lives only on the build machine is exactly how a bundle becomes unreproducible.`);
  }
}

const outFile = outFlag !== -1 && argv[outFlag + 1]
  ? path.resolve(argv[outFlag + 1])
  : path.join(REPO, `${manifest.name}-${manifest.version}.mcpb`);

log(`building ${manifest.name} v${manifest.version}`);

// ---------------------------------------------------------------- 3. stage
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of ["manifest.json", "icon.png", "README.md"]) {
  fs.copyFileSync(path.join(REPO, f), path.join(STAGE, f));
}

// Install production dependencies against the real lockfile, then replace the
// staged package.json with a production-only one. Installing first keeps `npm ci`
// happy (it demands package.json and the lockfile agree) while what ships carries
// no devDependencies.
fs.copyFileSync(path.join(REPO, "package.json"), path.join(STAGE, "package.json"));
fs.copyFileSync(path.join(REPO, "package-lock.json"), path.join(STAGE, "package-lock.json"));

const npm = npmCli();
log("  installing production dependencies");
run(npm.file, [...npm.prefix, "ci", "--omit=dev", "--ignore-scripts"], STAGE, "npm ci --omit=dev");

fs.writeFileSync(path.join(STAGE, "package.json"), JSON.stringify({
  name: pkg.name, version: manifest.version, description: pkg.description,
  type: pkg.type, main: "server/index.js", license: pkg.license,
  dependencies: pkg.dependencies,
}, null, 2) + "\n");
fs.rmSync(path.join(STAGE, "package-lock.json"), { force: true });

// ---------------------------------------------------------------- 4. natives
const resvgPkgPath = path.join(STAGE, "node_modules", "@resvg", "resvg-js", "package.json");
if (!fs.existsSync(resvgPkgPath)) {
  die("@resvg/resvg-js was not installed into the staging tree.",
    "It must be a runtime dependency. Check that it is in `dependencies`, not `devDependencies`.");
}
const resvgVersion = JSON.parse(fs.readFileSync(resvgPkgPath, "utf8")).version;
log(`  fetching ${NATIVE_TARGETS.length} native prebuilts for @resvg/resvg-js@${resvgVersion}`);

// Outside STAGE deliberately: a tarball left behind by a mid-loop failure would
// otherwise be staged and shipped.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcpb-natives-"));
try {
  for (const target of NATIVE_TARGETS) {
    const spec = `${target}@${resvgVersion}`;
    const dest = path.join(STAGE, "node_modules", ...target.split("/"));
    if (fs.existsSync(path.join(dest, "package.json"))) { log(`    ${target} (already present)`); continue; }

    const out = run(npm.file, [...npm.prefix, "pack", spec, "--pack-destination", tmp], REPO, `npm pack ${spec}`);
    const tgz = out.trim().split("\n").pop().trim();
    const tgzPath = path.join(tmp, tgz);
    if (!fs.existsSync(tgzPath)) die(`npm pack ${spec} reported '${tgz}' but the file is not there.`, "Re-run; if it persists the registry response is malformed.");

    fs.mkdirSync(dest, { recursive: true });
    try {
      extractNpmTarball(tgzPath, dest);
    } catch (error) {
      die(`could not extract ${spec}: ${error.message}`, "Re-run. If it persists, the published tarball changed shape.");
    }
    const node = fs.readdirSync(dest).filter((n) => n.endsWith(".node"));
    if (node.length === 0) die(`${target} unpacked with no .node binary.`, "The published package changed shape; inspect the tarball.");
    log(`    ${target}  ${(fs.statSync(path.join(dest, node[0])).size / 1e6).toFixed(1)} MB`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. server code
fs.cpSync(path.join(REPO, "dist"), path.join(STAGE, "server"), { recursive: true });
if (!fs.existsSync(path.join(STAGE, "server", "index.js"))) {
  die("server/index.js is missing from the staged tree.", "dist/ did not contain index.js. Run `npm run build`.");
}

// ---------------------------------------------------------------- 6. pack
const mcpbBin = path.join(REPO, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
if (!fs.existsSync(mcpbBin)) {
  die("@anthropic-ai/mcpb is not installed.",
    "Run `npm install`. This script will not fall back to a plain zip: the packer validates "
    + "manifest.json against the bundle spec, and losing that validation is worse than a failed build.");
}
fs.rmSync(outFile, { force: true });
log("  packing");
const packOut = run(process.execPath, [mcpbBin, "pack", STAGE, outFile], REPO, "mcpb pack");
process.stdout.write(packOut.split("\n").filter((l) => l.trim()).slice(-4).join("\n") + "\n");

if (!fs.existsSync(outFile)) die("mcpb pack reported success but produced no file.", "Inspect the output above.");
const size = fs.statSync(outFile).size;
log(`\n  ${path.relative(REPO, outFile)}  ${(size / 1048576).toFixed(2)} MiB`);
log(`  staged tree left at build/ for inspection\n`);

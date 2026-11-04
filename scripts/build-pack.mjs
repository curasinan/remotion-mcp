#!/usr/bin/env node
/**
 * Builds a template pack from a Remotion project (design 5.4, docs/CONTRACT-pack.md):
 *
 *   node scripts/build-pack.mjs <projectDir> [--out <dir>]
 *
 * It bundles the project, loads RemotionRoot through the project's own esbuild, discovers the compositions, runs
 * each schema through the zod 4 gate, exports it with the project's own z.toJSONSchema, checks that every bound
 * survived and that the export passes the service's JSON Schema gate, then writes `<out>` (default
 * `<projectDir>/dist-pack/`): pack-manifest.json, bundle/, package.json and package-lock.json. Last, it loads the
 * result with the service's own loadPack. Any failure prints every problem found and exits 1.
 *
 * It needs `npm run build:service` first: the JSON Schema gate, loadPack and the zod gate's limits come from
 * dist-service/. This file is only the CLI and always runs; the rules it applies live in scripts/lib/, where the
 * tests import them.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { dependencyProblems, fail, hashBundle, PackBuildError, prepareOutDir } from "./lib/pack-files.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_TEMPLATES = path.join(REPO, "dist-service", "service", "templates.js");
/** The schema and discovery rules. They read the zod gate's limits from dist-service, so they load after the check. */
const PACK_TEMPLATES = new URL("./lib/pack-templates.mjs", import.meta.url).href;
/** dist-service/ as a URL: the form in which Node names a module it cannot find. */
const DIST_SERVICE_URL = new URL("../dist-service/", import.meta.url).href;
const USAGE = "usage: node scripts/build-pack.mjs <projectDir> [--out <dir>]";
/** Where the bundle is entered, in Remotion's own order of preference. */
const ENTRY_CANDIDATES = ["src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx"];
/**
 * The generated module esbuild bundles to read the schemas. RemotionRoot comes from src/Root, Still from the
 * project's own remotion (so a <Still> is told apart by identity), and zod is the project's own, for its
 * toJSONSchema.
 */
const DISCOVERY_ENTRY = [
  'export { RemotionRoot } from "./src/Root";',
  'export { Still } from "remotion";',
  'export * as projectZod from "zod";',
].join("\n");

/** The project dir and the output dir from argv, or a usage failure. */
function parseCommandLine(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { out: { type: "string" } } });
  } catch (err) {
    fail(err.message, USAGE);
  }
  if (parsed.positionals.length !== 1) fail(USAGE);
  const projectDir = path.resolve(parsed.positionals[0]);
  const outDir = path.resolve(parsed.values.out ?? path.join(projectDir, "dist-pack"));
  return { projectDir, outDir };
}

/** Reads a JSON file of the project, or fails naming it. */
function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return fail(`${label}: ${err.code === "ENOENT" ? "required" : `cannot be read (${err.message})`}`);
  }
}

/** Step 1: bundles the project into `bundleDir`, with its own Remotion CLI, or with @remotion/bundler's bundle(). */
async function bundleProject(projectDir, bundleDir, projectRequire) {
  const entry = ENTRY_CANDIDATES.find((candidate) => fs.existsSync(path.join(projectDir, candidate)));
  if (entry === undefined) fail(`no entry point: expected one of ${ENTRY_CANDIDATES.join(", ")}`);

  // Why the CLI cannot bundle, or undefined when it can. The fallback says so, so a broken install is not silent.
  let unavailable;
  let cli;
  try {
    const cliPackage = projectRequire.resolve("@remotion/cli/package.json");
    const { bin } = JSON.parse(fs.readFileSync(cliPackage, "utf8"));
    cli = path.join(path.dirname(cliPackage), typeof bin === "string" ? bin : bin.remotion);
  } catch (err) {
    // A resolve error goes on to list the require stack; its first line names what was missing.
    unavailable = `@remotion/cli does not resolve: ${String(err?.message ?? err).split("\n")[0]}`;
  }
  // The project's own CLI, run directly with this node: what `npx remotion` resolves to, without a shell.
  const runCli = (args, stdio) => spawnSync(process.execPath, [cli, ...args], { cwd: projectDir, stdio });
  if (unavailable === undefined) {
    const help = runCli(["bundle", "--help"], "ignore");
    if (help.status !== 0) {
      unavailable = `remotion bundle --help ${help.error ? `failed: ${help.error.message}` : `exited ${help.status ?? help.signal}`}`;
    }
  }
  if (unavailable === undefined) {
    console.log(`build-pack: bundling ${entry} with remotion bundle`);
    // --disable-git-source keeps the commit out of the bundle, so packHash does not change with it.
    const run = runCli(["bundle", entry, "--out-dir", bundleDir, "--disable-git-source"], ["ignore", "inherit", "inherit"]);
    if (run.status !== 0) fail(`remotion bundle failed (${run.error?.message ?? `exit ${run.status ?? run.signal}`})`);
  } else {
    console.log(`build-pack: remotion bundle is unavailable (${unavailable}); bundling ${entry} with @remotion/bundler's bundle()`);
    let bundler;
    try {
      bundler = await import(pathToFileURL(projectRequire.resolve("@remotion/bundler")).href);
    } catch (err) {
      fail(`neither remotion bundle nor @remotion/bundler is available: ${err.message}`);
    }
    try {
      await bundler.bundle({ entryPoint: path.join(projectDir, entry), outDir: bundleDir, enableCaching: false });
    } catch (err) {
      fail(`@remotion/bundler bundle() failed: ${err.message}`);
    }
  }
  if (!fs.existsSync(path.join(bundleDir, "index.html"))) fail("the bundle has no index.html");
}

/** The project's esbuild: hoisted beside the project, or else the one @remotion/bundler depends on. */
function projectEsbuild(projectRequire) {
  try {
    return projectRequire("esbuild");
  } catch {
    try {
      return createRequire(projectRequire.resolve("@remotion/bundler/package.json"))("esbuild");
    } catch (err) {
      return fail(`the project's esbuild cannot be found: ${err.message}`);
    }
  }
}

/** Step 2: bundles the discovery entry with the project's esbuild and loads it: RemotionRoot, Still and zod. */
async function loadRoot(projectDir, projectRequire, requireDiscoveryBundle) {
  const esbuild = projectEsbuild(projectRequire);
  let output;
  try {
    const result = await esbuild.build({
      stdin: { contents: DISCOVERY_ENTRY, resolveDir: projectDir, sourcefile: "build-pack-discovery.js", loader: "js" },
      absWorkingDir: projectDir,
      bundle: true,
      platform: "node",
      format: "cjs",
      jsx: "automatic",
      write: false,
      logLevel: "silent",
    });
    output = result.outputFiles[0].contents;
  } catch (err) {
    const located = (err.errors ?? []).map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text));
    fail(...(located.length > 0 ? located.map((line) => `loading src/Root: ${line}`) : [`loading src/Root: ${err.message}`]));
  }
  // A temp file, never inside the project: everything it needs is bundled into it.
  return requireDiscoveryBundle(output);
}

/**
 * Whether the rules failed to load because dist-service lacks a module or an export they import. A service build from
 * before the limits moved to constants.ts lacks the exports; a partial one, the module. `npm run build:service` fixes
 * either, and nothing else.
 */
function serviceBuildBehind(err) {
  if (err?.code === "ERR_MODULE_NOT_FOUND") return typeof err.url === "string" && err.url.startsWith(DIST_SERVICE_URL);
  // V8 names the module as the importing file wrote it.
  return err instanceof SyntaxError
    && /^The requested module '[^']*\/dist-service\/[^']*' does not provide an export named /.test(err.message);
}

/** Builds the pack; returns its manifest, or throws a PackBuildError. */
async function buildPack(projectDir, outDir) {
  if (!fs.existsSync(SERVICE_TEMPLATES)) {
    fail("dist-service/service/templates.js is missing; run `npm run build:service` in the repository first");
  }
  const { checkSchemaVocabulary, loadPack } = await import(pathToFileURL(SERVICE_TEMPLATES).href);
  let rules;
  try {
    rules = await import(PACK_TEMPLATES);
  } catch (err) {
    const rebuild = serviceBuildBehind(err) ? "; dist-service is incomplete or older than these scripts: run `npm run build:service` again" : "";
    fail(`cannot load scripts/lib/pack-templates.mjs: ${String(err)}${rebuild}`);
  }
  const { requireDiscoveryBundle, templatesOf } = rules;

  const pkg = readJson(path.join(projectDir, "package.json"), "package.json");
  readJson(path.join(projectDir, "package-lock.json"), "package-lock.json (the derived image runs npm ci)");
  const deps = dependencyProblems(pkg);
  if (deps.length > 0) fail(...deps);
  const projectRequire = createRequire(path.join(projectDir, "package.json"));
  let remotionVersion;
  try {
    remotionVersion = readJson(projectRequire.resolve("@remotion/renderer/package.json"), "@remotion/renderer").version;
  } catch (err) {
    fail(err instanceof PackBuildError ? err.message : "@remotion/renderer is not installed; run npm ci in the project");
  }

  prepareOutDir(outDir, projectDir);
  try {
    const bundleDir = path.join(outDir, "bundle");
    await bundleProject(projectDir, bundleDir, projectRequire);
    const templates = templatesOf(await loadRoot(projectDir, projectRequire, requireDiscoveryBundle), checkSchemaVocabulary);

    const manifest = { packHash: hashBundle(bundleDir), remotionVersion, templates };
    fs.writeFileSync(path.join(outDir, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(projectDir, file), path.join(outDir, file));

    // The service loads exactly this; a pack it would refuse is not built. The message places each problem in the
    // manifest, schema problems included.
    try {
      loadPack(outDir);
    } catch (err) {
      fail(`loadPack: ${err.message}`);
    }
    return manifest;
  } catch (err) {
    // No half-built pack is left behind for a later step to pick up.
    fs.rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}

try {
  const { projectDir, outDir } = parseCommandLine(process.argv.slice(2));
  const manifest = await buildPack(projectDir, outDir);
  console.log(`build-pack: wrote ${outDir}`);
  console.log(`  packHash ${manifest.packHash}`);
  console.log(`  remotion ${manifest.remotionVersion}`);
  console.log(`  templates ${manifest.templates.map((t) => t.id).join(", ")}`);
} catch (err) {
  const problems = err instanceof PackBuildError ? err.problems : [err.stack ?? String(err)];
  for (const problem of problems) console.error(`build-pack: ${problem}`);
  process.exitCode = 1;
}

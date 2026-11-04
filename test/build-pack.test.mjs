// build-pack's own steps (scripts/lib/pack-templates.mjs and scripts/build-pack.mjs, docs/CONTRACT-pack.md): loading
// src/Root in Node, turning the compositions into the manifest's templates, and the CLI's bundler fallback. The
// templates are built from hand-built React elements, the repo's zod/v4 and the service's own JSON Schema gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z, toJSONSchema } from "zod/v4";

import { PackBuildError } from "../scripts/lib/pack-files.mjs";

const REPO = path.join(import.meta.dirname, "..");
const SERVICE = path.join(REPO, "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "templates.js"))) {
  throw new Error("dist-service/service/templates.js does not exist. Run `npm run build:service` first; "
    + "build-pack runs the service's own JSON Schema gate.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const { checkSchemaVocabulary } = await import(pathToFileURL(path.join(SERVICE, "templates.js")).href);
const { requireDiscoveryBundle, templatesOf } = await import("../scripts/lib/pack-templates.mjs");

// Hand-built React elements: the shape React.createElement returns, with stand-ins for remotion's components.
const ELEMENT = Symbol.for("react.transitional.element");
const FRAGMENT = Symbol.for("react.fragment");
const el = (type, props = {}) => ({ $$typeof: ELEMENT, type, key: null, props });
function Composition() {}
function Still() {}
function Scene() {}

/** A composition element `id` with `schema`, at a static size. */
const composition = (id, schema) =>
  el(Composition, { id, component: Scene, width: 1280, height: 720, fps: 30, durationInFrames: 1, schema });
/** What requireDiscoveryBundle returns for a RemotionRoot rendering `children`, with the repo's zod as the project's. */
const loaded = (...children) => ({
  RemotionRoot: () => el(FRAGMENT, { children }),
  Still,
  projectZod: { toJSONSchema },
});

/** The problems templatesOf fails with; fails the test when it returns instead, or throws anything else. */
function refusal(loadedRoot) {
  try {
    templatesOf(loadedRoot, checkSchemaVocabulary);
  } catch (err) {
    assert.ok(err instanceof PackBuildError, `expected a PackBuildError, got ${err?.stack ?? err}`);
    return err.problems;
  }
  return assert.fail("templatesOf returned templates; expected a PackBuildError");
}

test("templatesOf makes one template per composition, its propsSchema the project's own export", () => {
  const schema = z.strictObject({ label: z.string().max(80), color: z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/) });
  const templates = templatesOf(loaded(composition("swatch", schema), el(Still, { id: "dot", component: Scene,
    width: 64, height: 64, schema: z.strictObject({}) })), checkSchemaVocabulary);
  assert.deepEqual(templates, [
    { id: "swatch", compositionId: "swatch", width: 1280, height: 720, defaultFps: 30, maxFrames: 1, propsSchema: toJSONSchema(schema) },
    { id: "dot", compositionId: "dot", width: 64, height: 64, defaultFps: 1, maxFrames: 1,
      propsSchema: toJSONSchema(z.strictObject({})) },
  ]);
});

test("templatesOf refuses a .refine row through the zod gate, naming the composition", () => {
  const refined = z.strictObject({ a: z.string().max(5).refine(() => true) });
  assert.deepEqual(refusal(loaded(composition("card", refined))), ["card: <root>.a: refine and superRefine not allowed"]);
});

test("templatesOf refuses a schema whose export carries allOf, through the service's JSON Schema gate", () => {
  // .meta() writes keywords straight into the export: this passes the zod gate and the bounds check.
  const composed = z.strictObject({ a: z.string().max(5).meta({ allOf: [{ maxLength: 5 }] }) });
  assert.deepEqual(refusal(loaded(composition("card", composed))), ["card: propsSchema/properties/a: keyword allOf not allowed"]);
});

test("templatesOf refuses a bound the export lost, naming the composition", () => {
  const loosened = z.strictObject({ a: z.string().max(5).meta({ maxLength: 999 }) });
  assert.deepEqual(refusal(loaded(composition("card", loosened))), ["card: <root>.a: maxLength 5 missing from the export"]);
});

test("templatesOf lists every problem of every composition before it fails", () => {
  const refined = z.strictObject({ a: z.string().max(5).refine(() => true), b: z.string() });
  const composed = z.strictObject({ a: z.string().max(5).meta({ allOf: [{ maxLength: 5 }] }) });
  assert.deepEqual(refusal(loaded(composition("card", refined), composition("good", z.strictObject({})),
    composition("poster", composed))), [
    "card: <root>.a: refine and superRefine not allowed",
    "card: <root>.b: string needs .max(N)",
    "poster: propsSchema/properties/a: keyword allOf not allowed",
  ]);
});

test("templatesOf refuses a root with no usable compositions, a RemotionRoot that throws, and a zod without toJSONSchema", () => {
  assert.deepEqual(refusal(loaded()), ["RemotionRoot registers no compositions"]);
  assert.deepEqual(refusal(loaded(el(Composition, { id: "bare", component: Scene, width: 64, height: 64, fps: 30,
    durationInFrames: 1 }))), ["bare: schema required"]);
  assert.deepEqual(refusal({ ...loaded(), RemotionRoot: () => { throw new Error("hooks need a renderer"); } }), [
    "calling RemotionRoot() failed (it must return its compositions without hooks): hooks need a renderer",
  ]);
  assert.deepEqual(refusal({ ...loaded(composition("card", z.strictObject({}))), projectZod: {} }), [
    "card: the project's zod has no toJSONSchema; zod 4 is required",
  ]);
  // An export that throws is a problem of its composition, listed with the others, not a crash of the build.
  const throwing = { toJSONSchema: () => { throw new Error("cannot export"); } };
  assert.deepEqual(refusal({ ...loaded(composition("card", z.strictObject({})), composition("poster", z.strictObject({ a: z.string().max(5) }))),
    projectZod: throwing }), [
    "card: z.toJSONSchema failed: cannot export",
    "poster: z.toJSONSchema failed: cannot export",
  ]);
});

const BROWSER_HINT = "module scope must not use browser APIs (docs/CONTRACT-pack.md)";

test("requireDiscoveryBundle names a module-scope browser API in one line, not with a stack into a deleted file", () => {
  const problems = (code) => {
    try {
      requireDiscoveryBundle(code);
    } catch (err) {
      assert.ok(err instanceof PackBuildError, `expected a PackBuildError, got ${err?.stack ?? err}`);
      return err.problems;
    }
    return assert.fail("requireDiscoveryBundle loaded the bundle; expected a PackBuildError");
  };
  assert.deepEqual(problems("document.title = 'x';\nexports.RemotionRoot = () => null;"),
    [`loading src/Root in Node failed: document is not defined; ${BROWSER_HINT}`]);
  // What @remotion/fonts' loadFont does first, at module scope.
  assert.deepEqual(problems("new FontFace('Pack', 'url(font.ttf)');\nexports.RemotionRoot = () => null;"),
    [`loading src/Root in Node failed: FontFace is not defined; ${BROWSER_HINT}`]);
  assert.deepEqual(problems("exports.Still = 1;"), ["src/Root must export the RemotionRoot component"]);
  // A module can throw a value that is not an Error. The line still says what it threw.
  assert.deepEqual(problems("throw 'no window here';"), [`loading src/Root in Node failed: no window here; ${BROWSER_HINT}`]);

  const ok = requireDiscoveryBundle("exports.RemotionRoot = () => 'root'; exports.Still = 'still';");
  assert.equal(ok.RemotionRoot(), "root");
  assert.equal(ok.Still, "still");
});

/** Writes `files`, relative path to content, under `dir`; a null content deletes that file. */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}

/**
 * A project build-pack accepts up to its bundle step: package.json and package-lock.json, an installed
 * @remotion/renderer and an entry point, with `files` added. Nothing else is installed.
 */
function stubProject(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeTree(dir, {
    "package.json": JSON.stringify({ name: "stub", dependencies: { "@remotion/cli": "4.0.532", "@remotion/renderer": "4.0.532" } }),
    "package-lock.json": "{}",
    "node_modules/@remotion/renderer/package.json": JSON.stringify({ name: "@remotion/renderer", version: "4.0.532" }),
    "src/index.ts": "",
    ...files,
  });
  return dir;
}

/**
 * Where Node looks for a package from a project in `dir`, besides `dir`'s own node_modules and the folders
 * hermeticEnv empties: each ancestor's node_modules, and node's own `<prefix>/lib/node`.
 */
function placesAbove(dir) {
  const places = [];
  for (let up = path.dirname(dir); ; up = path.dirname(up)) {
    places.push(path.join(up, "node_modules"));
    if (path.dirname(up) === up) break;
  }
  // As Node's own Module._initPaths has it: node sits in the prefix on Windows, and in <prefix>/bin elsewhere.
  places.push(path.resolve(process.execPath, process.platform === "win32" ? ".." : "../..", "lib", "node"));
  return places;
}

/**
 * Fails before a CLI run when @remotion/cli or @remotion/bundler is installed where build-pack would find it from
 * `dir`. The tests expect both absent, and must never run a real one in their place.
 */
function assertNothingInstalledAbove(dir) {
  const found = placesAbove(dir).flatMap((place) => ["@remotion/cli", "@remotion/bundler"].map((pkg) => path.join(place, pkg)))
    .filter((pkg) => fs.existsSync(pkg));
  if (found.length > 0) {
    assert.fail(`${found.join(" and ")} would be found by build-pack from ${dir}, so this test would run it instead of `
      + "its stub. Remove it, or point the temp dir (TMPDIR; TEMP and TMP on Windows) where nothing above holds one.");
  }
}

/**
 * The environment of a CLI run: the parent's, without NODE_PATH, and with HOME and USERPROFILE a fresh empty dir.
 * Node's global folders, NODE_PATH, $HOME/.node_modules and $HOME/.node_libraries, then hold nothing.
 */
function hermeticEnv(t, base = process.env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Windows variable names are case-insensitive: dropping every spelling leaves exactly one of each.
  const kept = Object.entries(base).filter(([name]) => !["NODE_PATH", "HOME", "USERPROFILE"].includes(name.toUpperCase()));
  return { ...Object.fromEntries(kept), HOME: home, USERPROFILE: home };
}

/** Runs `script`, build-pack.mjs by default, on `dir`, once nothing above `dir` can stand in for a missing package. */
function buildPack(t, dir, script = path.join(REPO, "scripts", "build-pack.mjs")) {
  assertNothingInstalledAbove(dir);
  return spawnSync(process.execPath, [script, dir], { cwd: REPO, encoding: "utf8", timeout: 60_000, env: hermeticEnv(t) });
}

/** A @remotion/cli and a @remotion/bundler under `dir` that each fail loudly if build-pack ever runs them. */
function plantRemotion(dir) {
  writeTree(dir, {
    "@remotion/cli/package.json": JSON.stringify({ name: "@remotion/cli", bin: { remotion: "cli.js" } }),
    "@remotion/cli/cli.js": "console.error('the planted @remotion/cli ran');\nprocess.exit(7);\n",
    "@remotion/bundler/package.json": JSON.stringify({ name: "@remotion/bundler", main: "index.js" }),
    "@remotion/bundler/index.js": "exports.bundle = () => { throw new Error('the planted @remotion/bundler ran'); };\n",
  });
}

/**
 * Points this test process's NODE_PATH, HOME and USERPROFILE at planted Remotion packages until the test ends, so a
 * CLI run that inherited them would find a CLI and a bundler. Returns the dir they are planted under.
 */
function pollute(t) {
  const planted = fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-planted-"));
  plantRemotion(path.join(planted, "path"));
  plantRemotion(path.join(planted, "home", ".node_modules"));
  const saved = Object.fromEntries(["NODE_PATH", "HOME", "USERPROFILE"].map((name) => [name, process.env[name]]));
  Object.assign(process.env, { NODE_PATH: path.join(planted, "path"), HOME: path.join(planted, "home"), USERPROFILE: path.join(planted, "home") });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(planted, { recursive: true, force: true });
  });
  return planted;
}

test("a CLI run finds packages only in its own project, never in NODE_PATH, the home folders or above the project", (t) => {
  const planted = pollute(t);
  const dir = stubProject(t);
  /** Where a project in `dir` resolves @remotion/cli from, under `env`: build-pack resolves through this createRequire. */
  const lookups = (env) => {
    const run = spawnSync(process.execPath, ["-p",
      "JSON.stringify(require('node:module').createRequire(require('node:path').join(process.argv[1], 'package.json')).resolve.paths('@remotion/cli'))",
      dir], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  // The control: the polluted variables do point Node at the planted packages.
  assert.ok(lookups(process.env).includes(path.join(planted, "path")), "NODE_PATH not in the lookups");
  assert.ok(lookups(process.env).includes(path.join(planted, "home", ".node_modules")), "the home folder not in the lookups");

  // A run's environment leaves Node the project's own node_modules, the empty home's folders, and the places the
  // check before each run covers. Nothing else.
  const env = hermeticEnv(t);
  const covered = new Set([path.join(dir, "node_modules"), path.join(env.HOME, ".node_modules"),
    path.join(env.HOME, ".node_libraries"), ...placesAbove(dir)]);
  assert.deepEqual(lookups(env).filter((place) => !covered.has(place)), []);

  // That check runs before the CLI, and names what it found.
  plantRemotion(path.join(planted, "above", "node_modules"));
  const above = (pkg) => path.join(planted, "above", "node_modules", "@remotion", pkg);
  assert.throws(() => buildPack(t, path.join(planted, "above", "project")),
    (err) => err.message.startsWith(`${above("cli")} and ${above("bundler")} would be found by build-pack from `));
});

test("build-pack says why remotion bundle is unavailable before it falls back to bundle()", (t) => {
  // NODE_PATH and the home folders hold a CLI and a bundler that each run must not find.
  pollute(t);
  const missing = stubProject(t);
  const noCli = buildPack(t, missing);
  assert.equal(noCli.status, 1, noCli.stderr);
  assert.match(noCli.stdout, /^build-pack: remotion bundle is unavailable \(@remotion\/cli does not resolve: Cannot find module '@remotion\/cli\/package\.json'[^\n]*\); bundling src\/index\.ts with @remotion\/bundler's bundle\(\)$/m);
  assert.match(noCli.stderr, /^build-pack: neither remotion bundle nor @remotion\/bundler is available/m);
  assert.equal(fs.existsSync(path.join(missing, "dist-pack")), false, "a failed build left dist-pack/ behind");

  const broken = stubProject(t, {
    "node_modules/@remotion/cli/package.json": JSON.stringify({ name: "@remotion/cli", bin: { remotion: "cli.js" } }),
    "node_modules/@remotion/cli/cli.js": "process.exit(3);\n",
  });
  const badCli = buildPack(t, broken);
  assert.equal(badCli.status, 1, badCli.stderr);
  assert.match(badCli.stdout, /^build-pack: remotion bundle is unavailable \(remotion bundle --help exited 3\); bundling src\/index\.ts with @remotion\/bundler's bundle\(\)$/m);

  // A probe that cannot start at all is named by its spawn error, not by an exit status it never had. This bin is
  // longer than any OS lets one argument be: E2BIG on Linux and macOS, ENAMETOOLONG on Windows.
  const unspawnable = stubProject(t, {
    "node_modules/@remotion/cli/package.json": JSON.stringify({ name: "@remotion/cli", bin: { remotion: "x".repeat(4 * 1024 * 1024) } }),
  });
  const noSpawn = buildPack(t, unspawnable);
  assert.equal(noSpawn.status, 1, noSpawn.stderr);
  assert.match(noSpawn.stdout, /^build-pack: remotion bundle is unavailable \(remotion bundle --help failed: spawnSync \S.* (E2BIG|ENAMETOOLONG)\); bundling src\/index\.ts with @remotion\/bundler's bundle\(\)$/m);
  assert.match(noSpawn.stderr, /^build-pack: neither remotion bundle nor @remotion\/bundler is available/m);
});

/**
 * build-pack.mjs and scripts/lib/ copied under a temp root, beside a stand-in dist-service: its templates.js exports
 * the two names build-pack imports first, and its constants.js the zod gate's limits. `files` are written over the
 * copy, and a null deletes one. The copy loads its rules from this tree, so a test can break them. The root is a real
 * path, as Node reports module paths.
 */
function cliCopy(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-copy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(REPO, "scripts", "lib"), path.join(root, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "build-pack.mjs"), path.join(root, "scripts", "build-pack.mjs"));
  writeTree(root, {
    "package.json": JSON.stringify({ type: "module" }),
    "dist-service/service/templates.js": "export const checkSchemaVocabulary = () => [];\nexport const loadPack = () => {};\n",
    "dist-service/service/constants.js": "export const MAX_TEMPLATE_ID = 100, MAX_SCHEMA_DEPTH = 64, MAX_EXPANDED_NODES = 10_000;\n",
    ...files,
  });
  return root;
}

test("build-pack names what stopped its rules loading, and suggests a service build only when dist-service is behind", (t) => {
  const CANNOT = "build-pack: cannot load scripts/lib/pack-templates.mjs: ";
  const REBUILD = "; dist-service is incomplete or older than these scripts: run `npm run build:service` again";
  /** The one line a copy with `files` fails with, and the copy's root. */
  const failure = (files) => {
    const root = cliCopy(t, files);
    const run = buildPack(t, root, path.join(root, "scripts", "build-pack.mjs"));
    assert.equal(run.status, 1, run.stderr);
    const lines = run.stderr.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, run.stderr);
    return { root, line: lines[0] };
  };
  const at = (root, ...rel) => path.join(root, ...rel);

  // The control: an intact copy loads its rules, and stops only at the project, which here has no lockfile.
  assert.equal(failure({}).line, "build-pack: package-lock.json (the derived image runs npm ci): required");

  // dist-service lacks a module the rules import.
  const missing = failure({ "dist-service/service/constants.js": null });
  assert.equal(missing.line, `${CANNOT}Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${at(missing.root, "dist-service", "service", "constants.js")}' `
    + `imported from ${at(missing.root, "scripts", "lib", "zod-gate.mjs")}${REBUILD}`);
  // A service build from before the limits moved to constants.ts: the module is there, the exports are not.
  assert.equal(failure({ "dist-service/service/constants.js": "export const IDENTITY_SKEW_S = 30;\n" }).line,
    `${CANNOT}SyntaxError: The requested module '../../dist-service/service/constants.js' does not provide an export named 'MAX_EXPANDED_NODES'${REBUILD}`);

  // Anything else is named as it is, and a service build would not fix it: a syntax error in the rules, and a module
  // or an export of scripts/lib that is missing.
  assert.equal(failure({ "scripts/lib/pack-templates.mjs": "export const = 1;\n" }).line, `${CANNOT}SyntaxError: Unexpected token '='`);
  const gone = failure({ "scripts/lib/zod-gate.mjs": null });
  assert.equal(gone.line, `${CANNOT}Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${at(gone.root, "scripts", "lib", "zod-gate.mjs")}' `
    + `imported from ${at(gone.root, "scripts", "lib", "pack-templates.mjs")}`);
  assert.equal(failure({ "scripts/lib/zod-gate.mjs": "export const unrelated = 1;\n" }).line,
    `${CANNOT}SyntaxError: The requested module './zod-gate.mjs' does not provide an export named 'boundsSurvived'`);
});

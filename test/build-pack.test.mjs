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

  const ok = requireDiscoveryBundle("exports.RemotionRoot = () => 'root'; exports.Still = 'still';");
  assert.equal(ok.RemotionRoot(), "root");
  assert.equal(ok.Still, "still");
});

/**
 * A project build-pack accepts up to its bundle step: package.json and package-lock.json, an installed
 * @remotion/renderer and an entry point, with `files` added. Nothing else is installed.
 */
function stubProject(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  write("package.json", JSON.stringify({ name: "stub", dependencies: { "@remotion/cli": "4.0.532", "@remotion/renderer": "4.0.532" } }));
  write("package-lock.json", "{}");
  write("node_modules/@remotion/renderer/package.json", JSON.stringify({ name: "@remotion/renderer", version: "4.0.532" }));
  write("src/index.ts", "");
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return dir;
}

const buildPack = (dir) => spawnSync(process.execPath, [path.join(REPO, "scripts", "build-pack.mjs"), dir],
  { cwd: REPO, encoding: "utf8", timeout: 60_000 });

test("build-pack says why remotion bundle is unavailable before it falls back to bundle()", (t) => {
  const missing = stubProject(t);
  const noCli = buildPack(missing);
  assert.equal(noCli.status, 1, noCli.stderr);
  assert.match(noCli.stdout, /^build-pack: remotion bundle is unavailable \(@remotion\/cli does not resolve: Cannot find module '@remotion\/cli\/package\.json'[^\n]*\); bundling src\/index\.ts with @remotion\/bundler's bundle\(\)$/m);
  assert.match(noCli.stderr, /^build-pack: neither remotion bundle nor @remotion\/bundler is available/m);
  assert.equal(fs.existsSync(path.join(missing, "dist-pack")), false, "a failed build left dist-pack/ behind");

  const broken = stubProject(t, {
    "node_modules/@remotion/cli/package.json": JSON.stringify({ name: "@remotion/cli", bin: { remotion: "cli.js" } }),
    "node_modules/@remotion/cli/cli.js": "process.exit(3);\n",
  });
  const badCli = buildPack(broken);
  assert.equal(badCli.status, 1, badCli.stderr);
  assert.match(badCli.stdout, /^build-pack: remotion bundle is unavailable \(remotion bundle --help exited 3\); bundling src\/index\.ts with @remotion\/bundler's bundle\(\)$/m);
});

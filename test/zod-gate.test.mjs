// The zod 4 vocabulary gate scripts/build-pack.mjs runs on every composition's schema, its composition discovery,
// and its file rules: packHash, dependencies and the output dir (design 5.4, docs/CONTRACT-pack.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z as z3 } from "zod";
import { z, toJSONSchema } from "zod/v4";

import {
  boundsSurvived, compositionProblems, discoverCompositions, gateSchema, zodMajor,
} from "../scripts/lib/zod-gate.mjs";
import { dependencyProblems, hashBundle, prepareOutDir } from "../scripts/lib/pack-files.mjs";

/** A strict object that passes the gate, with `row` added: each refused row is the only thing wrong with it. */
const base = (row = {}) => z.strictObject({ a: z.string().max(10), ...row });

const yes = () => true;

/**
 * [label, the refused construct, its positive twin (undefined: the base alone), the rule the one violation names].
 * Each row is built fresh per test, so no schema object is shared between cases.
 */
const REFUSED = [
  ["z.url().max(10)", () => z.url().max(10), () => z.string().max(10), /format url not allowed/],
  ["z.string().max(9).url()", () => z.string().max(9).url(), () => z.string().max(10), /format url not allowed/],
  ["z.email().max(10)", () => z.email().max(10), () => z.string().max(10), /format email not allowed/],
  ["z.string().max(10).email()", () => z.string().max(10).email(), () => z.string().max(10), /format email not allowed/],
  ["z.string() with no max", () => z.string(), () => z.string().max(10), /string needs \.max/],
  ["z.number().min(0) with no max", () => z.number().min(0), () => z.number().min(0).max(1), /number needs an upper bound/],
  ["z.number().max(1) with no min", () => z.number().max(1), () => z.number().min(0).max(1), /number needs a lower bound/],
  ["z.array() with no max", () => z.array(z.string().max(5)), () => z.array(z.string().max(5)).max(3), /array needs \.max/],
  ["z.object({}), not strict", () => z.object({}), () => z.strictObject({}), /object must be strict/],
  [".passthrough()", () => z.strictObject({}).passthrough(), () => z.strictObject({}), /object must be strict/],
  [".catchall(z.string().max(5))", () => z.strictObject({}).catchall(z.string().max(5)), () => z.strictObject({}),
    /object must be strict/],
  ["z.string().max(9).refine()", () => z.string().max(9).refine(yes), () => z.string().max(9), /refine/],
  ["z.enum().refine()", () => z.enum(["a", "b"]).refine(yes), () => z.enum(["a", "b"]), /refine/],
  ["z.literal().refine()", () => z.literal("a").refine(yes), () => z.literal("a"), /refine/],
  ["optional().refine()", () => z.string().max(9).optional().refine(yes), () => z.string().max(9).optional(), /refine/],
  [".superRefine()", () => z.string().max(9).superRefine(() => {}), () => z.string().max(9), /refine/],
  [".transform()", () => z.string().max(9).transform((s) => s), () => z.string().max(9), /transform/],
  ["z.preprocess()", () => z.preprocess((v) => v, z.string().max(9)), () => z.string().max(9), /transform/],
  [".trim()", () => z.string().max(9).trim(), () => z.string().max(9), /overwrite checks \(\.trim/],
  ["z.record()", () => z.record(z.string().max(5), z.string().max(5)), undefined, /type record not allowed/],
  ["z.any()", () => z.any(), undefined, /type any not allowed/],
  ["z.unknown()", () => z.unknown(), undefined, /type unknown not allowed/],
  ["z.union()", () => z.union([z.string().max(5), z.boolean()]), undefined, /type union not allowed/],
  // Beyond the design's list: the export drops a regex's flags, so its pattern would no longer match what zod
  // matched; and a check kind the gate does not know (multipleOf exports a keyword the service refuses).
  ["a regex with flags", () => z.string().max(7).regex(/^#[0-9a-f]{6}$/i), () => z.string().max(7).regex(/^#[0-9a-f]{6}$/),
    /regex flags not allowed/],
  ["z.number().multipleOf()", () => z.number().min(0).max(10).multipleOf(2), () => z.number().min(0).max(10),
    /check multiple_of not allowed/],
];

for (const [label, construct, twin, rule] of REFUSED) {
  test(`gateSchema refuses ${label} with exactly one violation, and passes its twin`, () => {
    const violations = gateSchema(base({ b: construct() }));
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0], rule);
    assert.ok(violations[0].startsWith("<root>.b: "), violations[0]);
    assert.deepEqual(gateSchema(base(twin === undefined ? {} : { b: twin() })), []);
  });
}

/** The kind of schema a real template declares; every construct in it is allowed. */
const realistic = () => z.strictObject({
  title: z.string().max(80),
  color: z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/),
  players: z.array(z.strictObject({ name: z.string().max(40), number: z.number().int().min(1).max(99) })).max(22),
  theme: z.enum(["light", "dark"]),
  subtitle: z.string().max(120).optional(),
});

test("it permits the realistic template", () => {
  assert.deepEqual(gateSchema(realistic()), []);
});

test("it permits booleans, literals, top-level int formats and exclusive bounds", () => {
  const schema = z.strictObject({
    on: z.boolean(),
    kind: z.literal("card"),
    count: z.int().min(0).max(5),
    ratio: z.number().gt(0).lt(1),
    code: z.string().length(3),
  });
  assert.deepEqual(gateSchema(schema), []);
});

test("gateSchema requires a strict object at the root", () => {
  assert.deepEqual(gateSchema(z.string().max(5)), ["<root>: the props schema must be z.strictObject"]);
  assert.deepEqual(gateSchema(z.object({ a: z.string().max(5) })), ["<root>: object must be strict (z.strictObject)"]);
});

test("gateSchema names nested and non-identifier paths", () => {
  const schema = z.strictObject({ list: z.array(z.strictObject({ "full name": z.string() })).max(2) });
  assert.deepEqual(gateSchema(schema), ['<root>.list[]["full name"]: string needs .max(N)']);
});

test("gateSchema refuses a recursive schema and a schema nested past 64 levels, and returns", () => {
  const node = z.strictObject({
    name: z.string().max(5),
    get child() {
      return node.optional();
    },
  });
  assert.deepEqual(gateSchema(z.strictObject({ tree: node })), ["<root>.tree.child: recursive schema not allowed"]);

  let deep = z.strictObject({ leaf: z.string().max(5) });
  for (let i = 0; i < 70; i += 1) deep = z.strictObject({ n: deep });
  const violations = gateSchema(deep);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0], /: schema nested too deeply$/);
});

test("boundsSurvived reports nothing for z.toJSONSchema of the realistic template, and reports a removed maxLength", () => {
  const schema = realistic();
  const exported = toJSONSchema(schema);
  assert.deepEqual(boundsSurvived(schema, exported), []);

  delete exported.properties.title.maxLength;
  assert.deepEqual(boundsSurvived(schema, exported), ["<root>.title: maxLength 80 missing from the export"]);
});

test("boundsSurvived reports every other lost bound", () => {
  const schema = realistic();
  const exported = toJSONSchema(schema);
  const player = exported.properties.players.items;
  delete exported.properties.color.pattern;
  delete exported.properties.players.maxItems;
  delete player.properties.number.maximum;
  player.properties.number.minimum = 0;
  delete player.additionalProperties;
  exported.required = exported.required.filter((name) => name !== "theme");
  delete exported.properties.theme.enum;
  delete exported.properties.subtitle;
  assert.deepEqual(boundsSurvived(schema, exported).sort(), [
    "<root>.color: pattern ^#[0-9a-fA-F]{6}$ missing from the export",
    "<root>.players: maxItems 22 missing from the export",
    "<root>.players[].number: maximum 99 missing from the export",
    "<root>.players[].number: minimum 1 missing from the export",
    "<root>.players[]: additionalProperties: false missing from the export",
    "<root>.subtitle: missing from the export",
    "<root>.theme: enum missing from the export",
    "<root>.theme: required missing from the export",
  ]);
});

test("boundsSurvived reports a lost minLength and minItems", () => {
  const schema = z.strictObject({ code: z.string().min(2).max(5), list: z.array(z.boolean()).min(1).max(3) });
  const exported = toJSONSchema(schema);
  assert.deepEqual(boundsSurvived(schema, exported), []);
  delete exported.properties.code.minLength;
  delete exported.properties.list.minItems;
  assert.deepEqual(boundsSurvived(schema, exported), [
    "<root>.code: minLength 2 missing from the export",
    "<root>.list: minItems 1 missing from the export",
  ]);
});

test("boundsSurvived follows a $ref into $defs, and accepts a tighter bound", () => {
  const schema = z.strictObject({ title: z.string().max(80), count: z.number().min(0).max(10) });
  const exported = {
    type: "object",
    properties: { title: { $ref: "#/$defs/Title" }, count: { type: "number", exclusiveMinimum: 0, maximum: 5 } },
    required: ["title", "count"],
    additionalProperties: false,
    $defs: { Title: { type: "string", maxLength: 40 } },
  };
  assert.deepEqual(boundsSurvived(schema, exported), []);
  exported.$defs.Title = { type: "string" };
  assert.deepEqual(boundsSurvived(schema, exported), ["<root>.title: maxLength 80 missing from the export"]);
});

// An enum or literal loses its bound when the export admits a value zod refuses: the backend validates against the
// export, so the template would receive a value its own zod type excludes. Admitting fewer values is tighter.
test("boundsSurvived reports an enum or literal the export widened, and accepts one it narrowed", () => {
  const wider = z.strictObject({ theme: z.enum(["light", "dark"]).meta({ enum: ["light", "dark", "neon"] }) });
  assert.deepEqual(gateSchema(wider), []);
  assert.deepEqual(boundsSurvived(wider, toJSONSchema(wider)), ['<root>.theme: the export admits "neon", which zod refuses']);

  const widerLiteral = z.strictObject({ kind: z.literal("card").meta({ const: undefined, enum: ["card", "poster"] }) });
  assert.deepEqual(gateSchema(widerLiteral), []);
  assert.deepEqual(boundsSurvived(widerLiteral, toJSONSchema(widerLiteral)), [
    '<root>.kind: the export admits "poster", which zod refuses',
  ]);

  // A const and an enum are both read, and a value either one names counts. JSON Schema would admit only "card"
  // here; reading every named value means a node carrying both is never read as tighter than it is.
  const both = z.strictObject({ kind: z.literal("card") });
  assert.deepEqual(boundsSurvived(both, { ...toJSONSchema(both), properties: { kind: { const: "card", enum: ["card", 7] } } }), [
    "<root>.kind: the export admits 7, which zod refuses",
  ]);

  const narrower = z.strictObject({ theme: z.enum(["light", "dark"]).meta({ enum: ["light"] }) });
  assert.deepEqual(boundsSurvived(narrower, toJSONSchema(narrower)), []);
  const narrowerLiteral = z.strictObject({ kind: z.literal(["card", "poster"]) });
  const narrowed = toJSONSchema(narrowerLiteral);
  assert.deepEqual(narrowed.properties.kind.enum, ["card", "poster"]);
  narrowed.properties.kind = { type: "string", const: "card" };
  assert.deepEqual(boundsSurvived(narrowerLiteral, narrowed), []);
});

test("boundsSurvived refuses an empty or malformed enum, and reads a numeric enum's values as zod does", () => {
  const schema = z.strictObject({ theme: z.enum(["light", "dark"]) });
  const exported = toJSONSchema(schema);
  exported.properties.theme.enum = [];
  assert.deepEqual(boundsSurvived(schema, exported), ["<root>.theme: enum missing from the export"]);
  // A malformed enum is not read past to a const beside it.
  exported.properties.theme = { type: "string", enum: "light", const: "light" };
  assert.deepEqual(boundsSurvived(schema, exported), ["<root>.theme: enum missing from the export"]);
  // A value that is not a string, number, boolean or null is named by its kind only.
  exported.properties.theme = { enum: ["light", ["dark"], { dark: 1 }, Symbol("dark"), null] };
  assert.deepEqual(boundsSurvived(schema, exported), [
    "<root>.theme: the export admits an array, an object, a symbol, null, which zod refuses",
  ]);

  // A TypeScript numeric enum carries its reverse mapping: zod accepts 0 and refuses "Up".
  const numeric = z.enum({ Up: 0, 0: "Up" });
  assert.equal(numeric.safeParse("Up").success, false);
  const direction = z.strictObject({ dir: numeric });
  assert.deepEqual(boundsSurvived(direction, toJSONSchema(direction)), []);
  const widerNumeric = z.strictObject({ dir: z.enum({ Up: 0, 0: "Up" }).meta({ type: ["number", "string"], enum: [0, "Up"] }) });
  assert.deepEqual(boundsSurvived(widerNumeric, toJSONSchema(widerNumeric)), [
    '<root>.dir: the export admits "Up", which zod refuses',
  ]);
});

test("zod 3 schemas are refused with the clear message", () => {
  const schema = z3.object({ a: z3.string().max(10) }).strict();
  assert.equal(zodMajor(schema), 3);
  assert.equal(zodMajor(base()), 4);
  assert.deepEqual(gateSchema(schema), ["<root>: zod 3 is not supported, use zod 4"]);
});

// Hand-built React elements: the shape React.createElement returns, with stand-ins for remotion's components.
const ELEMENT = Symbol.for("react.transitional.element");
const FRAGMENT = Symbol.for("react.fragment");
const el = (type, props = {}) => ({ $$typeof: ELEMENT, type, key: null, props });
function Composition() {}
function Still() {}
function Folder() {}
function Scene() {}

test("discoverCompositions finds none in an empty root, flags calculateMetadata without static size, and flags a composition with no schema by id", () => {
  assert.deepEqual(discoverCompositions(el(FRAGMENT)), []);
  assert.deepEqual(discoverCompositions(el(FRAGMENT, { children: [null, false, "text"] })), []);
  assert.deepEqual(compositionProblems([]), ["RemotionRoot registers no compositions"]);

  const schema = base();
  const root = el(FRAGMENT, {
    children: [
      el(Composition, { id: "card", component: Scene, width: 1280, height: 720, fps: 30, durationInFrames: 90, schema }),
      el(Folder, {
        name: "more",
        children: [
          el(Composition, { id: "sized-later", component: Scene, fps: 30, durationInFrames: 1, schema,
            calculateMetadata: () => ({ width: 10, height: 10 }) }),
          [el(Composition, { id: "bare", lazyComponent: () => Promise.resolve({ default: Scene }), width: 64, height: 64,
            fps: 30, durationInFrames: 1 })],
        ],
      }),
      el(Still, { id: "poster", component: Scene, width: 640, height: 360, schema }),
    ],
  });
  const found = discoverCompositions(root, { Still });
  assert.deepEqual(found.map(({ id, width, height, fps, durationInFrames, hasCalculateMetadata }) =>
    ({ id, width, height, fps, durationInFrames, hasCalculateMetadata })), [
    { id: "card", width: 1280, height: 720, fps: 30, durationInFrames: 90, hasCalculateMetadata: false },
    { id: "sized-later", width: undefined, height: undefined, fps: 30, durationInFrames: 1, hasCalculateMetadata: true },
    { id: "bare", width: 64, height: 64, fps: 30, durationInFrames: 1, hasCalculateMetadata: false },
    { id: "poster", width: 640, height: 360, fps: 1, durationInFrames: 1, hasCalculateMetadata: false },
  ]);
  assert.equal(found[0].schema, schema);
  assert.equal(found[2].schema, undefined);
  assert.deepEqual(compositionProblems(found), [
    "sized-later: calculateMetadata needs a static width and height",
    "bare: schema required",
  ]);
});

test("compositionProblems flags a composition without a static size, fps or duration, or with an id over 100", () => {
  const schema = base();
  const sized = { component: Scene, width: 64, height: 64, fps: 30, durationInFrames: 1, schema };
  const problems = compositionProblems(discoverCompositions(el(FRAGMENT, {
    children: [
      el(Composition, { id: "no-size", component: Scene, fps: 30, durationInFrames: 1, schema }),
      el(Still, { id: "unknown-still", component: Scene, width: 64, height: 64, schema }),
      el(Composition, { id: "a".repeat(100), ...sized }),
      el(Composition, { id: "b".repeat(101), ...sized }),
    ],
  })));
  assert.deepEqual(problems, [
    "no-size: static width and height required",
    "unknown-still: static fps and durationInFrames required",
    `${"b".repeat(101)}: id longer than 100 characters, which render_still never accepts as a template_id`,
  ]);
});

test("hashBundle covers every file's relative path and contents, in code-unit order", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "public"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dir, "public", "a.txt"), "a");
  const first = hashBundle(dir);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashBundle(dir), first);

  fs.writeFileSync(path.join(dir, "public", "a.txt"), "b");
  const edited = hashBundle(dir);
  assert.notEqual(edited, first);

  fs.renameSync(path.join(dir, "public", "a.txt"), path.join(dir, "public", "c.txt"));
  assert.notEqual(hashBundle(dir), edited);

  // Moving a byte from one file's end to the next file's start must change the hash: the framing is unambiguous.
  fs.writeFileSync(path.join(dir, "public", "c.txt"), "bx");
  const split = hashBundle(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>b");
  fs.writeFileSync(path.join(dir, "public", "c.txt"), "x");
  assert.notEqual(hashBundle(dir), split);
});

test("hashBundle hashes path, NUL, byte length, NUL and bytes per file, sorted by code unit, not by locale", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Code-unit order puts "B.txt" (0x42) before "a.txt" (0x61); a locale sort, and NTFS's listing, put it after.
  const files = [["B.txt", "upper"], ["a.txt", "ş"], ["sub/z.txt", ""]];
  fs.mkdirSync(path.join(dir, "sub"));
  for (const [rel, content] of files) fs.writeFileSync(path.join(dir, rel), content);
  const expected = crypto.createHash("sha256");
  for (const [rel, content] of files) {
    expected.update(`${rel}\0${Buffer.byteLength(content)}\0`);
    expected.update(content);
  }
  assert.equal(hashBundle(dir), `sha256:${expected.digest("hex")}`);
});

test("dependencyProblems wants remotion and every @remotion/* package under dependencies", () => {
  const remotion = { remotion: "4.0.532", "@remotion/cli": "4.0.532", "@remotion/renderer": "4.0.532" };
  assert.deepEqual(dependencyProblems({ dependencies: remotion, devDependencies: { typescript: "5.7.2" } }), []);
  assert.deepEqual(dependencyProblems({
    dependencies: { remotion: "4.0.532" },
    devDependencies: { "@remotion/cli": "4.0.532", "@remotion/fonts": "4.0.532", typescript: "5.7.2" },
  }), [
    "package.json: @remotion/cli must be under dependencies (the derived image runs npm ci --omit=dev)",
    "package.json: @remotion/renderer must be under dependencies (the derived image runs npm ci --omit=dev)",
    "package.json: @remotion/fonts must be under dependencies (the derived image runs npm ci --omit=dev)",
  ]);
});

test("prepareOutDir empties a previous pack, and refuses a dir holding anything else or holding the project", (t) => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const project = path.join(top, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "Root.tsx"), "source");

  const previous = path.join(project, "dist-pack");
  fs.mkdirSync(path.join(previous, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(previous, "pack-manifest.json"), "{}");
  fs.writeFileSync(path.join(previous, "bundle", "index.html"), "old");
  prepareOutDir(previous, project);
  assert.deepEqual(fs.readdirSync(previous), []);

  // A mistyped --out: the sources must survive, untouched.
  assert.throws(() => prepareOutDir(path.join(project, "src"), project), /holds Root\.tsx, which build-pack did not write/);
  assert.equal(fs.readFileSync(path.join(project, "src", "Root.tsx"), "utf8"), "source");
  assert.throws(() => prepareOutDir(project, project), /must not be the project dir or contain it/);
  assert.throws(() => prepareOutDir(top, project), /must not be the project dir or contain it/);
  assert.equal(fs.readFileSync(path.join(project, "src", "Root.tsx"), "utf8"), "source");

  const fresh = path.join(top, "fresh", "out");
  prepareOutDir(fresh, project);
  assert.ok(fs.statSync(fresh).isDirectory());
});

test("hashBundle refuses a link in the bundle rather than hash or follow it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "real"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  // A junction needs no privilege on Windows, and is an ordinary symlink elsewhere.
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linked"), "junction");
  assert.throws(() => hashBundle(dir), /bundle\/linked: neither a file nor a directory/);
});

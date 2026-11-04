// The zod 4 vocabulary gate scripts/build-pack.mjs runs on every composition's schema, and its composition
// discovery (scripts/lib/zod-gate.mjs, design 5.4, docs/CONTRACT-pack.md). The file rules are in pack-files.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z as z3 } from "zod";
import { z, toJSONSchema } from "zod/v4";

const SERVICE = path.join(import.meta.dirname, "..", "dist-service", "service");
if (!fs.existsSync(path.join(SERVICE, "constants.js"))) {
  throw new Error("dist-service/service/constants.js does not exist. Run `npm run build:service` first; "
    + "the zod gate reads its limits from the service build.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const service = (name) => import(pathToFileURL(path.join(SERVICE, name)).href);
const { MAX_EXPANDED_NODES, MAX_SCHEMA_DEPTH, MAX_TEMPLATE_ID } = await service("constants.js");
const { checkSchemaVocabulary } = await service("templates.js");
const {
  boundsSurvived, compositionProblems, discoverCompositions, gateSchema, zodMajor,
} = await import("../scripts/lib/zod-gate.mjs");

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
  // A second regex exports as allOf, a keyword the service refuses and the author never wrote.
  ["two .regex() calls", () => z.string().max(7).regex(/a/).regex(/b/), () => z.string().max(7).regex(/a/),
    /at most one \.regex\(\) per string/],
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

test("boundsSurvived reports a literal whose const the export lost", () => {
  const schema = z.strictObject({ kind: z.literal("card") });
  const exported = toJSONSchema(schema);
  assert.deepEqual(boundsSurvived(schema, exported), []);
  delete exported.properties.kind.const;
  assert.deepEqual(boundsSurvived(schema, exported), ["<root>.kind: const missing from the export"]);
});

test("boundsSurvived reports each side of a lost .length(N), on a string and on an array", () => {
  const schema = z.strictObject({ code: z.string().length(3), list: z.array(z.boolean()).length(3) });
  const exported = toJSONSchema(schema);
  assert.deepEqual(boundsSurvived(schema, exported), []);
  delete exported.properties.code.maxLength;
  delete exported.properties.list.maxItems;
  assert.deepEqual(boundsSurvived(schema, exported), [
    "<root>.code: maxLength 3 missing from the export",
    "<root>.list: maxItems 3 missing from the export",
  ]);
  delete exported.properties.code.minLength;
  delete exported.properties.list.minItems;
  assert.deepEqual(boundsSurvived(schema, exported), [
    "<root>.code: maxLength 3 missing from the export",
    "<root>.code: minLength 3 missing from the export",
    "<root>.list: maxItems 3 missing from the export",
    "<root>.list: minItems 3 missing from the export",
  ]);
});

test("boundsSurvived reports a lost exclusive bound, and an inclusive one at the same value as lost too", () => {
  const schema = z.strictObject({ ratio: z.number().gt(0).lt(1) });
  const exported = toJSONSchema(schema);
  assert.deepEqual(boundsSurvived(schema, exported), []);
  const ratio = exported.properties.ratio;
  delete ratio.exclusiveMinimum;
  delete ratio.exclusiveMaximum;
  assert.deepEqual(boundsSurvived(schema, exported), [
    "<root>.ratio: exclusiveMinimum 0 missing from the export",
    "<root>.ratio: exclusiveMaximum 1 missing from the export",
  ]);
  // minimum 0 admits 0, which .gt(0) refuses; minimum 0.25 and maximum 0.75 are tighter, and count.
  Object.assign(ratio, { minimum: 0, maximum: 1 });
  assert.equal(boundsSurvived(schema, exported).length, 2);
  Object.assign(ratio, { minimum: 0.25, maximum: 0.75 });
  assert.deepEqual(boundsSurvived(schema, exported), []);
});

// The export must not admit what the strict object refuses: a property zod does not know, or a value of another type.
test("boundsSurvived reports a property the export adds to a strict object", () => {
  const added = z.strictObject({ a: z.string().max(5) }).meta({
    properties: { a: { type: "string", maxLength: 5 }, extra: { type: "string", maxLength: 5 } },
  });
  assert.deepEqual(gateSchema(added), []);
  assert.deepEqual(checkSchemaVocabulary(toJSONSchema(added)), []);
  assert.deepEqual(boundsSurvived(added, toJSONSchema(added)), ['<root>: the export admits property "extra", which zod refuses']);

  const nested = realistic();
  const exported = toJSONSchema(nested);
  exported.properties.players.items.properties["full name"] = { type: "string", maxLength: 3 };
  assert.deepEqual(boundsSurvived(nested, exported), [
    '<root>.players[]: the export admits property "full name", which zod refuses',
  ]);
});

test("boundsSurvived reports an exported type zod refuses, or a type the export lost", () => {
  const retyped = z.strictObject({ a: z.string().max(5).meta({ type: "number", minimum: 0, maximum: 1 }) });
  assert.deepEqual(gateSchema(retyped), []);
  assert.deepEqual(checkSchemaVocabulary(toJSONSchema(retyped)), []);
  assert.deepEqual(boundsSurvived(retyped, toJSONSchema(retyped)), ['<root>.a: the export admits type "number", which zod refuses']);

  // An integer exported as any number admits 0.5, which zod refuses. A number exported as an integer is tighter.
  const counts = z.strictObject({ n: z.int().min(0).max(5), m: z.number().int().min(0).max(5), x: z.number().min(0).max(1) });
  const exported = toJSONSchema(counts);
  assert.deepEqual(boundsSurvived(counts, exported), []);
  exported.properties.x.type = "integer";
  assert.deepEqual(boundsSurvived(counts, exported), []);
  exported.properties.n.type = "number";
  exported.properties.m.type = "number";
  assert.deepEqual(boundsSurvived(counts, exported), [
    '<root>.n: the export admits type "number", which zod refuses',
    '<root>.m: the export admits type "number", which zod refuses',
  ]);

  const kinds = z.strictObject({
    s: z.string().max(5), on: z.boolean(), list: z.array(z.boolean()).max(2), box: z.strictObject({}),
  });
  const lost = toJSONSchema(kinds);
  delete lost.properties.s.type;
  lost.properties.on.type = ["boolean", "null"];
  lost.properties.list.type = "object";
  lost.properties.box.type = "array";
  assert.deepEqual(boundsSurvived(kinds, lost), [
    "<root>.s: type string missing from the export",
    '<root>.on: the export admits type "null", which zod refuses',
    '<root>.list: the export admits type "object", which zod refuses',
    '<root>.box: the export admits type "array", which zod refuses',
  ]);
});

/** `levels` strict objects, each holding the one below twice: a DAG of 2^(levels+1) - 1 nodes once expanded. */
const dag = (levels) => {
  let node = z.string().max(1);
  for (let i = 0; i < levels; i += 1) node = z.strictObject({ a: node, b: node });
  return node;
};
/** The export of dag(levels), each level one $defs entry, so the JSON stays small however deep the DAG is. */
const dagExport = (levels) => {
  const $defs = { L0: { type: "string", maxLength: 1 } };
  for (let i = 1; i <= levels; i += 1) {
    const below = { $ref: `#/$defs/L${i - 1}` };
    $defs[`L${i}`] = { type: "object", properties: { a: below, b: below }, required: ["a", "b"], additionalProperties: false };
  }
  return { $ref: `#/$defs/L${levels}`, $defs };
};
const BUDGET = `<root>: schema expands past ${MAX_EXPANDED_NODES} nodes, counting a shared subschema at each use`;

test("gateSchema and boundsSurvived stop at the service's node budget, so a shared subschema is never walked exponentially", () => {
  // 8191 nodes pass; 16383 do not. Each is far below the depth limit, so the budget is the only rule they meet.
  assert.deepEqual(gateSchema(dag(12)), []);
  assert.deepEqual(boundsSurvived(dag(12), dagExport(12)), []);
  assert.deepEqual(gateSchema(dag(13)), [BUDGET]);
  assert.deepEqual(boundsSurvived(dag(13), dagExport(13)), [BUDGET]);
  // 2^41 - 1 nodes: without the budget, each walk would never return.
  const started = performance.now();
  assert.deepEqual(gateSchema(dag(40)), [BUDGET]);
  assert.deepEqual(boundsSurvived(dag(40), dagExport(40)), [BUDGET]);
  assert.ok(performance.now() - started < 5_000, `the walks took ${Math.round(performance.now() - started)} ms`);
});

// The gate refuses at build time what the service would refuse at startup, so its limits are the service's own.
test("the gate's limits are the service's: render_still's template_id, the schema depth and the node budget", async () => {
  const { TOOL_DEFS } = await service("tools.js");
  const templateId = TOOL_DEFS.render_still.inputSchema.template_id;
  const composition = (id) => ({ id, width: 64, height: 64, fps: 30, durationInFrames: 1, schema: base(), hasCalculateMetadata: false });
  for (const length of [MAX_TEMPLATE_ID, MAX_TEMPLATE_ID + 1]) {
    const id = "a".repeat(length);
    assert.equal(compositionProblems([composition(id)]).length === 0, templateId.safeParse(id).success, `an id of ${length}`);
  }
  assert.equal(templateId.safeParse("a".repeat(MAX_TEMPLATE_ID + 1)).success, false);

  /** A chain of strict objects `depth` nodes deep, the root counted as 1: as deep in zod as in its export. */
  const chain = (depth) => {
    let node = z.string().max(5);
    for (let i = 1; i < depth; i += 1) node = z.strictObject({ n: node });
    return node;
  };
  /** A strict object of `nodes` nodes in all: the root, one optional field, and required fields. */
  const wide = (nodes) => z.strictObject(Object.fromEntries(Array.from({ length: nodes - 1 },
    (_, i) => [`f${i}`, i === 0 ? z.boolean().optional() : z.boolean()])));
  for (const [label, make, limit] of [["depth", chain, MAX_SCHEMA_DEPTH], ["nodes", wide, MAX_EXPANDED_NODES]]) {
    for (const size of [limit, limit + 1]) {
      const schema = make(size);
      const serviceAccepts = checkSchemaVocabulary(toJSONSchema(schema)).length === 0;
      assert.equal(serviceAccepts, size === limit, `the service at ${label} ${size}`);
      assert.equal(gateSchema(schema).length === 0, serviceAccepts, `the gate at ${label} ${size}`);
    }
  }
  assert.deepEqual(boundsSurvived(wide(MAX_EXPANDED_NODES), toJSONSchema(wide(MAX_EXPANDED_NODES))), []);
  assert.deepEqual(boundsSurvived(wide(MAX_EXPANDED_NODES + 1), toJSONSchema(wide(MAX_EXPANDED_NODES + 1))), [BUDGET]);
});

test("zod 3 schemas are refused with the clear message", () => {
  const schema = z3.object({ a: z3.string().max(10) }).strict();
  assert.equal(zodMajor(schema), 3);
  assert.equal(zodMajor(base()), 4);
  assert.deepEqual(gateSchema(schema), ["<root>: zod 3 is not supported, use zod 4"]);
});

test("gateSchema refuses a zod 3 node inside a zod 4 object, and a value that is no zod schema", () => {
  const mixed = z.strictObject({ b: z3.string().max(5) });
  assert.deepEqual(gateSchema(mixed), ["<root>.b: not a zod 4 schema"]);
  assert.deepEqual(boundsSurvived(mixed, { type: "object", properties: {}, additionalProperties: false }), []);
  for (const value of [undefined, null, {}, "z.string()", 5]) {
    assert.deepEqual(gateSchema(value), ["<root>: not a zod schema"], String(value));
  }
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

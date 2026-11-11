// Template packs: the loader, the JSON Schema gate and props validation (design 5.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z, toJSONSchema } from "zod/v4";

const REPO = path.join(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist-service");
const SERVICE = path.join(DIST, "service");
if (!fs.existsSync(path.join(SERVICE, "templates.js"))) {
  throw new Error("dist-service/service/templates.js does not exist. Run `npm run build:service` first; "
    + "the service tests import the compiled service build, not dist/.");
}
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const { loadPack, checkSchemaVocabulary, PackError } =
  await import(pathToFileURL(path.join(SERVICE, "templates.js")).href);
const { MAX_RASTER_PIXELS } = await import(pathToFileURL(path.join(DIST, "constants.js")).href);
const { MAX_TEMPLATE_ID } = await import(pathToFileURL(path.join(SERVICE, "constants.js")).href);
const { TOOL_DEFS } = await import(pathToFileURL(path.join(SERVICE, "tools.js")).href);

const PACKS = path.join(REPO, "test", "fixtures", "packs");
const GOOD = path.join(PACKS, "good");
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const TURKISH = "Beşiktaş · İstanbul · Şenol Güneş";
const CANARY = "CANARY-5e1b";

/** Props the good pack's `scoreboard` accepts; each case changes one thing. */
const validProps = () => ({
  label: "Final", color: "#1A2B3C", players: [{ name: "Ada", number: 10 }], theme: "dark", opacity: 0.5,
});

/** A strict object schema around `properties`, which is what the gate requires of every object. */
const obj = (properties, extra = {}) => ({ type: "object", properties, additionalProperties: false, ...extra });

/** The error loadPack throws for `dir`; fails the test when it loads instead. */
function refusal(dir) {
  try {
    loadPack(dir);
  } catch (err) {
    return err;
  }
  return assert.fail(`loadPack accepted ${dir}`);
}

/** A copy of the good pack in a fresh temp dir, removed after the test, with `edit` applied to its manifest. */
function tempPack(t, edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(GOOD, dir, { recursive: true });
  const file = path.join(dir, "pack-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest));
  return dir;
}

test("the good pack loads and lists its templates", () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(GOOD, "pack-manifest.json"), "utf8"));
  const pack = loadPack(GOOD);
  assert.equal(pack.dir, GOOD);
  assert.equal(pack.bundleDir, path.join(GOOD, "bundle"));
  assert.deepEqual(pack.manifest, onDisk);
  assert.deepEqual(pack.manifest.templates.map((t) => t.id), ["scoreboard", "swatch"]);
  assert.deepEqual(pack.template("scoreboard"), onDisk.templates[0]);
  assert.deepEqual(pack.template("swatch"), onDisk.templates[1]);

  // One validator per template: scoreboard's props are not swatch's.
  assert.deepEqual(pack.validateProps("scoreboard", validProps()), { ok: true });
  assert.deepEqual(pack.validateProps("swatch", { color: "#1A2B3C" }), { ok: true });
  assert.equal(pack.validateProps("swatch", validProps()).ok, false);
});

/** Each bad fixture pack, and exactly the problems it must be refused with. */
const BAD_PACKS = {
  "no-additional-false": ["/properties/x: additionalProperties: false required"],
  "unbounded-string": ["/properties/x: maxLength required"],
  "url-format": ["/properties/x: keyword format not allowed"],
  "no-maxitems": ["/properties/x: maxItems required"],
  "half-bounded-number": ["/properties/x: maximum or exclusiveMaximum required"],
  "hidden-in-oneof": ["/properties/x: keyword oneOf not allowed", "/properties/x: type required"],
  "unknown-keyword": ["/properties/x: keyword patternProperties not allowed"],
  "boolean-schema": ["/properties/x: boolean schema not allowed"],
  "zero-templates": ["/templates: at least one template required"],
  "duplicate-ids": ["/templates/1/id: duplicate of /templates/0/id"],
  oversize: [`/templates/0: width * height exceeds MAX_RASTER_PIXELS (${MAX_RASTER_PIXELS})`],
  "missing-bundle": ["bundle/index.html: file required"],
  "bundle-no-index": ["bundle/index.html: file required"],
};

test("each bad pack is refused with its problem named at the right pointer", () => {
  // Every fixture pack is covered here or is the good one.
  assert.deepEqual(fs.readdirSync(PACKS).sort(), ["good", ...Object.keys(BAD_PACKS)].sort());
  const oversize = JSON.parse(fs.readFileSync(path.join(PACKS, "oversize", "pack-manifest.json"), "utf8"));
  assert.ok(oversize.templates[0].width * oversize.templates[0].height > MAX_RASTER_PIXELS);

  for (const [name, expected] of Object.entries(BAD_PACKS)) {
    const err = refusal(path.join(PACKS, name));
    assert.ok(err instanceof PackError, `${name}: ${err}`);
    assert.equal(err.name, "PackError");
    // Exactly these: each fixture holds one hole, so it proves that one rule.
    assert.deepEqual(err.problems, expected, name);
  }
});

test("enum and const strings need no maxLength, and exclusive bounds count as bounds", () => {
  assert.deepEqual(checkSchemaVocabulary(obj({
    theme: { type: "string", enum: ["light", "dark"] },
    kind: { type: "string", const: "scoreboard" },
    untypedEnum: { enum: ["a", "b"] },
    untypedConst: { const: "x" },
    open: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    lowOpen: { type: "number", exclusiveMinimum: -1, maximum: 1 },
    highOpen: { type: "integer", minimum: 0, exclusiveMaximum: 10 },
  })), []);

  // Negative controls: a plain string still needs maxLength, and each side needs its own bound.
  assert.deepEqual(checkSchemaVocabulary(obj({ s: { type: "string" } })), ["/properties/s: maxLength required"]);
  assert.deepEqual(checkSchemaVocabulary(obj({ n: { type: "number", exclusiveMinimum: 0 } })),
    ["/properties/n: maximum or exclusiveMaximum required"]);
  assert.deepEqual(checkSchemaVocabulary(obj({ n: { type: "integer", exclusiveMaximum: 9 } })),
    ["/properties/n: minimum or exclusiveMinimum required"]);

  // At request time: the good pack's opacity is exclusiveMinimum 0, maximum 1, and its theme an enum.
  const pack = loadPack(GOOD);
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), opacity: 1, theme: "light" }), { ok: true });
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), opacity: 0 }), { ok: false, paths: ["/opacity"] });
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), theme: "neon" }), { ok: false, paths: ["/theme"] });
});

test("checkSchemaVocabulary reports nested and untyped holes at full pointers", () => {
  const check = (schema, expected) => assert.deepEqual(checkSchemaVocabulary(schema), expected, JSON.stringify(schema));
  const name = { type: "string", maxLength: 40 };
  const number = { type: "integer", minimum: 1, maximum: 99 };

  check(obj({ x: {} }), ["/properties/x: type required"]);
  check(obj({ x: { type: ["string", "null"] } }), ["/properties/x: type must be a single string"]);
  check(obj({ x: { type: "array", maxItems: 2 } }), ["/properties/x: items required"]);
  check(obj({ players: { type: "array", maxItems: 22, items: obj({ name: { type: "string" }, number }) } }),
    ["/properties/players/items/properties/name: maxLength required"]);
  check(obj({ x: { anyOf: [{ type: "string", maxLength: 3 }, { type: "string" }] } }),
    ["/properties/x/anyOf/1: maxLength required"]);
  check({ $defs: { Name: { type: "string" } }, ...obj({ x: { $ref: "#/$defs/Name" } }) },
    ["/$defs/Name: maxLength required"]);
  check(obj({ x: { $ref: "#/$defs/Missing" } }), ["/properties/x: $ref must name an existing #/$defs entry"]);

  // Positive controls: the same shapes, bounded, pass.
  check(obj({ players: { type: "array", maxItems: 22, items: obj({ name, number }) } }), []);
  check({ $defs: { Name: name }, ...obj({ x: { $ref: "#/$defs/Name" } }) }, []);

  // A $ref is exactly #/$defs/<name>: anything else is refused before the name is looked up.
  for (const $ref of ["#", "#/$defs", "#/$defs/", "#/$defs/Name/maxLength", "#/$defs/Name\n", "other.json#/$defs/Name",
    "#/properties/x", 7]) {
    check({ $defs: { Name: name }, ...obj({ x: { $ref } }) }, ["/properties/x: $ref must be #/$defs/<name>"]);
  }
  // Names are escaped per RFC 6901, and the root is the empty pointer.
  check(obj({ "a/b~c": { type: "string" } }), ["/properties/a~1b~0c: maxLength required"]);
  check({ type: "string" }, [": the root must be type object", ": maxLength required"]);
});

test("the vocabulary is closed: root-only keywords, literal false, schema-object items, usable limits", () => {
  const check = (schema, expected) => assert.deepEqual(checkSchemaVocabulary(schema), expected, JSON.stringify(schema));

  // Positive control: every allowed keyword at once.
  check({
    $schema: DRAFT,
    $defs: { Hex: { type: "string", minLength: 7, maxLength: 7, pattern: "^#[0-9a-f]{6}$" } },
    type: "object", title: "t", description: "d", default: {}, examples: [{}],
    properties: {
      color: { $ref: "#/$defs/Hex" },
      tags: { type: "array", minItems: 0, maxItems: 3, items: { type: "string", maxLength: 8 } },
      mode: { anyOf: [{ type: "string", const: "a" }, { type: "null" }] },
      n: { type: "integer", minimum: 0, maximum: 9 },
    },
    required: ["color"],
    additionalProperties: false,
  }, []);

  check({ $schema: "http://json-schema.org/draft-07/schema#", ...obj({}) },
    [`/$schema: must be ${DRAFT}`]);
  check({ $defs: [], ...obj({}) }, ["/$defs: must be an object"]);
  check(obj({ x: { $defs: {}, $schema: DRAFT, type: "boolean" } }),
    ["/properties/x: keyword $defs not allowed", "/properties/x: keyword $schema not allowed"]);
  check(obj({}, { additionalProperties: true }), [": additionalProperties must be false"]);
  check(obj({ x: { type: "object", properties: {}, additionalProperties: { type: "string", maxLength: 1 } } }),
    ["/properties/x: additionalProperties must be false"]);
  check(obj({ x: { type: "array", maxItems: 2, items: true } }), ["/properties/x/items: boolean schema not allowed"]);
  check(obj({ x: { type: "array", maxItems: 2, items: [{ type: "null" }] } }),
    ["/properties/x/items: schema must be an object"]);
  check(obj({ x: { anyOf: [] } }), ["/properties/x: anyOf must be a non-empty array"]);
  check(obj({ x: { type: "object", properties: [], additionalProperties: false } }),
    ["/properties/x: properties must be an object"]);

  // A limit counts only when it is one: a string, null or negative value is no bound.
  check(obj({ x: { type: "string", maxLength: "5" } }), ["/properties/x: maxLength required"]);
  check(obj({ x: { type: "array", maxItems: -1, items: { type: "null" } } }), ["/properties/x: maxItems required"]);
  check(obj({ x: { type: "number", minimum: null, maximum: 1 } }), ["/properties/x: minimum or exclusiveMinimum required"]);

  check(true, [": boolean schema not allowed"]);
  check(null, [": schema must be an object"]);
});

/** A string bounded to one character: what each ref below claims to reach. */
const ONE = { type: "string", maxLength: 1 };

/** Swatch's schema replaced by `schema`, in a temp copy of the good pack. */
const swatchPack = (t, schema) => tempPack(t, (m) => { m.templates[1].propsSchema = schema; });

test("a $ref is exactly #/$defs/<name> of [A-Za-z0-9_.-], so ajv follows the def the walker checked", (t) => {
  // Def `a` holds an unbounded string schema as its `default`, an annotation the walker never visits. Each ref
  // names a sibling def bounded to one character. ajv percent-decodes the fragment and splits it on "/", so a `live`
  // ref reaches $defs.a.default instead. The ~1 ref is not live, since ajv unescapes it to the sibling's name, but
  // that name holds a "/" all the same.
  const long = "y".repeat(200_000);
  for (const [key, $ref, live] of [
    ["a%2Fdefault", "#/$defs/a%2Fdefault", true],
    ["a%2fdefault", "#/$defs/a%2fdefault", true],
    ["a/default", "#/$defs/a~1default", false],
    ["a/default", "#/$defs/a/default", true],
  ]) {
    const schema = { $defs: { a: { type: "string", maxLength: 5, default: { type: "string" } }, [key]: ONE },
      ...obj({ x: { $ref } }) };
    // The premise: ajv itself lets the over-long string through a live ref.
    assert.equal(new Ajv2020({ strict: true }).compile(schema)({ x: long }), live, `ajv on ${$ref}`);
    assert.deepEqual(checkSchemaVocabulary(schema),
      ["/properties/x: $ref must be #/$defs/<name>", `/$defs/${key.replaceAll("/", "~1")}: def name not allowed`], $ref);
    assert.ok(refusal(swatchPack(t, schema)) instanceof PackError, $ref);
  }

  // A def name outside the charset is refused at its own pointer, whether or not a ref names it.
  assert.deepEqual(checkSchemaVocabulary({ $defs: { "Team Name": ONE, "Şenol": ONE, "": ONE, "a~b": ONE }, ...obj({}) }), [
    "/$defs/Team Name: def name not allowed",
    "/$defs/Şenol: def name not allowed",
    "/$defs/: def name not allowed",
    "/$defs/a~0b: def name not allowed",
  ]);

  // Positive control: a name drawing on every allowed class resolves, and ajv enforces that very def.
  const valid = { $defs: { "Label_1.v2": { type: "string", maxLength: 3 } }, ...obj({ x: { $ref: "#/$defs/Label_1.v2" } }) };
  assert.deepEqual(checkSchemaVocabulary(valid), []);
  const pack = loadPack(swatchPack(t, valid));
  assert.deepEqual(pack.validateProps("swatch", { x: "abc" }), { ok: true });
  assert.deepEqual(pack.validateProps("swatch", { x: "abcd" }), { ok: false, paths: ["/x"] });

  // The names zod 4 gives the defs it extracts keep to the charset.
  const Hex = z.string().max(7);
  const shared = toJSONSchema(z.strictObject({ a: Hex, b: Hex }), { reused: "ref" });
  assert.deepEqual(Object.keys(shared.$defs), ["__schema0"]);
  assert.deepEqual(checkSchemaVocabulary(shared), []);
});

test("a $ref may not reach its own def, directly or through others", (t) => {
  const direct = { $defs: { n: { type: "array", maxItems: 2, items: { $ref: "#/$defs/n" } } }, ...obj({ x: { $ref: "#/$defs/n" } }) };
  assert.deepEqual(checkSchemaVocabulary(direct), ["/$defs/n/items: recursive $ref not allowed"]);

  // a -> b -> c -> a; the root's own ref into the cycle is not on it.
  const indirect = {
    $defs: {
      a: obj({ next: { $ref: "#/$defs/b" } }),
      b: { type: "array", maxItems: 2, items: { $ref: "#/$defs/c" } },
      c: { anyOf: [{ $ref: "#/$defs/a" }, { type: "null" }] },
    },
    ...obj({ x: { $ref: "#/$defs/a" } }),
  };
  assert.deepEqual(checkSchemaVocabulary(indirect), [
    "/$defs/a/properties/next: recursive $ref not allowed",
    "/$defs/b/items: recursive $ref not allowed",
    "/$defs/c/anyOf/0: recursive $ref not allowed",
  ]);

  // Positive control: defs that share a def, with no cycle, pass.
  const shared = { $defs: { name: ONE, player: obj({ name: { $ref: "#/$defs/name" } }) },
    ...obj({ a: { $ref: "#/$defs/player" }, b: { $ref: "#/$defs/name" } }) };
  assert.deepEqual(checkSchemaVocabulary(shared), []);

  // Loaded, the direct cycle is a PackError; it used to load, and a 10 KB body then threw a RangeError.
  for (const schema of [direct, indirect]) {
    const err = refusal(swatchPack(t, schema));
    assert.ok(err instanceof PackError, String(err));
    assert.deepEqual(err.problems, checkSchemaVocabulary(schema));
  }
});

/** A schema `n` nodes deep, the root counted, nesting through `step`, around a null. */
function nested(n, step = (child) => obj({ x: child })) {
  let node = { type: "null" };
  for (let i = 1; i < n; i++) node = step(node);
  return node;
}

/** A string inside `n` arrays, or whatever `wrap` nests it in: a value `n` levels deep, where a scalar counts 0. */
function nestedValue(n, wrap = (v) => [v]) {
  let value = "v";
  for (let i = 0; i < n; i++) value = wrap(value);
  return value;
}

test("a schema nests at most 64 deep, and a far deeper one is a PackError, never a RangeError", (t) => {
  const tooDeep = (at) => [`${at}: schema nested too deeply`];
  assert.deepEqual(checkSchemaVocabulary(nested(64)), []);
  assert.deepEqual(checkSchemaVocabulary(nested(65)), tooDeep("/properties/x".repeat(64)));
  // Every way down counts: items, anyOf branches, and $defs entries, which sit one below the root. The root is an
  // object, so each chain starts one below it.
  const underRoot = (n, step) => obj({ x: nested(n - 1, step) });
  const items = (child) => ({ type: "array", maxItems: 1, items: child });
  assert.deepEqual(checkSchemaVocabulary(underRoot(64, items)), []);
  assert.deepEqual(checkSchemaVocabulary(underRoot(65, items)), tooDeep(`/properties/x${"/items".repeat(63)}`));
  const anyOf = (child) => ({ anyOf: [child] });
  assert.deepEqual(checkSchemaVocabulary(underRoot(64, anyOf)), []);
  assert.deepEqual(checkSchemaVocabulary(underRoot(65, anyOf)), tooDeep(`/properties/x${"/anyOf/0".repeat(63)}`));
  assert.deepEqual(checkSchemaVocabulary({ $defs: { d: nested(63) }, ...obj({}) }), []);
  assert.deepEqual(checkSchemaVocabulary({ $defs: { d: nested(64) }, ...obj({}) }),
    tooDeep(`/$defs/d${"/properties/x".repeat(63)}`));

  // The deepest allowed schema loads, and ajv validates against it.
  const deepest = loadPack(swatchPack(t, nested(64)));
  let props = null;
  for (let i = 1; i < 64; i++) props = { x: props };
  assert.deepEqual(deepest.validateProps("swatch", props), { ok: true });

  // 12 000 anyOf levels: the walk stops at the cap, so loadPack throws a PackError naming the first node past it.
  // JSON.stringify of so deep an object can overflow the runner's own stack, so the levels are spliced in as text.
  const dir = swatchPack(t, obj({ x: "DEEP" }));
  const file = path.join(dir, "pack-manifest.json");
  const levels = 12_000;
  fs.writeFileSync(file, fs.readFileSync(file, "utf8")
    .replace('"DEEP"', `${'{"anyOf":['.repeat(levels)}{"type":"null"}${"]}".repeat(levels)}`));
  const err = refusal(dir);
  assert.ok(err instanceof PackError, String(err));
  assert.deepEqual(err.problems, tooDeep(`/properties/x${"/anyOf/0".repeat(63)}`));

  // A default is no schema, but list_templates publishes it. 100 000 levels used to load, and JSON.stringify of the
  // manifest then threw a RangeError from about 5 000. Past 64 levels it is now a PackError, never a RangeError.
  const annotated = swatchPack(t, obj({ x: { type: "string", maxLength: 1, default: "DEEP" } }));
  const manifest = path.join(annotated, "pack-manifest.json");
  fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8")
    .replace('"DEEP"', `${"[".repeat(100_000)}${"]".repeat(100_000)}`));
  const deepDefault = refusal(annotated);
  assert.ok(deepDefault instanceof PackError, String(deepDefault));
  assert.deepEqual(deepDefault.problems, ["/properties/x/default: value nested too deeply"]);

  // Positive control: a 64-deep default loads, is frozen, and the manifest it sits in still serializes.
  const loaded = loadPack(swatchPack(t, obj({ x: { type: "string", maxLength: 1, default: nestedValue(64) } })));
  assert.ok(Object.isFrozen(loaded.template("swatch").propsSchema.properties.x.default));
  assert.ok(JSON.stringify(loaded.manifest).includes("[".repeat(64)));
  assert.deepEqual(loaded.validateProps("swatch", { x: "ab" }), { ok: false, paths: ["/x"] });
});

test("a const, enum, examples or default value nests at most 64 deep, so publishing or comparing it cannot overflow",
  (t) => {
    const tooDeep = (at) => [`${at}: value nested too deeply`];
    const string = { type: "string", maxLength: 1 };
    // Every place a value may sit; enum and examples count each element on its own.
    const places = [
      [(v) => obj({ x: { const: v } }), "/properties/x/const"],
      [(v) => obj({ x: { enum: ["a", v] } }), "/properties/x/enum/1"],
      [(v) => obj({ x: { ...string, examples: ["a", v] } }), "/properties/x/examples/1"],
      [(v) => obj({ x: { ...string, default: v } }), "/properties/x/default"],
      [(v) => ({ ...obj({}), default: v }), "/default"],
      [(v) => ({ $defs: { d: { const: v } }, ...obj({}) }), "/$defs/d/const"],
      [(v) => obj({ x: { type: "array", maxItems: 1, items: { enum: [v] } } }), "/properties/x/items/enum/0"],
    ];
    const inObject = (v) => ({ a: v });
    for (const [schemaOf, at] of places) {
      assert.deepEqual(checkSchemaVocabulary(schemaOf(nestedValue(64))), [], at);
      assert.deepEqual(checkSchemaVocabulary(schemaOf(nestedValue(65))), tooDeep(at), at);
      // Objects nest as arrays do.
      assert.deepEqual(checkSchemaVocabulary(schemaOf(nestedValue(64, inObject))), [], at);
      assert.deepEqual(checkSchemaVocabulary(schemaOf(nestedValue(65, inObject))), tooDeep(at), at);
      // The measure keeps its own stack: far past the cap is a problem, never a RangeError.
      assert.deepEqual(checkSchemaVocabulary(schemaOf(nestedValue(100_000))), tooDeep(at), at);
    }
    // examples that is not an array is measured whole (ajv refuses it later in any case).
    assert.deepEqual(checkSchemaVocabulary(obj({ x: { ...string, examples: { a: nestedValue(63) } } })), []);
    assert.deepEqual(checkSchemaVocabulary(obj({ x: { ...string, examples: { a: nestedValue(64) } } })),
      tooDeep("/properties/x/examples"));

    // A 12 000-deep const used to load, and a matching 24 KB body then made ajv's deep-equal throw a RangeError.
    // The levels are spliced in as text, as JSON.stringify of so deep a value overflows the runner's own stack.
    const dir = swatchPack(t, obj({ x: { const: "DEEP" } }));
    const file = path.join(dir, "pack-manifest.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8")
      .replace('"DEEP"', `${"[".repeat(12_000)}${"]".repeat(12_000)}`));
    const err = refusal(dir);
    assert.ok(err instanceof PackError, String(err));
    assert.deepEqual(err.problems, tooDeep("/properties/x/const"));

    // Positive control at request time: a 64-deep const loads, and ajv compares a caller value against it.
    const pack = loadPack(swatchPack(t, obj({ x: { const: nestedValue(64) } })));
    assert.deepEqual(pack.validateProps("swatch", { x: nestedValue(64) }), { ok: true });
    assert.deepEqual(pack.validateProps("swatch", { x: nestedValue(64, inObject) }), { ok: false, paths: ["/x"] });
    assert.deepEqual(pack.validateProps("swatch", { x: nestedValue(12_000) }), { ok: false, paths: ["/x"] });
    assert.ok(JSON.stringify(pack.manifest).includes("[".repeat(64)));
  });

/**
 * `n` defs, each an anyOf of two refs to the next, ending in a null: 2^n paths for ajv to try. Expanded, with a ref
 * node counted as 1 plus its def, d_k holds 3 + 2 * size(d_k+1) nodes, so d_0 holds 2^(n+2) - 3, and the root,
 * with its property node, 2^(n+2) - 1.
 */
function fanOut(n) {
  const $defs = {};
  for (let k = 0; k < n; k++) $defs[`d${k}`] = { anyOf: [{ $ref: `#/$defs/d${k + 1}` }, { $ref: `#/$defs/d${k + 1}` }] };
  $defs[`d${n}`] = { type: "null" };
  return { $defs, ...obj({ x: { $ref: "#/$defs/d0" } }) };
}

test("a schema expands, each $ref in place, to at most 10000 nodes, so anyOf fan-out cannot stall validation", (t) => {
  const tooBig = [": schema expands past 10000 nodes"];
  // 2^13 - 1 = 8191 nodes pass; 2^14 - 1 = 16383 do not.
  assert.deepEqual(checkSchemaVocabulary(fanOut(11)), []);
  assert.deepEqual(checkSchemaVocabulary(fanOut(12)), tooBig);

  // n = 22 used to load, and validating {x: "s"} against it then took 1.7 s. It is refused, well under a second.
  const dir = swatchPack(t, fanOut(22));
  const started = performance.now();
  assert.deepEqual(checkSchemaVocabulary(fanOut(22)), tooBig);
  const err = refusal(dir);
  const elapsed = performance.now() - started;
  assert.ok(err instanceof PackError, String(err));
  assert.deepEqual(err.problems, tooBig);
  assert.match(err.message, /\/templates\/1\/propsSchema: schema expands past 10000 nodes/);
  assert.ok(elapsed < 1000, `the refusal took ${elapsed} ms`);

  // Exactly at the budget: def a holds 99 nulls, so 100 nodes, and each of the root's 99 refs to it is 1 + 100, so the
  // root holds 1 + 99 * 101 = 10000. A def counts once per ref to it, and never in place. One null more is 10001.
  const props = (count, node) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, node]));
  const atBudget = { $defs: { a: obj(props(99, { type: "null" })) }, ...obj(props(99, { $ref: "#/$defs/a" })) };
  assert.deepEqual(checkSchemaVocabulary(atBudget), []);
  assert.deepEqual(checkSchemaVocabulary({ ...atBudget, properties: { ...atBudget.properties, q: { type: "null" } } }),
    tooBig);
  const edge = loadPack(swatchPack(t, atBudget));
  const nulls = Object.fromEntries(Array.from({ length: 99 }, (_, i) => [`p${i}`, null]));
  assert.deepEqual(edge.validateProps("swatch", { p0: nulls, p98: nulls }), { ok: true });
  assert.deepEqual(edge.validateProps("swatch", { p0: { ...nulls, p50: 0 } }), { ok: false, paths: ["/p0/p50"] });

  // A def shared from many places stays within the budget. Def one sits in 50 rows of 50 refs, 2500 places in all:
  // a row is 1 + 50 * (1 + 1) = 101 nodes, and the root 1 + 50 * (1 + 101) = 5101.
  const shared = { $defs: { one: ONE, row: obj(props(50, { $ref: "#/$defs/one" })) },
    ...obj(props(50, { $ref: "#/$defs/row" })) };
  assert.deepEqual(checkSchemaVocabulary(shared), []);
  const many = loadPack(swatchPack(t, shared));
  assert.deepEqual(many.validateProps("swatch", { p0: { p0: "a", p49: "b" }, p49: { p1: "c" } }), { ok: true });
  assert.deepEqual(many.validateProps("swatch", { p49: { p49: "bb" } }), { ok: false, paths: ["/p49/p49"] });

  // The good pack and the realistic zod export stay well inside it.
  assert.equal(loadPack(GOOD).manifest.templates.length, 2);
});

test("the expansion count visits each def once: 200 levels of fan-out, 2^202 nodes expanded, are refused at once", () => {
  // A count that followed every ref would never finish, so it runs in a child with a deadline, not in this runner.
  const child = `const [, moduleUrl] = process.argv;
const { checkSchemaVocabulary } = await import(moduleUrl);
const $defs = {};
for (let k = 0; k < 200; k++) $defs["d" + k] = { anyOf: [{ $ref: "#/$defs/d" + (k + 1) }, { $ref: "#/$defs/d" + (k + 1) }] };
$defs.d200 = { type: "null" };
const started = performance.now();
const problems = checkSchemaVocabulary({ $defs, type: "object", additionalProperties: false,
  properties: { x: { $ref: "#/$defs/d0" } } });
process.stdout.write(JSON.stringify({ problems, elapsed: performance.now() - started }));`;
  const run = spawnSync(process.execPath,
    ["--input-type=module", "-e", child, pathToFileURL(path.join(SERVICE, "templates.js")).href],
    { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.error?.code, undefined, "the count did not finish within 20 s: it followed every ref");
  assert.equal(run.status, 0, run.stderr);
  const { problems, elapsed } = JSON.parse(run.stdout);
  assert.deepEqual(problems, [": schema expands past 10000 nodes"]);
  assert.ok(elapsed < 1000, `the count took ${elapsed} ms`);
});

// A spread call, push(...list), passes each element as its own argument, and V8 caps how many a call can take: past
// about 130 000 it throws RangeError. The two lists below are as long as a manifest makes them, so neither is spread.
test("a def that fans in 200 000 refs is refused as too big, never a RangeError out of the expansion count", (t) => {
  // Def a is an anyOf of 200 000 refs to def b, so the count meets 200 000 unsized targets of one def at once.
  const fanIn = { $defs: { a: { anyOf: Array.from({ length: 200_000 }, () => ({ $ref: "#/$defs/b" })) },
    b: { type: "null" } }, ...obj({ x: { $ref: "#/$defs/a" } }) };
  const tooBig = [": schema expands past 10000 nodes"];
  const err = refusal(swatchPack(t, fanIn));
  assert.ok(err instanceof PackError, String(err));
  assert.deepEqual(err.problems, tooBig);
  assert.deepEqual(checkSchemaVocabulary(fanIn), tooBig);
});

test("a manifest of 200 000 templates is a PackError naming each, never a RangeError", (t) => {
  const err = refusal(tempPack(t, (m) => { m.templates = Array.from({ length: 200_000 }, () => 0); }));
  assert.ok(err instanceof PackError, String(err));
  assert.equal(err.problems.length, 200_000);
  assert.equal(err.problems[0], "/templates/0: object required");
  assert.equal(err.problems.at(-1), "/templates/199999: object required");
});

test("a number with const or a non-empty enum needs no bounds, and an enum counts only as a non-empty array", (t) => {
  // zod 4 exports z.literal(5) as a const number, and z.enum as a string enum.
  const literals = toJSONSchema(z.strictObject({ n: z.literal(5), e: z.enum(["a", "b"]) }));
  assert.deepEqual(literals.properties, { n: { type: "number", const: 5 }, e: { type: "string", enum: ["a", "b"] } });
  assert.deepEqual(checkSchemaVocabulary(literals), []);
  assert.deepEqual(checkSchemaVocabulary(obj({ i: { type: "integer", const: 3 }, m: { type: "number", enum: [1, 2.5] } })), []);

  // A null or empty enum is no enum: the bounds are required again.
  assert.deepEqual(checkSchemaVocabulary(obj({ x: { type: "string", enum: null } })), ["/properties/x: maxLength required"]);
  assert.deepEqual(checkSchemaVocabulary(obj({ x: { type: "string", enum: [] } })), ["/properties/x: maxLength required"]);
  assert.deepEqual(checkSchemaVocabulary(obj({ x: { type: "number", enum: [] } })),
    ["/properties/x: minimum or exclusiveMinimum required", "/properties/x: maximum or exclusiveMaximum required"]);
  assert.deepEqual(checkSchemaVocabulary(obj({ x: { type: "integer", enum: null, maximum: 9 } })),
    ["/properties/x: minimum or exclusiveMinimum required"]);

  // At request time the literal still holds.
  const pack = loadPack(swatchPack(t, literals));
  assert.deepEqual(pack.validateProps("swatch", { n: 5, e: "a" }), { ok: true });
  assert.deepEqual(pack.validateProps("swatch", { n: 6, e: "a" }), { ok: false, paths: ["/n"] });
});

test("the zod 4 toJSONSchema export of the realistic template passes the gate", () => {
  const realistic = z.strictObject({
    label: z.string().max(40),
    color: z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/),
    players: z.array(z.strictObject({ name: z.string().max(40), number: z.number().int().min(1).max(99) })).max(22),
    theme: z.enum(["light", "dark"]),
    opacity: z.number().gt(0).lte(1),
    short: z.string().max(5).optional(),
  });
  const exported = toJSONSchema(realistic);
  assert.deepEqual(checkSchemaVocabulary(exported), []);
  // The good pack's scoreboard schema is this very export, so the loader tests run on a realistic schema.
  assert.deepEqual(loadPack(GOOD).template("scoreboard").propsSchema, exported);
});

test("invalid props map to pointers and never echo values", (t) => {
  const pack = loadPack(GOOD);
  const noLabel = validProps();
  delete noLabel.label;
  const cases = [
    [{ ...validProps(), players: [{ name: CANARY.padEnd(41, "x"), number: 7 }] }, ["/players/0/name"]],
    [noLabel, ["/label"]],
    [{ ...validProps(), extra: CANARY }, ["/extra"]],
    [{ ...validProps(), "a/b~c": CANARY }, ["/a~1b~0c"]],
    // maxLength fails at /color, and validation stops there: pattern never runs on the over-long string.
    [{ ...validProps(), color: `${CANARY}-too-long` }, ["/color"]],
    [{ ...validProps(), theme: CANARY }, ["/theme"]],
    [{ ...validProps(), players: [{ name: "Ada", number: 100 }] }, ["/players/0/number"]],
    [{ ...validProps(), players: [{ number: 7 }] }, ["/players/0/name"]],
    [{ ...validProps(), players: Array.from({ length: 23 }, () => ({ name: CANARY, number: 1 })) }, ["/players"]],
    // Validation stops at the first failing keyword, here the first missing required prop.
    [JSON.parse(`{"__proto__": "${CANARY}"}`), ["/label"]],
    // An own `__proto__` key from JSON.parse is an unknown key like any other.
    [JSON.parse(`{"__proto__": "${CANARY}", ${JSON.stringify(validProps()).slice(1)}`), ["/__proto__"]],
    [null, [""]],
    [[CANARY], [""]],
  ];
  for (const [props, paths] of cases) {
    const result = pack.validateProps("scoreboard", props);
    assert.equal(result.ok, false, JSON.stringify(props));
    assert.deepEqual([...result.paths].sort(), [...paths].sort(), JSON.stringify(props));
    assert.equal(new Set(result.paths).size, result.paths.length, "each path is named once");
    assert.ok(!JSON.stringify(result).includes(CANARY), `the result echoes a value: ${JSON.stringify(result)}`);
  }
  // The plan's exact shapes.
  assert.deepEqual(pack.validateProps("scoreboard", cases[0][0]), { ok: false, paths: ["/players/0/name"] });
  assert.deepEqual(pack.validateProps("scoreboard", noLabel), { ok: false, paths: ["/label"] });
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), extra: CANARY }), { ok: false, paths: ["/extra"] });
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), "a/b~c": 1 }), { ok: false, paths: ["/a~1b~0c"] });

  // anyOf reports each failing branch and then itself, all at one path: the path is still named once.
  const union = loadPack(tempPack(t, (m) => {
    m.templates[1].propsSchema.properties.color =
      { anyOf: [{ type: "string", maxLength: 3 }, { type: "integer", minimum: 0, maximum: 9 }] };
  }));
  assert.deepEqual(union.validateProps("swatch", { color: CANARY }), { ok: false, paths: ["/color"] });
});

/** The good pack's color pattern; the spy below records what this regex is run on. */
const COLOR_PATTERN = "^#[0-9a-fA-F]{6}$";

test("A13: a pack's pattern never sees a caller string past its maxLength or outside its enum", (t) => {
  // The gate lets an enum string carry a pattern with no maxLength; swatch gains one, beside its bounded color.
  const pack = loadPack(tempPack(t, (m) => {
    m.templates[1].propsSchema.properties.tone = { type: "string", enum: ["#000000", "#FFFFFF"], pattern: COLOR_PATTERN };
  }));
  assert.equal(pack.template("swatch").propsSchema.properties.color.pattern, COLOR_PATTERN);

  const realTest = RegExp.prototype.test;
  const lengths = [];
  /** The result, and the code-point length of every string the color pattern was run on meanwhile. */
  const validate = (id, props) => {
    lengths.length = 0;
    RegExp.prototype.test = function spy(s) {
      if (this.source === COLOR_PATTERN) lengths.push([...String(s)].length);
      return realTest.call(this, s);
    };
    try {
      return { result: pack.validateProps(id, props), lengths: [...lengths] };
    } finally {
      RegExp.prototype.test = realTest;
    }
  };

  // Positive control: the spy does see the pattern run, on an in-bounds color.
  assert.deepEqual(validate("swatch", { color: "#1A2B3C" }), { result: { ok: true }, lengths: [7] });
  assert.deepEqual(validate("swatch", { color: "#1A2B3C", tone: "#FFFFFF" }), { result: { ok: true }, lengths: [7, 7] });

  // Past maxLength 7, or outside the enum, the pattern must not run: a backtracking regex would stall on it.
  const long = `#${"a".repeat(100_000)}`;
  assert.deepEqual(validate("swatch", { color: long }), { result: { ok: false, paths: ["/color"] }, lengths: [] });
  assert.deepEqual(validate("scoreboard", { ...validProps(), color: long }),
    { result: { ok: false, paths: ["/color"] }, lengths: [] });
  assert.deepEqual(validate("swatch", { color: "#1A2B3C", tone: long }),
    { result: { ok: false, paths: ["/tone"] }, lengths: [7] });
});

test("A13: a catastrophic pack pattern cannot stall validation with a string past maxLength", (t) => {
  // ^(a+)+$ backtracks exponentially on "aaa…!". The props string is far past maxLength 5, so validation must
  // stop at maxLength: were the pattern run on it, the event loop would block for hours. The check runs in a
  // child with a deadline, because a synchronous stall would hang this runner rather than fail the test.
  const dir = tempPack(t, (m) => {
    m.templates[1].propsSchema.properties.color = { type: "string", maxLength: 5, pattern: "^(a+)+$" };
  });
  const child = `const [, moduleUrl, packDir] = process.argv;
const { loadPack } = await import(moduleUrl);
const pack = loadPack(packDir);
process.stdout.write(JSON.stringify([pack.validateProps("swatch", { color: "a".repeat(64) + "!" }),
  pack.validateProps("swatch", { color: "aaaaa" })]));`;
  const run = spawnSync(process.execPath,
    ["--input-type=module", "-e", child, pathToFileURL(path.join(SERVICE, "templates.js")).href, dir],
    { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.error?.code, undefined, "validation did not finish within 20 s: the pattern ran past maxLength");
  assert.equal(run.status, 0, run.stderr);
  // The second result is the positive control: the pattern does apply within maxLength.
  assert.deepEqual(JSON.parse(run.stdout), [{ ok: false, paths: ["/color"] }, { ok: true }]);
});

test("REVIEW FOCUS 2: Turkish text validates, and maxLength counts code points", () => {
  const pack = loadPack(GOOD);
  assert.ok([...TURKISH].length <= 40);
  assert.deepEqual(pack.validateProps("scoreboard",
    { ...validProps(), label: TURKISH, players: [{ name: TURKISH, number: 1 }] }), { ok: true });

  // ş is one code point and two UTF-8 bytes: 40 pass the 40 limit, 41 do not.
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), label: "ş".repeat(40) }), { ok: true });
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), label: "ş".repeat(41) }),
    { ok: false, paths: ["/label"] });

  // An emoji is one code point and two UTF-16 code units, so a code-unit count would refuse five.
  const five = "😀".repeat(5);
  assert.equal(five.length, 10);
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), short: five }), { ok: true });
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), short: "😀".repeat(6) }),
    { ok: false, paths: ["/short"] });
});

test("template() returns undefined for an unknown id", () => {
  const pack = loadPack(GOOD);
  // "Scoreboard" is a compositionId, not a template id; the rest live on Object.prototype.
  for (const id of ["nope", "", "Scoreboard", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(pack.template(id), undefined, id);
  }
});

test("validateProps throws for an unknown id rather than passing its props", () => {
  const pack = loadPack(GOOD);
  for (const id of ["nope", "__proto__", "constructor"]) {
    assert.throws(() => pack.validateProps(id, validProps()),
      (err) => err instanceof Error && !(err instanceof PackError) && /no such template/.test(err.message), id);
  }
});

test("the manifest's own fields are checked, so a hole cannot slip past the pixel bound", (t) => {
  const problemsOf = (edit) => refusal(tempPack(t, edit)).problems;
  const first = (edit) => (m) => edit(m.templates[0]);

  assert.deepEqual(problemsOf(first((e) => { delete e.width; })), ["/templates/0/width: positive integer required"]);
  assert.deepEqual(problemsOf(first((e) => { e.height = "720"; })), ["/templates/0/height: positive integer required"]);
  assert.deepEqual(problemsOf(first((e) => { e.width = 1.5; })), ["/templates/0/width: positive integer required"]);
  assert.deepEqual(problemsOf(first((e) => { e.maxFrames = 0; })), ["/templates/0/maxFrames: integer >= 1 required"]);
  assert.deepEqual(problemsOf(first((e) => { e.maxFrames = 2.5; })), ["/templates/0/maxFrames: integer >= 1 required"]);
  assert.deepEqual(problemsOf(first((e) => { e.defaultFps = 0; })), ["/templates/0/defaultFps: positive number required"]);
  assert.deepEqual(problemsOf(first((e) => { e.id = ""; })), ["/templates/0/id: non-empty string required"]);
  assert.deepEqual(problemsOf(first((e) => { delete e.compositionId; })),
    ["/templates/0/compositionId: non-empty string required"]);
  assert.deepEqual(problemsOf(first((e) => { delete e.propsSchema; })), [": schema must be an object"]);
  assert.deepEqual(problemsOf((m) => { delete m.packHash; }), ["/packHash: non-empty string required"]);
  assert.deepEqual(problemsOf((m) => { m.remotionVersion = 4; }), ["/remotionVersion: non-empty string required"]);
  assert.deepEqual(problemsOf((m) => { m.templates = {}; }), ["/templates: array required"]);
  assert.deepEqual(problemsOf((m) => { m.templates[1] = 5; }), ["/templates/1: object required"]);
  assert.deepEqual(problemsOf(first((e) => { e.width = 8000; e.height = 8001; })),
    [`/templates/0: width * height exceeds MAX_RASTER_PIXELS (${MAX_RASTER_PIXELS})`]);

  // Boundaries: exactly MAX_RASTER_PIXELS and a single frame load. Unknown fields are dropped.
  assert.equal(8000 * 8000, MAX_RASTER_PIXELS);
  const edge = loadPack(tempPack(t, first((e) => { e.width = 8000; e.height = 8000; e.maxFrames = 1; e.note = "x"; })));
  assert.equal(edge.template("scoreboard").width * edge.template("scoreboard").height, MAX_RASTER_PIXELS);
  assert.equal(edge.template("scoreboard").maxFrames, 1);
  assert.equal("note" in edge.template("scoreboard"), false);
});

test("compositionId keeps to Remotion's composition id rule and never starts with '-'", (t) => {
  // The id reaches the Remotion CLI as a positional argument: a leading '-' would read as a flag.
  const rule = "/templates/0/compositionId: only a-z, A-Z, 0-9, CJK and '-' allowed, and no leading '-'";
  const withId = (id) => tempPack(t, (m) => { m.templates[0].compositionId = id; });
  for (const id of ["-Scoreboard", "--props=x", "Score board", "Score_board", "Score.board", "a/b", "Şenol", "x\n"]) {
    assert.deepEqual(refusal(withId(id)).problems, [rule], JSON.stringify(id));
  }
  // Positive controls: Remotion's own charset, CJK and an inner '-' included.
  for (const id of ["Score-board-2", "比分", "S"]) assert.equal(loadPack(withId(id)).template("scoreboard").compositionId, id);
});

test("a template id is at most MAX_TEMPLATE_ID characters, the most render_still accepts, in the composition-id charset",
  (t) => {
    const templateId = TOOL_DEFS.render_still.inputSchema.template_id;
    const tooLong = `/templates/0/id: longer than ${MAX_TEMPLATE_ID} characters, the most render_still accepts as a template_id`;
    const charset = "/templates/0/id: only a-z, A-Z, 0-9, CJK and '-' allowed, and no leading '-'";
    const withId = (id) => tempPack(t, (m) => { m.templates[0].id = id; });

    // One past render_still's own limit, read from the same constant: the SDK would refuse every call naming it.
    const over = "s".repeat(MAX_TEMPLATE_ID + 1);
    assert.equal(templateId.safeParse(over).success, false, "control: render_still refuses this id");
    const err = refusal(withId(over));
    assert.ok(err instanceof PackError, String(err));
    assert.deepEqual(err.problems, [tooLong]);
    assert.ok(err.message.includes(tooLong), "the problem is located in the manifest");
    // Counted in UTF-16 units, as zod's max() counts them.
    assert.deepEqual(refusal(withId("比".repeat(MAX_TEMPLATE_ID + 1))).problems, [tooLong]);

    // The contract's charset: the id reaches logs and the audit, and the CLI refuses a leading '-'.
    for (const id of ["score board", "score_board", "-scoreboard", "a/b", "Şenol", "x\n", "‮scoreboard"]) {
      assert.deepEqual(refusal(withId(id)).problems, [charset], JSON.stringify(id));
    }
    assert.deepEqual(refusal(withId(`${over} x`)).problems, [charset, tooLong], "both rules are named");

    // Positive controls: exactly the limit, CJK, an inner '-', and one character all load, and render_still accepts each.
    for (const id of ["s".repeat(MAX_TEMPLATE_ID), "比".repeat(MAX_TEMPLATE_ID), "score-board-2", "S"]) {
      assert.equal(loadPack(withId(id)).template(id)?.id, id, id);
      assert.equal(templateId.safeParse(id).success, true, `render_still accepts ${id}`);
    }
  });

test("a propsSchema's root must be type object, so no published contract is one render_still can never accept", (t) => {
  const root = ": the root must be type object";
  // Each passed the gate and loaded before, yet render_still's props is always an object.
  for (const schema of [
    { type: "string", maxLength: 5 },
    { enum: ["a", "b"] },
    { type: "array", maxItems: 2, items: { type: "boolean" } },
    { anyOf: [obj({}), { type: "null" }] },
    { $defs: { o: obj({}) }, $ref: "#/$defs/o" },
  ]) {
    assert.deepEqual(checkSchemaVocabulary(schema), [root], JSON.stringify(schema));
    const err = refusal(swatchPack(t, schema));
    assert.ok(err instanceof PackError, String(err));
    assert.deepEqual(err.problems, [root], JSON.stringify(schema));
    assert.match(err.message, /\/templates\/1\/propsSchema: the root must be type object/);
  }
  // Only the root: an object root with an anyOf of object branches still passes, and a non-object node below the
  // root is the vocabulary's ordinary business.
  assert.deepEqual(checkSchemaVocabulary({ type: "object", additionalProperties: false,
    anyOf: [obj({ a: ONE }), obj({ b: ONE })] }), []);
  assert.deepEqual(checkSchemaVocabulary(obj({ x: { type: "string", maxLength: 5 } })), []);
  // Positive control: an object root loads, and ajv validates against it.
  const pack = loadPack(swatchPack(t, obj({ x: ONE })));
  assert.deepEqual(pack.validateProps("swatch", { x: "a" }), { ok: true });
});

test("bundle/index.html is 'file required' only when it is missing; any other stat failure is named", (t) => {
  // A bundle that is a file: ENOTDIR on Linux, ENOENT on Windows. Either way there is no index.html.
  const fileBundle = tempPack(t);
  fs.rmSync(path.join(fileBundle, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(fileBundle, "bundle"), "not a directory");
  assert.deepEqual(refusal(fileBundle).problems, ["bundle/index.html: file required"]);

  // A NUL byte fails every fs call with ERR_INVALID_ARG_VALUE, on every platform.
  assert.deepEqual(refusal(path.join(GOOD, "a\0b")).problems, [
    "pack-manifest.json: cannot be read (ERR_INVALID_ARG_VALUE)",
    "bundle/index.html: cannot be read (ERR_INVALID_ARG_VALUE)",
  ]);

  // Codes no portable setup produces are injected: templates.js calls statSync on this same node:fs object.
  const dir = tempPack(t);
  const realStat = fs.statSync;
  for (const [code, rule] of [["EACCES", "cannot be read (EACCES)"], ["ELOOP", "cannot be read (ELOOP)"],
    ["EIO", "cannot be read (EIO)"], ["ENOTDIR", "file required"], ["ENOENT", "file required"]]) {
    let calls = 0;
    fs.statSync = (file, ...rest) => {
      if (path.basename(String(file)) !== "index.html") return realStat(file, ...rest);
      calls += 1;
      throw Object.assign(new Error(`injected ${code}`), { code });
    };
    let problems;
    try {
      problems = refusal(dir).problems;
    } finally {
      fs.statSync = realStat;
    }
    assert.equal(calls, 1, `${code}: the injected statSync was not the one called`);
    assert.deepEqual(problems, [`bundle/index.html: ${rule}`], code);
  }
});

test("a schema ajv's strict mode refuses is a PackError, never a raw throw", (t) => {
  // ajv's own wording is not pinned: only that the walker passed it, and that the refusal is one located problem.
  const missingRequired = (m) => { m.templates[1].propsSchema.required.push("missing"); };
  const badPattern = (m) => { m.templates[1].propsSchema.properties.color.pattern = "("; };
  for (const edit of [missingRequired, badPattern]) {
    const dir = tempPack(t, edit);
    const schema = JSON.parse(fs.readFileSync(path.join(dir, "pack-manifest.json"), "utf8")).templates[1].propsSchema;
    assert.deepEqual(checkSchemaVocabulary(schema), [], "the walker passes it; ajv is what refuses");
    const err = refusal(dir);
    assert.ok(err instanceof PackError, String(err));
    assert.equal(err.problems.length, 1);
    assert.match(err.problems[0], /^: ajv refused the schema: /);
    assert.match(err.message, /^template pack refused: \/templates\/1\/propsSchema: ajv refused the schema: /);
  }
});

test("a schema ajv cannot compile prints nothing, and is still a located PackError", (t) => {
  // With allErrors off, ajv nests one `if` per property, so one object of about 1000 properties nests deeper than V8's
  // parser can go. ajv's default logger then printed the whole generated function, about 600 KB, to console.error,
  // before loadPack turned the throw into a problem. The width that takes depends on the host's stack, so the test
  // first finds one at which an ajv with the default logger does print: that is also the control that the spy works.
  const printed = [];
  for (const level of ["error", "warn", "log"]) {
    t.mock.method(console, level, (...args) => { printed.push(`${level}: ${String(args[0]).slice(0, 80)}`); });
  }
  const wide = (n) => obj(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: "null" }])));
  const width = [850, 1000, 1200, 1450, 1750, 2100, 2500].find((n) => {
    printed.length = 0;
    try {
      new Ajv2020({ allErrors: false, strict: true }).compile(wide(n));
    } catch {
      // Whether it throws is not the point here; loadPack's refusal is checked below.
    }
    return printed.length > 0;
  });
  if (width === undefined) {
    t.skip("an ajv with the default logger printed nothing at any probed width, so this host cannot show the dump");
    return;
  }

  printed.length = 0;
  const err = refusal(swatchPack(t, wide(width)));
  assert.deepEqual(printed, [], `loadPack printed at width ${width}`);
  assert.ok(err instanceof PackError, String(err));
  assert.equal(err.problems.length, 1);
  assert.match(err.problems[0], /^: ajv refused the schema: /);
  assert.match(err.message, /^template pack refused: \/templates\/1\/propsSchema: ajv refused the schema: /);
});

test("a missing or malformed manifest is a PackError naming every problem", (t) => {
  const dir = tempPack(t);
  const file = path.join(dir, "pack-manifest.json");
  fs.rmSync(file);
  assert.deepEqual(refusal(dir).problems, ["pack-manifest.json: cannot be read (ENOENT)"]);
  fs.writeFileSync(file, "{");
  assert.deepEqual(refusal(dir).problems, ["pack-manifest.json: not valid JSON"]);
  fs.writeFileSync(file, "[]");
  assert.deepEqual(refusal(dir).problems, ["pack-manifest.json: must hold a JSON object"]);
  assert.deepEqual(refusal(path.join(dir, "absent")).problems,
    ["pack-manifest.json: cannot be read (ENOENT)", "bundle/index.html: file required"]);
});

test("every problem is named at once, and the message places schema problems in the manifest", (t) => {
  const dir = tempPack(t, (m) => {
    m.templates[0].propsSchema.properties.label = { type: "string" };
    Object.assign(m.templates[1], { id: "scoreboard", width: 8001, height: 8000 });
  });
  fs.rmSync(path.join(dir, "bundle"), { recursive: true });
  const err = refusal(dir);
  assert.deepEqual([...err.problems].sort(), [
    "/properties/label: maxLength required",
    "/templates/1/id: duplicate of /templates/0/id",
    `/templates/1: width * height exceeds MAX_RASTER_PIXELS (${MAX_RASTER_PIXELS})`,
    "bundle/index.html: file required",
  ].sort());
  assert.match(err.message, /\/templates\/0\/propsSchema\/properties\/label: maxLength required/);
  assert.match(err.message, /\/templates\/1\/id: duplicate of \/templates\/0\/id/);
  assert.match(err.message, /bundle\/index\.html: file required/);
});

test("dir and bundleDir are absolute even when the pack dir is given relative", () => {
  // The CLI runs with its cwd in a render's work dir, so a relative bundleDir would point there.
  const rel = path.relative(process.cwd(), GOOD);
  assert.equal(path.isAbsolute(rel), false, "the test needs a relative path to prove anything");
  const pack = loadPack(rel);
  assert.equal(pack.dir, path.resolve(rel));
  assert.equal(pack.bundleDir, path.join(path.resolve(rel), "bundle"));
});

test("the loaded manifest is frozen, so the published schema stays the enforced one", () => {
  const pack = loadPack(GOOD);
  const short = pack.template("scoreboard").propsSchema.properties.short;
  assert.throws(() => { short.maxLength = 500; }, TypeError);
  assert.throws(() => { pack.manifest.templates.push({}); }, TypeError);
  assert.throws(() => { pack.template("swatch").width = 1; }, TypeError);
  assert.equal(short.maxLength, 5);
  assert.deepEqual(pack.validateProps("scoreboard", { ...validProps(), short: "x".repeat(6) }),
    { ok: false, paths: ["/short"] });
});

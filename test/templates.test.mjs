// Template packs: the loader, the JSON Schema gate and props validation (design 5.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    for (const problem of expected) {
      assert.ok(err.problems.includes(problem), `${name}: ${JSON.stringify(err.problems)} lacks ${problem}`);
    }
    // Exactly these: each fixture holds one hole, so it proves that one rule.
    assert.deepEqual(err.problems, expected, name);
  }
  assert.ok(refusal(path.join(PACKS, "hidden-in-oneof")).problems.includes("/properties/x: keyword oneOf not allowed"));
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
  check(obj({ x: { type: ["string", "null"], maxLength: 3 } }), ["/properties/x: type must be a single string"]);
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
  check({ $defs: { "a/b~c": name }, ...obj({ x: { $ref: "#/$defs/a~1b~0c" } }) }, []);

  // A $ref reaches only a #/$defs entry, by its own name.
  for (const $ref of ["#", "#/$defs", "#/$defs/Name/maxLength", "other.json#/$defs/Name", "#/properties/x", 7]) {
    check({ $defs: { Name: name }, ...obj({ x: { $ref } }) }, ["/properties/x: $ref must name an existing #/$defs entry"]);
  }
  // Names are escaped per RFC 6901, and the root is the empty pointer.
  check(obj({ "a/b~c": { type: "string" } }), ["/properties/a~1b~0c: maxLength required"]);
  check({ type: "string" }, [": maxLength required"]);
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

test("a schema ajv's strict mode refuses is a PackError, never a raw throw", (t) => {
  const missingRequired = (m) => { m.templates[1].propsSchema.required.push("missing"); };
  const badPattern = (m) => { m.templates[1].propsSchema.properties.color.pattern = "("; };
  for (const [edit, rule] of [[missingRequired, /strict mode: required property "missing" is not defined/],
    [badPattern, /Invalid regular expression/]]) {
    const dir = tempPack(t, edit);
    const schema = JSON.parse(fs.readFileSync(path.join(dir, "pack-manifest.json"), "utf8")).templates[1].propsSchema;
    assert.deepEqual(checkSchemaVocabulary(schema), [], "the walker passes it; ajv is what refuses");
    const err = refusal(dir);
    assert.ok(err instanceof PackError, String(err));
    assert.equal(err.problems.length, 1);
    assert.match(err.problems[0], /^: ajv refused the schema: /);
    assert.match(err.problems[0], rule);
    assert.match(err.message, /\/templates\/1\/propsSchema: ajv refused the schema: /);
  }
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

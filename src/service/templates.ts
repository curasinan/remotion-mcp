/**
 * Loads a template pack and holds its props contract (design 5.4). A pack is `pack-manifest.json` beside a
 * prebuilt `bundle/`. Every template's `propsSchema` must pass a closed JSON Schema vocabulary before ajv
 * compiles it, and props are validated at request time against that same published schema.
 */

import fs from "node:fs";
import path from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { MAX_RASTER_PIXELS } from "../constants.js";

export interface TemplateEntry { id: string; compositionId: string; width: number; height: number;
  defaultFps: number; maxFrames: number; propsSchema: Record<string, unknown> }
export interface PackManifest { packHash: string; remotionVersion: string; templates: TemplateEntry[] }
export type PropsResult = { ok: true } | { ok: false; paths: string[] }; // RFC 6901 pointers, never values
export interface LoadedPack { dir: string; bundleDir: string; manifest: PackManifest;
  template(id: string): TemplateEntry | undefined; validateProps(id: string, props: unknown): PropsResult }

/**
 * A pack the service must not start with. `problems` holds each `<pointer>: <rule>` found: manifest
 * pointers, `pack-manifest.json` and `bundle/index.html` for the files, and schema pointers relative to the
 * template's `propsSchema`. The message places every schema problem in the manifest as well.
 */
export class PackError extends Error {
  readonly problems: string[];

  constructor(problems: string[], located: string[] = problems) {
    super(`template pack refused: ${located.join("; ")}`);
    this.name = "PackError";
    this.problems = problems;
  }
}

const MANIFEST_FILE = "pack-manifest.json";
const BUNDLE_INDEX = "bundle/index.html";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DEFS_PREFIX = "#/$defs/";
/**
 * What a `$defs` name may hold, and so the one token a `$ref` may carry after `#/$defs/`. ajv percent-decodes a
 * ref's fragment, splits it on "/" and unescapes `~1` and `~0`. None of that changes a name of these characters, so
 * ajv follows exactly the def the walker checked.
 */
const DEF_NAME = /^[A-Za-z0-9_.-]+$/;
/** How deep a schema may nest, its root counted as 1. The walk stops there, so it never recurses further. */
const MAX_SCHEMA_DEPTH = 64;
/**
 * How deep a `default`, `examples`, `const` or `enum` value may nest: the arrays and objects on its deepest path, so
 * a scalar is 0. list_templates serializes these values, and ajv deep-compares a caller's value against a `const` or
 * an `enum` element, both by recursion.
 */
const MAX_VALUE_DEPTH = 64;
/**
 * How many nodes a schema may hold with each `$ref` replaced by its def. ajv validates through every ref, so an
 * anyOf of two refs to the same def, repeated def after def, doubles the work per def.
 */
const MAX_EXPANDED_NODES = 10_000;
/**
 * Remotion's own composition id rule, `/^([a-zA-Z0-9-\u4E00-\u9FFF])+$/` in remotion 4.0.532's
 * `dist/cjs/validation/validate-composition-id.js`. The id reaches the CLI as a positional argument, so a leading
 * '-' is refused as well: the CLI would read it as a flag.
 */
const COMPOSITION_ID = /^[a-zA-Z0-9\u4E00-\u9FFF-]+$/;

/** Every keyword a schema node may carry. `format` is absent: strict ajv has no formats loaded. */
const NODE_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "anyOf", "$ref",
  "title", "description", "default", "examples",
]);
/** Allowed at the root of a `propsSchema` only. */
const ROOT_KEYWORDS = new Set(["$schema", "$defs"]);
/** Besides a single-string `type`, what tells a node's kind. */
const TYPE_CARRIERS = ["enum", "const", "anyOf", "$ref"];

type Report = (problem: string, at?: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const has = (node: Record<string, unknown>, key: string): boolean => Object.hasOwn(node, key);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
/** A length or item limit counts only as a non-negative integer. */
const isLimit = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
/** A numeric bound counts only as a finite number. */
const isBound = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

/** RFC 6901: `~` becomes `~0`, then `/` becomes `~1`. */
const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

/** The name in a `$ref` of exactly `#/$defs/<name>`, or undefined for any other `$ref`. */
function refName(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(DEFS_PREFIX)) return undefined;
  const name = ref.slice(DEFS_PREFIX.length);
  return DEF_NAME.test(name) ? name : undefined;
}

/** A `$ref` to an existing def: the def it sits in (undefined outside `$defs`), the def it names, and its pointer. */
interface RefEdge { from: string | undefined; to: string; ptr: string }

/**
 * What one walk shares: the root's `$defs`, the problems found, every resolved `$ref`, and how many nodes each def
 * holds before its refs are expanded (the key undefined counts the nodes outside `$defs`).
 */
interface WalkState { defs: Record<string, unknown> | undefined; out: string[]; refs: RefEdge[];
  nodes: Map<string | undefined, number> }

/**
 * Whether `value` holds more than MAX_VALUE_DEPTH arrays and objects along one path. It keeps its own stack and
 * returns at the first container past the cap, so no depth can overflow the call stack.
 */
function nestsTooDeep(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [item, enclosing] = top;
    if (typeof item !== "object" || item === null) continue;
    if (enclosing >= MAX_VALUE_DEPTH) return true;
    for (const child of Object.values(item)) stack.push([child, enclosing + 1]);
  }
  return false;
}

/** Appends a problem for each `default`, `examples`, `const` or `enum` value of `node` that nests too deeply. */
function checkValueDepth(node: Record<string, unknown>, ptr: string, out: string[]): void {
  const tooDeep = (value: unknown, at: string): void => {
    if (nestsTooDeep(value)) out.push(`${at}: value nested too deeply`);
  };
  for (const key of ["default", "const"]) {
    if (has(node, key)) tooDeep(node[key], `${ptr}/${key}`);
  }
  // Each element on its own, as ajv compares a caller's value with one element at a time.
  for (const key of ["enum", "examples"]) {
    if (!has(node, key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((element, i) => tooDeep(element, `${ptr}/${key}/${i}`));
    else tooDeep(value, `${ptr}/${key}`);
  }
}

/**
 * Appends every problem of `node`, and of the nodes under it, to `state.out`. `depth` counts the root as 1, and
 * `def` names the `$defs` entry the node sits in.
 */
function walk(node: unknown, ptr: string, depth: number, def: string | undefined, state: WalkState,
  root = false): void {
  const { defs, out } = state;
  if (depth > MAX_SCHEMA_DEPTH) {
    out.push(`${ptr}: schema nested too deeply`);
    return;
  }
  if (typeof node === "boolean") {
    out.push(`${ptr}: boolean schema not allowed`);
    return;
  }
  if (!isRecord(node)) {
    out.push(`${ptr}: schema must be an object`);
    return;
  }
  state.nodes.set(def, (state.nodes.get(def) ?? 0) + 1);

  for (const key of Object.keys(node)) {
    if (!NODE_KEYWORDS.has(key) && !(root && ROOT_KEYWORDS.has(key))) out.push(`${ptr}: keyword ${key} not allowed`);
  }
  if (root && has(node, "$schema") && node.$schema !== DRAFT_2020_12) out.push(`${ptr}/$schema: must be ${DRAFT_2020_12}`);

  const { type } = node;
  if (has(node, "type") && typeof type !== "string") out.push(`${ptr}: type must be a single string`);
  if (!has(node, "type") && !TYPE_CARRIERS.some((key) => has(node, key))) out.push(`${ptr}: type required`);
  if (has(node, "$ref")) {
    const name = refName(node.$ref);
    if (name === undefined) out.push(`${ptr}: $ref must be #/$defs/<name>`);
    else if (defs === undefined || !has(defs, name)) out.push(`${ptr}: $ref must name an existing #/$defs entry`);
    else state.refs.push({ from: def, to: name, ptr });
  }

  if (has(node, "additionalProperties") && node.additionalProperties !== false) {
    out.push(`${ptr}: additionalProperties must be false`);
  } else if (type === "object" && !has(node, "additionalProperties")) {
    out.push(`${ptr}: additionalProperties: false required`);
  }
  if (type === "array") {
    if (!isLimit(node.maxItems)) out.push(`${ptr}: maxItems required`);
    if (!has(node, "items")) out.push(`${ptr}: items required`);
  }
  // A const or a non-empty enum bounds a value by itself; a null or empty enum bounds nothing.
  const fixed = has(node, "const") || (Array.isArray(node.enum) && node.enum.length > 0);
  if (type === "string" && !fixed && !isLimit(node.maxLength)) out.push(`${ptr}: maxLength required`);
  if ((type === "number" || type === "integer") && !fixed) {
    if (!isBound(node.minimum) && !isBound(node.exclusiveMinimum)) out.push(`${ptr}: minimum or exclusiveMinimum required`);
    if (!isBound(node.maximum) && !isBound(node.exclusiveMaximum)) out.push(`${ptr}: maximum or exclusiveMaximum required`);
  }
  checkValueDepth(node, ptr, out);

  const below = depth + 1;
  if (has(node, "properties")) {
    if (isRecord(node.properties)) {
      for (const [name, sub] of Object.entries(node.properties)) {
        walk(sub, `${ptr}/properties/${escapeToken(name)}`, below, def, state);
      }
    } else {
      out.push(`${ptr}: properties must be an object`);
    }
  }
  if (has(node, "items")) walk(node.items, `${ptr}/items`, below, def, state);
  if (has(node, "anyOf")) {
    if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
      node.anyOf.forEach((branch, i) => walk(branch, `${ptr}/anyOf/${i}`, below, def, state));
    } else {
      out.push(`${ptr}: anyOf must be a non-empty array`);
    }
  }
  if (root && has(node, "$defs")) {
    if (isRecord(node.$defs)) {
      for (const [name, sub] of Object.entries(node.$defs)) {
        const at = `${ptr}/$defs/${escapeToken(name)}`;
        if (!DEF_NAME.test(name)) out.push(`${at}: def name not allowed`);
        walk(sub, at, below, name, state);
      }
    } else {
      out.push(`${ptr}/$defs: must be an object`);
    }
  }
}

/**
 * Appends each `$ref` that lies on a cycle: one in a def that the def it names can reach again. ajv would
 * recurse through such a ref once per level of the caller's props. The search keeps its own stack. Returns
 * whether it found any.
 */
function reportCycles(refs: RefEdge[], out: string[]): boolean {
  const before = out.length;
  const next = new Map<string, string[]>();
  for (const { from, to } of refs) {
    if (from === undefined) continue;
    const targets = next.get(from);
    if (targets === undefined) next.set(from, [to]);
    else targets.push(to);
  }
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set([start]);
    const stack = [start];
    for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
      if (name === goal) return true;
      for (const to of next.get(name) ?? []) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    return false;
  };
  for (const { from, to, ptr } of refs) {
    if (from !== undefined && reaches(to, from)) out.push(`${ptr}: recursive $ref not allowed`);
  }
  return out.length > before;
}

/**
 * Appends a problem at the root when the schema, each `$ref` replaced by the def it names, holds more than
 * MAX_EXPANDED_NODES nodes. A node counts 1 plus the nodes under it, and a `$ref` node adds its def's expanded size.
 * The def graph must be acyclic. Each def is sized once, after the defs it names, with an explicit stack, and every
 * sum saturates one past the budget, so the count is linear in the schema and never overflows.
 */
function reportExpansion(nodes: Map<string | undefined, number>, refs: RefEdge[], out: string[]): void {
  const past = MAX_EXPANDED_NODES + 1;
  const targets = new Map<string | undefined, string[]>();
  for (const { from, to } of refs) {
    const list = targets.get(from);
    if (list === undefined) targets.set(from, [to]);
    else list.push(to);
  }
  const sizes = new Map<string, number>();
  /** The expanded size of the nodes counted under `owner`, once every def it names is sized. */
  const expanded = (owner: string | undefined): number => (targets.get(owner) ?? [])
    .reduce((sum, to) => Math.min(past, sum + (sizes.get(to) as number)), Math.min(past, nodes.get(owner) ?? 0));

  const stack = [...(targets.get(undefined) ?? [])];
  for (let name = stack.at(-1); name !== undefined; name = stack.at(-1)) {
    if (sizes.has(name)) {
      stack.pop();
      continue;
    }
    const unsized = (targets.get(name) ?? []).filter((to) => !sizes.has(to));
    if (unsized.length > 0) {
      // One push each: push(...unsized) passes every target as an argument, and V8 caps how many a call takes, so a
      // def with about 130 000 refs threw RangeError.
      for (const to of unsized) stack.push(to);
    } else {
      sizes.set(name, expanded(name));
      stack.pop();
    }
  }
  if (expanded(undefined) > MAX_EXPANDED_NODES) out.push(`: schema expands past ${MAX_EXPANDED_NODES} nodes`);
}

/**
 * The closed-vocabulary gate a `propsSchema` must pass before ajv compiles it: every problem as
 * `<pointer>: <rule>`, with the pointer relative to the schema's root (`""`). An empty list passes.
 */
export function checkSchemaVocabulary(schema: unknown): string[] {
  const state: WalkState = {
    defs: isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : undefined,
    out: [],
    refs: [],
    nodes: new Map(),
  };
  walk(schema, "", 1, undefined, state, true);
  // The expansion is sized only over an acyclic def graph; a cycle is refused on its own.
  if (!reportCycles(state.refs, state.out)) reportExpansion(state.nodes, state.refs, state.out);
  return state.out;
}

/** Each ajv error as the pointer to the prop it is about. ajv's `instancePath` is already escaped. */
function pointerOf(error: ErrorObject): string {
  if (error.keyword === "required") return `${error.instancePath}/${escapeToken(String(error.params.missingProperty))}`;
  if (error.keyword === "additionalProperties") {
    return `${error.instancePath}/${escapeToken(String(error.params.additionalProperty))}`;
  }
  return error.instancePath;
}

/** Freezes `value` and everything under it. It keeps its own stack, so no nesting depth can overflow the call stack. */
function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === "object" && next !== null && !Object.isFrozen(next)) {
      Object.freeze(next);
      for (const child of Object.values(next)) stack.push(child);
    }
  }
  return value;
}

/** Reports why `file` is not a file: missing (ENOENT, ENOTDIR), or any other stat failure, named by its code. */
function checkBundleIndex(file: string, report: Report): void {
  let isFile: boolean;
  try {
    isFile = fs.statSync(file).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    report(code === "ENOENT" || code === "ENOTDIR"
      ? `${BUNDLE_INDEX}: file required`
      : `${BUNDLE_INDEX}: cannot be read (${code ?? "error"})`);
    return;
  }
  if (!isFile) report(`${BUNDLE_INDEX}: file required`);
}

/** The parsed manifest object, or undefined after reporting why there is none. */
function readManifest(file: string, report: Report): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    report(`${MANIFEST_FILE}: cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    report(`${MANIFEST_FILE}: not valid JSON`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    report(`${MANIFEST_FILE}: must hold a JSON object`);
    return undefined;
  }
  return parsed;
}

/** Reports every problem with one template's own fields. */
function checkTemplateFields(entry: Record<string, unknown>, at: string, report: Report): void {
  if (!isText(entry.id)) report(`${at}/id: non-empty string required`);
  if (!isText(entry.compositionId)) {
    report(`${at}/compositionId: non-empty string required`);
  } else if (!COMPOSITION_ID.test(entry.compositionId) || entry.compositionId.startsWith("-")) {
    report(`${at}/compositionId: only a-z, A-Z, 0-9, CJK and '-' allowed, and no leading '-'`);
  }
  for (const field of ["width", "height"]) {
    if (!isPositiveInteger(entry[field])) report(`${at}/${field}: positive integer required`);
  }
  if (!(isBound(entry.defaultFps) && (entry.defaultFps as number) > 0)) report(`${at}/defaultFps: positive number required`);
  if (!(Number.isSafeInteger(entry.maxFrames) && (entry.maxFrames as number) >= 1)) {
    report(`${at}/maxFrames: integer >= 1 required`);
  }
  if (isPositiveInteger(entry.width) && isPositiveInteger(entry.height) && entry.width * entry.height > MAX_RASTER_PIXELS) {
    report(`${at}: width * height exceeds MAX_RASTER_PIXELS (${MAX_RASTER_PIXELS})`);
  }
}

/** Loads the pack in `dir`, or throws a PackError naming every problem found. */
export function loadPack(dir: string): LoadedPack {
  // Absolute, because the CLI runs with its cwd in a render's work dir.
  const packDir = path.resolve(dir);
  const bundleDir = path.join(packDir, "bundle");
  const problems: string[] = [];
  const located: string[] = [];
  const report: Report = (problem, at = "") => {
    problems.push(problem);
    located.push(at + problem);
  };

  const raw = readManifest(path.join(packDir, MANIFEST_FILE), report);
  const list: unknown[] = [];
  const validators: ValidateFunction[] = [];
  if (raw !== undefined) {
    for (const field of ["packHash", "remotionVersion"]) {
      if (!isText(raw[field])) report(`/${field}: non-empty string required`);
    }
    if (!Array.isArray(raw.templates)) {
      report("/templates: array required");
    } else if (raw.templates.length === 0) {
      report("/templates: at least one template required");
    } else {
      // One push each, never push(...templates): V8 caps a call's arguments, so a long list would throw RangeError.
      for (const entry of raw.templates) list.push(entry);
    }
  }

  // allErrors stays false: ajv then stops a node at its first failing keyword, and maxLength, enum and const all run
  // before pattern. With allErrors on, a pack's pattern would run on a caller string of any length, and one
  // backtracking regex would block the event loop (ajv's security guide gives the same warning). logger is off: when
  // V8 cannot compile a schema's generated code, ajv's default logger prints the whole function (about 600 KB for an
  // object of 1000 properties) to console.error. The throw itself still becomes a problem below.
  const ajv = new Ajv2020({ allErrors: false, strict: true, logger: false });
  const firstById = new Map<string, number>();
  list.forEach((entry, i) => {
    const at = `/templates/${i}`;
    if (!isRecord(entry)) {
      report(`${at}: object required`);
      return;
    }
    checkTemplateFields(entry, at, report);
    if (isText(entry.id)) {
      const first = firstById.get(entry.id);
      if (first === undefined) firstById.set(entry.id, i);
      else report(`${at}/id: duplicate of /templates/${first}/id`);
    }

    const holes = checkSchemaVocabulary(entry.propsSchema);
    for (const hole of holes) report(hole, `${at}/propsSchema`);
    if (holes.length > 0) return;
    try {
      validators[i] = ajv.compile(entry.propsSchema as Record<string, unknown>);
    } catch (err) {
      report(`: ajv refused the schema: ${(err as Error).message}`, `${at}/propsSchema`);
    }
  });

  checkBundleIndex(path.join(bundleDir, "index.html"), report);
  if (problems.length > 0 || raw === undefined) throw new PackError(problems, located);

  // Every field below was checked above. Each schema is frozen only now, after the walk has bounded it: its nodes nest
  // at most 64 deep, each default, examples, const and enum value (each enum and examples element) holds at most 64
  // nested arrays and objects, and the schema expands, each $ref in place, to at most 10000 nodes. So list_templates
  // can serialize it, and ajv can apply it, with no RangeError and no exponential stall. Frozen, the schema
  // list_templates publishes stays the one ajv enforces.
  const templates = (list as Record<string, unknown>[]).map((entry): TemplateEntry => Object.freeze({
    id: entry.id as string,
    compositionId: entry.compositionId as string,
    width: entry.width as number,
    height: entry.height as number,
    defaultFps: entry.defaultFps as number,
    maxFrames: entry.maxFrames as number,
    propsSchema: deepFreeze(entry.propsSchema as Record<string, unknown>),
  }));
  const manifest: PackManifest = Object.freeze({
    packHash: raw.packHash as string,
    remotionVersion: raw.remotionVersion as string,
    templates: Object.freeze(templates) as TemplateEntry[],
  });
  const byId = new Map(templates.map((entry, i) => [entry.id, { entry, validate: validators[i] as ValidateFunction }]));

  return {
    dir: packDir,
    bundleDir,
    manifest,
    template: (id) => byId.get(id)?.entry,
    validateProps(id, props) {
      const found = byId.get(id);
      if (found === undefined) throw new Error("validateProps: no such template; call template() first");
      if (found.validate(props)) return { ok: true };
      return { ok: false, paths: [...new Set((found.validate.errors ?? []).map(pointerOf))] };
    },
  };
}

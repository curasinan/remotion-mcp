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

/** What one walk shares: the root's `$defs`, the problems found, and every resolved `$ref`. */
interface WalkState { defs: Record<string, unknown> | undefined; out: string[]; refs: RefEdge[] }

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
 * recurse through such a ref once per level of the caller's props. The search keeps its own stack.
 */
function reportCycles(refs: RefEdge[], out: string[]): void {
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
  };
  walk(schema, "", 1, undefined, state, true);
  reportCycles(state.refs, state.out);
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
    if (!Array.isArray(raw.templates)) report("/templates: array required");
    else if (raw.templates.length === 0) report("/templates: at least one template required");
    else list.push(...raw.templates);
  }

  // allErrors stays false: ajv then stops a node at its first failing keyword, and maxLength, enum and const all run
  // before pattern. With allErrors on, a pack's pattern would run on a caller string of any length, and one
  // backtracking regex would block the event loop (ajv's security guide gives the same warning).
  const ajv = new Ajv2020({ allErrors: false, strict: true });
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

  // Every field below was checked above. Each schema is frozen only now, after the walk has bounded it, so the
  // schema list_templates publishes stays the one ajv enforces.
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

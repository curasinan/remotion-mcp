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
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DEFS_PREFIX = "#/$defs/";

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

/** True when `ref` is `#/$defs/<name>` and the root's `$defs` holds `<name>`. */
function resolvesToDef(ref: unknown, defs: Record<string, unknown> | undefined): boolean {
  if (typeof ref !== "string" || !ref.startsWith(DEFS_PREFIX) || defs === undefined) return false;
  const token = ref.slice(DEFS_PREFIX.length);
  return !token.includes("/") && has(defs, token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Appends every problem of `node`, and of the nodes under it, to `out`. */
function walk(node: unknown, ptr: string, defs: Record<string, unknown> | undefined, out: string[],
  root = false): void {
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
  if (has(node, "$ref") && !resolvesToDef(node.$ref, defs)) {
    out.push(`${ptr}: $ref must name an existing #/$defs entry`);
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
  if (type === "string" && !has(node, "enum") && !has(node, "const") && !isLimit(node.maxLength)) {
    out.push(`${ptr}: maxLength required`);
  }
  if (type === "number" || type === "integer") {
    if (!isBound(node.minimum) && !isBound(node.exclusiveMinimum)) out.push(`${ptr}: minimum or exclusiveMinimum required`);
    if (!isBound(node.maximum) && !isBound(node.exclusiveMaximum)) out.push(`${ptr}: maximum or exclusiveMaximum required`);
  }

  if (has(node, "properties")) {
    if (isRecord(node.properties)) {
      for (const [name, sub] of Object.entries(node.properties)) walk(sub, `${ptr}/properties/${escapeToken(name)}`, defs, out);
    } else {
      out.push(`${ptr}: properties must be an object`);
    }
  }
  if (has(node, "items")) walk(node.items, `${ptr}/items`, defs, out);
  if (has(node, "anyOf")) {
    if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
      node.anyOf.forEach((branch, i) => walk(branch, `${ptr}/anyOf/${i}`, defs, out));
    } else {
      out.push(`${ptr}: anyOf must be a non-empty array`);
    }
  }
  if (root && has(node, "$defs")) {
    if (isRecord(node.$defs)) {
      for (const [name, def] of Object.entries(node.$defs)) walk(def, `${ptr}/$defs/${escapeToken(name)}`, defs, out);
    } else {
      out.push(`${ptr}/$defs: must be an object`);
    }
  }
}

/**
 * The closed-vocabulary gate a `propsSchema` must pass before ajv compiles it: every problem as
 * `<pointer>: <rule>`, with the pointer relative to the schema's root (`""`). An empty list passes.
 */
export function checkSchemaVocabulary(schema: unknown): string[] {
  const out: string[] = [];
  const defs = isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : undefined;
  walk(schema, "", defs, out, true);
  return out;
}

/** Each ajv error as the pointer to the prop it is about. ajv's `instancePath` is already escaped. */
function pointerOf(error: ErrorObject): string {
  if (error.keyword === "required") return `${error.instancePath}/${escapeToken(String(error.params.missingProperty))}`;
  if (error.keyword === "additionalProperties") {
    return `${error.instancePath}/${escapeToken(String(error.params.additionalProperty))}`;
  }
  return error.instancePath;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
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
  return deepFreeze(parsed);
}

/** Reports every problem with one template's own fields. */
function checkTemplateFields(entry: Record<string, unknown>, at: string, report: Report): void {
  for (const field of ["id", "compositionId"]) {
    if (!isText(entry[field])) report(`${at}/${field}: non-empty string required`);
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

  const ajv = new Ajv2020({ allErrors: true, strict: true });
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

  if (!isFile(path.join(bundleDir, "index.html"))) report("bundle/index.html: file required");
  if (problems.length > 0 || raw === undefined) throw new PackError(problems, located);

  // Every field below was checked above.
  const templates = (list as Record<string, unknown>[]).map((entry): TemplateEntry => Object.freeze({
    id: entry.id as string,
    compositionId: entry.compositionId as string,
    width: entry.width as number,
    height: entry.height as number,
    defaultFps: entry.defaultFps as number,
    maxFrames: entry.maxFrames as number,
    propsSchema: entry.propsSchema as Record<string, unknown>,
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

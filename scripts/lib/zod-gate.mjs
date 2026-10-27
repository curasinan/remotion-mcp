/**
 * The zod 4 vocabulary gate and composition discovery behind scripts/build-pack.mjs (design 5.4,
 * docs/CONTRACT-pack.md). It reads zod's own definitions (`schema._zod.def`) and plain React elements, so it imports
 * neither zod nor React: build-pack hands it the pack's own copies.
 *
 * Every problem is a string `<path>: <rule>`. A path starts at `<root>`, the props object; `.name` (or `["a b"]`)
 * steps into a property and `[]` into an array's elements. An optional field keeps its field's path.
 */

const ROOT = "<root>";
/** How deep a schema may nest, the root counted as 1. Every zod node counts, so the export nests no deeper. */
const MAX_DEPTH = 64;
/** The longest template_id render_still accepts (src/service/tools.ts), in UTF-16 units as zod counts it. */
const MAX_TEMPLATE_ID = 100;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isObject = (value) => typeof value === "object" && value !== null;
/** A length or item limit counts only as a non-negative integer, as in the service's JSON Schema gate. */
const isLimit = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
/** A RegExp by its shape, so a pattern from another realm counts too. */
const isRegExp = (value) => isObject(value) && typeof value.source === "string" && typeof value.flags === "string";
const childPath = (at, key) => (IDENTIFIER.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`);

const defOf = (schema) => schema._zod.def;
/** Each check's own definition. zod 4 keeps refine, trim and every bound in `def.checks`, on every node type. */
const checksOf = (schema) => (defOf(schema).checks ?? []).map((check) => check?._zod?.def ?? {});

/** 4 for a zod 4 schema, which carries `_zod`; 3 for anything else. */
export function zodMajor(schema) {
  return isObject(schema) && isObject(schema._zod) ? 4 : 3;
}

/** The checks each allowed type may carry. A `string_format` check must also be a regex without flags. */
const ALLOWED_CHECKS = {
  string: new Set(["max_length", "min_length", "length_equals", "string_format"]),
  number: new Set(["greater_than", "less_than", "number_format"]),
  array: new Set(["max_length", "min_length", "length_equals"]),
};

/** The problem with one check of a node of `type`, or undefined when the check is allowed there. */
function checkProblem(type, check) {
  if (check.check === "custom") return "refine and superRefine not allowed";
  if (check.check === "overwrite") return "overwrite checks (.trim, .toLowerCase, .toUpperCase, .normalize) not allowed";
  if (!ALLOWED_CHECKS[type]?.has(check.check)) return `check ${check.check} not allowed`;
  if (check.check === "string_format") {
    if (check.format !== "regex") return `format ${check.format} not allowed`;
    // The export keeps only the source, so a flag would change what the published pattern matches.
    if (!isRegExp(check.pattern) || check.pattern.flags !== "") return "regex flags not allowed";
  }
  return undefined;
}

/** Whether any check is a `max_length` or `length_equals` with a usable limit. */
const hasMaxLength = (checks) => checks.some((c) =>
  (c.check === "max_length" && isLimit(c.maximum)) || (c.check === "length_equals" && isLimit(c.length)));
const hasBound = (checks, kind) => checks.some((c) => c.check === kind && Number.isFinite(c.value));

/** Appends every problem of `schema`, and of the schemas under it, to `out`. `ancestors` holds the path's nodes. */
function gateNode(schema, at, depth, ancestors, out) {
  if (depth > MAX_DEPTH) {
    out.push(`${at}: schema nested too deeply`);
    return;
  }
  if (ancestors.has(schema)) {
    out.push(`${at}: recursive schema not allowed`);
    return;
  }
  if (zodMajor(schema) !== 4) {
    out.push(`${at}: not a zod 4 schema`);
    return;
  }
  const def = defOf(schema);
  const checks = checksOf(schema);
  if (def.type === "pipe" || def.type === "transform") {
    out.push(`${at}: transform, preprocess and pipe not allowed`);
    return;
  }
  if (!["string", "number", "boolean", "enum", "literal", "object", "array", "optional"].includes(def.type)) {
    out.push(`${at}: type ${def.type} not allowed`);
    return;
  }
  for (const check of checks) {
    const problem = checkProblem(def.type, check);
    if (problem !== undefined) out.push(`${at}: ${problem}`);
  }

  ancestors.add(schema);
  const below = depth + 1;
  switch (def.type) {
    case "string":
      // z.url(), z.email() and the other top-level formats carry their format on the schema itself.
      if (def.format !== undefined) out.push(`${at}: format ${def.format} not allowed`);
      if (!hasMaxLength(checks)) out.push(`${at}: string needs .max(N)`);
      break;
    case "number":
      // A top-level number format (z.int(), z.float32()) is allowed, but is not a bound by itself.
      if (!hasBound(checks, "greater_than")) out.push(`${at}: number needs a lower bound (.min or .gt)`);
      if (!hasBound(checks, "less_than")) out.push(`${at}: number needs an upper bound (.max or .lt)`);
      break;
    case "array":
      if (!hasMaxLength(checks)) out.push(`${at}: array needs .max(N)`);
      gateNode(def.element, `${at}[]`, below, ancestors, out);
      break;
    case "object":
      // z.strictObject sets the catchall to never; z.object leaves none, and .passthrough() and .catchall() set another.
      if (zodMajor(def.catchall) !== 4 || defOf(def.catchall).type !== "never") {
        out.push(`${at}: object must be strict (z.strictObject)`);
      }
      for (const [key, sub] of Object.entries(def.shape)) gateNode(sub, childPath(at, key), below, ancestors, out);
      break;
    case "optional":
      gateNode(def.innerType, at, below, ancestors, out);
      break;
    default:
      // boolean, enum and literal: bounded by their type, and their checks were read above.
      break;
  }
  ancestors.delete(schema);
}

/**
 * The gate a composition's schema must pass before build-pack exports it: every problem, or [] when it passes.
 * The root must be a strict object. Allowed under it: strict objects, strings with a max (and at most regexes
 * without flags), numbers with a lower and an upper bound, booleans, enums, literals, arrays with a max, and
 * optional of any of these. Refused: formats, anything unbounded, refine, superRefine and overwrite checks on any
 * type, pipes and transforms, and every other type.
 */
export function gateSchema(schema) {
  if (!isObject(schema) || (!isObject(schema._zod) && !isObject(schema._def))) return [`${ROOT}: not a zod schema`];
  if (zodMajor(schema) !== 4) return [`${ROOT}: zod 3 is not supported, use zod 4`];
  if (defOf(schema).type !== "object") return [`${ROOT}: the props schema must be z.strictObject`];
  const out = [];
  gateNode(schema, ROOT, 1, new Set(), out);
  return out;
}

/** `node`, or the `#/$defs/<name>` entry its `$ref` chain ends at; undefined when the chain breaks or loops. */
function resolveRef(node, defs) {
  let current = node;
  for (let hops = 0; hops <= MAX_DEPTH; hops += 1) {
    if (!isObject(current) || typeof current.$ref !== "string") return current;
    const name = current.$ref.startsWith("#/$defs/") ? current.$ref.slice("#/$defs/".length) : undefined;
    current = name !== undefined && Object.hasOwn(defs, name) ? defs[name] : undefined;
  }
  return undefined;
}

/** The patterns an exported string node carries: its own, and those zod puts in `allOf` when there are several. */
const patternsOf = (json) => [json.pattern, ...(Array.isArray(json.allOf) ? json.allOf.map((part) => part?.pattern) : [])];

/** Appends each bound of a string or array node that the export lost. `keys` names the JSON keywords to check. */
function lengthsSurvived(checks, json, at, keys, out) {
  for (const c of checks) {
    const max = c.check === "max_length" ? c.maximum : c.check === "length_equals" ? c.length : undefined;
    const min = c.check === "min_length" ? c.minimum : c.check === "length_equals" ? c.length : undefined;
    if (isLimit(max) && !(isLimit(json[keys.max]) && json[keys.max] <= max)) {
      out.push(`${at}: ${keys.max} ${max} missing from the export`);
    }
    if (isLimit(min) && !(isLimit(json[keys.min]) && json[keys.min] >= min)) {
      out.push(`${at}: ${keys.min} ${min} missing from the export`);
    }
  }
}

/** Appends each number bound the export lost. A tighter exported bound, inclusive or exclusive, still counts. */
function numberBoundsSurvived(checks, json, at, out) {
  for (const c of checks) {
    if (!Number.isFinite(c.value)) continue;
    if (c.check === "greater_than") {
      const kept = c.inclusive
        ? (isNumber(json.minimum) && json.minimum >= c.value) || (isNumber(json.exclusiveMinimum) && json.exclusiveMinimum >= c.value)
        : (isNumber(json.exclusiveMinimum) && json.exclusiveMinimum >= c.value) || (isNumber(json.minimum) && json.minimum > c.value);
      if (!kept) out.push(`${at}: ${c.inclusive ? "minimum" : "exclusiveMinimum"} ${c.value} missing from the export`);
    } else if (c.check === "less_than") {
      const kept = c.inclusive
        ? (isNumber(json.maximum) && json.maximum <= c.value) || (isNumber(json.exclusiveMaximum) && json.exclusiveMaximum <= c.value)
        : (isNumber(json.exclusiveMaximum) && json.exclusiveMaximum <= c.value) || (isNumber(json.maximum) && json.maximum < c.value);
      if (!kept) out.push(`${at}: ${c.inclusive ? "maximum" : "exclusiveMaximum"} ${c.value} missing from the export`);
    }
  }
}

/**
 * The values an enum or literal accepts, as zod reads them. For an enum that is zod's own getEnumValues: a
 * TypeScript numeric enum also maps each number back to its name, and zod drops those reverse entries.
 */
function zodValues(def) {
  if (def.type === "literal") return Array.isArray(def.values) ? def.values : [];
  const entries = Object.entries(isObject(def.entries) ? def.entries : {});
  const numbers = entries.map(([, value]) => value).filter((value) => typeof value === "number");
  return entries.filter(([key]) => numbers.indexOf(Number(key)) === -1).map(([, value]) => value);
}

/**
 * Every value an exported node names in `enum` and `const`, or undefined when it names none (no `const`, and no
 * `enum` or an empty one) or carries an `enum` that is not an array. A value either keyword names counts. JSON Schema
 * admits only the values both name, so a node carrying both is never read as tighter than it is.
 */
function exportedValues(json) {
  const named = [];
  if (Object.hasOwn(json, "enum")) {
    if (!Array.isArray(json.enum)) return undefined;
    named.push(...json.enum);
  }
  if (Object.hasOwn(json, "const")) named.push(json.const);
  return named.length > 0 ? named : undefined;
}

/** A value for a message: a string quoted, a number, boolean or null as written, and only the kind of anything else. */
const showValue = (value) => {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (isObject(value)) return "an object";
  if (typeof value === "function" || typeof value === "symbol") return `a ${typeof value}`;
  return String(value);
};

/** Appends to `out` each bound of `schema` that its exported `json` node lost. */
function survivedNode(schema, jsonNode, at, depth, defs, out) {
  if (depth > MAX_DEPTH || zodMajor(schema) !== 4) return;
  const json = resolveRef(jsonNode, defs);
  if (!isObject(json)) {
    out.push(`${at}: missing from the export`);
    return;
  }
  const def = defOf(schema);
  const checks = checksOf(schema);
  const below = depth + 1;
  switch (def.type) {
    case "optional":
      survivedNode(def.innerType, json, at, below, defs, out);
      break;
    case "string": {
      lengthsSurvived(checks, json, at, { max: "maxLength", min: "minLength" }, out);
      const patterns = patternsOf(json);
      for (const c of checks) {
        if (c.check === "string_format" && c.format === "regex" && isRegExp(c.pattern)
          && !patterns.includes(c.pattern.source)) {
          out.push(`${at}: pattern ${c.pattern.source} missing from the export`);
        }
      }
      break;
    }
    case "number":
      numberBoundsSurvived(checks, json, at, out);
      break;
    case "array":
      lengthsSurvived(checks, json, at, { max: "maxItems", min: "minItems" }, out);
      survivedNode(def.element, json.items, `${at}[]`, below, defs, out);
      break;
    case "object": {
      if (zodMajor(def.catchall) === 4 && defOf(def.catchall).type === "never" && json.additionalProperties !== false) {
        out.push(`${at}: additionalProperties: false missing from the export`);
      }
      const properties = isObject(json.properties) ? json.properties : {};
      const required = Array.isArray(json.required) ? json.required : [];
      for (const [key, sub] of Object.entries(def.shape)) {
        const subAt = childPath(at, key);
        if (zodMajor(sub) === 4 && defOf(sub).type !== "optional" && !required.includes(key)) {
          out.push(`${subAt}: required missing from the export`);
        }
        survivedNode(sub, Object.hasOwn(properties, key) ? properties[key] : undefined, subAt, below, defs, out);
      }
      break;
    }
    case "enum":
    case "literal": {
      // The bound is lost when the export admits a value zod refuses. Naming fewer values is tighter, and counts.
      const named = exportedValues(json);
      if (named === undefined) {
        out.push(`${at}: ${def.type === "enum" ? "enum" : "const"} missing from the export`);
        break;
      }
      const accepted = zodValues(def);
      const refused = named.filter((value) => !accepted.includes(value));
      if (refused.length > 0) out.push(`${at}: the export admits ${refused.map(showValue).join(", ")}, which zod refuses`);
      break;
    }
    default:
      break;
  }
}

/**
 * Every bound the gate accepted that `jsonSchema`, the schema's export, does not carry: `[]` when all survived.
 * It checks lengths, item counts, patterns, number bounds, strict objects, required fields, enums and literals. An
 * exported bound at least as tight as zod's counts: for an enum or literal, an `enum` or `const` that names only
 * values zod accepts. A `$ref` into the export's `$defs` is followed.
 */
export function boundsSurvived(schema, jsonSchema) {
  const defs = isObject(jsonSchema) && isObject(jsonSchema.$defs) ? jsonSchema.$defs : {};
  const out = [];
  survivedNode(schema, jsonSchema, ROOT, 1, defs, out);
  return out;
}

const isElement = (node) => isObject(node) && !Array.isArray(node) && "type" in node && isObject(node.props);

/** A `<Composition>` by its props: a string id and a component. `<Still>` matches too, and is told apart by identity. */
const isComposition = (props) => typeof props.id === "string" && ("component" in props || "lazyComponent" in props);

/**
 * The compositions in the tree RemotionRoot() returned, in document order. It looks through fragments, arrays and
 * `<Folder>` children, never inside a composition, and never calls a component: one that registers compositions
 * from its own render is not seen. `Still`, the project's own remotion `Still`, marks the elements that render a
 * one-frame composition at 1 fps, as remotion's Still does.
 */
export function discoverCompositions(rootElement, { Still } = {}) {
  const found = [];
  const stack = [rootElement];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    if (!isElement(node)) continue;
    const { props } = node;
    if (isComposition(props)) {
      const still = Still !== undefined && node.type === Still;
      found.push({
        id: props.id,
        width: props.width,
        height: props.height,
        fps: still ? 1 : props.fps,
        durationInFrames: still ? 1 : props.durationInFrames,
        schema: props.schema,
        hasCalculateMetadata: props.calculateMetadata !== undefined && props.calculateMetadata !== null,
      });
    } else if ("children" in props) {
      stack.push(props.children);
    }
  }
  return found;
}

/**
 * Why the discovered compositions cannot become templates: none at all, or one without a static size, fps and
 * duration (the manifest records them, and the service passes them to the CLI), without a schema, or with an id
 * longer than render_still accepts.
 */
export function compositionProblems(compositions) {
  if (compositions.length === 0) return ["RemotionRoot registers no compositions"];
  const out = [];
  for (const c of compositions) {
    if (c.id.length > MAX_TEMPLATE_ID) {
      out.push(`${c.id}: id longer than ${MAX_TEMPLATE_ID} characters, which render_still never accepts as a template_id`);
    }
    if (!isPositiveInteger(c.width) || !isPositiveInteger(c.height)) {
      out.push(c.hasCalculateMetadata
        ? `${c.id}: calculateMetadata needs a static width and height`
        : `${c.id}: static width and height required`);
    }
    if (!(isNumber(c.fps) && c.fps > 0) || !isPositiveInteger(c.durationInFrames)) {
      out.push(`${c.id}: static fps and durationInFrames required`);
    }
    if (c.schema === undefined || c.schema === null) out.push(`${c.id}: schema required`);
  }
  return out;
}

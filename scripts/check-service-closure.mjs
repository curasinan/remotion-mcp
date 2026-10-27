// The absence suite's static check (design 5.7, ADR-5): reads the emitted service closure, dist-service/, as syntax.
// It never reads text: services/exec.js names remotion_list_compositions in a hint string, and a text check would fail
// a correct closure.
//
// Importable, as test/absence.test.mjs does, and runnable:
//   node scripts/check-service-closure.mjs [distDir]    (default: dist-service)
// It prints each problem and exits 1 when there is any, and exits 0 when there is none.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The one file that may register a tool, relative to the dist dir. */
const REGISTRY = "service/registry.js";
/** The local-dev tools the service closure must not contain (design 4). */
const FORBIDDEN_TOOLS = ["viz_render_html", "remotion_list_compositions", "remotion_init_project",
  "remotion_start_studio"];
/** Local-dev modules the service never needs, matched on the name before the first dot of any path segment. */
const FORBIDDEN_MODULES = ["raster", "tile", "network", "visualize", "studio", "compare", "environment", "browser"];
/** The native rasterizer and the browser driver: the service's still path runs neither (design 5.6). */
const FORBIDDEN_PACKAGES = ["@resvg/resvg-js", "puppeteer-core"];
/** What tsc can emit: .js, and .mjs and .cjs from .mts and .cts sources. */
const SCRIPT = /\.[cm]?js$/;
/**
 * The method names that register a tool: McpServer's registerTool and tool, and the SDK's experimental
 * server.experimental.tasks.registerToolTask, which reaches the same internal _createRegisteredTool and lists its tool
 * in tools/list the same way.
 */
const REGISTER_METHODS = ["registerTool", "registerToolTask", "tool"];
/**
 * The registration methods whose every use but a direct call is reported. Not `tool`: a plain read of a `tool`
 * property is the gateway claim's, so only a `.tool` used through .bind, .call or .apply is.
 */
const STRICT_METHODS = ["registerTool", "registerToolTask"];
/** The Function methods that call or capture a method without a direct call. */
const FUNCTION_METHODS = ["bind", "call", "apply"];

/** Every file under `dir`, relative to it, with forward slashes. */
function walk(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

/** A string literal's value, or null for anything else (a template with substitutions is not a literal). */
function literalText(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text : null;
}

/** `x.name` or `x["name"]`: the member's name and the node that spells it, or null. */
function memberOf(node) {
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, at: node.name };
  if (ts.isElementAccessExpression(node)) {
    const name = literalText(node.argumentExpression);
    if (name !== null) return { name, at: node.argumentExpression };
  }
  return null;
}

/** The expression inside any parentheses. */
function unparen(node) {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/**
 * `node` with any parentheses around it, and the parent of that. `ancestors` runs from the source file down to
 * `node`'s parent.
 */
function outermost(node, ancestors) {
  let outer = node;
  let i = ancestors.length - 1;
  while (i >= 0 && ts.isParenthesizedExpression(ancestors[i])) {
    outer = ancestors[i];
    i -= 1;
  }
  return { outer, parent: ancestors[i] };
}

/** Whether `outer` is what `parent` calls: a call's or a `new`'s callee, or a tagged template's tag. */
function isCallee(outer, parent) {
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === outer;
  return ts.isTaggedTemplateExpression(parent) && parent.tag === outer;
}

/** Whether `node` is the pattern side of a destructuring assignment, `({ a } = b)` or `for ({ a } of b)`. */
function isAssignmentPattern(node, ancestors) {
  let inner = node;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const up = ancestors[i];
    if (ts.isObjectLiteralExpression(up) || ts.isArrayLiteralExpression(up) || ts.isParenthesizedExpression(up)
      || ts.isPropertyAssignment(up) || ts.isShorthandPropertyAssignment(up) || ts.isSpreadAssignment(up)
      || ts.isSpreadElement(up)) {
      inner = up;
      continue;
    }
    if (ts.isBinaryExpression(up)) return up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.left === inner;
    if (ts.isForOfStatement(up) || ts.isForInStatement(up)) return up.initializer === inner;
    return false;
  }
  return false;
}

/** How a member read of registerTool that is not a call is used: the word each problem names. */
function useOf(outer, parent) {
  if (parent === undefined) return "reference";
  const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
    && parent.expression === outer ? memberOf(parent) : null;
  if (member !== null && FUNCTION_METHODS.includes(member.name)) return member.name;
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) return "alias";
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && parent.right === outer) return "alias";
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(outer)) {
    return "argument";
  }
  if ((ts.isPropertyAssignment(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
    || ts.isPropertyDeclaration(parent)) && parent.initializer === outer) return "initializer";
  return "reference";
}

/**
 * The strict method `node` names when it is not a member access's own name or key: a bare identifier (a variable, a
 * destructured or declared name) or a string, "registerTool" or "registerToolTask". Null for anything else.
 */
function bareStrictName(node, parent) {
  if (ts.isIdentifier(node)) {
    return STRICT_METHODS.includes(node.text) && !(parent !== undefined && ts.isPropertyAccessExpression(parent)
      && parent.name === node) ? node.text : null;
  }
  const text = literalText(node);
  return text !== null && STRICT_METHODS.includes(text) && !(parent !== undefined
    && ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ? text : null;
}

/** Whether a module specifier is one of the forbidden packages or a subpath of one. */
const isForbiddenPackage = (spec) => FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));

/** How a bare strict name, or such a string that is not a member key, is used. */
function nameUseOf(node, parent, ancestors) {
  if (ts.isBindingElement(parent)) return "destructuring";
  if ((ts.isShorthandPropertyAssignment(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) {
    return isAssignmentPattern(parent, ancestors.slice(0, -1)) ? "destructuring" : "property";
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return "string";
  return "identifier";
}

/**
 * The string literals of `[...]` or `Object.freeze([...])`, or null when the expression is anything else or holds
 * anything but string literals.
 */
function literalList(expr, { frozen }) {
  let list = unparen(expr);
  const isFreeze = ts.isCallExpression(list) && list.arguments.length === 1
    && ts.isPropertyAccessExpression(list.expression) && ts.isIdentifier(list.expression.expression)
    && list.expression.expression.text === "Object" && list.expression.name.text === "freeze";
  if (isFreeze) list = unparen(list.arguments[0]);
  else if (frozen) return null;
  if (!ts.isArrayLiteralExpression(list)) return null;
  const names = list.elements.map(literalText);
  return names.includes(null) ? null : names;
}

/**
 * The names a for...of registers, when the registration's name argument is the loop's own `const` variable. The
 * iterable is a literal list, or a `const` in the same file bound to `Object.freeze([...])` of string literals, which
 * no module can change. `names` is null when the iterable is anything else.
 */
function loopOf(nameArg, ancestors, checker, sourceFile) {
  if (nameArg === undefined || !ts.isIdentifier(nameArg)) return null;
  const symbol = checker.getSymbolAtLocation(nameArg);
  if (symbol === undefined) return null;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const loop = ancestors[i];
    // Only a call in the loop's body, not in its iterable.
    if (!ts.isForOfStatement(loop) || ancestors[i + 1] !== loop.statement) continue;
    const list = loop.initializer;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0
      || list.declarations.length !== 1 || !ts.isIdentifier(list.declarations[0].name)) continue;
    if (checker.getSymbolAtLocation(list.declarations[0].name) !== symbol) continue;
    return { iterable: unparen(loop.expression).getText(sourceFile),
      names: iterableNames(loop.expression, checker, sourceFile) };
  }
  return null;
}

/** The string literals a for...of iterates over, by loopOf's rules, or null. */
function iterableNames(expr, checker, sourceFile) {
  const inner = unparen(expr);
  if (!ts.isIdentifier(inner)) return literalList(inner, { frozen: false });
  const declaration = checker.getSymbolAtLocation(inner)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.getSourceFile() !== sourceFile
    || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 || declaration.initializer === undefined) {
    return null;
  }
  return literalList(declaration.initializer, { frozen: true });
}

/**
 * Reads every .js, .mjs and .cjs file under `distDir` as syntax, with the repo's TypeScript parser and binder.
 * - `files`: each scanned file, relative to `distDir`, with forward slashes.
 * - `registrations`: each call of a `.registerTool`, `.registerToolTask` or `.tool` member (also `["registerTool"]`,
 *   `["registerToolTask"]` and `["tool"]`). `name` is its first argument when that is a string literal, else null.
 *   `loop` is set when the name is the variable of an enclosing `for (const x of ...)`: the iterable's text, and the
 *   string literals it holds, or null.
 * - `registerToolRefs`: each use of registerTool or registerToolTask other than a direct call (an alias, an argument,
 *   destructuring, a `.bind`, `.call` or `.apply`, ...), and each `.tool` used as the object of `.bind`, `.call` or
 *   `.apply`. A plain read of a `tool` property, such as the claims' `tool`, is not one.
 * - `specifiers`: each import, re-export, `import()` and `require()`, with `spec` null when it is not a literal.
 * - `packageLiterals`: each other string literal (a no-substitution template included) whose value is a forbidden
 *   package or a subpath of one, such as the argument of a require made by createRequire. A literal already in
 *   `specifiers` is not repeated here.
 * Every `line` is 1-based. Throws when a file does not parse, rather than check a partial tree.
 */
export function analyzeClosure(distDir) {
  const files = walk(distDir).filter((rel) => SCRIPT.test(rel)).sort();
  const absolute = files.map((rel) => path.join(distDir, ...rel.split("/")));
  const program = ts.createProgram({
    rootNames: absolute,
    // noLib and noResolve: the binder, for scopes, needs nothing outside these files.
    options: { allowJs: true, checkJs: false, noEmit: true, noLib: true, noResolve: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const checker = program.getTypeChecker();
  const registrations = [];
  const registerToolRefs = [];
  const specifiers = [];
  const packageLiterals = [];

  files.forEach((file, index) => {
    const sourceFile = program.getSourceFile(absolute[index]);
    if (sourceFile === undefined) throw new Error(`check-service-closure: ${file} was not read`);
    const syntax = program.getSyntacticDiagnostics(sourceFile);
    if (syntax.length > 0) {
      const [first] = syntax;
      const at = first.start === undefined ? "" : `:${sourceFile.getLineAndCharacterOfPosition(first.start).line + 1}`;
      throw new Error(`check-service-closure: ${file}${at} does not parse: `
        + ts.flattenDiagnosticMessageText(first.messageText, "\n"));
    }
    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const ref = (node, member, kind) => registerToolRefs.push({ file, line: lineOf(node), member, kind });
    // The literals that are a specifier's own, so packageLiterals does not report one twice.
    const specifierNodes = new Set();

    const visit = (node, ancestors) => {
      const parent = ancestors[ancestors.length - 1];
      const member = memberOf(node);
      const bare = member === null ? bareStrictName(node, parent) : null;
      if (member !== null && REGISTER_METHODS.includes(member.name)) {
        const { outer, parent: user } = outermost(node, ancestors);
        if (isCallee(outer, user)) {
          const nameArg = ts.isTaggedTemplateExpression(user) ? undefined : user.arguments?.[0];
          registrations.push({ file, line: lineOf(member.at), method: member.name,
            name: nameArg === undefined ? null : literalText(nameArg),
            loop: loopOf(nameArg, ancestors, checker, sourceFile) });
        } else {
          const use = useOf(outer, user);
          if (STRICT_METHODS.includes(member.name) || FUNCTION_METHODS.includes(use)) ref(member.at, member.name, use);
        }
      } else if (bare !== null) {
        ref(node, bare, nameUseOf(node, parent, ancestors));
      }

      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        specifiers.push({ file, line: lineOf(node), kind: ts.isImportDeclaration(node) ? "import" : "export",
          spec: literalText(node.moduleSpecifier) });
        specifierNodes.add(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        specifiers.push({ file, line: lineOf(node), kind: ts.isIdentifier(node.expression) ? "require" : "dynamic",
          spec: literalText(node.arguments[0]) });
        if (node.arguments[0] !== undefined) specifierNodes.add(node.arguments[0]);
      }

      const value = literalText(node);
      if (value !== null && !specifierNodes.has(node) && isForbiddenPackage(value)) {
        packageLiterals.push({ file, line: lineOf(node), value });
      }

      ancestors.push(node);
      ts.forEachChild(node, (child) => visit(child, ancestors));
      ancestors.pop();
    };
    visit(sourceFile, []);
  });

  return { files, registrations, registerToolRefs, specifiers, packageLiterals };
}

/** The names a registration registers: its literal name, or its loop's names. */
const namesOf = (r) => (r.name !== null ? [r.name] : r.loop?.names ?? []);

/** Every problem in `analysis`, one line each, as `<file>[:<line>]: <what>`. An empty array is a pass. */
export function verdict(analysis) {
  const problems = [];

  for (const file of analysis.files) {
    const segments = file.split("/");
    if (segments.slice(0, -1).includes("tools")) {
      problems.push(`${file}: a module under tools/, where the local-dev tools live`);
    }
    const stem = segments.map((segment) => segment.split(".")[0]).find((s) => FORBIDDEN_MODULES.includes(s));
    if (stem !== undefined) problems.push(`${file}: named ${stem}, a module only the local-dev profile uses`);
  }

  const inRegistry = analysis.registrations.filter((r) => r.file === REGISTRY);
  if (inRegistry.length > 1) {
    problems.push(`${REGISTRY}: ${inRegistry.length} registration call sites, at lines `
      + `${inRegistry.map((r) => r.line).join(", ")}; only its one loop may register`);
  }
  for (const r of analysis.registrations) {
    const at = `${r.file}:${r.line}`;
    if (r.file !== REGISTRY) {
      problems.push(`${at}: a ${r.method} call outside ${REGISTRY}`);
    } else if (r.name === null && r.loop === null) {
      problems.push(`${at}: a ${r.method} call whose name is neither a string literal nor its for...of loop's `
        + "variable");
    } else if (r.name === null && r.loop.names === null) {
      problems.push(`${at}: a ${r.method} call looping over ${r.loop.iterable}, which is not a frozen list of string `
        + `literals declared in ${REGISTRY}`);
    }
    for (const name of namesOf(r)) {
      if (FORBIDDEN_TOOLS.includes(name)) problems.push(`${at}: registers the forbidden tool ${name}`);
    }
  }

  for (const ref of analysis.registerToolRefs) {
    problems.push(STRICT_METHODS.includes(ref.member)
      ? `${ref.file}:${ref.line}: a non-call reference to ${ref.member} (${ref.kind})`
      : `${ref.file}:${ref.line}: .${ref.member} used through .${ref.kind}`);
  }

  for (const s of analysis.specifiers) {
    const at = `${s.file}:${s.line}`;
    if (s.spec === null) {
      problems.push(`${at}: a non-literal ${s.kind === "require" ? "require()" : "import()"}`);
    } else if (isForbiddenPackage(s.spec)) {
      problems.push(`${at}: imports ${s.spec}`);
    }
  }
  for (const p of analysis.packageLiterals) {
    problems.push(`${p.file}:${p.line}: names the forbidden package ${p.value} outside an import or require()`);
  }
  return problems;
}

/** Whether this module is the script node was started with, rather than an import. */
function isMain() {
  if (process.argv[1] === undefined) return false;
  const real = (p) => fs.realpathSync.native(p);
  try {
    return real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const distDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..",
    "dist-service"));
  if (!fs.existsSync(path.join(distDir, "service", "index.js"))) {
    console.error(`check-service-closure: ${distDir} holds no service/index.js. Run \`npm run build:service\` first; `
      + "a missing build must not pass.");
    process.exit(1);
  }
  const analysis = analyzeClosure(distDir);
  const problems = verdict(analysis);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`check-service-closure: ${analysis.files.length} files, registration call sites: `
    + `${analysis.registrations.length}, no problems`);
}

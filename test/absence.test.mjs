// The absence suite (design 5.7, ADR-5): viz_render_html, remotion_list_compositions, remotion_init_project and
// remotion_start_studio are missing from the compiled service closure itself, not refused at runtime.
// - T1-T4 check dist-service/ as built.
// - T5 and T6 poison a copy of src/, build it with the repo's tsc, and require the same checks to catch it, which is
//   what proves T1-T4 are live.
// - The evasion cases run verdict on small hand-written .js fixtures, one rule at a time.
// The checks read syntax, not text: services/exec.js names remotion_list_compositions in a hint string.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { analyzeClosure, verdict } from "../scripts/check-service-closure.mjs";
import { fakeRun } from "./helpers/service-harness.mjs";
import { makeSigningFetch } from "./helpers/signing-client.mjs";

const REPO = path.join(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist-service");
const TSC = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
const GOOD = path.join(REPO, "test", "fixtures", "packs", "good");
const REGISTRY = "service/registry.js";

if (!fs.existsSync(path.join(DIST, "service", "index.js"))) {
  throw new Error("dist-service/service/index.js does not exist. Run `npm run build:service` first; "
    + "a missing build must not pass the absence suite.");
}

/** The service profile, in registration order (design 4). */
const FOUR = ["list_templates", "render_still", "render_video_start", "render_job_status"];
/** The local-dev tools the service closure must not contain (design 4, global constraints). */
const FORBIDDEN_TOOLS = ["viz_render_html", "remotion_list_compositions", "remotion_init_project",
  "remotion_start_studio"];
/** The local-dev modules the service never needs, by the name before the first dot. */
const FORBIDDEN_MODULES = ["raster", "tile", "network", "visualize", "studio", "compare", "environment", "browser"];

/** A poisoned build compiles the whole service closure; give it room on a slow CI leg. */
const BUILD = { timeout: 180_000 };
/** Every live check has this timeout, so a request that never settles fails with the test's name. */
const TIMED = { timeout: 30_000 };

// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const load = (distDir, name) => import(pathToFileURL(path.join(distDir, "service", name)).href);

/** T1's check, reused by T6 to show it fails on a poisoned registry. */
function assertFrozenFour(serviceTools) {
  assert.deepEqual([...serviceTools], FOUR, "SERVICE_TOOLS is not exactly the four service tools, in order");
  assert.ok(Object.isFrozen(serviceTools), "SERVICE_TOOLS is not frozen, so a module could push a fifth tool");
}

/** T2's check, reused by T6 to show it fails on a poisoned registry. */
function assertLiveFour(names) {
  assert.deepEqual(names, FOUR, `a live tools/list returned ${JSON.stringify(names)}, not the four service tools`);
}

/**
 * The tool names a live tools/list returns from `distDir`'s createServiceHandler: a real HTTP server on 127.0.0.1:0,
 * the good pack, a fake runner, and the SDK client with every POST signed by the gateway stand-in.
 */
async function liveToolNames(t, distDir) {
  const { createServiceHandler } = await load(distDir, "http.js");
  const { loadPack } = await load(distDir, "templates.js");
  const { RenderSlots } = await load(distDir, "slots.js");
  const { createAuditSink } = await load(distDir, "audit.js");
  const c = await load(distDir, "constants.js");

  // Scratch for the audit log and the render root, which a tools/list never touches.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "absence-live-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const tempRoot = path.join(scratch, "renders");
  fs.mkdirSync(tempRoot);
  const auditPath = path.join(scratch, "audit", "service-audit.jsonl");
  const key = randomBytes(32); // generated per run, never a published key
  const now = Math.floor(Date.now() / 1000);
  const audience = "deploy-absence";
  const logLines = [];
  const ctx = {
    pack: loadPack(GOOD), slots: new RenderSlots(2), run: fakeRun(),
    cli: { file: process.execPath, prefixArgs: ["/pack/node_modules/@remotion/cli/remotion-cli.js"] },
    browserExecutable: "/opt/chrome-headless-shell/chrome-headless-shell", tempRoot,
    audit: createAuditSink(auditPath, randomBytes(32)),
    stillDeadlineMs: c.RENDER_STILL_DEADLINE_MS, cliTimeoutMs: c.RENDER_CLI_TIMEOUT_MS,
    graceMs: c.RENDER_KILL_GRACE_MS, verifyDeadlineMs: c.RENDER_VERIFY_DEADLINE_MS,
    pngCapBytes: c.SERVICE_PNG_CAP_BYTES, shutdown: new AbortController().signal,
    onUnverifiedCleanup: () => assert.fail("a tools/list starts no render"),
    // The operator log, captured so no test writes to stderr.
    log: (line) => logLines.push(line),
  };
  const cfg = {
    host: "127.0.0.1", port: 0, audience, identityKey: key, auditKey: randomBytes(32), auditLogPath: auditPath,
    packDir: GOOD, browserExecutable: ctx.browserExecutable, slots: 2, skewS: c.IDENTITY_SKEW_S,
    bodyCapBytes: c.SERVICE_BODY_CAP_BYTES, stillDeadlineMs: c.RENDER_STILL_DEADLINE_MS,
    pngCapBytes: c.SERVICE_PNG_CAP_BYTES, tempRoot,
  };
  const handler = createServiceHandler(ctx, cfg, { clock: { nowS: () => now, startedAtS: now - 600 } });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const fetch = makeSigningFetch({ key, audience, principal: "principal-a", tenant: "tenant-a", nowS: () => now });
  const client = new Client({ name: "absence-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.address().port}/mcp`), { fetch }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(logLines, [], "the service logged an internal error while listing its tools");
    return tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

/** Replaces the one occurrence of `from` in `file`. An anchor that is missing or repeated fails the test. */
function edit(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  const at = text.indexOf(from);
  assert.ok(at >= 0 && text.indexOf(from, at + 1) < 0,
    `the poison's anchor ${JSON.stringify(from)} must occur exactly once in ${file}; the source has moved`);
  // Sliced, not String.replace, whose replacement string gives `$` a meaning.
  fs.writeFileSync(file, text.slice(0, at) + to + text.slice(at + from.length));
}

/** A tmp-poison-* dir in the repo, never os.tmpdir(): resolution must find the repo's node_modules and package.json. */
function poisonRoot() {
  return fs.mkdtempSync(path.join(REPO, "tmp-poison-"));
}

/**
 * Copies src/ and both tsconfigs into `root`, applies `poison` to the copy's src/, and builds it with the repo's tsc.
 * Returns the copy's dist-service/. Its entry must exist, so a failed compile can never pass as "poison detected".
 */
async function poisonedBuild(root, poison) {
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  for (const f of ["tsconfig.json", "tsconfig.service.json"]) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  poison(path.join(root, "src"));
  const tsc = await new Promise((resolve) => {
    execFile(process.execPath, [TSC, "-p", path.join(root, "tsconfig.service.json")], { cwd: root },
      (error, stdout, stderr) => resolve({ error, output: `${stdout}${stderr}` }));
  });
  assert.equal(tsc.error, null, `the poisoned build did not compile:\n${tsc.output}`);
  const dist = path.join(root, "dist-service");
  assert.ok(fs.existsSync(path.join(dist, "service", "index.js")),
    "the poisoned build emitted no dist-service/service/index.js, so there is nothing to check");
  return dist;
}

/** Removes a tmp-poison-* dir, if before() got as far as making it. */
function removeRoot(root) {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
}

/** Whether `problems` has one about `file` that contains `fragment`. */
const reports = (problems, file, fragment) => problems.some((p) => p.startsWith(`${file}:`) && p.includes(fragment));

test("T1: the registry exports exactly the frozen four, in order", async () => {
  const { SERVICE_TOOLS } = await load(DIST, "registry.js");
  assertFrozenFour(SERVICE_TOOLS);
});

test("T2: a live tools/list against dist-service returns exactly the four", TIMED, async (t) => {
  assertLiveFour(await liveToolNames(t, DIST));
});

test("T3: verdict on dist-service is empty, even though services/exec.js names remotion_list_compositions in a "
  + "hint string", () => {
  // The premise: a check that read text would fail this build.
  const exec = fs.readFileSync(path.join(DIST, "services", "exec.js"), "utf8");
  assert.ok(exec.includes("remotion_list_compositions"),
    "services/exec.js no longer names remotion_list_compositions, so this test no longer shows why the check reads "
    + "syntax rather than text");

  const analysis = analyzeClosure(DIST);
  // Positive control: the walk reached the registry and the file with the hint, so an empty verdict means something.
  for (const file of [REGISTRY, "services/exec.js", "service/index.js"]) {
    assert.ok(analysis.files.includes(file),
      `the analysis did not scan ${file} (scanned ${analysis.files.join(", ")})`);
  }
  assert.deepEqual(verdict(analysis), []);
});

test("T4: exactly one registration call site, in service/registry.js, inside its loop", () => {
  const { registrations, registerToolRefs } = analyzeClosure(DIST);
  assert.equal(registrations.length, 1,
    `expected one registration call site, found ${JSON.stringify(registrations)}`);
  const [site] = registrations;
  assert.equal(site.file, REGISTRY);
  assert.equal(site.method, "registerTool");
  assert.equal(site.name, null, "the registry's call site takes its name from the loop, not a literal");
  assert.deepEqual(site.loop, { iterable: "SERVICE_TOOLS", names: FOUR },
    "the call site is not inside a for...of over the frozen SERVICE_TOOLS");
  // The reported line is the call's own line.
  const line = fs.readFileSync(path.join(DIST, ...REGISTRY.split("/")), "utf8").split(/\r?\n/)[site.line - 1];
  assert.match(line, /\.registerTool\(/, `service/registry.js:${site.line} is not the call site`);
  assert.deepEqual(registerToolRefs, [], "registerTool is referenced other than by its one call");
});

describe("T5 poisoned build: a type-only import of src/services/entrypoint.ts and tools/project.ts", () => {
  let root;
  let dist;
  before(async () => {
    root = poisonRoot();
    dist = await poisonedBuild(root, (src) => {
      const tools = path.join(src, "service", "tools.ts");
      fs.writeFileSync(tools, 'import type {} from "../tools/project.js";\n'
        + 'import type {} from "../services/entrypoint.js";\n' + fs.readFileSync(tools, "utf8"));
    });
  }, BUILD);
  after(() => removeRoot(root));

  test("verdict reports the tool module, its forbidden tool, and the modules and import() it drags in", () => {
    const analysis = analyzeClosure(dist);
    // The premise: tsc emits every file in the program, type-only imports' targets included.
    const emitted = ["tools/project.js", "services/entrypoint.js", "services/environment.js", "services/browser.js"];
    for (const file of emitted) {
      assert.ok(analysis.files.includes(file), `the poisoned build did not emit ${file}`);
    }
    const problems = verdict(analysis);
    const expected = [
      ["tools/project.js", "a module under tools/"],
      ["tools/project.js", "registers the forbidden tool remotion_init_project"],
      ["services/environment.js", "named environment"],
      ["services/browser.js", "named browser"],
      ["services/browser.js", "a non-literal import()"],
    ];
    for (const [file, fragment] of expected) {
      assert.ok(reports(problems, file, fragment),
        `verdict did not report ${file}: ${fragment}. It reported:\n${problems.join("\n")}`);
    }
  });
});

describe("T6 poisoned registry: a fifth tool", () => {
  let root;
  let dist;
  before(async () => {
    root = poisonRoot();
    dist = await poisonedBuild(root, (src) => {
      edit(path.join(src, "service", "registry.ts"), '"render_job_status"] as const',
        '"render_job_status", "viz_render_html"] as const');
      edit(path.join(src, "service", "tools.ts"), "} satisfies Record<string, ToolDef>);",
        '  viz_render_html: { description: "A poisoned fifth tool.", handler: notImplemented },\n'
        + "} satisfies Record<string, ToolDef>);");
    });
  }, BUILD);
  after(() => removeRoot(root));

  test("T1's equality fails", async () => {
    const { SERVICE_TOOLS } = await load(dist, "registry.js");
    assert.throws(() => assertFrozenFour(SERVICE_TOOLS), { name: "AssertionError" });
  });

  test("a live tools/list from the poisoned build returns five", TIMED, async (t) => {
    const names = await liveToolNames(t, dist);
    assert.deepEqual(names, [...FOUR, "viz_render_html"]);
    assert.throws(() => assertLiveFour(names), { name: "AssertionError" });
  });

  test("verdict reports viz_render_html", () => {
    const problems = verdict(analyzeClosure(dist));
    assert.equal(problems.length, 1, `expected the one poisoned name, got:\n${problems.join("\n")}`);
    assert.match(problems[0], /^service\/registry\.js:\d+: registers the forbidden tool viz_render_html$/);
  });
});

// Each fixture is a closure of its own: one hand-written .js file in a dir of its own, analyzed alone, so the problems
// verdict returns are exactly the fixture's.
const fixtures = { root: undefined, next: 0 };
/** Where most fixtures go: a file outside the registry. */
const EVASION = "service/evasion.js";
const NOT_LOOP_VARIABLE = "a registerTool call whose name is neither a string literal nor its for...of loop's variable";

/** Writes `files` ({ relative path: source }) into a fresh dir and returns the dir. */
function writeFixture(files) {
  fixtures.next += 1;
  const dir = path.join(fixtures.root, String(fixtures.next));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), source);
  }
  return dir;
}

/** The verdict on `files` alone, after checking the analysis scanned each of them. */
function check(files) {
  const analysis = analyzeClosure(writeFixture(files));
  for (const rel of Object.keys(files)) {
    assert.ok(analysis.files.includes(rel), `the analysis did not scan the fixture ${rel}`);
  }
  return verdict(analysis);
}

/** Asserts the fixture yields exactly the one problem `expected`. */
function assertOneProblem(files, expected) {
  assert.deepEqual(check(files), [expected]);
}

/** A registry.js fixture from its lines. */
const registry = (...lines) => ({ [REGISTRY]: [...lines, ""].join("\n") });

describe("verdict on hand-written fixtures", () => {
  before(() => {
    fixtures.root = poisonRoot();
  });
  after(() => removeRoot(fixtures.root));

  describe("verdict catches each evasion", () => {
    const evasions = [
      ["const r = server.registerTool",
        "export function f(server) {\n  const r = server.registerTool;\n  return r;\n}\n",
        `${EVASION}:2: a non-call reference to registerTool (alias)`],
      ['server["registerTool"]("x", …)',
        'export function f(server, h) {\n  server["registerTool"]("x", {}, h);\n}\n',
        `${EVASION}:2: a registerTool call outside ${REGISTRY}`],
      ["server.tool.bind(server)",
        "export const f = (server) => server.tool.bind(server);\n",
        `${EVASION}:1: .tool used through .bind`],
      ["const { registerTool } = server",
        "export function f(server) {\n  const { registerTool } = server;\n}\n",
        `${EVASION}:2: a non-call reference to registerTool (destructuring)`],
      ["server.registerTool(name, …) outside the registry",
        "export function f(server, name, h) {\n  server.registerTool(name, {}, h);\n}\n",
        `${EVASION}:2: a registerTool call outside ${REGISTRY}`],
      ['import("@resvg/resvg-js")',
        'export const f = () => import("@resvg/resvg-js");\n',
        `${EVASION}:1: imports @resvg/resvg-js`],
      ["import(variable)",
        "export const f = (variable) => import(variable);\n",
        `${EVASION}:1: a non-literal import()`],
    ];
    for (const [title, source, expected] of evasions) {
      test(title, () => assertOneProblem({ [EVASION]: source }, expected));
    }
  });

  test("positive control: claims.tool !== toolOf(m) is not reported", () => {
    // The gateway contract's claim is named `tool`, so reading it is not a registration. Neither is text that names
    // a forbidden tool or registerTool inside a longer string.
    assert.deepEqual(check({ [EVASION]: [
      "export function f(claims, m, x, toolOf) {",
      "  const { tool } = claims;",
      "  const event = { tool: x.tool };",
      '  const hint = "Call remotion_list_compositions; never server.registerTool(\\"viz_render_html\\")";',
      "  return claims.tool !== toolOf(m) || tool === event.tool || hint === '';",
      "}",
      "",
    ].join("\n") }), []);
  });

  test("analyzeClosure refuses a file that does not parse, rather than check a partial tree", () => {
    const dir = writeFixture({ [EVASION]: "export function f(server) {\n  server.registerTool(\n" });
    assert.throws(() => analyzeClosure(dir),
      /^Error: check-service-closure: service\/evasion\.js:\d+ does not parse: /);
  });

  describe("verdict reports each other non-call use of registerTool or .tool", () => {
    const uses = [
      ["server.registerTool.call(server, …)",
        'export const f = (server, h) => server.registerTool.call(server, "x", {}, h);\n',
        `${EVASION}:1: a non-call reference to registerTool (call)`],
      ["registerTool as an argument",
        "export const f = (server, register) => register(server.registerTool);\n",
        `${EVASION}:1: a non-call reference to registerTool (argument)`],
      ["registerTool as a property initializer",
        "export const f = (server) => ({ register: server.registerTool });\n",
        `${EVASION}:1: a non-call reference to registerTool (initializer)`],
      ['server["registerTool"] read but not called',
        'export const f = (server) => server["registerTool"];\n',
        `${EVASION}:1: a non-call reference to registerTool (reference)`],
      ["destructuring in an assignment: ({ registerTool: o.r } = server)",
        "export function f(server, o) {\n  ({ registerTool: o.r } = server);\n}\n",
        `${EVASION}:2: a non-call reference to registerTool (destructuring)`],
      ['the name alone, as a string: const k = "registerTool"',
        'export const k = "registerTool";\n',
        `${EVASION}:1: a non-call reference to registerTool (string)`],
      ["a bare registerTool, as an imported function would be",
        "export const f = (server) => registerTool(server);\n",
        `${EVASION}:1: a non-call reference to registerTool (identifier)`],
      ["(server.registerTool)(…) outside the registry",
        'export const f = (server, h) => (server.registerTool)("x", {}, h);\n',
        `${EVASION}:1: a registerTool call outside ${REGISTRY}`],
      ["server.tool.apply(server, …)",
        "export const f = (server, args) => server.tool.apply(server, args);\n",
        `${EVASION}:1: .tool used through .apply`],
      ['server["tool"].call(server, …)',
        'export const f = (server, h) => server["tool"].call(server, "x", h);\n',
        `${EVASION}:1: .tool used through .call`],
      ["server.tool(…) outside the registry",
        'export const f = (server, h) => server.tool("x", h);\n',
        `${EVASION}:1: a tool call outside ${REGISTRY}`],
      ['server["tool"](…) outside the registry',
        'export const f = (server, h) => server["tool"]("x", h);\n',
        `${EVASION}:1: a tool call outside ${REGISTRY}`],
    ];
    for (const [title, source, expected] of uses) {
      test(title, () => assertOneProblem({ [EVASION]: source }, expected));
    }
  });

  describe("verdict holds service/registry.js to its one loop over a frozen list", () => {
    test("two call sites", () => {
      assertOneProblem(registry(
        "export function r(server, h) {",
        '  server.registerTool("list_templates", {}, h);',
        '  server.registerTool("render_still", {}, h);',
        "}",
      ), `${REGISTRY}: 2 registration call sites, at lines 2, 3; only its one loop may register`);
    });

    test("a non-literal name outside a loop", () => {
      assertOneProblem(registry(
        "export function r(server, name, h) {",
        "  server.registerTool(name, {}, h);",
        "}",
      ), `${REGISTRY}:2: ${NOT_LOOP_VARIABLE}`);
    });

    test("a name that shadows the loop's variable", () => {
      assertOneProblem(registry(
        'export const SERVICE_TOOLS = Object.freeze(["list_templates"]);',
        "export function r(server, h) {",
        "  for (const name of SERVICE_TOOLS) {",
        "    {",
        '      const name = "viz_render_html";',
        "      server.registerTool(name, {}, h);",
        "    }",
        "  }",
        "}",
      ), `${REGISTRY}:6: ${NOT_LOOP_VARIABLE}`);
    });

    test("a loop over a list that is not frozen", () => {
      assertOneProblem(registry(
        'export const SERVICE_TOOLS = ["list_templates"];',
        "export function r(server, h) {",
        "  for (const name of SERVICE_TOOLS) server.registerTool(name, {}, h);",
        "}",
      ), `${REGISTRY}:3: a registerTool call looping over SERVICE_TOOLS, which is not a frozen list of string literals `
        + `declared in ${REGISTRY}`);
    });

    test("a loop over a frozen list that names a forbidden tool", () => {
      assertOneProblem(registry(
        'export const SERVICE_TOOLS = Object.freeze(["list_templates", "remotion_start_studio"]);',
        "export function r(server, h) {",
        "  for (const name of SERVICE_TOOLS) server.registerTool(name, {}, h);",
        "}",
      ), `${REGISTRY}:3: registers the forbidden tool remotion_start_studio`);
    });

    for (const name of FORBIDDEN_TOOLS) {
      test(`a literal ${name}`, () => {
        assertOneProblem(registry("export function r(server, h) {", `  server.registerTool("${name}", {}, h);`, "}"),
          `${REGISTRY}:2: registers the forbidden tool ${name}`);
      });
    }
  });

  describe("verdict reports each local-dev module", () => {
    test("a file under tools/", () => {
      assertOneProblem({ "tools/render.js": "export {};\n" },
        "tools/render.js: a module under tools/, where the local-dev tools live");
    });
    for (const stem of FORBIDDEN_MODULES) {
      test(`a file named ${stem}`, () => {
        assertOneProblem({ [`services/${stem}.js`]: "export {};\n" },
          `services/${stem}.js: named ${stem}, a module only the local-dev profile uses`);
      });
    }
  });

  describe("verdict reports each forbidden specifier", () => {
    const subpath = "puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
    const specifiers = [
      ["a static import of puppeteer-core", 'import "puppeteer-core";\n',
        `${EVASION}:1: imports puppeteer-core`],
      ["a re-export from a puppeteer-core subpath", `export * from "${subpath}";\n`,
        `${EVASION}:1: imports ${subpath}`],
      ["a static import of @resvg/resvg-js", 'import { Resvg } from "@resvg/resvg-js";\nexport { Resvg };\n',
        `${EVASION}:1: imports @resvg/resvg-js`],
      ["require of puppeteer-core", 'export const f = (require) => require("puppeteer-core");\n',
        `${EVASION}:1: imports puppeteer-core`],
      ["a non-literal require", "export const f = (require, x) => require(x);\n",
        `${EVASION}:1: a non-literal require()`],
    ];
    for (const [title, source, expected] of specifiers) {
      test(title, () => assertOneProblem({ [EVASION]: source }, expected));
    }
  });
});

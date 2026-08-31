# CI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing six-leg CI into a correctness, security, regression and release pipeline that verifies the artifact users actually install, not just the source tree.

**Architecture:** One `ci.yml` (on push/PR) and one `release.yml` (on tag). CI keeps its build-and-test matrix but retargets it at supported Node versions, then gains a fan-out job that downloads the built `.mcpb`, extracts it on each platform, and completes a real MCP handshake against the extracted server. Release is separate because it needs `id-token: write` for keyless signing, and a workflow that can sign should not run on every pull request.

**Tech Stack:** GitHub Actions, `node --test` (retained — not vitest), TypeScript 5, `@anthropic-ai/mcpb`, Sigstore cosign, Syft, Trivy, semantic-release.

**Spec:** This document. The decisions below were made explicitly by the repo owner on 2026-08-31 and are not open for re-litigation by an implementer; where a decision has a known cost, it is recorded with the decision.

---

## Global Constraints

- **Node floor is 22.** `package.json` `engines.node` must read `">=22"`. Matrix tests `[22, 24, 26]`. Node 20 reached EOL in April 2026 (last release `v20.20.2`, 2026-03-24, verified against `https://nodejs.org/dist/index.json` on 2026-08-31); Node 18 EOL'd April 2025. The package must not claim support for an unpatched runtime.
- **Test runner stays `node --test`.** Do not introduce vitest. 96 tests pass today across 11 files with zero test dependencies. Coverage is added via Node's own `--experimental-test-coverage`.
- **`SERVER_VERSION`, `manifest.json.version` and `package.json.version` must always be equal.** Enforced today by a GUARD in `test/unit.test.mjs` and a fail-fast in `scripts/build-bundle.mjs`. Any release automation must update all three atomically.
- **ESLint lands advisory-first.** `continue-on-error: true` until findings are cleared, then flipped in its own commit.
- **No step may embed an absolute path containing a username.** Two files already violate the spirit of this (`verify-roundtrip.mjs:23`, `docs/superpowers/plans/2026-08-25-gateway-audit-dashboard.md`); they are harmless but must not be joined by new ones once the repo is public.
- **Every gate must be proven to catch a known-bad input before it is trusted.** A guard observed only staying quiet is indistinguishable from a disabled one. Each task below includes that proof step.
- **CI already sets `REMOTION_MCP_PAGE_TIMEOUT_MS: "90000"`.** Preserve it in any workflow that runs `npm test`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` | Modify. Matrix retarget, lint, coverage, conformance, scanning, artifact verification. |
| `.github/workflows/release.yml` | Create. Tag-triggered: version sync, build, sign, publish. Isolated because it needs `id-token: write`. |
| `eslint.config.js` | Create. Flat config, typescript-eslint. |
| `scripts/check-bundle-size.mjs` | Create. Compares the built `.mcpb` against a recorded baseline. |
| `scripts/bundle-size-baseline.json` | Create. The recorded ceiling, updated deliberately. |
| `scripts/verify-bundle-runtime.mjs` | Create. Extracts a `.mcpb` and completes an MCP handshake against it. |
| `scripts/sync-version.mjs` | Create. Writes one version into all three files that must agree. |
| `test/engines.test.mjs` | Create. Guards that `engines.node` and the CI matrix cannot drift apart. |
| `test/version-sync.test.mjs` | Create. Guards `sync-version.mjs` against the three-way invariant. |
| `package.json` | Modify. `engines`, new scripts, `semantic-release` devDeps. |

---

## Task 0: Make the repository public

The whole budget argument for the expanded matrix depends on this. A private repo meters Actions minutes at 1×/2×/10× for Linux/Windows/macOS; the current run bills ~54 minutes, and the target pipeline would bill ~150.

**Files:**
- No source changes. This is a verification task plus a settings change.

**Interfaces:**
- Produces: an unmetered Actions budget, which every later task assumes.

- [ ] **Step 1: Re-verify that no secret has ever been committed**

```bash
git rev-list --all | while read c; do
  git grep -inE '(sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY)' "$c" -- . 2>/dev/null
done
```

Expected: no output. This was run on 2026-08-31 across all 45 commits and 60 ever-tracked files and produced nothing; re-run because history may have advanced.

- [ ] **Step 2: Prove the scan catches a known-bad input**

Do not trust a scan that has only ever stayed quiet.

```bash
git stash list >/dev/null
printf 'ghp_%s\n' "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" > /tmp/canary.txt
grep -inE 'ghp_[A-Za-z0-9]{30,}' /tmp/canary.txt && echo "GUARD WORKS" || echo "GUARD IS DEAD"
rm /tmp/canary.txt
```

Expected: `GUARD WORKS`. If it prints `GUARD IS DEAD`, the regex was mangled by shell escaping and Step 1 proved nothing.

- [ ] **Step 3: Confirm what becomes public**

```bash
git log --all --pretty=format: --name-only --diff-filter=A | sort -u | grep -vE '^$'
```

Read the list. It includes `docs/adr/`, `docs/superpowers/plans/`, and the audit-log design. That is intended — it is the portfolio value — but confirm it deliberately rather than discovering it later.

- [ ] **Step 4: Flip visibility**

```bash
gh repo edit --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 5: Verify**

```bash
gh repo view --json visibility -q .visibility
```

Expected: `PUBLIC`.

---

## Task 1: Retarget the Node matrix and the engines claim

**Files:**
- Create: `test/engines.test.mjs`
- Modify: `package.json` (`engines.node`, test script)
- Modify: `.github/workflows/ci.yml:12-13` (matrix)

**Interfaces:**
- Produces: `engines.node` = `">=22"`, matrix `[22, 24, 26]`. Task 7 reuses the same matrix values.

- [ ] **Step 1: Write the failing test**

`test/engines.test.mjs`:

```js
/**
 * The engines claim and the CI matrix are two statements of the same fact, in
 * two files, with nothing connecting them. They drifted once already: engines
 * said >=18 while CI tested 20 and 22, so the package claimed support for a
 * runtime no test had ever exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

function matrixNodeVersions() {
  const match = workflow.match(/node:\s*\[([^\]]+)\]/);
  assert.ok(match, "ci.yml has no `node: [...]` matrix line to read");
  return match[1].split(",").map((v) => Number(v.trim())).sort((a, b) => a - b);
}

test("engines.node names a floor, not a range or a wildcard", () => {
  assert.match(pkg.engines.node, /^>=\d+$/, `engines.node is '${pkg.engines.node}'`);
});

test("the lowest tested Node version is exactly the engines floor", () => {
  // Lower would mean claiming support for something never tested. Higher would
  // mean burning CI on a version the package does not claim.
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.equal(matrixNodeVersions()[0], floor);
});

test("no EOL Node major is tested or claimed", () => {
  // Node 20 EOL 2026-04, Node 18 EOL 2025-04. Verified against
  // https://nodejs.org/dist/index.json on 2026-08-31.
  const EOL = [18, 20];
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.ok(!EOL.includes(floor), `engines floor ${floor} is EOL`);
  for (const version of matrixNodeVersions()) {
    assert.ok(!EOL.includes(version), `matrix tests EOL node ${version}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test test/engines.test.mjs
```

Expected: two failures — `engines.node` is `">=18"`, and the matrix's lowest entry is `20`.

- [ ] **Step 3: Update `package.json`**

Set `"engines": { "node": ">=22" }`, and append the new test file to the `test` script so it runs with everything else.

- [ ] **Step 4: Update the matrix**

In `.github/workflows/ci.yml`, change `node: [20, 22]` to:

```yaml
        node: [22, 24, 26]
```

- [ ] **Step 5: Run the tests**

```bash
node --test test/engines.test.mjs && npm test
```

Expected: 3 new tests pass; full suite still green.

- [ ] **Step 6: Commit**

```bash
git add package.json .github/workflows/ci.yml test/engines.test.mjs
git commit -m "ci: test supported Node versions and claim only those

Node 20 EOL'd 2026-04 and Node 18 in 2025-04, but engines said >=18 while
CI tested 20 and 22 - so the package claimed support for a runtime no test
had ever run. test/engines.test.mjs ties the two statements together."
```

---

## Task 2: Coverage reporting

Node's own coverage, no new dependency. Advisory first — a threshold set before anyone has seen the number is a number invented, not measured.

**Files:**
- Modify: `package.json` (add `test:coverage` script)
- Modify: `.github/workflows/ci.yml` (one step on the ubuntu/24 leg only)

**Interfaces:**
- Produces: a printed coverage summary. No gate yet; Task 2b (deferred, not in this plan) may add one once a real baseline exists.

- [ ] **Step 1: Add the script**

In `package.json` `scripts`, add — reusing the exact file list from `test` so the two cannot diverge:

```json
"test:coverage": "node --test --experimental-test-coverage test/*.test.mjs"
```

- [ ] **Step 2: Run it locally and record the number**

```bash
npm run test:coverage 2>&1 | tail -20
```

Write the resulting line coverage percentage into the commit message. It is the baseline any future threshold must be argued from.

- [ ] **Step 3: Add the CI step**

In `ci.yml`, inside `build-and-test`, after the `Test` step:

```yaml
      - name: Coverage
        if: matrix.os == 'ubuntu-latest' && matrix.node == 24
        run: npm run test:coverage
        env:
          REMOTION_MCP_PAGE_TIMEOUT_MS: "90000"
```

One leg only: coverage is a property of the code, not of the platform, and running it six times produces one number six times.

- [ ] **Step 4: Verify**

```bash
npm run test:coverage 2>&1 | grep -E "all files|% Lines"
```

Expected: a coverage table is printed and the command exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci: report test coverage on one leg

Node's own --experimental-test-coverage, no new dependency. Advisory only:
a threshold chosen before anyone has seen the number is invented, not
measured. Baseline at this commit: <PASTE PERCENTAGE FROM STEP 2>."
```

---

## Task 3: ESLint, advisory

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json` (devDeps, `lint` script)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run lint`. Task 3b (a later, separate commit) flips `continue-on-error` to false.

- [ ] **Step 1: Install**

```bash
npm install --save-dev eslint @eslint/js typescript-eslint
```

- [ ] **Step 2: Create `eslint.config.js`**

```js
// Flat config. Type-aware rules are deliberately NOT enabled yet: they need a
// project reference and roughly triple lint time, and this config lands in
// advisory mode where the goal is a readable finding count, not maximum depth.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "*.mcpb"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // The codebase uses `Record<string, unknown>` for puppeteer's untyped
      // options bag on purpose; flagging it adds noise, not safety.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs", "scripts/**"],
    ...tseslint.configs.disableTypeChecked,
  },
);
```

- [ ] **Step 3: Add the script and see the real finding count**

Add `"lint": "eslint ."` to `scripts`, then:

```bash
npm run lint 2>&1 | tail -5
```

Record the count. Do not fix anything yet — a mechanical fix commit touching every file must not be mixed with a config commit.

- [ ] **Step 4: Add the CI step, non-blocking**

```yaml
      - name: Lint
        if: matrix.os == 'ubuntu-latest' && matrix.node == 24
        run: npm run lint
        continue-on-error: true   # flip to blocking once findings are cleared
```

- [ ] **Step 5: Prove the linter actually runs**

A `continue-on-error` step that silently does nothing looks identical to a clean one.

```bash
printf 'const unused = 1;\n' >> src/constants.ts
npm run lint 2>&1 | grep -c "no-unused-vars"
git checkout src/constants.ts
```

Expected: at least 1. If 0, the config is not matching `src/**/*.ts` and the step is decorative.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.js package.json package-lock.json .github/workflows/ci.yml
git commit -m "ci: add ESLint in advisory mode

Non-blocking on purpose: <N> findings on the existing tree, and a mechanical
fix commit touching most files should not be reviewed alongside a config
commit. Flip continue-on-error once the count is zero. Verified the config
actually matches src/**/*.ts by planting an unused binding."
```

---

## Task 4: MCP protocol conformance via an independent implementation

`test/protocol.test.mjs` already handshakes the server — but with our own client code. If that harness has a bug, both sides agree and the test passes anyway. MCP Inspector is a second implementation, which is the entire point.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `dist/index.js` from the build step.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Find the working invocation locally**

```bash
npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

Expected: JSON containing a `tools` array. If the flag spelling differs in the current release, record the working form here before writing the CI step — do not guess it into a workflow.

- [ ] **Step 2: Add the step**

```yaml
      - name: MCP conformance (independent client)
        if: matrix.os == 'ubuntu-latest' && matrix.node == 24
        run: |
          npx -y @modelcontextprotocol/inspector --cli node dist/index.js \
            --method tools/list > inspector-tools.json
          node -e "
            const r = JSON.parse(require('fs').readFileSync('inspector-tools.json','utf8'));
            const tools = r.tools ?? r;
            if (!Array.isArray(tools)) { console.error('no tools array'); process.exit(1); }
            if (tools.length !== 13) {
              console.error('expected 13 tools, got ' + tools.length + ': ' + tools.map(t=>t.name).join(','));
              process.exit(1);
            }
            for (const t of tools) {
              if (!t.name || !t.description || !t.inputSchema) {
                console.error('tool missing required field: ' + JSON.stringify(t).slice(0,200));
                process.exit(1);
              }
            }
            console.log('conformance OK: ' + tools.length + ' tools');
          "
        env:
          REMOTION_MCP_WORKSPACE: ${{ github.workspace }}
```

The count is hardcoded at 13 deliberately: adding a tool should require touching this line, so nobody adds one without noticing the conformance check exists.

- [ ] **Step 3: Prove it fails on a wrong count**

```bash
# temporarily assert 99 instead of 13 and confirm the node -e block exits 1
```

Expected: non-zero exit with the "expected 13 tools, got 13" message shape.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: check tools/list with an independent MCP client

test/protocol.test.mjs handshakes with our own client code, so a bug in the
harness passes on both sides. MCP Inspector is a second implementation."
```

---

## Task 5: Bundle size regression gate

**Files:**
- Create: `scripts/check-bundle-size.mjs`
- Create: `scripts/bundle-size-baseline.json`
- Modify: `.github/workflows/ci.yml` (bundle job)

**Interfaces:**
- Consumes: the `.mcpb` produced by `npm run bundle`.
- Produces: a non-zero exit when the bundle grows past the ceiling.

- [ ] **Step 1: Record the baseline from a real build**

```bash
npm run bundle
node -e "
  const fs=require('fs'); const f=fs.readdirSync('.').find(n=>n.endsWith('.mcpb'));
  const bytes=fs.statSync(f).size;
  fs.writeFileSync('scripts/bundle-size-baseline.json',
    JSON.stringify({ file:f, bytes, recordedAt:new Date().toISOString().slice(0,10), tolerancePercent:10 },null,2)+'\n');
  console.log(f, bytes, (bytes/1048576).toFixed(2)+' MiB');
"
```

- [ ] **Step 2: Write `scripts/check-bundle-size.mjs`**

```js
/**
 * Fail the build when the distributable grows unexpectedly.
 *
 * The number this protects is not aesthetic: NATIVE_TARGETS in build-bundle.mjs
 * fetches six platform binaries, and the two musl entries are commented out
 * behind a deliberate ~8 MB decision. A gate here means that decision gets made
 * again explicitly rather than discovered in a release.
 */
import fs from "node:fs";
import path from "node:path";

const baselinePath = new URL("./bundle-size-baseline.json", import.meta.url);
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

const bundle = fs.readdirSync(process.cwd()).find((n) => n.endsWith(".mcpb"));
if (!bundle) {
  console.error("No .mcpb in the working directory. Run `npm run bundle` first.");
  process.exit(1);
}

const bytes = fs.statSync(path.resolve(bundle)).size;
const ceiling = Math.round(baseline.bytes * (1 + baseline.tolerancePercent / 100));
const mib = (n) => (n / 1048576).toFixed(2) + " MiB";

console.log(`bundle   ${bundle}  ${mib(bytes)}`);
console.log(`baseline ${baseline.file}  ${mib(baseline.bytes)}  (recorded ${baseline.recordedAt})`);
console.log(`ceiling  ${mib(ceiling)}  (+${baseline.tolerancePercent}%)`);

if (bytes > ceiling) {
  console.error(
    `\nBundle exceeded the ceiling by ${mib(bytes - ceiling)}.\n` +
      `If the growth is intended - enabling the musl targets, for example - update\n` +
      `scripts/bundle-size-baseline.json in the same commit and say why.`,
  );
  process.exit(1);
}
console.log("\nWithin budget.");
```

- [ ] **Step 3: Prove the gate catches growth**

```bash
node -e "
  const fs=require('fs'); const p='scripts/bundle-size-baseline.json';
  const b=JSON.parse(fs.readFileSync(p,'utf8')); const orig=b.bytes;
  b.bytes = Math.floor(b.bytes/2);            // pretend the baseline was half
  fs.writeFileSync(p, JSON.stringify(b,null,2)+'\n');
  console.log('baseline halved to force a breach');
"
node scripts/check-bundle-size.mjs; echo "exit=$?"
```

Expected: `exit=1` and the breach message. Then restore the real baseline from Step 1.

- [ ] **Step 4: Verify it passes on the true baseline**

```bash
node scripts/check-bundle-size.mjs; echo "exit=$?"
```

Expected: `exit=0`, "Within budget."

- [ ] **Step 5: Wire it into the bundle job**

```yaml
      - name: Bundle size gate
        run: node scripts/check-bundle-size.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/check-bundle-size.mjs scripts/bundle-size-baseline.json .github/workflows/ci.yml
git commit -m "ci: gate the bundle against a recorded size baseline

Verified in both directions: halving the baseline makes it exit 1, the real
baseline exits 0."
```

---

## Task 6: Run the shipped artifact on every platform

The highest-value gap. CI tests the source tree on three platforms and builds the `.mcpb` on one, but nothing has ever *executed* the thing a user installs. The per-platform resvg binaries in `NATIVE_TARGETS` are asserted to be present in the zip and never once loaded from inside it.

**Files:**
- Create: `scripts/verify-bundle-runtime.mjs`
- Modify: `.github/workflows/ci.yml` (bundle job uploads the artifact; new `verify-bundle` job)

**Interfaces:**
- Consumes: the `.mcpb` artifact uploaded by the `bundle` job.
- Produces: proof that the extracted server initializes, lists 13 tools, and rasterizes an SVG using the platform's own native binary.

- [ ] **Step 1: Write `scripts/verify-bundle-runtime.mjs`**

```js
/**
 * Extract a .mcpb and drive the server inside it over stdio.
 *
 * Everything else in CI tests the source tree. This tests the artifact: the
 * manifest's entry point, the vendored node_modules, and - the part nothing
 * else covers - whether the platform's own @resvg/resvg-js binary actually
 * LOADS from inside the bundle. test/bundle.test.mjs asserts those six binaries
 * are present in the zip; presence is not loadability.
 *
 * Usage: node scripts/verify-bundle-runtime.mjs <path-to.mcpb> <extract-dir>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , bundlePath, extractDir] = process.argv;
if (!bundlePath || !extractDir) {
  console.error("usage: verify-bundle-runtime.mjs <bundle.mcpb> <extract-dir>");
  process.exit(1);
}

// Reuse the pure-Node zip reader already written for test/bundle.test.mjs
// rather than shelling out to tar: GNU tar under Git Bash reads C:\... as a
// remote host spec, which is why that reader exists in the first place.
const { extractZip } = await import(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "zip-reader.mjs")
);
await extractZip(bundlePath, extractDir);

const entry = path.join(extractDir, "server", "index.js");
if (!fs.existsSync(entry)) {
  console.error(`No server/index.js in the extracted bundle at ${extractDir}`);
  process.exit(1);
}

const workspace = fs.mkdtempSync(path.join(extractDir, "ws-"));
const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: { ...process.env, REMOTION_MCP_WORKSPACE: workspace },
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d.toString(); });
child.stderr.on("data", (d) => { stderr += d.toString(); });

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "bundle-verify", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
// The one call that forces the native addon to load. A 2x2 square is enough:
// this is a linkage test, not a rendering test.
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
  name: "viz_render_svg",
  arguments: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#000"/></svg>',
    width: 2, return_image: false, output_path: "probe.png",
  } } });

const deadline = setTimeout(() => {
  console.error(`Timed out. stderr:\n${stderr}`);
  child.kill("SIGKILL");
  process.exit(1);
}, 120_000);

const responses = new Map();
child.stdout.on("data", () => {
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    } catch { /* partial line; the next chunk completes it */ }
  }
  if (responses.has(1) && responses.has(2) && responses.has(3)) finish();
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  child.kill();

  const problems = [];
  const init = responses.get(1);
  if (!init?.result?.serverInfo?.name) problems.push("initialize returned no serverInfo");

  const tools = responses.get(2)?.result?.tools;
  if (!Array.isArray(tools)) problems.push("tools/list returned no array");
  else if (tools.length !== 13) problems.push(`expected 13 tools, got ${tools.length}`);

  const render = responses.get(3);
  if (render?.error) problems.push(`viz_render_svg errored: ${JSON.stringify(render.error).slice(0, 300)}`);
  else if (render?.result?.isError) {
    problems.push(`viz_render_svg refused: ${JSON.stringify(render.result.content).slice(0, 300)}`);
  }

  if (problems.length > 0) {
    console.error(`Bundle runtime verification FAILED on ${process.platform}/${process.arch}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nserver stderr:\n${stderr}`);
    process.exit(1);
  }
  console.log(`Bundle runtime OK on ${process.platform}/${process.arch}: ${tools.length} tools, resvg loaded.`);
  process.exit(0);
}
```

- [ ] **Step 2: Extract the zip reader so both callers share it**

`test/bundle.test.mjs` contains a pure-Node zip reader. Move it to `test/zip-reader.mjs` exporting `extractZip(zipPath, destDir)` and `readZipEntries(zipPath)`, and re-import it from `test/bundle.test.mjs`.

- [ ] **Step 3: Prove the extraction refactor did not break the existing test**

An extraction with no re-run of the caller is how a regression stays invisible.

```bash
node --test test/bundle.test.mjs
```

Expected: all 10 assertions still pass. If the file skips because no `.mcpb` exists, build one first with `npm run bundle`.

- [ ] **Step 4: Run the verifier locally against a real bundle**

```bash
npm run bundle
node scripts/verify-bundle-runtime.mjs remotion-viz-1.2.0.mcpb ./tmp-verify
```

Expected: `Bundle runtime OK on win32/x64: 13 tools, resvg loaded.`

- [ ] **Step 5: Prove it fails on a broken bundle**

```bash
rm -rf ./tmp-broken && mkdir -p ./tmp-broken
node scripts/verify-bundle-runtime.mjs remotion-viz-1.2.0.mcpb ./tmp-broken
rm ./tmp-broken/server/index.js
node scripts/verify-bundle-runtime.mjs remotion-viz-1.2.0.mcpb ./tmp-broken; echo "exit=$?"
```

Note the verifier re-extracts, so to prove the failure path, instead corrupt one of the vendored resvg binaries and re-run:

```bash
node -e "require('fs').writeFileSync('./tmp-verify/node_modules/@resvg/resvg-js-win32-x64-msvc/resvg.win32-x64-msvc.node','garbage')"
node -e "
  const {spawnSync}=require('child_process');
  const r=spawnSync(process.execPath,['./tmp-verify/server/index.js'],{input:'',shell:false});
  console.log('server exited', r.status);
"
```

Expected: the corrupted addon produces a load failure. Record the exact symptom in the commit message — it is the thing this job exists to catch.

- [ ] **Step 6: Upload the bundle as an artifact**

In the `bundle` job, after the size gate:

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: mcpb
          path: "*.mcpb"
          retention-days: 7
```

- [ ] **Step 7: Add the fan-out job**

```yaml
  verify-bundle:
    needs: bundle
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest    # linux-x64-gnu
          - os: windows-latest   # win32-x64
          - os: macos-latest     # darwin-arm64
          - os: macos-13         # darwin-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: actions/download-artifact@v4
        with:
          name: mcpb
      - name: Run the shipped artifact
        shell: bash
        run: |
          BUNDLE=$(ls *.mcpb | head -1)
          node scripts/verify-bundle-runtime.mjs "$BUNDLE" ./extracted
```

**Coverage note, to be stated in the commit rather than left implicit:** this covers 4 of the 6 shipped binaries. `linux-arm64-gnu` needs an ARM64 Linux runner — verify whether the `ubuntu-24.04-arm` label is available to this repo before adding it, do not assume. `win32-arm64` has no GitHub-hosted runner at all and is shipped untested by necessity; say so in `docs/adr/` rather than letting it look covered.

- [ ] **Step 8: Commit**

```bash
git add scripts/verify-bundle-runtime.mjs test/zip-reader.mjs test/bundle.test.mjs .github/workflows/ci.yml
git commit -m "ci: run the shipped .mcpb on four platforms

Nothing previously executed the artifact users install. test/bundle.test.mjs
asserts the six native binaries are present in the zip; presence is not
loadability, and viz_render_svg is the call that forces the addon to load.

Covers linux-x64, win32-x64, darwin-x64, darwin-arm64. linux-arm64 pending a
runner label check; win32-arm64 has no hosted runner and ships untested."
```

---

## Task 7: Supply-chain scanning

**Files:**
- Modify: `.github/workflows/ci.yml` (extend the `sbom` job)

- [ ] **Step 1: Add Trivy filesystem scan**

```yaml
      - name: Trivy filesystem scan
        uses: aquasecurity/trivy-action@0.28.0
        with:
          scan-type: fs
          scan-ref: .
          severity: CRITICAL,HIGH
          exit-code: '0'          # advisory, matching the npm audit gate's posture
          format: table
```

`exit-code: '0'` is deliberate and matches the existing `npm audit` step, which gates on critical only. Raising both is a separate decision with a separate argument.

- [ ] **Step 2: Add an SPDX SBOM alongside the CycloneDX one**

```yaml
      - name: SPDX SBOM
        uses: anchore/sbom-action@v0
        with:
          path: .
          format: spdx-json
          artifact-name: sbom.spdx.json
```

- [ ] **Step 3: Verify both artifacts appear**

Push, then:

```bash
gh run view --json jobs -q '.jobs[] | select(.name=="sbom") | .conclusion'
gh run download --name sbom
gh run download --name sbom.spdx.json
```

Expected: both download and are valid JSON.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Trivy fs scan and an SPDX SBOM

Trivy is advisory, matching the existing npm audit posture. SPDX joins the
CycloneDX SBOM because consumers differ on which they accept."
```

---

## Task 8: Version sync, required before any release automation

`semantic-release` writes `package.json`. This repo needs three files to move together, and two independent mechanisms fail loudly if they do not. Building the sync first means the release workflow has something correct to call.

**Files:**
- Create: `scripts/sync-version.mjs`
- Create: `test/version-sync.test.mjs`
- Modify: `package.json` (script entry)

**Interfaces:**
- Produces: `node scripts/sync-version.mjs <version>` writing `package.json`, `manifest.json`, and `src/constants.ts` atomically. Task 9 calls this from `@semantic-release/exec`.

- [ ] **Step 1: Write the failing test**

`test/version-sync.test.mjs`:

```js
/**
 * Three files must state the same version. test/unit.test.mjs guards two of
 * them at test time and scripts/build-bundle.mjs refuses to build on drift, so
 * a release tool that updates only package.json produces a tag that cannot be
 * built.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "sync-version.mjs");

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsync-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.0" }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "x", version: "1.2.0" }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(dir, "src", "constants.ts"),
    'export const SERVER_NAME = "x";\nexport const SERVER_VERSION = "1.2.0";\n',
  );
  return dir;
}

test("all three files move together", () => {
  const dir = makeFixture();
  execFileSync(process.execPath, [script, "2.0.0"], { cwd: dir, shell: false });

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "2.0.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version, "2.0.0");
  assert.match(fs.readFileSync(path.join(dir, "src", "constants.ts"), "utf8"), /SERVER_VERSION = "2\.0\.0"/);
});

test("a malformed version is refused before anything is written", () => {
  const dir = makeFixture();
  assert.throws(() => execFileSync(process.execPath, [script, "v2.0"], { cwd: dir, shell: false, stdio: "pipe" }));
  // Nothing partially written.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "1.2.0");
});

test("a constants.ts that does not match the expected shape is refused, not silently skipped", () => {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, "src", "constants.ts"), "export const SOMETHING_ELSE = 1;\n");
  assert.throws(() => execFileSync(process.execPath, [script, "2.0.0"], { cwd: dir, shell: false, stdio: "pipe" }));
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test test/version-sync.test.mjs
```

Expected: all three fail — `scripts/sync-version.mjs` does not exist.

- [ ] **Step 3: Write `scripts/sync-version.mjs`**

```js
/**
 * Write one version into every file that must state it.
 *
 * package.json, manifest.json and src/constants.ts SERVER_VERSION are three
 * statements of one fact. test/unit.test.mjs fails on drift and
 * scripts/build-bundle.mjs refuses to build on it, so a release tool that
 * updates one of them produces an unbuildable tag.
 *
 * Validates everything before writing anything: a half-applied version bump is
 * worse than a refused one.
 */
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`Expected a bare semver like 1.2.3, got '${version ?? ""}'.`);
  process.exit(1);
}

const cwd = process.cwd();
const pkgPath = path.join(cwd, "package.json");
const manifestPath = path.join(cwd, "manifest.json");
const constantsPath = path.join(cwd, "src", "constants.ts");

const constants = fs.readFileSync(constantsPath, "utf8");
const pattern = /(export const SERVER_VERSION = ")([^"]+)(";)/;
if (!pattern.test(constants)) {
  console.error(
    `${constantsPath} has no 'export const SERVER_VERSION = "..."' line.\n` +
      `Refusing rather than skipping it: a silent skip here ships a version mismatch.`,
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

pkg.version = version;
manifest.version = version;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(constantsPath, constants.replace(pattern, `$1${version}$3`));

console.log(`version ${version} written to package.json, manifest.json, src/constants.ts`);
```

- [ ] **Step 4: Run the tests**

```bash
node --test test/version-sync.test.mjs
```

Expected: 3 pass.

- [ ] **Step 5: Prove the real guards agree**

```bash
node scripts/sync-version.mjs 1.2.1 && npm run build && npm test 2>&1 | grep -E "SERVER_VERSION|pass |fail "
git checkout package.json manifest.json src/constants.ts && npm run build
```

Expected: the GUARD test passes at 1.2.1 — meaning the sync satisfies the invariant the release depends on — then the checkout restores 1.2.0.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-version.mjs test/version-sync.test.mjs package.json
git commit -m "release: one command that moves all three version statements

semantic-release writes package.json only. manifest.json and constants.ts
SERVER_VERSION must move with it or the GUARD test and build-bundle.mjs both
fail, producing a tag that cannot be built. Validates before writing so a
malformed version leaves nothing half-applied."
```

---

## Task 9: Release workflow — tag, build, sign, publish

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `package.json` (semantic-release devDeps and config)

**Interfaces:**
- Consumes: `scripts/sync-version.mjs` from Task 8, `scripts/check-bundle-size.mjs` from Task 5, `scripts/verify-bundle-runtime.mjs` from Task 6.

- [ ] **Step 1: Install semantic-release and the exec plugin**

```bash
npm install --save-dev semantic-release @semantic-release/exec @semantic-release/git @semantic-release/github
```

- [ ] **Step 2: Add the config to `package.json`**

```json
"release": {
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/exec", {
      "prepareCmd": "node scripts/sync-version.mjs ${nextRelease.version} && npm run build && npm run bundle && node scripts/check-bundle-size.mjs"
    }],
    ["@semantic-release/git", {
      "assets": ["package.json", "manifest.json", "src/constants.ts"],
      "message": "chore(release): ${nextRelease.version} [skip ci]"
    }],
    ["@semantic-release/github", { "assets": [{ "path": "*.mcpb" }] }]
  ]
}
```

The `prepareCmd` chain is the whole reason Task 8 exists: sync all three files, build, bundle, and refuse the release if the bundle breached its size ceiling.

- [ ] **Step 3: Dry-run it locally before it ever runs in CI**

```bash
npx semantic-release --dry-run --no-ci 2>&1 | tail -30
```

Expected: it reports the next version it would publish and does not write anything. If it reports "no release", the commit messages since the last tag are not conventional-commit shaped — decide that explicitly rather than discovering it on a tag push.

- [ ] **Step 4: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]
  workflow_dispatch:

# Separate from ci.yml because id-token: write is what makes keyless signing
# possible, and a workflow that can sign must not run on pull requests from
# forks.
permissions:
  contents: write
  issues: write
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # semantic-release reads tag history
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - run: npm ci

      - name: Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx semantic-release

      - name: Install cosign
        if: hashFiles('*.mcpb') != ''
        uses: sigstore/cosign-installer@v3

      - name: Sign the bundle
        if: hashFiles('*.mcpb') != ''
        run: |
          BUNDLE=$(ls *.mcpb | head -1)
          cosign sign-blob --yes \
            --output-signature "${BUNDLE}.sig" \
            --output-certificate "${BUNDLE}.pem" \
            "$BUNDLE"
          TAG=$(node -p "'v' + require('./package.json').version")
          gh release upload "$TAG" "${BUNDLE}.sig" "${BUNDLE}.pem" --clobber
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 5: Verify a real release end to end**

This is the step that matters, and it must be done on a real tag, not reasoned about:

```bash
gh workflow run release.yml
gh run watch
```

Then confirm a human can actually get and verify the artifact:

```bash
TAG=$(gh release list --limit 1 --json tagName -q '.[0].tagName')
gh release download "$TAG"
cosign verify-blob \
  --certificate remotion-viz-*.mcpb.pem \
  --signature remotion-viz-*.mcpb.sig \
  --certificate-identity-regexp 'https://github.com/curasinan/remotion-mcp/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  remotion-viz-*.mcpb
```

Expected: `Verified OK`. A release that publishes a signature nobody has ever verified is a release that has not been tested — the same failure mode as asserting a route exists without ever loading it in a browser.

- [ ] **Step 6: Verify the published artifact actually runs**

```bash
node scripts/verify-bundle-runtime.mjs remotion-viz-*.mcpb ./from-release
```

Expected: `Bundle runtime OK`. This closes the loop: the thing on the Releases page is the thing that works.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release.yml package.json package-lock.json
git commit -m "release: tag-driven build, sign and publish

semantic-release drives version selection; @semantic-release/exec calls
sync-version.mjs so all three version statements move together, then builds,
bundles, and fails the release if the size gate breaches.

cosign keyless signing writes to the Rekor transparency log, so the signature
is verifiable by someone who does not trust this repository. Verified by
downloading the published release and running cosign verify-blob plus the
runtime check against it."
```

---

## Self-Review

**Spec coverage.** Every gate from the brief maps to a task: correctness (Tasks 1–4: matrix, coverage, lint, conformance), security (Task 7: Trivy fs, SPDX SBOM — CycloneDX already exists), regression (Tasks 5–6: bundle size, artifact runtime), release (Tasks 8–9: semantic-release, GitHub Release, cosign).

**Two items from the brief are deliberately not implemented, with reasons:**

1. **vitest** — rejected by the owner. 96 tests pass on `node --test` with no test dependency; migration is a rewrite of 11 files for no CI-visible gain. Coverage, the one thing vitest would have added to CI, is delivered by Task 2 instead.
2. **Per-platform native compilation, QEMU, and the `macos-13`/`macos-14` build split** — the premise is wrong for this repo. `scripts/build-bundle.mjs:90` *downloads* six prebuilt `@resvg/resvg-js-*` packages from npm; nothing is compiled. That is why the `bundle` job is ubuntu-only and finishes in 31 seconds. The real gap was never building per platform, it was *running* per platform — which is Task 6.

**Known coverage limit, stated rather than hidden.** Task 6 exercises 4 of the 6 shipped native binaries. `linux-arm64-gnu` depends on an ARM64 Linux runner label whose availability to this repo is unverified — Task 6 Step 7 says to check, not assume. `win32-arm64` has no GitHub-hosted runner and ships untested by necessity; that belongs in an ADR, not in silence.

**Ordering rationale.** Task 0 first because the budget argument for everything else depends on it. Task 8 before Task 9 because release automation without atomic version sync produces unbuildable tags. Task 6 is the highest-value single task and could be pulled forward if only one thing gets done.

**Type consistency.** `scripts/sync-version.mjs` takes a bare semver and is called identically in Task 8 Step 5 and Task 9's `prepareCmd`. `scripts/verify-bundle-runtime.mjs` takes `(bundlePath, extractDir)` in Task 6 Steps 4–5, Task 6 Step 7's workflow, and Task 9 Step 6. `extractZip(zipPath, destDir)` is defined in Task 6 Step 2 and consumed in Step 1.

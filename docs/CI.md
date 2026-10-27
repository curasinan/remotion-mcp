# CI and release pipeline

Four workflows. This file says what each gate proves, and — where it matters —
what evidence exists that the gate actually catches something, rather than only
that it has stayed quiet.

That distinction is the organising idea here. A gate nobody has watched fail is
indistinguishable from a gate that is switched off, so several of the checks
below have a recorded moment where they caught a deliberately planted defect.

## `ci.yml` — on every push and pull request

| Job | Needs | What it is for |
| --- | --- | --- |
| `build-and-test` | — | 3 OS × Node 22/24/26 = 9 legs. Type-check, build, service build, browser-presence assertion, the suite, coverage on one leg, MCP conformance, lint, `npm audit`. |
| `sbom` | — | CycloneDX and SPDX SBOMs, plus a Trivy filesystem scan (advisory). |
| `bundle` | `build-and-test` | Builds the `.mcpb`, enforces the size ceiling, runs the bundle assertions. |
| `verify-bundle` | `bundle` | 6 platforms. Extracts the shipped artifact and *runs* it. |
| `lint-workflows` | — | `actionlint` over `.github/workflows/`. |
| `ci-ok` | all of the above | One aggregate check, so branch protection has a single required status instead of 15 that change name whenever the matrix does. |

### The service build runs before the suite

`npm run build:service` compiles `tsconfig.service.json`, whose only root is
`src/service/index.ts`, into `dist-service/`. The service profile's tests import
their modules from `dist-service/service/*.js`, not from `dist/`, so the
`Build service` step sits straight after `Build` and before every test step, in
both `ci.yml` and `release.yml`. Locally, run
`npm run build && npm run build:service` before `npm test`; without
`dist-service/` the service tests fail rather than skip.

It is also the only type-check `src/service/` gets: `tsconfig.json`, which
`npm run typecheck` uses, excludes that tree so the stdio build never ships it.
The `bundle` job skips it: the `.mcpb` is built from `dist/` alone, and
`test/bundle.test.mjs` never imports `dist-service/`.

### The absence suite: four tools missing, not refused

`viz_render_html`, `remotion_list_compositions`, `remotion_init_project` and
`remotion_start_studio` must be missing from the compiled service closure
itself, not refused at runtime (design §5.7, ADR-5). `test/absence.test.mjs`
proves it on every leg as part of `npm test`; `npm run test:absence` runs it
alone. Like the other service tests it needs `npm run build:service` first, and
fails rather than skips without `dist-service/service/index.js`.

The static half is `scripts/check-service-closure.mjs`. `analyzeClosure` reads
every `.js`, `.mjs` and `.cjs` file under the dist dir as syntax, with the
repo's own `typescript` parser and binder, and `verdict` turns that into a list
of problems; an empty list is a pass. It also runs on its own:
`node scripts/check-service-closure.mjs [distDir]` exits 1 on any problem, or
when the dir holds no `service/index.js`.

It reads syntax, never text. `services/exec.js` names
`remotion_list_compositions` in a hint string, so a check that grepped the
build for forbidden names would fail a correct closure.

`verdict` reports:

- **Registrations.** Any `.registerTool(` or `.tool(` call, including
  `["registerTool"](` and `["tool"](`, outside `service/registry.js`. In the
  registry, more than one call site, or a name that is neither a string literal
  nor the `const` variable of its `for...of` loop. The loop must run over a
  frozen list of string literals declared in the registry, which is how the
  loop's names are known.
- **Other uses.** Any use of `registerTool` other than a direct call: an alias,
  an argument, an initializer, destructuring, `.bind`, `.call` or `.apply`. Also
  any `.tool` used through `.bind`, `.call` or `.apply`. A plain read of a
  `tool` property, such as `claims.tool`, is not reported, because the gateway
  contract's claim is named `tool`.
- **Names and files.** Any of the four forbidden names, registered as a literal
  or through the loop's list. Any file under `tools/`. Any file or directory
  named `raster`, `tile`, `network`, `visualize`, `studio`, `compare`,
  `environment` or `browser`.
- **Specifiers.** Any `@resvg/resvg-js` or `puppeteer-core` import, re-export,
  `import()` or `require()`, subpaths included. Any non-literal `import()` or
  `require()`.

| Test | What it proves |
| --- | --- |
| T1 | `SERVICE_TOOLS` in `dist-service/service/registry.js` is exactly the four, in order, and frozen. |
| T2 | A live `tools/list` returns exactly the four. It goes through the built `createServiceHandler` on 127.0.0.1, with the SDK client and every POST signed. |
| T3 | `verdict` on `dist-service/` is empty, although `services/exec.js` names `remotion_list_compositions`. |
| T4 | There is exactly one registration call site. It is in `service/registry.js`, inside its loop over `SERVICE_TOOLS`, and nothing else references `registerTool`. |
| T5 | **Poisoned build.** A type-only `import type {} from` of `tools/project.js` and `services/entrypoint.js` is added to `src/service/tools.ts`. `verdict` must report `tools/project.js`, its `remotion_init_project`, `services/environment.js`, `services/browser.js`, and `browser.js`'s non-literal `import()`. |
| T6 | **Poisoned registry.** `"viz_render_html"` is appended to `SERVICE_TOOLS`, with a matching `TOOL_DEFS` entry. T1's equality must fail, a live `tools/list` must return five, and `verdict` must report `viz_render_html` and nothing else. |
| fixtures | Hand-written `.js` fixtures, one evasion each, must each yield exactly their one problem. They include an alias, `["registerTool"](`, `.tool.bind`, destructuring, a registration outside the registry, a shadowed loop variable, an unfrozen list, each forbidden name, module and package, and a non-literal `import()`. A positive control (`claims.tool !== toolOf(m)`, plus a string that names a forbidden tool) must yield none. |

**The poisoned controls are the evidence that T1–T4 can fail.** A gate that
has never been seen failing looks the same as one that is switched off. T5 and
T6 plant real poison in every run and require the same checks to catch it.

- **How each one is built.** It copies `src/`, `tsconfig.json` and
  `tsconfig.service.json` into a fresh `tmp-poison-*` directory, applies the
  poison by a text edit, and compiles with the repo's own `tsc`.
- **A failed compile cannot pass.** The build must emit
  `dist-service/service/index.js`, so a broken compile fails the test instead of
  passing as "poison detected". A poison whose anchor text is missing or
  repeated fails too, so a refactor cannot quietly turn it into a no-op.
- **T5 is the case that matters most.** A type-only import emits no runtime
  `import`, but tsc still puts its target in the program and emits it. Nothing
  at runtime would ever load `tools/project.js`, yet it ships in the build. Only
  a check that walks every emitted file catches it.
- **Where the directories go.** They are made inside the repository, never in
  `os.tmpdir()`, so that module resolution, `@types/node` and
  `"type": "module"` find the repo's own copies as ancestors. Each is removed in
  `after()`. If a run is killed first, `.gitignore` (`/tmp-poison-*/`) and the
  ESLint ignore list (`tmp-*/**`) keep the leftovers out of commits and lint.

**Recorded evidence.** When the check was written, an interface-only stub of
`check-service-closure.mjs` failed 48 of the suite's 52 tests. The four that
passed test the build rather than the script: T1, T2, and T6's runtime halves.
Then 20 single-rule mutations each turned at least one test red. Nineteen
disabled or loosened one rule, and one reported every `.tool` read. For
example, matching the loop variable by name instead of by scope fails only the
shadowed-variable fixture. Reporting every `.tool` read fails T3, T4 and the
positive control.

**What the syntax check cannot see, and what covers it.** A registration
through a computed member name (`server[k](...)` with `k` not a literal), or a
`.tool` read into a variable and called later, cannot be told apart from
ordinary code. Plain `.tool` reads are allowed for the claims. The live
`tools/list` (T2) is the backstop: a fifth tool shows up there however it was
registered, as T6 shows.

### The browser-presence assertion is not decoration

`test/html.test.mjs` gates all seven of its tests on `locateBrowser()` evaluated
at module scope. On a runner without Chrome the file *skips* and `npm test`
still exits 0 — a green gate that ran nothing, which is worse than no gate
because it looks like coverage. The assertion turns that into a hard failure.

### `verify-bundle` exists because presence is not loadability

`test/bundle.test.mjs` asserts the six `@resvg/resvg-js` platform binaries are
present in the zip. That is not the same as them working. `verify-bundle`
extracts the artifact on each target platform, completes a real MCP handshake
against the bundled server, and calls `viz_render_svg`, which forces that
platform's own native addon to load.

**Recorded evidence.** Corrupting the `darwin-arm64` binary inside an otherwise
valid `.mcpb` leaves all ten `bundle.test.mjs` assertions green while the
artifact is unusable for every macOS ARM user; only the `macos-latest` leg
catches it. Corrupting the *build platform's own* binary is the one case the
older assertions already caught (9 of 10). Before this job existed, exactly one
of the six binaries was ever loaded, and only incidentally.

### The lint gate, and the canary that proved it

`npm run lint` is blocking as of PR #7. Before it was made blocking, a temporary
`canary.yml` workflow planted a deliberate lint violation to establish that the
linter actually reported it. It did, and the canary was removed in `f205528`
with the message *"remove the canary now that the linter has been seen catching
it"*.

**That evidence is a single failed workflow run, and it is deliberately not
deleted:**

```
workflow id 347516519  (.github/workflows/canary.yml, file since removed)
  run: 2026-09-01, branch ci/pipeline-hardening, conclusion: failure
```

GitHub keeps the workflow *entity* registered as `active` even though the file
is gone, so it still appears in `gh api .../actions/workflows`. Deleting that one
run would drop the ghost from the listing — and would destroy the only record
that the lint gate was ever observed catching a planted violation. The confusing
API line is the cheaper of the two costs. If you are tidying workflows and
wondering why a non-existent `canary.yml` is listed, this is why; leave it.

## `release.yml` — on push to `main`, and `workflow_dispatch`

semantic-release decides the version from commit types, `@semantic-release/exec`
runs `scripts/sync-version.mjs` so `package.json`, `manifest.json` and
`SERVER_VERSION` move together, then builds, bundles, and enforces the size gate
before anything is tagged. cosign signs the artifact keyless and verifies its own
signature before the job ends.

Three things worth knowing:

- **The gate runs before `npx semantic-release`,** so a failure leaves no tag.
  It covers type-check, build, the service build, the browser assertion and
  the suite on ubuntu/Node 24 — *not* the full matrix, not `verify-bundle`,
  not the conformance check. A green release is not a green matrix.
- **A downgrade guard refuses any computed version at or below the one in
  `package.json`.** It exists because with no tags in the repository
  semantic-release restarts at `1.0.0` and would have published a downgrade,
  rewriting all three version files and pushing that to `main`. Confirmed in a
  dry run before it could happen; after tagging `v1.2.0` the same dry run
  correctly computed `1.2.1`.
- **Most merges produce no release, by design.** Only `feat:` and `fix:` (and
  breaking changes) trigger one. A run of `ci:`, `docs:`, `test:`, `build:` and
  `refactor:` commits correctly publishes nothing — the workflow still runs the
  full gate before deciding.

See [`../README.md#verifying-a-release`](../README.md) for the verification
recipe, including why cosign 3 cannot verify these artifacts and a 2.x binary is
required.

## `pages.yml` — the landing site

Publishes `site/` to GitHub Pages. **Nothing derived from the audit log belongs
here.** The log's `detail` field records file paths verbatim for strings under 64
characters, and Pages is public; see [`GATEWAY.md`](GATEWAY.md) for where audit
data may and may not go.

## `ruleset-drift.yml` — daily at 07:00 UTC

Asserts the `protect-main` ruleset is still `active`. Branch protection that
silently lapses is worse than none, because the absence of failures reads as
health. This is the one check that fails when *nothing* happened.

## Supply chain

Third-party actions are SHA-pinned, not tag-pinned — a tag is mutable and the
release workflow holds `id-token: write` and `contents: write`. `sigstore/cosign-installer`
is pinned to the v3 line deliberately: v4 installs cosign 3, which replaced the
detached `--output-signature`/`--output-certificate` form of `sign-blob` with
`--bundle`, changing both the published files and the command a user runs to
check them.

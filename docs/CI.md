# CI and release pipeline

Five workflows. This file says what each gate proves, and — where it matters —
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
| `pack` | — | Builds the fixture template pack on Linux with `scripts/build-pack.mjs` and uploads `dist-pack/` as the `pack` artifact. |
| `image` | `pack` | Builds the service image and the derived image from the `pack` artifact, then runs `image-checks.sh`, `image-e2e.mjs` and `walk-only-proof.mjs` against them. |
| `lint-workflows` | — | `actionlint` over `.github/workflows/`. |
| `ci-ok` | all of the above | One aggregate check, so branch protection has a single required status instead of 20 that change name whenever the matrix does. |

### The service build runs before the suite

`npm run build:service` compiles `tsconfig.service.json` into `dist-service/`.
It has two roots: `src/service/index.ts`, and `src/service/healthcheck.ts`,
the image's `HEALTHCHECK`, which `index.ts` never imports because importing
it would run the probe. The service profile's tests import
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

- **Registrations.** Any `.registerTool(`, `.registerToolTask(` or `.tool(`
  call, including `["registerTool"](`, `["registerToolTask"](` and
  `["tool"](`, outside `service/registry.js`. `registerToolTask` is the SDK's
  experimental `server.experimental.tasks.registerToolTask`. It registers
  through the same internal `_createRegisteredTool` as `registerTool`, and its
  tool appears in `tools/list` the same way, so every rule here treats it
  exactly like `registerTool`. In the registry, the check reports more than one
  call site, or a name that is neither a string literal nor the `const`
  variable of its `for...of` loop. The loop must run over a frozen list of
  string literals, declared with `const` in the registry, which is how the
  loop's names are known.
- **Other uses.** Any use of `registerTool` or `registerToolTask` other than a
  direct call: an alias, an argument, an initializer, destructuring, `.bind`,
  `.call` or `.apply`, a bare identifier, or the name as a string. Also any
  `.tool` used through `.bind`, `.call` or `.apply`. A plain read of a `tool`
  property, such as `claims.tool`, is not reported, because the gateway
  contract's claim is named `tool`.
- **Names and files.** Any of the four forbidden names, registered as a literal
  or through the loop's list. Any file under `tools/`. Any file or directory
  named `raster`, `tile`, `network`, `visualize`, `studio`, `compare`,
  `environment` or `browser`.
- **Specifiers.** Any `@resvg/resvg-js` or `puppeteer-core` import, re-export,
  `import()` or `require()`, subpaths included. Any non-literal `import()` or
  `require()`.
- **Package names anywhere.** Any other string literal, a no-substitution
  template literal included, whose whole value is `@resvg/resvg-js` or
  `puppeteer-core`, or starts with `@resvg/resvg-js/` or `puppeteer-core/`.
  This is what catches a package loaded without a call of `require`, such as
  `createRequire(import.meta.url)("puppeteer-core")`. A literal that is already
  an import's or a `require()`'s own specifier is reported once, as that
  specifier. A longer string that merely mentions a package, such as
  ``"Run `npm install puppeteer-core`"``, is not reported. Nor is
  `service/preflight.js`'s
  `createRequire(...).resolve("@remotion/renderer/package.json")`.

| Test | What it proves |
| --- | --- |
| T1 | `SERVICE_TOOLS` in `dist-service/service/registry.js` is exactly the four, in order, and frozen. |
| T2 | A live `tools/list` returns exactly the four. It goes through the built `createServiceHandler` on 127.0.0.1, with the SDK client and every POST signed. |
| T3 | `verdict` on `dist-service/` is empty, although `services/exec.js` names `remotion_list_compositions`. |
| T4 | There is exactly one registration call site, through `registerTool`, `registerToolTask` or `.tool`. It is a `registerTool` call in `service/registry.js`, inside its loop over `SERVICE_TOOLS`, and nothing else references `registerTool` or `registerToolTask`. |
| T5 | **Poisoned build.** A type-only `import type {} from` of `tools/project.js` and `services/entrypoint.js` is added to `src/service/tools.ts`. `verdict` must report `tools/project.js`, its `remotion_init_project`, `services/environment.js`, `services/browser.js`, and `browser.js`'s non-literal `import()`. |
| T6 | **Poisoned registry.** `"viz_render_html"` is appended to `SERVICE_TOOLS`, with a matching `TOOL_DEFS` entry. T1's equality must fail, matched by its own message, since T1's freeze check throws an `AssertionError` too. A live `tools/list` must return five, and `verdict` must report `viz_render_html` and nothing else. |
| fixtures | Hand-written `.js` fixtures, one evasion each, must each yield exactly their one problem. They include an alias, `["registerTool"](`, `.tool.bind`, destructuring, a registration outside the registry, and every one of those forms again for `registerToolTask`. They also include a shadowed loop variable, a `let` loop variable reassigned before the call, a `let` list reassigned before the loop, an unfrozen list, each forbidden name, module and package, a non-literal `import()`, and both `createRequire` forms. Positive controls must yield none: `claims.tool !== toolOf(m)`, a string that names a forbidden tool, and preflight's `createRequire(...).resolve`. |
| teardown | Removing a scratch dir is best-effort. `fs.promises.rm` gets `maxRetries` and `retryDelay`. An `EBUSY` or `EPERM` that outlasts the retries is logged, not thrown, and any other error still fails the run. |

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
- **Removal is best-effort.** On Windows, OneDrive or Defender can hold a file
  open. `fs.promises.rm` retries up to 5 times per entry, each wait 100 ms
  longer. A dir still held after that (`EBUSY`, `EPERM`, `ENOTEMPTY`, `EMFILE`
  or `ENFILE`) is logged with its path, and the run's result stands. It uses
  `fs.promises.rm` because on Node 24 for Windows, `fs.rmSync` failed on a held
  dir at once, with `EPERM` and no retry.

**Recorded evidence.** When the check was written, an interface-only stub of
`check-service-closure.mjs` failed 48 of the suite's 52 tests. The four that
passed test the build rather than the script: T1, T2, and T6's runtime halves.
Then 20 single-rule mutations each turned at least one test red. Nineteen
disabled or loosened one rule, and one reported every `.tool` read. For
example, matching the loop variable by name instead of by scope fails only the
shadowed-variable fixture. Reporting every `.tool` read fails T3, T4 and the
positive control.

**Fix round 1.** Five review findings added rules and tests:
- the `registerToolTask` API;
- package names reached through `createRequire`;
- the two `const` guards behind the loop's names, which no test had pinned;
- T6's message match;
- best-effort teardown.

Each new guard was proved both ways with single mutations, 18 in all, and each
turned at least one test red. One more stays green: making `fs.rmSync` the
default again. That difference shows only on a held dir on Windows, so it was
measured by hand rather than in the suite.

**What the check covers, and what it does not.** The check exists to stop the
repo's own reviewed sources from carrying a local-dev tool or package into the
service build by accident. A gap that only a deliberate evasion could reach is
a documented limit, not a defect. The live `tools/list` (T2) is the backstop for
registrations: a fifth tool shows up there however it was registered, as T6
shows.

Covered:

- Every direct registration, through `registerTool`, `registerToolTask` or
  `.tool`, by dot or by a literal bracket key, parenthesised or not.
- Every other use of `registerTool` or `registerToolTask`, including through a
  comma, a conditional or `Reflect.apply`, since any non-call reference to
  either name is reported.
- Every import, re-export, `import()` and `require()` of a forbidden package,
  by its specifier.
- Every string literal, or template literal without substitutions, whose
  whole value names a forbidden package or a subpath of one. This catches a
  `require` under another name (`const r = require; r("puppeteer-core")`), a
  `createRequire(import.meta.url)("puppeteer-core")`, and
  `const req = createRequire(...); req("puppeteer-core")`.
- Every non-literal `import()`, and every non-literal call of a function named
  `require`.

Not covered:

- A registration through a computed member name, such as `server[k](...)` with
  `k` not a literal.
- A `.tool` read into a variable and called later. Plain `.tool` reads are
  allowed for the claims.
- A `.tool` callee reached through a comma, `(0, server.tool)(...)`, a
  conditional, `(c ? server.tool : f)(...)`, or
  `Reflect.apply(server.tool, ...)`. The check reports only a `.tool` used
  through `.bind`, `.call` or `.apply`.
- An `Object` shadowed in the registry. The frozen-list rule reads
  `Object.freeze([...])` by its syntax, so a local `Object` whose `freeze`
  returns another list would pass.
- A non-literal argument to a `require` under another name, such as
  `req(name)` where `req` came from `createRequire`. Only `import()` and calls
  of a function named `require` are checked for a non-literal argument.
- A package name built at runtime, such as `"puppeteer" + "-core"`, a template
  literal with substitutions, or `String.fromCharCode(...)`.
- Calling the SDK's private `_createRegisteredTool`, or replacing the
  `tools/list` handler through the low-level `server.server.setRequestHandler`.
- Any other deliberate obfuscation.

The file-name rules still catch the local-dev modules that load the forbidden
packages, such as `services/raster.js` and `services/browser.js`.

### The `pack` job: the fixture pack, built as a deployer builds one

`fixtures/pack/` is a separate Remotion project with two templates, `swatch`
and `slow`. The job installs it with its own lockfile and builds it the way
[`CONTRACT-pack.md`](CONTRACT-pack.md) tells a deployer to:

1. `npm ci`, then `npm run build:service`. `build-pack.mjs` imports the
   service's own JSON Schema gate, `loadPack` and the limits both gates share
   from `dist-service/`.
2. `npm ci --prefix fixtures/pack`. It runs on Linux, so the pack's native
   packages are the Linux ones.
3. `node scripts/build-pack.mjs fixtures/pack`. It exits 1 if any gate refuses
   a schema, or if the service's `loadPack` refuses the result.
4. It uploads `fixtures/pack/dist-pack/` as the `pack` artifact:
   `pack-manifest.json`, `bundle/`, `package.json` and `package-lock.json`.
   The step sets `include-hidden-files: true`, because `packHash` covers every
   file under `bundle/`, dotfiles included, and `loadPack` never re-hashes. It
   sets `if-no-files-found: error`, so a missing pack fails the job.

build-pack's rules are unit-tested as part of `npm test`:
- `test/zod-gate.test.mjs`: the zod gate, the bounds check and discovery.
  Each refused construct sits on an otherwise valid schema and must give
  exactly one violation, and its positive twin must give none. One test also
  holds the gate's limits to the service's own behaviour: `render_still`'s
  `template_id`, the JSON Schema gate's depth and its node budget.
- `test/build-pack.test.mjs`: each composition's checks in order, loading
  `src/Root`, the CLI's bundler fallback, and what the CLI says when its own
  rules cannot load. Its CLI runs are hermetic. Each runs without `NODE_PATH`,
  with `HOME` and `USERPROFILE` set to an empty dir. Each runs only after a
  check that neither an ancestor of the stub project nor node's own
  `lib/node` holds `@remotion/cli` or `@remotion/bundler`. So a machine with
  either installed fails that check by name, and never runs a real one.
- `test/pack-files.test.mjs`: `packHash`, the dependency rules and the
  output dir.

The job is the end-to-end half: a real bundle, a real `RemotionRoot`, and
zod 4.5.4's own `z.toJSONSchema`.

**Recorded evidence (2026-10-27, WSL Ubuntu, Node 22).**
- A rebuild of the same checkout gave the same `packHash`. An edit to
  `Swatch.tsx` changed it, and undoing the edit restored it. Remotion
  4.0.532's `index.html` records four things beyond the sources: the build
  directory (`remotion_cwd`), its name (`remotion_projectName`), each
  `public/` file's modification time (`remotion_staticFiles`) and the build
  host's CPU count (`maxConcurrency` in `remotion_renderDefaults`, and
  `concurrency`, which Remotion derives from it). So every
  fresh checkout, CI's included, gets its own hash.
- `remotion still` rendered `swatch` from `dist-pack/bundle` with the
  Turkish props.
- Separate copies with planted defects each made `build-pack` exit 1. These
  failures named the composition:
  - a non-strict object
  - a missing schema
  - zod 3 schemas
  - `calculateMetadata` without a static size
  - `.trim()` together with a flagged regex, both reported
- These failures named the file or the dir instead:
  - `@remotion/cli` under `devDependencies`: `package.json: @remotion/cli
    must be under dependencies …`
  - an `--out` dir holding files `build-pack` did not write: `output dir
    <dir>: holds …`. It was refused, and nothing was deleted.
- Each of build-pack's own steps was proved both ways: with the repo's
  script, and with a copy that had that one step removed.
  - **The bounds check.** `z.string().max(80).meta({ maxLength: 999 })`
    passes the zod gate, but its export says 999. With the check, the build
    fails. Without it, the pack builds with `maxLength: 999`.
  - **The final `loadPack`.** A 20000 × 20000 composition passes every schema
    gate. With `loadPack`, the build fails on `MAX_RASTER_PIXELS`. Without
    it, the pack builds.
  - **The JSON Schema gate.** Two `.regex()` calls export an `allOf`. With
    the gate, the build fails, naming the template. Without it, `loadPack`
    still refuses the pack. Since fix round 2 the zod gate refuses a second
    `.regex()` itself; `test/build-pack.test.mjs` now plants the `allOf`
    with `.meta()`, and removing the step turns it red.
- 114 single-guard mutations each turned the three unit test files red on
  Windows, in the pack work's fix rounds 2 and 3 (commits `1f8e2cb` to
  `70aac09`):
  - 71 of `scripts/lib/zod-gate.mjs`
  - 12 of `scripts/lib/pack-templates.mjs`
  - 8 of `scripts/lib/pack-files.mjs`
  - 11 of `scripts/build-pack.mjs`
  - 9 of `test/build-pack.test.mjs`'s own hermetic CLI runs
  - 3 of the service's own limits, in the built `dist-service/`

  Each mutation removes or loosens one guard of those files. They are not
  every possible mutation. An earlier count of 45 missed five guards that a
  review then showed could be deleted with every test still green. The 96 of
  fix round 2 then missed three guards that round had added. All eight are
  now among the 114. Fix round 3's 18 also ran under WSL Ubuntu with Node 22.
  17 turned red there. The one that keeps the parent's `USERPROFILE` stayed
  green by design, since Node reads `USERPROFILE` only on Windows.

### The `image` job: the images, proved on Linux

The job downloads the `pack` artifact into `fixtures/pack/dist-pack/`, builds
`Dockerfile.service` as `rv-service:dev`, then builds
`fixtures/pack/Dockerfile.derived` on top of it as `rv-pack:dev`
([`DEPLOY.md`](DEPLOY.md) explains both). It then runs three checks. Each
check generates its own throwaway keys and passes them to `docker run` by
name, so no key is in the repository, an image or an argv.

1. **`scripts/image-checks.sh`**, piped into a running derived container
   (`docker exec -i rv sh -s`), once that container reports healthy. It is
   never copied into the image. It checks that `setpriv` is on PATH, that no
   package manager is on PATH (npm, npx, yarn, yarnpkg or corepack), that
   PID 1 is `tini`, that the browser runs `--version`, that `ldd` finds every
   one of its libraries, that the
   `@remotion/renderer` the pack's CLI loads is at least 4.0.458, that
   `/var/log/remotion-viz` is writable, and that it runs as a user other
   than root. Every check runs, and each failure names what was missing. The
   browser's `--version` and `ldd` are bounded at 30 s each, so a hung
   browser fails its check instead of hanging the job.
2. **`scripts/image-e2e.mjs rv-pack:dev`** drives the derived image directly
   with this repository's test signing client,
   `test/helpers/signing-client.mjs`. **The owner's gateway is not in it,**
   so it is not a test of the backend, gateway and service path. It starts
   one container and waits for its `HEALTHCHECK` to report healthy. Then:
   - `render_still swatch` with `props/turkish.json` returns a PNG, with
     the PNG signature and a 1280 × 720 IHDR.
   - A replay of that exact request gets 401.
   - A forged header, another tenant's claims under the genuine signature,
     gets 401. The genuine header on the same body then gets 200.
   - The audit log has the render's `ok` line and both refusals, no string
     from the props, and no character outside printable ASCII and no `\u`
     escape, so a truncated or re-encoded value is caught too.
   - `render_still slow` gets `render_timeout`, after the 45 s deadline.
   - A CLI killed with `kill -KILL` mid-render gives `render_failed`.
   - A Turkish label differs from an all-tofu label in at least half of the
     tofu render's ink pixels, measured with `pixelmatch`.

   After every render, the successful ones included, an orphan scan polls
   the container's `/proc` until no process that was not there before the
   case survives. The scan reads every pid's
   `cmdline` through `docker exec`, since the image has no `ps`. A failed
   exec fails the case, never counting as an empty scan. Its positive
   control is that it does see the render's Chrome while `slow` runs. It
   matches Chrome by `argv[0]`, because the CLI's own cmdline names the
   browser in `--browser-executable`. A `render_busy` is retried until a slot
   frees, since a slot is held until its render's processes are gone.
3. **`scripts/walk-only-proof.mjs`** runs inside the derived image with
   `tini` as PID 1 and `scripts/` mounted read-only, below the service. The
   e2e's timeout case cannot prove the `/proc` walk: on `SIGTERM`,
   Remotion's own BrowserRunner kills Chrome's group, `setpriv` or not. So
   the proof runs the service's own preflight, argv and `runRenderProcess` on
   `slow`, with `PATH=/usr/local/bin`, where Remotion cannot find `setpriv`,
   and an injected kill that only ever sends `SIGKILL`.
   - **The control** kills only the CLI's group. Cleanup must report
     unverified, and Chrome must survive. That shows the proof can fail.
   - **The proof** kills every group the walk recorded. Cleanup must report
     verified, and no new process may survive.

   Both runs also check that the kill was handed Chrome's own group.

To run the same locally, with Docker's Linux engine and the fixture pack
built on Linux (copied into `fixtures/pack/dist-pack/`, which is
gitignored), from the repository root after `npm ci` and
`npm run build:service`:

```sh
docker build -f Dockerfile.service -t rv-service:dev .
docker build -f fixtures/pack/Dockerfile.derived --build-arg SERVICE_IMAGE=rv-service:dev -t rv-pack:dev fixtures/pack
key() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }
# CI's "Image checks" step, in a subshell so its exit leaves your shell open. `set -e`, as CI's bash runs its steps,
# stops it at the first failed command, a failed `docker run` included. It polls to a 120 s deadline and stops early if
# the container exits; on any failure `docker logs rv` names the failed startup check. The subshell exits with the
# checks' own status, after the trap has removed the container.
(
  set -e
  trap 'status=$?; [ "$status" -eq 0 ] || docker logs rv; docker rm -f rv >/dev/null; exit "$status"' EXIT
  IDENTITY_HMAC_KEY="$(key)" AUDIT_HMAC_KEY="$(key)" docker run -d --name rv \
    --health-start-period=120s --health-start-interval=1s \
    -e SERVICE_AUDIENCE=ci -e IDENTITY_HMAC_KEY -e AUDIT_HMAC_KEY rv-pack:dev
  deadline=$((SECONDS + 120))
  until [ "$(docker inspect --format '{{.State.Health.Status}}' rv)" = healthy ]; do
    if [ "$(docker inspect --format '{{.State.Running}}' rv)" != true ] || [ "$SECONDS" -ge "$deadline" ]; then
      echo "the checks container did not report healthy" >&2
      exit 1
    fi
    sleep 1
  done
  docker exec -i rv sh -s < scripts/image-checks.sh
)
node scripts/image-e2e.mjs rv-pack:dev
IDENTITY_HMAC_KEY="$(key)" AUDIT_HMAC_KEY="$(key)" MSYS_NO_PATHCONV=1 docker run --rm --entrypoint /usr/bin/tini \
  -e SERVICE_AUDIENCE=proof -e IDENTITY_HMAC_KEY -e AUDIT_HMAC_KEY \
  -v "$PWD/scripts:/proof:ro" rv-pack:dev -- node /proof/walk-only-proof.mjs
```

`MSYS_NO_PATHCONV=1` matters only in Git Bash on Windows, which would
otherwise rewrite `/proof`. The recipe needs bash, for `$SECONDS`.

Nothing in the job waits unbounded. The job has `timeout-minutes: 30`.
`image-e2e.mjs` kills a docker call still running after 30 s (`docker run`
after 120 s) and times out a raw POST after 30 s, so a hung exec or an
unanswered request fails its case. A walk-only-proof run that fails, a
rejected render or a Chrome that never appears included, is aborted, its
cleanup awaited, and what it left killed and reaped, before the next run.

**Recorded evidence: the images have not yet been built.** Docker's engine
was down when Task 10 was written (2026-11-04), so the local image run, its
Step 4, has not happened, and this job has not yet run in CI. What has run is
a rehearsal of the three scripts in WSL Ubuntu with Node 22, natively and
not in Docker: the service and the proof ran from `dist-service/` in their
own pid and mount namespaces, with a reaper as PID 1, and a stand-in for the
`docker` CLI. It is not the image, but it is the scripts' own logic against
the real service, CLI and Chrome:

- `walk-only-proof.mjs` passed both runs. With the walk disabled in the
  built `render-process.js`, both runs failed.
- `image-e2e.mjs` passed every case. With the tofu label swapped for the
  Turkish one, case 7 failed with 0 differing pixels.
- `image-checks.sh` passed all eight checks in a namespace whose PID 1 was
  named `tini`, with a PATH without npm. On the plain WSL host it failed the
  six that host does not meet, each naming what was missing, and it failed
  a renderer below 4.0.458, a missing one and a pre-release.

Fix round 1 (2026-11-11) rehearsed the changed scripts the same way, with
faults planted. Each fault passed unseen before the fix and fails after it:
a process left behind by a successful render fails case 1; a truncated
Turkish value, and the same value `\u`-escaped, in the audit fail case 6;
a hung `docker exec` fails case 6 at its 30 s bound; a failed `docker rm -f`
prints a warning and leaves the verdict alone. In walk-only-proof, a rejected
render reaches its FAIL lines, and a run whose Chrome never appears leaves
nothing alive for the next run. `image-checks.sh` fails a hung browser and
`ldd` at 30 s, a root user, and, under dash, an audit directory whose write
fails, with its FAIL line and summary.

The first image run records its own evidence here.

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

## `service-image-publish.yml` — on push to `main`, when the owner enables it

Builds `Dockerfile.service` for linux/amd64 and pushes it to
`ghcr.io/curasinan/remotion-viz-service`, tagged with the commit SHA. The job
runs only when the repository variable `PUBLISH_SERVICE_IMAGE` is `'true'`,
which the owner sets when publishing is approved (design §1, ruling 3); until
then it is skipped. It holds `contents: read` and `packages: write`, and
nothing else. The pushed image's digest goes into the job summary, and that
digest, never the tag, is what a deployer pins as the derived image's
`SERVICE_IMAGE` ([`DEPLOY.md`](DEPLOY.md)). It has not run yet. It has
`timeout-minutes: 30`.

**No check runs against the digest it publishes.** It rebuilds the image
from the floating `node:22-bookworm-slim` base, so the image the `image` job
proved for the same commit is a separate build, possibly on a different
base. DEPLOY.md tells deployers to run `image-e2e.mjs` and
`walk-only-proof.mjs` on the fixture pack built over the pinned digest, and
`scripts/image-checks.sh` against their own derived image, before rollout.
Pinning the base, or gating the publish on the `image` job, is an owner
decision.

**The first publish creates a private package.** GHCR makes every new
package private, whatever its repository's visibility. The image's
`org.opencontainers.image.source` label links the package to this
repository, so it inherits the repository's access permissions, but not its
visibility. After the first publish, the owner sets the package's visibility
in its settings ([`DEPLOY.md`](DEPLOY.md#the-images)).

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

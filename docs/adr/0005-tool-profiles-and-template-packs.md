# ADR-5: Tool profiles and template packs

**Status:** Accepted

**Relation:** New ground; supersedes nothing. Builds on
[ADR-4](0004-http-transport-for-the-service-profile.md).

## Context

This ADR follows the owner's rulings of 2026-10-26, which are §1 of the
[v2 design](../superpowers/specs/2026-10-26-service-profile-v2-design.md), cited
here by number: ruling 2 (output), ruling 3 (distribution), ruling 6 (egress)
and ruling 7 (the boundary of a pack).

Two of the owner's fixed constraints of 2026-10-17, quoted because they are not
committed anywhere else:

> 2. Two tool profiles.
>    - local-dev: the current 13 tools, stdio only, never deployed to cloud.
>    - service: ONLY list_templates, render_still, render_video_start,
>      render_job_status. Tools that execute caller or project code
>      (viz_render_html, remotion_list_compositions, remotion_init_project,
>      remotion_start_studio) are NOT REGISTERED in this profile — not denied at
>      runtime, absent from the registration table.
> 3. The service profile renders only compositions from a template pack bundled at
>    deploy time. Props validated by each template's zod schema. The engine stays
>    domain-agnostic: football templates live in the ISE304-project repo, NOT in
>    remotion-viz-mcp.

Constraint 3 names zod as the validator. The pack author still writes zod, and
the contract that crosses the wire is the JSON Schema exported from it (see
Decision).

Nothing in the repository can select a subset of tools today:

- There is no registration table. `src/index.ts:22-27` makes six hard-coded
  `registerXTools(server)` calls. Those make 13 `server.registerTool(` calls,
  each with a literal name, under `src/tools/`.
- `manifest.json:60-113` is a second, hand-maintained list
  (`"tools_generated": false` at `:114`). `test/bundle.test.mjs:164-217` checks
  that the bundled server's sorted tool names equal it.
- `docs/TOOLS.md` already marks what makes four tools unfit for a network:
  - `remotion_init_project`: "`install:true` runs npm." (`:29`). `install` is
    an argument the caller supplies (`src/tools/project.ts:34-36`).
  - `remotion_list_compositions`: "Bundles and **executes** the project's
    code" (`:30`).
  - `remotion_start_studio`: a "Detached dev server; survives the session"
    (`:33`).
  - `viz_render_html`: screenshots caller HTML in headless Chrome (`:46`).

tsc emits the whole import closure of an entry point, so reusing a module drags
in what it imports. Two such edges mattered:

- `src/tools/render.ts` value-imported `requireEntryPoint` from
  `src/tools/project.ts`, which registers `remotion_init_project` (`:81-82`) and
  `remotion_list_compositions` (`:196-197`). PR #20 lifted it into a leaf,
  `src/services/entrypoint.ts`. `render.ts:29` now imports it from there, and
  `project.ts:50` re-exports it.
- `src/tools/render.ts:27` imports `tilePanels` from `src/services/tile.ts`.
  `tile.ts:5` imports `rasterizeSvg` from `src/services/raster.ts`, which does
  three things:
  - loads `@resvg/resvg-js` (`:3`)
  - imports `src/services/network.ts` (`:11`)
  - dynamically imports `puppeteer-core` (`:154`)

## Decision

### Two profiles, separated structurally

A flag would leave the dangerous handlers compiled, shipped, and one bad branch
from reachable, so the profiles are separated structurally instead. The service
profile has a different entry point, compile closure, output directory and
artifact (ADR-4). It will register exactly four tools from **one**
`registerTool(` site: a loop over a frozen `SERVICE_TOOLS` array in
`src/service/registry.ts`.

### The four forbidden tools are absent from the closure, not denied

That puts four requirements on the build. Spikes of 2026-10-25 (design §2)
established the first and the fourth:

1. **`tsconfig.service.json` must set `"include": []`.** Its other settings
   are `files: ["src/service/index.ts", "src/service/healthcheck.ts"]`,
   `noEmitOnError: true` and `outDir: dist-service`, and the entry lands at
   `dist-service/service/index.js`. The plan's Task 10 added the second root,
   `src/service/healthcheck.ts`: it is the image's `HEALTHCHECK`, and
   `index.ts` never imports it, because importing it would run the probe. A
   config that extends `tsconfig.json` and
   sets only `files` inherits `include: ["src/**/*"]`, which `tsc --showConfig`
   confirms. Its program would then contain every module under `src/`,
   `src/tools/project.ts` included, and the spike saw every tool module compile
   in.
2. **`requireEntryPoint` lives in a leaf, and the service needs neither
   `environment.ts` nor `browser.ts`.** The leaf is
   `src/services/entrypoint.ts` (PR #20). `test/profiles.test.mjs` asserts that
   nothing in its import closure is under `src/tools/`, and that `render.ts`
   reaches no other tool module. The leaf still calls `findEntryPoint` from
   `src/services/environment.ts`, which imports `browser.ts`
   (`environment.ts:7`), and `browser.ts` makes a non-literal `import(...)`
   (`browser.ts:105`). A service that renders a prebuilt bundle needs no
   entry-point discovery, so `src/service/` must import neither `environment.ts`
   nor `browser.ts` (design §5.7). The module check and the dependency check
   below will prove it.
3. **The service never reaches `tile.ts`.** The service's `render_still` will
   take one frame through its own spawner (`src/service/render-process.ts`,
   ADR-7), so it has nothing to tile. If the service imported `tile.ts`, resvg,
   `network.ts` and a `puppeteer-core` import would enter `dist-service/`.
4. **The absence suite reads the compiled output, not just names.** A grep of
   `dist-service/` for the four forbidden names fails on a correct closure,
   because shared hint strings name local-dev tools. It would also pass a
   closure that reached resvg. Type-only imports still emit their target
   modules. So the suite will run checks that tell a correct closure from a
   poisoned one:
   - **AST check.** It reads every `registerTool` and `.tool` call site in the
     emitted syntax tree. It allows only the one loop in `service/registry.js`.
     It flags any non-literal name, and any non-call reference to
     `registerTool`, such as an alias, `.bind` or destructuring. It requires
     zero forbidden names.
   - **Module check.** No file from `tools/*`, `raster`, `tile`, `network`,
     `visualize`, `studio`, `compare`, `environment` or `browser` is present.
   - **Dependency check.** There is no `@resvg/resvg-js` or `puppeteer-core`
     specifier, and no non-literal `import()`.
   - **Live check.** A live `tools/list` returns exactly the four tools.
   - **Poisoned build control.** A type-only import of `tools/project.js` must
     fail the AST check and the module check.
   - **Poisoned registry control.** A fifth tool must fail the registry check
     and the live check.

### The service schemas delete arguments rather than validate them

- `render_still` and `render_job_status` take strict input schemas, so an
  argument they do not name is refused. `render_still` takes
  `{ template_id, frame?, props }`. `list_templates` and `render_video_start`
  take no arguments and declare no schema, so the SDK ignores any arguments
  sent to them: SDK 1.30.0 validates nothing for a tool without one
  (`dist/esm/server/mcp.js:166-169`). A tenant or team field among those
  arguments is still audited as a violation (ADR-6).
- None has a tenant, team, path, output-name, entry-point or scale field.
- No service tool accepts a string that reaches a path join. The service mints
  the render's output path itself.
- No service response carries a filesystem path. Every error the service's own
  code returns is a category and a fixed message (`invalid_props` adds the
  first failing JSON pointer, plus one per failed `anyOf` branch where the
  validator reports them, never their values), never a path, a local-dev tool
  name, CLI output or a raw zod or ajv message.
- One kind of error is not the service's own. The owner approved it with the
  plan as deviation 2 (`docs/superpowers/plans/final_script.md:42-43`):

  > 2. **The SDK's own argument-validation errors pass through unchanged.** Examples are a non-string `template_id` or a non-object `props`. These messages describe the caller's own arguments. Every error this code raises still follows design §5.5.
  >    - The same goes for the SDK's `Tool <name> not found` reply to an unknown tool (`server/mcp.js:104`). It echoes back only the caller's own `params.name`.

  Such an error carries the SDK's text, for example
  `MCP error -32602: Input validation error: Invalid arguments for tool render_still: ...`
  or `MCP error -32602: Tool viz_render_html not found`, and no
  `structuredContent.category` (SDK 1.30.0, `dist/esm/server/mcp.js:141` and
  `:152-162`). `docs/CONTRACT-gateway.md` tells a backend so.
- `render_video_start` and `render_job_status` will be registered and will
  return a documented `not_implemented`. When `render_job_status` is
  implemented, it looks up `(tenant from the verified identity, job_id)`. A job
  owned by another tenant returns the same `job_not_found` as one that does not
  exist.

### Template packs

The service renders only compositions from a template pack. A deployer bakes the
pack into a derived image that builds on the service image this repository will
publish (owner ruling 3). This repository will contain no pack except a fixture.

**What the derived image contains** (design §5.4):
- `pack-manifest.json`:

  ```
  { packHash, remotionVersion,
    templates: [{ id, compositionId, width, height, defaultFps, maxFrames,
                  propsSchema }] }
  ```

  `propsSchema` is a JSON Schema (draft 2020-12), exported with the pack's own
  zod 4 `z.toJSONSchema`.
- `bundle/`, a prebuilt Remotion bundle, so a still never pays for bundling.
- `package.json` and the lockfile. A Linux build stage of the derived image runs
  `npm ci --omit=dev`, so native packages match the image. The runtime stage
  receives the resulting `node_modules` and has no `npm`. A pack never ships a
  `node_modules` built on Windows or macOS.
- Chrome Headless Shell, installed at a fixed path with `remotion browser
  ensure` in that same Linux stage, so the service never downloads a browser at
  runtime.

Each pack image brings its own Remotion CLI and Chrome, and the base image pins
no Remotion version (design §8, call 5). The service will check the installed
renderer when it starts (ADR-7).

**`scripts/build-pack.mjs`** will run in a Remotion project. It will bundle the
project, load the schemas through the project's own esbuild, and discover the
compositions, failing if it finds none. It will then run the zod gate, write the
manifest, and check that every bound the gate accepted appears in the exported
JSON Schema, failing if one is missing. The discovery limits are untested:
`<Folder>`, hooks, module-scope font loading and pnpm layouts.

**The fixture pack.** This repository will develop against a domain-agnostic
fixture pack, `Swatch`: a still with a text label, including a Turkish-glyph
prop. Its build will run in a Linux CI job. The football pack belongs to the
group, lives in `ISE304-project`, and must emit the same manifest shape.

### Two gates hold the pack to a vocabulary both sides can implement

The vocabulary carries no explicit fetch target. It has two gates, because the
service cannot trust that a deployer ran the first.

**The zod gate is a step of `build-pack`.** It will accept only zod 4 schemas.
Remotion 4 projects resolve zod to zod 4 (zod 4.4.3 and 4.5.4 were observed),
and a zod 3 schema will be refused with a clear message. The gate reads the
checks of every node type:
- **Allowed:**
  - strict objects
  - strings with a max, optionally with a regex
  - numbers with both bounds, inclusive or exclusive
  - booleans, enums and literals
  - arrays with a max
  - optional of any of these
- **Refused:**
  - url and email formats
  - anything unbounded
  - `custom` checks (refine and superRefine) and `overwrite` checks, on any type
  - pipe and transform
  - any, unknown, record and every other type

On zod 4, `.refine` is a check inside a field, not a wrapper. The prototype gate
still let `.refine` through on enum, literal and optional nodes, and an
independent re-check caught it. That is why the gate reads checks, not wrapper
types.

Remotion's own `zColor`, `zTextarea` and `zMatrix` helpers fail the gate, and
the pack authoring guide will give replacements. The export uses zod 4's own
`z.toJSONSchema`, because the SDK's helper and `zod-to-json-schema` silently
drop every bound. Build-pack's last step will catch a bound that goes missing
anyway.

**The JSON Schema gate must run at service startup,** on every `propsSchema` the
service loads. The service must refuse to start on a pack that fails it:
- every object has `additionalProperties: false`
- every array has `maxItems`
- no `format` is `uri` or `email`
- every string has `maxLength`, unless it is an `enum` or a `const`
- every number has a lower bound and an upper bound. `exclusiveMinimum` and
  `exclusiveMaximum` count.

### Props are validated with ajv, against the published schema

At request time the service will validate props with ajv (`ajv/dist/2020`)
against the template's `propsSchema`. No zod runs inside the service.
`list_templates` returns each template's `propsSchema`, and the backend
validates against that same published JSON Schema, so there is one contract.
Remotion's own render path does not appear to validate props. That was inferred
from its code, not tested with a render, so ajv is the validation.

Validation must happen before a render slot is taken or a process is spawned.
A failure is a refusal of category `invalid_props`. The audit will record that
category, not ajv's message, which can echo a caller's value (ADR-6).

A composition may compute its size at render time with `calculateMetadata`. The
service will always pass the manifest's width, height and frame to the CLI
explicitly, so its pre-render checks hold whatever the composition computes.

**The vocabulary does not keep URLs out of strings.** A bounded string can still
hold one. Whether a string is ever fetched depends on the template's own code,
which the gates cannot see. The vocabulary removes the explicit markers. Egress
deny is the control that actually binds, and it is the deployer's (see below).
Templates must also be self-contained: fonts and images live inside the pack,
and there are no web fonts.

## Why this is Accepted

**The pack is trusted code, and the boundary is stated by owner ruling 7.**
`render_still` runs the pack's bundle in headless Chrome, which is the very
reason `remotion_list_compositions` is excluded. The ruling restates the
boundary:
- A pack is code that a deployment's operator bakes into their own image.
- No tool accepts code with a request.
- A pack's risk belongs to the operator of the deployment that runs it.

So the service executes only code that its own deployment's operator chose to
bake. This ADR first stood as Proposed, behind a gate: a charter in
`ISE304-project` had to confirm that tenants do not supply their own Remotion
projects. Ruling 7 drops that gate. The claim no longer rests on a document in
another repository. It rests on what the service accepts, and the structural
separation above is what makes it checkable that no tool takes code with a
request.

**Egress is the deployer's control (ruling 6), and this ADR's security claim is
conditional on it.** `docs/DEPLOY.md` will make it mandatory: the container has
no outbound route, and cloud metadata is blocked. It is the only control that
binds Chrome's own fetches. This repository cannot enforce it, because egress
enforcement is outside the repository (design §3). A deployer who does not deny
egress leaves a pack that fetches a URL from a prop free to reach whatever the
container can reach.

**Review of a pack belongs to its operator.** Who may change a pack, through
which review, is the operator's to govern, because the risk is theirs.

## Consequences

- **Build status.** Decided 2026-10-26. As of 2026-11-11,
  `docs/superpowers/plans/final_script.md` has built on this branch what this
  ADR names: `src/service/` (the one registration site in `registry.ts`, the
  four tools in `tools.ts`, the JSON Schema gate and `loadPack` in
  `templates.ts`), `tsconfig.service.json` with its two roots,
  `scripts/build-pack.mjs` with the zod gate (`scripts/lib/zod-gate.mjs`,
  `scripts/lib/pack-templates.mjs`, `scripts/lib/pack-files.mjs`), the fixture
  pack (`fixtures/pack/`), the absence suite (`test/absence.test.mjs`,
  `scripts/check-service-closure.mjs`), `docs/CONTRACT-pack.md` and
  `docs/DEPLOY.md`. They join the leaf `src/services/entrypoint.ts` and its
  tests (PR #20). The images were built and run locally on 2026-11-13, on
  Docker Desktop's Linux engine 29.1.3, with the fixture pack built on top
  (Task 10 Step 4, [`CI.md`](../CI.md#the-image-job-the-images-proved-on-linux)):
  `image-checks.sh`, every case of `image-e2e.mjs` and both runs of
  `walk-only-proof.mjs` passed. Still unproven as of 2026-11-13:
  - CI's `image` job has not yet run on GitHub.

  Context, and the future tense above, describe the tree as of 2026-10-26.
- **Absence is claimed for the registration closure and the compiled artifact,
  not for the image.**
  - `puppeteer-core` and `@resvg/resvg-js` are production dependencies of this
    package, so the image's `node_modules` holds them after a production
    install.
  - The poisoned-registry control will prove the registry, not the image.
  - Until the image's dependency set is narrowed and a capability check proves
    it, this ADR does not claim the dangerous capabilities are absent from the
    image.
- **The service has no second manifest.** It is not packaged as an `.mcpb`.
  Agreement between the registry and what the service advertises will be
  asserted by a live `tools/list` (the absence suite's live check).
- **How a caller retrieves a still is decided; a video is not.** Owner ruling 2:
  `render_still` returns the PNG inside the MCP response, under a size cap.
  There is no storage and no download token. For video, `render_video_start` and
  `render_job_status` return `not_implemented` until they are built, and
  retrieval is decided then.
- **Some gaps remain and are named, not hidden:**
  - `build-pack`'s discovery limits (`<Folder>`, hooks, module-scope font
    loading, pnpm layouts) are untested.
  - That Remotion's render path does not validate props is inferred, not
    tested.
  - Egress deny and the review of a pack are the deployer's.

**Reversal cost: low for the mechanism, high for the boundary.** Collapsing to
one profile deletes a directory. Widening the service profile to accept code
with a request means re-arguing ruling 7.

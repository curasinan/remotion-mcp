# ADR-5: Tool profiles and template packs

**Status:** Proposed. Accepted when `ISE304-project/docs/CHARTER.md` exists and
confirms that tenants do not supply their own Remotion projects.

**Relation:** New ground; supersedes nothing. Builds on
[ADR-4](0004-http-transport-for-the-service-profile.md).

## Context

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
in what it imports. Two such edges matter:

- `src/tools/render.ts:29` value-imports `requireEntryPoint` from
  `src/tools/project.ts:50`. That module registers `remotion_init_project`
  (`:103-104`) and `remotion_list_compositions` (`:218-219`).
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
artifact (ADR-4). It registers exactly four tools from **one** `registerTool(`
site: a loop over a frozen `SERVICE_TOOLS` array in `src/service/registry.ts`
(plan Task 7).

### The four forbidden tools are absent from the closure, not denied

That puts four requirements on the tasks that build the closure:

1. **`tsconfig.service.json` sets `"include": []`.** A config that extends
   `tsconfig.json` and sets only `files` inherits `include: ["src/**/*"]`,
   which `tsc --showConfig` confirms. Its program would then contain every
   module under `src/`, `src/tools/project.ts` included. **This amends plan
   Task 6 Step 3.**
2. **`requireEntryPoint` moves to a leaf, `src/services/entrypoint.ts`** (plan
   Task 3). It is a leaf with respect to `src/tools/` only. It still calls
   `findEntryPoint` from `src/services/environment.ts`, which imports
   `browser.ts` (`environment.ts:7`). That is discovery code, not native code.
   Moving the project-shape helpers into a leaf `project-shape.ts` is
   recommended before the image is built. No plan task does it yet.
3. **`src/services/render-core.ts` (plan Task 5) must not import `tile.ts`.**
   The service's `render_still` takes one frame, so it has nothing to tile. If
   render-core imported `tile.ts`, resvg, `network.ts` and a `puppeteer-core`
   import would enter `dist-service/`.
4. **The absence suite checks modules, not just names.** Plan Task 7 greps
   `dist-service/` for the four forbidden names. It must also fail on any
   module from `src/tools/`, and on `raster.js`, `tile.js` or `network.js`.
   The name grep alone would pass a closure that reached resvg.

### The service schemas delete arguments rather than validate them

- All four input schemas are `.strict()`.
- None has a tenant, team, path, output-name, entry-point or scale field.
- No service tool accepts a string that reaches a path join.
  `src/services/paths.ts` freezes its root at import (`:8-14`), and with no
  such string it needs no tenant parameter.
- No service response carries a filesystem path.
- `render_job_status` looks up `(tenant from the verified identity, job_id)`
  in the job store (plan Task 11). A job owned by another tenant returns the
  same `job_not_found` as one that does not exist.

### Template packs

The service renders only compositions from a pack baked into the image at build
time. The pack emits `pack-manifest.json`:

```
{ packHash, templates: [{ id, compositionId, schemaName, defaultFps, maxFrames }] }
```

Props are validated against the named template's zod schema on every
`render_still` call, and on every `render_video_start` call once it is
implemented (ADR-7). Validation happens before the frame budget is computed, a
render slot is taken or a child is forked. Plan Task 7 Step 3 builds it in
`src/service/templates.ts`. A failure is a `ToolInputError` of category
`invalid_props`. The audit records that category, not zod's message, which can
echo a caller's value (ADR-6).

This repository develops and benchmarks against a domain-agnostic fixture pack
(`Swatch` and `Ticker`, plan Task 20). The football pack belongs to the group,
lives in `ISE304-project`, and must emit the same shape.

### Template zod schemas are the backend contract

Until a backend contract exists, the template zod schemas are the contract, and
the backend conforms to them. They are held to a vocabulary that both sides can
implement and that carries no explicit fetch target. The gate reads each schema
node's definition rather than constructor names. In zod 3 that is `_def.typeName`
plus, for bounds, `_def.checks`, `_def.maxLength` and `_def.unknownKeys`.

- **Allowed:**
  - `ZodObject` with `strict` unknown keys
  - `ZodString` with a `max` check, optionally with a `regex`
  - `ZodNumber` with both bounds
  - `ZodBoolean`, `ZodEnum` and `ZodLiteral`
  - `ZodArray` with a maximum length
  - `ZodOptional` of any of these
- **Refused:**
  - a `ZodString` with a `url` check
  - an unbounded string, number or array
  - `ZodEffects`: `.refine`, `.superRefine`, `.transform` and `.preprocess`
  - `ZodAny`, `ZodUnknown` and `ZodRecord`

A template references any asset it needs by an id from a baked set, never by a
URL. The gate must run in the image build against whichever pack is baked, not
only against the fixture pack.

**This amends plan Task 20 Steps 1-2.** Those steps allowlist eight
constructors, with no requirement for bounds or strictness. `.url()` is a check
on an allowlisted constructor, not a construct outside the allowlist, so as
written the steps would accept `z.string().url()`. Task 20's intentionally bad
schema must include one.

**The vocabulary does not keep URLs out of strings.** A bounded string can
still hold one. Whether a string is ever fetched depends on the template's own
code, which the gate cannot see. The vocabulary removes the explicit markers.
Egress deny is the control that actually binds; see below.

## Why this is Proposed

**The pack is trusted code.** `render_still` bundles the template project and
runs it in headless Chrome, which is the very reason
`remotion_list_compositions` is excluded. So the honest statement of this
boundary is that the service executes only code its operators chose to bake.

That rests on one claim the owner has made and no committed requirement states:
**tenants do not supply their own Remotion projects.** Fixed constraint 3 says
the pack is "bundled at deploy time", but a constraint is an owner assertion.
`ISE304-project` has no charter: it is empty as of 2026-10-17. If the charter
says otherwise, this boundary collapses.

The boundary also rests on two controls that no in-scope plan task builds:
- **Container egress deny-by-default,** with cloud metadata endpoints blocked
  at the network namespace. It is the only control that binds Chrome's own
  fetches, and no plan task builds it.
- **Review governance of the football pack.** Plan Task 2 Steps 3-4 describe
  it: `CODEOWNERS` for `packages/templates/**`, and branch protection on
  `main`. But Task 2 is out of scope, and is left for the `ISE304-project`
  group to pick up.

## Consequences

- **Absence is claimed for the registration closure and the compiled artifact,
  not for the image.**
  - `puppeteer-core` and `@resvg/resvg-js` are production dependencies of this
    package, so a plain `npm ci --omit=dev` puts them in the image's
    `node_modules`.
  - No plan task narrows the image's dependency set, or builds a poisoned image
    to prove a capability check. Plan Task 7's "POISONED CONTROL (image)" is a
    poisoned registry.
  - Until both exist, this ADR does not claim the dangerous capabilities are
    absent from the image.
- **The service has no second manifest.** It is not packaged as an `.mcpb`.
  Agreement between the registry and what the service advertises is asserted
  by a live `tools/list` (plan Task 7).
- **Not yet in any plan task:**
  - the schema-reflection test for `.strict()` and no path join
  - the identical-`job_not_found` assertion at the tool response
  - a test that no service response carries a filesystem path
  - closure requirement 1, which amends plan Task 6 Step 3
  - the `project-shape.ts` split recommended in closure requirement 2
  - closure requirements 3 and 4
  - check-level enforcement in the vocabulary gate
  - running the gate in the image build
  - container egress deny
- **How a caller retrieves an artifact is undecided.** The design's candidate
  is a tenant-scoped, single-use download token. Until retrieval is decided,
  `render_job_status`, once implemented (ADR-7), returns status and digest
  fields only.

**Reversal cost: low for the mechanism, high for the boundary.** Collapsing to
one profile deletes a directory. Widening the service profile means re-arguing
why the pack is trusted.

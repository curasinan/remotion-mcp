# TacticLens Render Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `remotion-viz-mcp` with a four-tool service profile behind a thin authenticating gateway, reachable over HTTP by the TacticLens backend, while the thirteen-tool local-dev profile stays stdio-only and unchanged.

**Architecture:** One source tree, two composition roots and two build outputs — `dist/` (stdio, 13 tools) and `dist-service/` (HTTP, 4 tools) — where the dangerous tools are absent from the service build because `tsc`'s transitive closure never reaches their registration module. A thin stateless gateway terminates auth, enforces the allowlist and body cap, signs a tenant identity header, and writes a hash-only audit envelope. Renders run in a forked child so a native abort surfaces as a tool error. Football templates live in `ISE304-project` and are baked into the image at build time.

**Tech Stack:** TypeScript 5, `@modelcontextprotocol/sdk` 1.30.0 (`server/streamableHttp.js`), `node:test`, `node:child_process.fork`, SQLite (WAL), Docker on `node:22-bookworm-slim`, Caddy, Remotion 4.

**Spec:** `../../../../docs/DESIGN-tacticlens-service.md` (outside this repo, at `helpers/docs/`). Read it with this plan; it carries the architecture diagram, the threat model and the attack record. Owner rulings of 2026-10-17 amend it — see Global Constraints.

---

## Scope and execution order

**Amended 2026-10-17 by owner ruling, after the task bodies below were written.** Task numbers are stable identifiers, not a schedule — they are deliberately *not* renumbered, because 40+ cross-references in Interfaces blocks and the Review Focus section read them, and a renumber with one stale reader sends an implementer to the wrong task. Read the order from here; read the tasks by their numbers.

### Scope: this repository only

**`ISE304-project` is an independent group project and is NOT in this plan's scope.** This plan develops the MCP server. Consequently:

- **Task 2 [ISE] and Task 13 [ISE] are OUT OF SCOPE.** Do not create, configure or commit anything in `ISE304-project`. Do not wait on it either.
- **Task 13's templates were a precondition for Tasks 14, 15 and 18.** They are replaced by **Task 20** below: a small, domain-agnostic fixture pack inside this repo. The football templates remain the group's work, baked in at deploy time; fixed constraint 3 (the engine stays domain-agnostic) is strengthened by this, not weakened — the engine is now developed and benchmarked against a pack that contains no football at all.
- **ADR-0005 cannot cite a charter that does not exist.** `ISE304-project` is 0 KB as of 2026-10-17. Write ADR-0005 citing the owner's fixed-constraint document, and mark its Status **Proposed**, not Accepted, with an explicit gate: *"Accepted when `ISE304-project/docs/CHARTER.md` exists and confirms that tenants do not supply their own Remotion projects."* That claim is the load-bearing one for the template-pack trust boundary, and it is currently an owner assertion rather than a committed requirement. The other three ADRs are Accepted on landing.
- **Task 19's `docs/CONTRACT-backend.md` is now the primary handoff artifact to the group**, not a side deliverable. It is the only thing that makes the two timelines joinable.

### Order

| # | Task | Why here |
| --- | --- | --- |
| 1 | **Task 1** — tsconfig exclusion | ~15 minutes, and ADR-0004 cites its outcome. Must precede the ADRs so ADR-0004 states a verified fact rather than an intention. |
| 2 | **Task 4** — ADRs 0004, 0005, 0006, 0007 | **Owner ruling: ADRs first.** Project Plan is due 2026-10-28 and is this document plus the ADR set. 0005 lands Proposed per the gate above. |
| 3 | Task 3 — lift `requireEntryPoint` | |
| 4 | Task 5 — render core | |
| 5 | **Task 20** — fixture template pack | Replaces Task 13. Must precede Tasks 7, 14, 15 and 18, all of which read `pack-manifest.json`. |
| 6 | Task 6 → 7 → 8 → 9 → 10 → 11 → 12 | Service root, frozen four, gateway, child, jobs, frame budget. |
| 7 | Task 14 → 15 → 16 → 17 → 18 → 19 | End-to-end, image, deploy, sweeper, benchmark, reconciliation and the contract. |

Task 1 and Task 4 together, plus the owner's own charter commit, are the whole 2026-10-28 deliverable.

---

## Task 20 [MCP]: A domain-agnostic fixture template pack

Replaces the out-of-scope Task 13. Without it, every task that reads `pack-manifest.json` blocks on another team's repo.

**Files:**
- Create: `fixtures/pack/src/Swatch.tsx`, `fixtures/pack/src/Ticker.tsx`, `fixtures/pack/src/schemas.ts`, `fixtures/pack/props/*.json`, `scripts/build-fixture-pack.mjs`, `scripts/check-schema-vocabulary.mjs`
- Modify: `package.json` (`build:pack`)

**Interfaces:**
- Produces: `pack-manifest.json` — `{ packHash: string, templates: [{ id, compositionId, schemaName, defaultFps, maxFrames }] }`. Tasks 7, 12, 14, 15 and 18 consume it. **This is the same shape the group's football pack must emit**, so Task 19's contract document specifies it.

Two compositions only, and deliberately not football: `Swatch` (a still — coloured panel with a text label) and `Ticker` (a short animation at 25 fps). Between them they exercise the still path, the video path, the zod validation path and the font path, which is everything the engine needs to be developed against.

- [ ] **Step 1: Write the schema-vocabulary CI gate first**

Walks each exported zod schema and fails on any construct outside the allowlist: `z.object`, `z.string`, `z.number`, `z.boolean`, `z.array`, `z.enum`, `z.optional`, `z.literal`. `z.transform`, `z.refine` and `z.any` are refused — a transform makes the schema unimplementable by a non-TypeScript caller, and the schema is the backend contract.

- [ ] **Step 2: Run the gate against an intentionally bad schema and confirm it fails.** Paste the output, then delete the bad schema. A gate nobody has watched reject something is indistinguishable from one that matches nothing.

- [ ] **Step 3: Write `schemas.ts`** — one schema per composition.

- [ ] **Step 4: Commit props fixtures, including one with Turkish glyphs** — a `label` of `Beşiktaş · İstanbul · Şenol Güneş`. Task 15's golden-image test renders this.

- [ ] **Step 5: Implement both compositions.**

- [ ] **Step 6: Implement `scripts/build-fixture-pack.mjs`**, emitting `pack-manifest.json` with `packHash` computed over the built bundle bytes.

- [ ] **Step 7: Verify**

Run: `npm run build:pack && node --test test/pack.test.mjs`
Expected: the gate passes, both compositions render from their fixtures, `pack-manifest.json` validates against the shape above, and `packHash` changes when a source file changes (prove it: edit, rebuild, compare).

- [ ] **Step 8: Commit**

---

## Global Constraints

Copied verbatim from the spec and the owner's rulings. Every task's requirements implicitly include these.

- **13 tools in local-dev, not 12.** `remotion_check_environment`, `remotion_ensure_browser`, `remotion_get_workspace_info`, `remotion_init_project`, `remotion_list_compositions`, `remotion_render_still`, `remotion_render_video`, `remotion_start_studio`, `remotion_stop_studio`, `viz_compare`, `viz_render_html`, `viz_render_svg`, `viz_validate_svg`.
- **Service profile is exactly four tools:** `list_templates`, `render_still`, `render_video_start`, `render_job_status`. The last two ship at the Design milestone (2026-12-08) returning a documented `not_implemented`; they are **protected scope, not stretch**.
- **Four tools must be structurally absent from `dist-service/`:** `viz_render_html`, `remotion_list_compositions`, `remotion_init_project`, `remotion_start_studio`. Absent from the registration closure, not denied at runtime.
- **Never edit an accepted ADR in place.** New ADRs supersede and quote the superseded clause by number. Next free number is **0004**.
- **Keys never in either repo.** Both are public.
- **Tenant identity comes from the authenticated principal, never from a tool argument.**
- **Audit records payload hashes and sizes only, never raw payloads.**
- **`--max-old-space-size` caps the V8 heap only, not resvg's native pixmap.** The pixel cap remains the native-memory guard and ADR-0007 must say so.
- **Image base is glibc:** `node:22-bookworm-slim`. Never Alpine — `test/bundle.test.mjs:150-152` records that resvg's musl entries are disabled, and this project shipped an accidental musl binary in v1.2.1.
- **Fonts pinned for coverage, not presence.** Player and team names contain Turkish (`ş ğ ı İ`) and other Latin Extended glyphs.
- **Deploys only from CI, only from protected `main`, image pinned by digest.**
- **Idempotency key is tenant-scoped `(tenant, idempotency_key)`;** a duplicate returns the existing `job_id`; key TTL equals job TTL.
- **Audit reconciliation is a batch job, not real-time.**
- **No LiteLLM spike this window.** The thin gateway is the plan. ADR-0006 records: *"LiteLLM will be re-evaluated against the same five criteria when it is deployed as the TacticLens LLM gateway."*
- **Template zod schemas are the contract** until a backend contract exists. The backend conforms to them.
- **Remotion licence status is unverified by this plan.** The owner has read the current text; this plan has not. Keep it marked unverified.

## Review Focus

Five failure modes the spec implies that no task's happy path exercises. Each has its test pinned to the owning task below.

1. **Idempotency check-then-insert race.** Two Celery workers retrying the same logical render concurrently. A `SELECT` then `INSERT` admits both and doubles the render. Must be one atomic statement — owned by **T11**.
2. **Turkish glyphs rendering as boxes.** A template prop of `Beşiktaş` in a container missing Latin Extended coverage renders tofu silently, and `viz_compare` is absent from the service profile so nothing looks at a frame until the demo — owned by **T15**.
3. **Body cap bypass via chunked transfer-encoding.** A `Content-Length` check alone passes an unbounded chunked body — owned by **T8**.
4. **Cross-tenant job poll.** Tenant A calling `render_job_status` with a `job_id` belonging to tenant B. Random 128-bit ids make it unlikely, not impossible, and the key must be composite — owned by **T11**.
5. **TTL sweeper measuring against the database's own clock.** A sweeper that takes an injectable `now` but filters with SQLite `datetime('now')` passes its frozen-clock test forever and then deletes the wrong generation — owned by **T17**.

---

## File Structure

### `remotion-mcp` — created

| File | Responsibility |
| --- | --- |
| `src/services/entrypoint.ts` | `requireEntryPoint` only. A leaf: imports nothing from `src/tools/`. |
| `src/services/render-core.ts` | The still/video render call, free of tool registration. |
| `src/service/index.ts` | Service composition root. Constructs the HTTP transport, calls the registry. |
| `src/service/registry.ts` | The frozen four. One registration site. |
| `src/service/templates.ts` | Reads `pack-manifest.json`; validates props against a template's zod schema. |
| `src/service/jobs.ts` | SQLite job store keyed `(tenant, job_id)`. |
| `src/service/child.ts` | Fork, deadline, SIGTERM→SIGKILL, process-group kill. |
| `gateway/` | The thin gateway: `config.ts`, `auth.ts`, `allowlist.ts`, `identity.ts`, `envelope.ts`, `server.ts`. |
| `scripts/reconcile-audit.mjs` | The batch reconciliation query. |
| `scripts/bench-render.mjs` | The capacity benchmark harness. |
| `docs/adr/0004-…` through `0007-…` | Four ADRs. |
| `docs/CONTRACT-backend.md` | The HMAC + idempotency contract for the backend author. |
| `Dockerfile.service`, `docker-compose.yml`, `Caddyfile` | Deployment. |
| `tsconfig.service.json` | `files: ["src/service/index.ts"]`, `outDir: "./dist-service"`. |

### `remotion-mcp` — modified

| File | Change |
| --- | --- |
| `tsconfig.json` | Add `"src/service/**"` and `"gateway/**"` to `exclude`. **This is the first change in the project.** |
| `src/tools/project.ts:50` | Remove `requireEntryPoint`; re-export from `entrypoint.ts` for local-dev callers. |
| `src/tools/render.ts:29` | Import from `../services/entrypoint.js`. |
| `package.json` | Scripts: `build:service`, `test:absence`, `bench`, `reconcile`. |

### `ISE304-project` — created

| File | Responsibility |
| --- | --- |
| `docs/CHARTER.md` | **The first commit.** ADR-0005 cites it. |
| `packages/templates/src/ShotMap.tsx`, `XgTimeline.tsx` | The two Analysis-milestone templates. |
| `packages/templates/src/schemas.ts` | One zod schema per template. The backend contract. |
| `packages/templates/fixtures/*.json` | Committed props fixtures, including one with Turkish glyphs. |
| `scripts/build-pack.mjs` | Emits `pack-manifest.json` with a bundle hash. |
| `scripts/check-schema-vocabulary.mjs` | CI gate: schemas use only allowlisted zod constructs. |
| `.github/CODEOWNERS` | `packages/templates/** @owner @teammate` — at least two, since an author cannot approve their own PR. |

---

## Task 1 [MCP]: Exclude the service tree from the stdio build

The build trap, closed before any service code exists. `tsconfig.json` is `include: ["src/**/*"]` and `scripts/build-bundle.mjs:269` copies `dist/` into the `.mcpb` wholesale, so a naive `src/service/` would ship inside the bundle and fail `test/bundle.test.mjs`'s *"the server ships no HTTP transport"* — a failure that would look like ADR-0004 breaking the stdio guarantee when it had not.

**Files:**
- Modify: `tsconfig.json` (`exclude`)
- Test: `test/profiles.test.mjs` (create)

**Interfaces:**
- Produces: a guarantee every later task relies on — `dist/` never contains service or gateway code.

- [ ] **Step 1: Write the failing test**

```js
// test/profiles.test.mjs
test("the stdio build excludes the service and gateway trees", () => {
  const cfg = JSON.parse(fs.readFileSync("tsconfig.json", "utf8"));
  assert.ok(cfg.exclude.includes("src/service/**"));
  assert.ok(cfg.exclude.includes("gateway/**"));
});

test("dist/ contains no service or gateway output", () => {
  // Walks dist/ and fails on any path segment named service or gateway.
  // Asserts dist/ is non-empty first, so a missing build cannot pass this.
});
```

- [ ] **Step 2: Run it and watch the first test fail**

Run: `node --test test/profiles.test.mjs`
Expected: FAIL — `exclude` is `["node_modules", "dist"]`.

- [ ] **Step 3: Add both globs to `exclude` in `tsconfig.json`**

- [ ] **Step 4: Verify, including that the ADR-0001 test still passes unmodified**

Run: `npm run build && node --test test/profiles.test.mjs && npm run bundle && REQUIRE_BUNDLE=1 node --test test/bundle.test.mjs`
Expected: all pass. `test/bundle.test.mjs` is **not edited** by this task or any other — that it keeps passing verbatim is the cheapest evidence stdio-only still holds for the `.mcpb`.

- [ ] **Step 5: Commit**

```bash
git commit -m "build: exclude the service and gateway trees from the stdio build"
```

---

## Task 2 [ISE]: Charter first, then the repo — **OUT OF SCOPE, DO NOT START**

> Left in place for the group to pick up. Not this plan's work; see "Scope and execution order".

ADR-0005 cites the charter, so the charter must exist before ADR-0005 can be marked Accepted. The repo is currently 0 KB.

**Files:**
- Create: `docs/CHARTER.md`, `package.json`, `tsconfig.json`, `eslint.config.js`, `.github/workflows/ci.yml`, `.github/CODEOWNERS`, `.gitignore`

**Interfaces:**
- Produces: a repo ADR-0005 can cite; `packages/templates/` for T13.

- [ ] **Step 1: Commit the charter as the first commit**

It must answer the six questions §9 of the spec lists as unsettled: whether tenants are users or projects; internet-facing or trusted-network; expected concurrent callers; whether tenants supply their own Remotion projects (fixed constraint 3 says no); retention obligations on user-uploaded match data; who owns a rendered artifact.

- [ ] **Step 2: Repo standup**

`node:test` wiring, eslint, CI running typecheck + lint + test, secret scanning enabled.

- [ ] **Step 3: `CODEOWNERS` with at least two owners for `packages/templates/**`**

- [ ] **Step 4: Enable branch protection on `main`** — required review, required status checks. Verify by attempting a direct push and confirming rejection; paste the rejection.

- [ ] **Step 5: Commit**

---

## Task 3 [MCP]: Lift `requireEntryPoint` to a leaf module

The refactor the spec proved necessary. `src/tools/render.ts:29` imports `requireEntryPoint` from `src/tools/project.ts:50`, and that module registers `remotion_init_project` (`:104`) and `remotion_list_compositions` (`:219`). `tsc` emits the transitive closure, so any service reuse of `render.ts` puts two forbidden tool names into `dist-service/`.

**Files:**
- Create: `src/services/entrypoint.ts`
- Modify: `src/tools/project.ts:50`, `src/tools/render.ts:29`
- Test: `test/profiles.test.mjs`

**Interfaces:**
- Produces: `requireEntryPoint(projectDir: string, explicit?: string): string` from `src/services/entrypoint.ts`. T5 consumes it.

- [ ] **Step 1: Write the failing test**

```js
test("entrypoint.ts is a leaf — it imports nothing from src/tools/", () => {
  const src = fs.readFileSync("src/services/entrypoint.ts", "utf8");
  assert.doesNotMatch(src, /from\s+["'].*\/tools\//);
});
```

- [ ] **Step 2: Run it and watch it fail** — the file does not exist.

- [ ] **Step 3: Move the function**

Move the body of `requireEntryPoint` verbatim into `src/services/entrypoint.ts`. In `project.ts`, re-export it so existing local-dev callers are unchanged. Point `render.ts:29` at `../services/entrypoint.js`.

- [ ] **Step 4: Verify nothing regressed**

Run: `npm run build && npm test`
Expected: the full suite passes — it is the protection for this refactor. Confirm the count matches the pre-refactor count plus this task's new tests, and that 0 are skipped.

- [ ] **Step 5: Commit**

---

## Task 4 [MCP]: ADRs 0004–0007

Due before the Project Plan on 2026-10-28. Schedule this **first** in week 1, not last.

**Files:**
- Create: `docs/adr/0004-http-transport-for-the-service-profile.md`, `0005-tool-profiles-and-template-packs.md`, `0006-gateway-for-the-service-profile.md`, `0007-process-isolation-for-rendering.md`
- Modify: `docs/adr/README.md` (add Status and Relation columns — it is an index, not an ADR)

- [ ] **Step 1: ADR-0004 — HTTP for the service profile**

Supersedes **part** of ADR-0001. Quote the stdio-only clause by number and state precisely what survives: local-dev stays stdio forever, on both laptops. Record that `test/bundle.test.mjs` passes unmodified (T1), and that OAuth 2.1 is **deferred, not absent** (Cut 2) with the compensating controls named.

- [ ] **Step 2: ADR-0005 — tool profiles and template packs**

Cites `ISE304-project/docs/CHARTER.md` (T2). Records that template zod schemas are the backend contract until a backend contract exists.

- [ ] **Step 3: ADR-0006 — the gateway**

Supersedes ADR-0002. **Quote ADR-0002's own reversal trigger verbatim and show both limbs are met:** HTTP returns (ADR-0004) and there is a multi-user goal (three principals). Record the consolidation trigger: *"LiteLLM will be re-evaluated against the same five criteria when it is deployed as the TacticLens LLM gateway."* Until then two gateways are accepted.

- [ ] **Step 4: ADR-0007 — process isolation**

Completes ADR-0003's unshipped half rather than superseding it: 0003's decision was "validation first, then option 2 if still warranted", and the service profile is the warrant. Scoped to the service profile only — local-dev keeps 0003's accepted residual risk (Cut 3). **Must state that `--max-old-space-size` caps the V8 heap only and the pixel cap remains the native-memory guard.**

- [ ] **Step 5: Verify no accepted ADR was edited**

Run: `git diff --name-only origin/main -- docs/adr/`
Expected: only the four new files and `README.md`. `0001`, `0002`, `0003` must not appear.

- [ ] **Step 6: Commit**

---

## Task 5 [MCP]: Extract the render core

**Files:**
- Create: `src/services/render-core.ts`
- Modify: `src/tools/render.ts`
- Test: `test/profiles.test.mjs`

**Interfaces:**
- Consumes: `requireEntryPoint` (T3).
- Produces: `renderStill(opts: RenderStillOptions): Promise<RenderResult>` and `renderVideo(opts: RenderVideoOptions): Promise<RenderResult>`, importing nothing from `src/tools/`. T7 and T10 consume these.

- [ ] **Step 1: Write the failing test** — same leaf assertion as T3, against `render-core.ts`.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Move the render call out of `render.ts` into `render-core.ts`**, leaving `render.ts` as registration plus argument marshalling.
- [ ] **Step 4: Run `npm test`** — unchanged count, 0 skipped.
- [ ] **Step 5: Commit**

---

## Task 6 [MCP]: The service composition root and HTTP transport

**Files:**
- Create: `src/service/index.ts`, `tsconfig.service.json`
- Modify: `package.json` (`build:service`)

**Interfaces:**
- Produces: `dist-service/index.js`, binding a **unix socket**, not a TCP port.

- [ ] **Step 1: Write the failing test**

```js
test("the service build contains no forbidden tool name", () => {
  const FORBIDDEN = ["viz_render_html", "remotion_list_compositions",
                     "remotion_init_project", "remotion_start_studio"];
  // Walks dist-service/**/*.js, asserts it is non-empty, then asserts no file
  // contains any forbidden name as a string literal.
});
```

- [ ] **Step 2: Run it and watch it fail** — `dist-service/` does not exist.

- [ ] **Step 3: Create `tsconfig.service.json`** with `files: ["src/service/index.ts"]`, `outDir: "./dist-service"`, extending the base config.

- [ ] **Step 4: Write `src/service/index.ts`**

Construct `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` (stateless), listening on the unix socket path from `GATEWAY_SOCKET`. Call `registerServiceTools` (T7).

- [ ] **Step 5: Verify**

Run: `npm run build:service && node --test test/profiles.test.mjs`
Expected: PASS, and `ls dist-service/tools/` must not list `project.js`.

- [ ] **Step 6: Commit**

---

## Task 7 [MCP]: The frozen four, and the absence suite

The whole security argument rests on this task. A test asserting "the list has four entries" passes when a fifth is one typo away, so the suite includes **two poisoned controls** that must fail.

**Files:**
- Create: `src/service/registry.ts`, `src/service/templates.ts`, `test/absence.test.mjs`
- Modify: `package.json` (`test:absence`)

**Interfaces:**
- Consumes: `renderStill` (T5), `requireEntryPoint` (T3).
- Produces: `registerServiceTools(server: McpServer): void` — one registration site; `SERVICE_TOOLS: readonly ["list_templates","render_still","render_video_start","render_job_status"]`.

- [ ] **Step 1: Write the absence suite**

```js
// T1: the registry exports exactly the frozen four, by name and in order
// T2: a live tools/list handshake against dist-service returns exactly those four
// T3: no file under dist-service/ contains a forbidden name (T6's test, moved here)
// T4: grep -c 'registerTool(' across dist-service/ === 1
// T5 POISONED CONTROL (build): a fixture tsconfig whose entry imports
//     src/tools/project.ts MUST produce a dist-service containing
//     remotion_init_project. If this test does not fail, T3 is inert.
// T6 POISONED CONTROL (image): a fixture registry adding a fifth tool MUST
//     fail T1 and T2. If it does not, the count assertion is decorative.
```

- [ ] **Step 2: Run and watch T1–T4 fail** (no registry) **and T5–T6 pass** (they assert failure of a thing that is already broken). Record both directions.

- [ ] **Step 3: Implement `registry.ts`** with the frozen four, and `templates.ts` reading `pack-manifest.json` and validating props against the named template's zod schema.

- [ ] **Step 4: Verify all six**

Run: `npm run build:service && node --test test/absence.test.mjs`
Expected: T1–T4 PASS, T5–T6 still PASS (the poisoned builds still produce the forbidden output, proving T3 and T1 can detect it).

- [ ] **Step 5: Commit**

---

## Task 8 [MCP]: Gateway — auth, allowlist, body cap

**Files:**
- Create: `gateway/config.ts`, `gateway/auth.ts`, `gateway/allowlist.ts`, `gateway/server.ts`, `gateway/test/gateway.test.mjs`

**Interfaces:**
- Produces: `authenticate(req): Principal | null` where `Principal = { keyId: string, tenant: string, kind: "backend" | "dev" }`; `isAllowed(toolName: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```js
test("an unknown bearer token is refused with 401 and no body detail")
test("a non-allowlisted tool name is refused with 403 before reaching upstream")
test("a body over the cap is refused with 413")
test("REVIEW FOCUS 3: a chunked body with no Content-Length is also capped", ...)
//   Sends Transfer-Encoding: chunked exceeding the cap. A Content-Length
//   check alone passes this; the cap must count bytes as they arrive.
test("dev keys are pinned to the fixed dev tenant and cannot assert another")
test("a tool argument named tenant or team_id does NOT influence the Principal")
```

- [ ] **Step 2: Run and watch all fail.**

- [ ] **Step 3: Implement.** Keys as hashes in config, read from the environment; never literals in the repo. Compare with `crypto.timingSafeEqual`.

- [ ] **Step 4: Verify, and prove the key store cannot be committed**

Run: `node --test gateway/test/gateway.test.mjs` and `git grep -nE '[A-Za-z0-9_-]{32,}' -- gateway/ | grep -v test`
Expected: tests pass; the grep returns nothing.

- [ ] **Step 5: Commit**

---

## Task 9 [MCP]: Gateway — HMAC identity and the audit envelope

**Files:**
- Create: `gateway/identity.ts`, `gateway/envelope.ts`
- Modify: `gateway/server.ts`
- Test: `gateway/test/gateway.test.mjs`

**Interfaces:**
- Produces: `signIdentity(p: Principal, requestId: string): string` → the `X-TL-Identity` header value; `writeEnvelope(e: Envelope): void` where `Envelope` carries `requestId`, `keyId`, `tenant`, `tool`, `startedAt`, `endedAt`, `outcome`, `upstreamFailureClass`, `reqSha256`, `reqBytes`, `respSha256`, `respBytes`, `packHash`.

- [ ] **Step 1: Write the failing tests**

```js
test("the service refuses a request whose identity header is absent")
test("the service refuses a forged identity header")
test("the service refuses a replayed identity header from a different request id")
test("CANARY: no envelope field ever contains a raw payload", ...)
//   Sends a body containing the sentinel "CANARY-7f3a" and asserts the
//   sentinel appears in NO envelope field. Without this, "hashes only" is
//   a claim nobody has tested.
test("the envelope records the template pack hash")
```

- [ ] **Step 2: Run and watch all fail.**

- [ ] **Step 3: Implement.** HMAC over `requestId || tenant || keyId` with a secret shared only between gateway and service; the request id binds the signature to one call.

- [ ] **Step 4: Verify** — `node --test gateway/test/gateway.test.mjs`, all pass including the canary.

- [ ] **Step 5: Commit**

---

## Task 10 [MCP]: The forked render child

**Files:**
- Create: `src/service/child.ts`, `src/service/render-worker.ts`, `test/child.test.mjs`

**Interfaces:**
- Consumes: `renderStill` (T5).
- Produces: `renderIsolated(job: RenderJob, timeoutMs: number): Promise<RenderResult>` — rejects with `ToolInputError` on crash or timeout, never leaves a process behind.
- **Also modifies `src/service/registry.ts`** (T7) to route `render_still` through `renderIsolated` instead of calling `renderStill` directly. T7 ships calling `renderStill` because isolation does not exist yet; this task rewires it. Re-run T7's absence suite afterwards — the rewiring touches the one registration site those tests guard.

- [ ] **Step 1: Write the failing tests**

```js
test("a child that exceeds the deadline is SIGTERMed then SIGKILLed, and rejects")
test("a child that aborts natively surfaces as a ToolInputError, not a crash", ...)
//   The 120-byte oversized-viewBox SVG from the existing suite is the known
//   native-abort input. Before isolation it kills the process.
test("the child's stdout never reaches the parent's JSON-RPC stream")
test("no process survives a killed render", ...)
//   Counts the process group before and after; polls to a deadline rather
//   than sleeping a fixed interval.
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** `fork` with `stdio: ['ignore','ignore','pipe','ipc']`, `execArgv: ['--max-old-space-size=512']`. Kill the **process group** on POSIX; `taskkill /T` on Windows. Pass the PNG by writing it to the workspace and returning a path — never over IPC, which serialises JSON.

- [ ] **Step 4: Verify** — `node --test test/child.test.mjs`.

- [ ] **Step 5: Commit**

---

## Task 11 [MCP]: The job store

**Files:**
- Create: `src/service/jobs.ts`, `test/jobs.test.mjs`

**Interfaces:**
- Produces: `claimJob(tenant: string, idempotencyKey: string, spec: JobSpec): { jobId: string, created: boolean }`; `getJob(tenant: string, jobId: string): Job | null`.

- [ ] **Step 1: Write the failing tests**

```js
test("REVIEW FOCUS 1: concurrent identical claims create exactly one job", ...)
//   Fires N concurrent claimJob calls with the same (tenant, key).
//   Asserts exactly one has created=true and all return the same jobId.
//   A SELECT-then-INSERT passes single-threaded and fails this.
test("REVIEW FOCUS 4: getJob refuses a job_id belonging to another tenant", ...)
//   Tenant B's jobId with tenant A's identity returns null, not the job.
test("the same idempotency key under two tenants yields two distinct jobs")
test("a job id is 128 bits of randomness, not sequential")
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** SQLite WAL, primary key `(tenant, job_id)`, unique index on `(tenant, idempotency_key)`. `claimJob` must be **one** `INSERT … ON CONFLICT(tenant, idempotency_key) DO NOTHING RETURNING job_id` followed by a read only when zero rows returned — never a check-then-insert.

- [ ] **Step 4: Verify** — `node --test test/jobs.test.mjs`, including the concurrency test.

- [ ] **Step 5: Commit**

---

## Task 12 [MCP]: The frame budget

**Files:**
- Modify: `src/service/templates.ts`, `src/constants.ts`
- Test: `test/absence.test.mjs`

**Interfaces:**
- Produces: `MAX_RENDER_FRAMES` in `src/constants.ts`, enforced at admission against `pack-manifest.json`.

- [ ] **Step 1: Derive the default and write it down**

Anchor to the existing render timeout, not to taste: `TIMEOUT_RENDER_MS` is the wall-clock bound a render already has, so the frame budget is the frame count that cannot exceed it at the slowest benchmarked rate. Until T18 fills in the benchmark, set the default from the arithmetic in spec §6 and record the formula in the constant's doc comment so T18 can re-derive it.

- [ ] **Step 2: Write the failing test** — a props payload whose frame count exceeds the budget is refused at admission with the budget named in the message, before any child is forked.

- [ ] **Step 3: Run and watch it fail.**
- [ ] **Step 4: Implement the admission check.**
- [ ] **Step 5: Verify, then commit.**

---

## Task 13 [ISE]: `ShotMap` and `XgTimeline` — **OUT OF SCOPE, DO NOT START**

> The group's work. Task 20 supplies the fixture pack this plan develops against.

3–4 days of React/Remotion work that existed in no week of the original schedule, and a hard precondition for T14 and T16.

**Files:**
- Create: `packages/templates/src/ShotMap.tsx`, `XgTimeline.tsx`, `schemas.ts`, `fixtures/*.json`, `scripts/build-pack.mjs`, `scripts/check-schema-vocabulary.mjs`

**Interfaces:**
- Produces: `pack-manifest.json` — `{ packHash: string, templates: [{ id, compositionId, schemaName, defaultFps, maxFrames }] }`. T7 and T12 consume it.

- [ ] **Step 1: Write the schema-vocabulary CI gate first**

A schema is the backend contract, so it must be expressible in the subset both sides can validate. The gate walks each exported zod schema and fails on any construct outside the allowlist (`z.object`, `z.string`, `z.number`, `z.boolean`, `z.array`, `z.enum`, `z.optional`, `z.literal`). `z.transform`, `z.refine` and `z.any` are refused — a transform makes the schema unimplementable by a non-TypeScript caller.

- [ ] **Step 2: Run it against an intentionally bad schema and confirm it fails.** Paste the output. Then delete the bad schema.

- [ ] **Step 3: Write one zod schema per template in `schemas.ts`.**

- [ ] **Step 4: Commit props fixtures, including one with Turkish glyphs** — `Beşiktaş`, `İstanbul`, `Şenol Güneş`. T15 renders this fixture.

- [ ] **Step 5: Implement the two templates.**

- [ ] **Step 6: Implement `build-pack.mjs`** emitting `pack-manifest.json` with a `packHash` over the built bundle bytes.

- [ ] **Step 7: Verify** — the gate passes, both templates render locally from their fixtures, `pack-manifest.json` validates.

- [ ] **Step 8: Commit**

---

## Task 14 [MCP]: `render_still` end to end against the real pack

**Files:**
- Test: `test/service-e2e.test.mjs` (create)

**Interfaces:**
- Consumes: everything from T6–T12, plus Task 20's fixture pack (NOT T13, which is out of scope).

- [ ] **Step 1: Write the failing test** — a `render_still` call through the gateway, with a signed identity, against a real built pack, producing a PNG whose dimensions match the request and whose first eight bytes are the PNG signature.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Wire the remaining seams.**
- [ ] **Step 4: Verify, then commit.**

---

## Task 15 [MCP]: The image, with font coverage proven

**Files:**
- Create: `Dockerfile.service`, `docker-compose.yml`, `Caddyfile`, `.github/workflows/service-image.yml`

- [ ] **Step 1: Write the Dockerfile** on `node:22-bookworm-slim`. Pin `chrome-headless-shell` by version at a fixed path and disable lazy download. Install a font with **Latin Extended coverage** and pin its version.

- [ ] **Step 2: Write the failing CI golden-image test**

```
REVIEW FOCUS 2. Runs INSIDE the built service image, because that is the only
place the font set is the shipped one, and viz_compare is absent from the
service profile so nothing else ever looks at a frame.

Renders the Turkish-glyph fixture from Task 20 and asserts the output differs from
a reference rendered with the font package removed. Tofu boxes are visually
distinct from glyphs, so the comparison is the assertion.
```

- [ ] **Step 3: Run it against an image built without the font and confirm it fails.** Paste the output — this is the only proof the check is live.

- [ ] **Step 4: Add the font, confirm it passes.**

- [ ] **Step 5: Decide and record the fallback architecture**

The spec's "identical image" fallback is **not identical on arm64**: spark is linux-arm64, needing a different resvg binding and a different Chrome Headless Shell. Choose one and write it in the compose file's comments: **(a)** rehearse the fallback on the x86-64 laptop, or **(b)** build multi-arch with `buildx` in CI and rehearse the arm64 image separately. State which; do not leave it implied.

- [ ] **Step 6: Commit**

---

## Task 16 [MCP]: Deploy

**Files:**
- Modify: `.github/workflows/service-image.yml`

- [ ] **Step 1: Provision the VM**, x86-64, glibc.
- [ ] **Step 2: Caddy for TLS**; the service socket at `0600`.
- [ ] **Step 3: Deploy only from CI, only from protected `main`, image pinned by digest.** Verify by attempting a deploy from a non-main branch and confirming refusal.
- [ ] **Step 4: Log shipping for both JSONL files with aligned retention.**
- [ ] **Step 5: Verify the human path** — a `render_still` from a Celery stub over real HTTPS through the real gateway to the real service, producing a PNG. Not a route existence check.
- [ ] **Step 6: Commit**

---

## Task 17 [MCP]: Quota, TTL sweeper, drop counter

The three things the original schedule deferred and that break at 2 a.m. on demo night.

**Files:**
- Create: `src/service/sweeper.ts`, `test/sweeper.test.mjs`
- Modify: `gateway/server.ts` (health endpoint)

**Interfaces:**
- Produces: `sweep(now: Date): { deleted: number, bytesFreed: number }`; a health endpoint reporting the audit drop counter.

- [ ] **Step 1: Write the failing tests**

```js
test("REVIEW FOCUS 5: the sweeper filters against the injected clock, not the DB clock", ...)
//   Seeds rows at fixed timestamps, calls sweep(frozenNow), asserts the
//   boundary row survives and the one past TTL does not. A sweeper using
//   SQLite datetime('now') passes today and deletes the wrong generation
//   once real time drifts past the seeds.
test("a tenant over quota is refused at admission, and the refusal is audited")
test("the health endpoint reports a non-zero drop counter when the audit sink fails")
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Every bound derives from the `now` parameter; no SQL wall-clock function appears in the sweeper's queries.
- [ ] **Step 4: Verify, then commit.**

---

## Task 18 [MCP]: The capacity benchmark

**Files:**
- Create: `scripts/bench-render.mjs`, `docs/BENCHMARK.md`

**Interfaces:**
- Produces: measured values for `B` (frames/sec at the slowest cell) and `K_safe` (concurrency), feeding back into T12's `MAX_RENDER_FRAMES`.

- [ ] **Step 1: Implement the harness** for the reduced 8-cell matrix (Cut 5): `ShotMap` and `XgTimeline` × {720p, 1080p} × concurrency {1, 2}, plus one knee cell — **cut per the owner's ruling**, paid to fund the walking skeleton.

- [ ] **Step 2: Run it overnight on the deployed instance.**

- [ ] **Step 3: Fill in `docs/BENCHMARK.md`** with measured numbers, the instance type, the image digest and the date. **No value in this file may be estimated** — an unmeasured cell is recorded as not run.

- [ ] **Step 4: Re-derive `MAX_RENDER_FRAMES`** from the measured slowest rate and `TIMEOUT_RENDER_MS`. If it differs from T12's provisional value, change the constant and say so in the commit.

- [ ] **Step 5: Commit**

---

## Task 19 [MCP]: Audit reconciliation and the backend contract

**Files:**
- Create: `scripts/reconcile-audit.mjs`, `docs/CONTRACT-backend.md`, `test/reconcile.test.mjs`

**Interfaces:**
- Produces: `reconcile(envelopes, serviceEvents): { mismatches: number, requestIds: string[] }`.

- [ ] **Step 1: Write the failing test** — a gateway envelope with no matching service event by request id is reported; a matched pair is not; an unmatched **service** event is reported separately, since the two directions mean different failures.

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement as a batch job**, not real-time (owner's ruling). Output is a mismatch count. Record in `docs/CONTRACT-backend.md` that **this count is the content of P1 when the dashboard design is reopened.**

- [ ] **Step 4: Write `docs/CONTRACT-backend.md`** for the backend author: the HMAC identity scheme, and that the idempotency key is tenant-scoped `(tenant, idempotency_key)`, a duplicate returns the existing `job_id`, and key TTL equals job TTL.

- [ ] **Step 5: Write `docs/ONBOARDING-local-dev.md`** — spec deliverable 4, which no other task produces.

For the frontend teammate: supported OS versions and the Node floor (`engines` says `>=22`); how to install the `.mcpb` into Claude Desktop; how to set `REMOTION_MCP_WORKSPACE` to an **absolute path with forward slashes** — the drive-relative form silently resolves against the current directory and the server refuses to start with a `ConfigError`; and where their own `audit.jsonl` lives.

Then an explicit **never** list: never commit a key or a `.env`; never run the service profile locally against the production socket; never point `REMOTION_MCP_WORKSPACE` at a directory containing anything they do not want a tool to read; never edit an accepted ADR; never add a tool to `src/service/registry.ts` without the absence suite passing. State that their local audit log is **never collected centrally** — it is theirs, on their machine, by design.

- [ ] **Step 6: Verify, then commit.**

---

## Milestones and what is not in this plan

| Date | Milestone | Tasks |
| --- | --- | --- |
| 2026-10-24 | Week 0 complete | T1, T2, T8 started |
| 2026-10-28 | **Project Plan due** | T4 (the ADRs) must be landed |
| 2026-11-07 | Profile separation proven | T3, T5, T6, T7, T9, T20 |
| 2026-11-21 | Deployed and measured | T10–T12, T14–T18 |
| 2026-11-24 | **Analysis due** | T19; writeup |
| ~2026-12-01 | **Walking skeleton** (team dependency) | this repo provides: gateway endpoint, one still template, `docs/CONTRACT-backend.md` |
| 2026-12-08 | **Design due** | `PossessionReplay`, `render_video_start`, `render_job_status` — **protected scope** |

**Not in this plan, deliberately:** OAuth 2.1 (Cut 2, deferred in ADR-0004 with compensating controls named); the resvg fork for local-dev (Cut 3 — ADR-0007 is service-profile only); the LiteLLM spike (dropped — the consolidation trigger is in ADR-0006); the `/mcp/remotion-viz` dashboard (on hold, its design preserved at `helpers/docs/DESIGN-gateway-reader.md`, and T19 produces its P1 content).

**The honest weakness, restated.** Nothing in these 19 tasks puts a person in front of `browser → API → Celery → gateway → service`. T16's verification uses a Celery **stub**. The walking skeleton at ~2026-12-01 is the first real exercise, and it depends on teammates' code that does not exist yet. T19's contract document is what this repo owes that milestone.

**Remotion licensing is an open risk, not a task.** The owner has read the current licence; this plan has not and marks it unverified. The clause that matters: automated programmatic rendering requires purchasing renders, and combined headcount counts collaborations — a 5-person team against a 3-employee free tier. An unfavourable answer does not change any task's code, but it changes whether this service may run at all. The email goes out in week 0.

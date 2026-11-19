# Service profile v2 — design

**Date:** 2026-10-26. **Status:** draft for owner approval.
**Supersedes, as a plan basis:** `docs/superpowers/plans/2026-10-17-tacticlens-service-profile.md`
and the design it argued from (`helpers/docs/DESIGN-tacticlens-service.md`, not in this repo).
The plan written from this design will be `docs/superpowers/plans/final_script.md`.

## 1. Why this exists, and what changed

The 2026-10-17 plan treated remotion-mcp's service profile as a TacticLens course
deliverable. It assumed:
- one hosted render service on one cloud VM
- a gateway in this repo, beside the service, on a unix socket
- exactly three principals
- the course calendar as its schedule

The owner has since ruled that this framing is wrong:

- **remotion-mcp is a general tool, not part of the ISE304 deliverables.** It
  serves several purposes: the group's TacticLens project, and the owner's
  personal projects.
- **Personal projects use the local-dev profile** (13 tools, stdio). It is
  already registered in the owner's Claude Code setup. Nothing about it changes
  here, except that it must not regress.
- **The service profile is a product other backends install.** The group runs
  it inside its own system, and another backend may run it too. This
  repository does not host anything.
- **One central gateway fronts every deployment.** The owner owns and controls
  it, and it is not in this repository. The owner grants each tenant permission
  and receives the audit envelopes.
- **The group's first real call is due 2026-11-20, and a single still is
  enough for it.** Video comes later.

### Owner rulings of 2026-10-26

These were chosen from options offered in chat:

1. **Isolation.** The service spawns the Remotion CLI directly, with no forked
   Node worker. This changes fixed constraint 6's "forked child" mechanism; its
   intent stays. The image must carry `setpriv` and `tini`. At startup the
   service checks that the installed Remotion renderer is at least 4.0.458.
2. **Output.** `render_still` returns the PNG inside the MCP response, under a
   size cap. There is no storage and no download token.
3. **Distribution.** This repository's CI publishes the service image to GitHub
   Container Registry, pinned by digest. Deployers build a small derived image
   that adds their template pack. Publishing is switched on only with the
   owner's approval.
4. **ADRs 0004, 0006 and 0007 are corrected before PR #18 merges.** They are
   not on `main` yet. Their text and Status lines are corrected together, and
   merging PR #18, after the owner reviews it, is the acceptance.
5. **"Done" on 2026-11-20 is a proof on the repository side.** A test signer in
   this repo, published test vectors and a locally built image together show,
   end to end, a signed request becoming a PNG. Two things are separate owner
   checkpoints, not on the critical path: the owner's real gateway, and
   publishing to GHCR.
6. **Network egress from renders is the deployer's control.** `docs/DEPLOY.md`
   makes it mandatory: the container has no outbound route, and cloud metadata
   is blocked. Templates must be self-contained, with fonts and images inside
   the pack and no web fonts. ADR-5's security claim is conditional on it.
7. **ADR-5 is accepted now, with a restated boundary.** A pack is code that a
   deployment's operator bakes into their own image. No tool accepts code with a
   request. A pack's risk belongs to the operator of the deployment that runs
   it. The ISE304 charter gate is dropped.
8. **The published image is linux/amd64 only.** arm64 can be added later.

## 2. What the spikes established (2026-10-25)

Four throwaway spikes ran, and each was re-checked by an independent agent. Their
evidence is the basis for the decisions below.

**Stateless MCP over TCP (SDK 1.30.0).**
- A fresh `McpServer` and a fresh transport per POST works with the real SDK
  client: initialize, tools/list and tools/call all succeed. Two concurrent
  calls overlap.
- The SDK does not enforce the initialize lifecycle in stateless mode.
- Without a pre-filter:
  - a GET opens a stream that never closes
  - a DELETE returns a silent 200
  - a JSON-RPC batch runs several tool calls under one HTTP request
- The SDK client opens that GET by itself after initialize, and it tolerates a
  405.
- In SSE mode the SDK sends a keep-alive every 15 s. In JSON mode it sends
  nothing at all until the result.
- The SDK client's default request timeout is **60 s**. After that the client
  gives up while the server keeps working.
- `notifications/cancelled` does nothing in stateless mode. Only a closed
  connection cancels.
- An HMAC identity check in the HTTP handler, before any server exists,
  refused all 12 forgery and replay cases. No tool ran for any of them.

**Killing a render tree on Linux.**
- Chrome leads its own process group. Killing the CLI's group takes Chrome
  down only when Remotion is ≥ 4.0.458, which wraps Chrome in
  `setpriv --pdeathsig SIGKILL`, and `setpriv` is on the PATH. With `setpriv`
  hidden, all five Chrome processes survived.
- On SIGTERM the CLI kills Chrome, but then usually does not exit. In the
  render phase it hung until SIGKILL in 4 of 4 re-check runs, so the SIGKILL is
  load-bearing.
- If SIGTERM arrives before Chrome's handler is registered, only pdeathsig
  kills Chrome. Without `setpriv`, Chrome leaked in 3 of 3 runs.
- An inherited environment marker cannot find Chrome, because Chrome rewrites
  its own `/proc/<pid>/environ`.
- A walk of parent pids from the CLI, taken before the kill, finds every Chrome
  process. Killing the groups it finds was not separately tested.
- Node as PID 1 leaves orphaned processes as zombies.

**Template schemas.**
- Remotion 4 projects resolve `zod` to **zod 4** (4.4.3, 4.5.4), not zod 3.
- On zod 4, `.refine` is a check inside a field, not a wrapper. The prototype
  gate still let `.refine` through on enum, literal and optional nodes, and the
  re-checker caught it.
- Converting zod 4 schemas to JSON Schema with the SDK's helper or with
  `zod-to-json-schema` silently drops every bound. zod 4's own `z.toJSONSchema`
  keeps them, and emits draft 2020-12.
- Remotion's render path does not appear to validate props. That was inferred
  from the code, not tested with a render.
- Remotion's own `zColor`, `zTextarea` and `zMatrix` helpers fail the gate.

**The service compile closure.**
- `tsconfig.service.json` must set `"include": []`. Without it, every tool
  module compiles in.
- The entry lands at `dist-service/service/index.js`.
- A check that "no emitted file contains a forbidden tool name" fails on a
  correct closure, because shared hint strings name local-dev tools.
- A check that reads `registerTool` and `.tool` call sites from the emitted
  syntax tree does tell a correct closure from a poisoned one.
- Type-only imports still emit their target modules.

## 3. Goals, non-goals, anti-goals

**Goals by 2026-11-20:**
1. A locally built service image, with a template pack added, returns a PNG
   from `render_still` for a request signed by this repo's test signer under
   the published contract (ruling 5).
2. The four forbidden tools are structurally absent from the service build, and
   the build proves it.
3. A render that hangs or crashes cannot leave processes behind, and cannot take
   the service down silently.
4. Props are validated against the template's published schema before anything
   renders.
5. The local-dev profile is unchanged, and `test/bundle.test.mjs` passes
   unedited.

**Owner checkpoints, not on the critical path:**
- the owner's gateway against the published test vectors
- enabling GHCR publishing

**Non-goals for 2026-11-20** (later work, not cut):
- `render_video_start` and `render_job_status` beyond a documented
  `not_implemented`
- the job store, idempotency, and enforcing the frame budget on video
- the sweeper and quotas
- the capacity benchmark harness
- audit reconciliation
- arm64

**Out of this repository entirely:**
- the gateway
- deploying, TLS termination and reverse proxies
- egress enforcement (ruling 6)
- monitoring and log shipping
- the football templates

**Anti-goals.** Any of these makes the work a failure, even if it technically
runs:
- A service image that renders but quietly lets a forged or replayed request
  through.
- A deployment that accumulates orphaned Chrome processes.
- A template contract that the backend can satisfy while the service rejects it,
  or the other way round.
- Anything that ships a key, a hostname or a tenant id in this public
  repository.

## 4. Constraints (owner, still binding)

- The engine stays domain-agnostic. The football templates live in
  `ISE304-project`, not here.
- The service profile is exactly four tools: `list_templates`, `render_still`,
  `render_video_start` and `render_job_status`.
- `viz_render_html`, `remotion_list_compositions`, `remotion_init_project` and
  `remotion_start_studio` are absent from the registration closure, not denied
  at runtime.
- Tenant identity comes from the authenticated principal, never from a tool
  argument.
- Audit records payload hashes and sizes only, never raw payloads.
- The image base is glibc (`node:22-bookworm-slim`), never Alpine.
- Keys never go into this repository.
- Accepted ADRs are never edited.
- Remotion's licence for this use is unverified in this repository.

## 5. The design

### 5.1 Topology

```
 TacticLens API / Celery (group)        other backend
            │                                 │
            └──────────► owner's gateway ◄────┘     (not in this repo)
                          │  auth, tenant grants, per-key limits,
                          │  response filter, envelope → owner
                          │  signs X-Render-Identity per deployment
              ┌───────────┴────────────┐
              ▼ HTTPS                  ▼ HTTPS
   deployment A (group's system)   deployment B
   deployer's TLS proxy            deployer's TLS proxy
   egress denied by deployer       egress denied by deployer
   service image + pack A          service image + pack B
```

The service speaks plain HTTP on a TCP port inside its deployment, and the
deployer terminates TLS in front of it. The service trusts a request only when
its identity header verifies, whatever network the request arrived from.

### 5.2 The request path inside the service

A `node:http` server handles each request in this order:

1. **Route and method.** Only `POST /mcp` passes. Any other method gets 405, and
   any other path gets 404.
2. **Raw body.** It is read under a cap (default 256 KiB) and counted as it
   arrives, so chunked bodies are capped too.
3. **Identity on raw bytes.**
   - **Checks:** the header parses, the signature matches, `aud` matches,
     `iat` and `exp` are acceptable, and `body_sha256` matches.
   - **On failure:** 401 with no detail. No server is created.
4. **Parse.** The body is parsed once, and an array body gets 400.
5. **Identity against the body.** `tool` and `request_id` must match the
   parsed body (5.3).
6. **Replay.** Only after every other check passes is `request_id` added to the
   seen set. A replay gets 401.
7. **Server.** A fresh `McpServer` is created, and the four tools are
   registered from the frozen `SERVICE_TOOLS`. The verified identity reaches
   the tools as `authInfo`.
8. **Transport.** A fresh `StreamableHTTPServerTransport` is connected
   (`sessionIdGenerator: undefined`, SSE response mode), and
   `handleRequest(req, res, parsedBody)` is called.
9. **Cancellation.** When `res` closes, the transport is closed. That aborts
   the tool's `AbortSignal`, which stops the render (5.6).

Health is not served over HTTP. The image's Docker `HEALTHCHECK` runs a small
in-container check against the process.

### 5.3 The identity header (contract with the owner's gateway)

**Format.** `X-Render-Identity` is
`base64url(claims) "." base64url(HMAC-SHA256(key, base64url(claims)))`.

**The claims** are a JSON object:

| Field | Meaning |
| --- | --- |
| `v` | contract version, `1` |
| `request_id` | gateway-minted, unique |
| `principal` | the gateway's key id for the caller |
| `tenant` | a tenant id the owner granted |
| `aud` | the deployment id this request is for |
| `tool` | `params.name` for `tools/call`, otherwise the JSON-RPC method |
| `body_sha256` | hex SHA-256 of the exact body bytes forwarded |
| `iat`, `exp` | seconds since the epoch |

**The service refuses a request** unless all of these hold:
- the signature matches its key (compared with `timingSafeEqual`)
- `aud` equals its deployment id
- `now` is within `[iat − skew, exp + skew]`, with skew defaulting to 30 s
- `exp − iat` is at most 120 s
- `iat` is no earlier than the service's own start time minus skew
- `body_sha256` matches
- `tool` matches the body
- `request_id` equals `params._meta["io.github.curasinan/request_id"]`
- that `request_id` has not been seen within the window

The start-time rule exists because the seen set lives in memory. Without it, a
restart would reopen the replay window. The cost is that requests signed just
before a restart are refused for about one skew interval.

**Deployments.** A deployment runs **one replica per `aud`** and is rolled out
with Recreate, never with surge.

**Keys.** Each deployment has its own HMAC key, so a deployment's operator
cannot forge requests to another deployment. Keys come from the environment
only.

**Child processes.** Children are spawned with an allowlisted environment:
PATH, HOME and the Remotion and Chrome variables. Neither key is passed on.
Because the children run as the service's uid, they could still read the
service's own environment through `/proc`. That residual is accepted, because
the pack is operator-baked code (ruling 7).

**What the gateway must do.** These are transport obligations the spikes showed
are required:
- inject `_meta` into every message it forwards, initialize and notifications
  included, and sign the rewritten bytes
- forward the body bytes unchanged
- forward `accept` with both `application/json` and `text/event-stream`
- forward `content-type: application/json`
- send no `mcp-protocol-version`, or one the service's SDK supports
- not buffer SSE
- use upstream timeouts of at least 60 s
- close the upstream connection when its caller disconnects

**Ignored fields.** A tenant or team field in `_meta` or in tool arguments has
no effect, and is recorded as a protocol violation.

This repo ships a **test signer** (`scripts/sign-identity.mjs`) and **test
vectors** (`test/vectors/identity-v1.json`): valid, forged, expired, wrong-aud,
body-tampered and replayed cases, with the exact bytes. The owner's gateway can
check itself against them.

### 5.4 Template packs

**What a deployer's derived image contains:**
- `pack-manifest.json`:
  `{ packHash, remotionVersion, templates: [{ id, compositionId, width, height, defaultFps, maxFrames, propsSchema }] }`.
  `propsSchema` is a JSON Schema (draft 2020-12), exported with the pack's own
  zod 4 `z.toJSONSchema`.
- `bundle/`, a prebuilt Remotion bundle, so a still never pays for bundling.
- `package.json` and the lockfile. A Linux build stage of the derived image runs
  `npm ci --omit=dev`, so native packages match the image. The runtime stage
  receives the resulting `node_modules` and has no `npm`. A pack never ships a
  `node_modules` built on Windows or macOS.
- Chrome Headless Shell, installed at a fixed path with `remotion browser ensure`
  in that same Linux stage, with runtime download disabled.

**`scripts/build-pack.mjs`.** This repo provides it, and it runs in a Remotion
project:
1. It bundles the project.
2. It loads the schemas through the project's own esbuild.
3. It discovers compositions. If it finds none, it fails.
4. It runs the **zod gate**. Only zod 4 schemas are accepted; a zod 3 schema is
   refused with a clear message.
5. It exports and writes the manifest.
6. It checks that every bound the gate accepted appears in the exported JSON
   Schema, and fails if one is missing.

The discovery limits are untested: `<Folder>`, hooks, module-scope font loading
and pnpm layouts.

**The zod gate** reads the checks of every node type.
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

The authoring guide gives replacements for `zColor`, `zTextarea` and `zMatrix`.

**The JSON Schema gate at service startup** applies to every `propsSchema` the
service loads. The service refuses to start on a pack that fails it, because it
cannot trust that the deployer ran the build gate.
- every object has `additionalProperties: false`
- every array has `maxItems`
- no `format` is `uri` or `email`
- every string has `maxLength`, **unless** it is an `enum` or a `const`
- every number has a lower bound and an upper bound. `exclusiveMinimum` and
  `exclusiveMaximum` count.

**At request time** props are validated with **ajv** (`ajv/dist/2020`) against
`propsSchema`, so no zod runs inside the service. `list_templates` returns each
template's `propsSchema`. The backend validates against that same published
JSON Schema, so there is one contract.

**Composition size.** Compositions may compute their size at render time with
`calculateMetadata`. The service always passes the manifest's width, height and
frame to the CLI explicitly, so the pre-render checks hold.

**The Remotion version check** reads the *installed*
`node_modules/@remotion/renderer/package.json`. It also requires
`dist/linux/wrap-with-setpriv.js` to exist. The declared range in `package.json`
is never used.

**Fixture pack.** This repo ships a domain-agnostic fixture pack, `Swatch`: a
still with a text label. It includes a Turkish-glyph prop. Its build runs in a
Linux CI job.

### 5.5 The four tools

**`list_templates`** returns, for each template, its `id`, `width`, `height`
and `propsSchema`.

**`render_still`** takes `{ template_id, frame?: int, props: object }` with a
strict schema.

1. **Checks.** It checks that:
   - the template exists
   - `frame < maxFrames`
   - `width × height` is within the raster bound
   - the props validate
2. **Slot.** It takes a render slot from a global count (default 2). If none is
   free, it refuses with `render_busy`. There is no queue in the service, and
   the SDK's `cliLimiter` is not used.
3. **Render.** It runs `remotion still` on `bundle/` through the
   **service-owned spawner** (5.6). The output path is minted by the service,
   the browser executable is pinned, and width, height and frame are passed
   explicitly.
4. **Deadline.** It has 45 s (`RENDER_STILL_DEADLINE_MS`). At the deadline it
   returns `render_timeout` at once, and finishes the kill in the background
   while the slot stays held.
5. **Output.** It returns the PNG as MCP image content, up to 4 MiB, then deletes
   the file.

The 45 s deadline leaves room within the SDK client's 60 s default for the hops
and the error path.

**`render_video_start` and `render_job_status`** are registered and return a
documented `not_implemented`.

**Errors.** Every error a caller sees is a category and a fixed message. A caller
never sees:
- a filesystem path
- a local-dev tool name
- a raw zod or ajv message

### 5.6 Isolation and cleanup

**The spawner.** The service has its own spawner, `src/service/render-process.ts`.
- It reuses only `killTree` from `exec.ts`.
- It does not go through `runCommand` or `cliLimiter`, and local-dev code is
  not changed.
- It takes an `AbortSignal`, spawns the CLI detached (so the CLI leads its own
  process group), and records the CLI's pid.

**Stopping a render.** On deadline, abort or shutdown:
1. Walk `/proc` from the CLI's pid to record every descendant and its process
   group.
2. Send SIGTERM to the CLI's group and to every recorded group.
3. Send SIGKILL to all of them 5 s later.
4. Poll, to a deadline, until every recorded pid has exited.

**Which part carries the guarantee.** `setpriv`'s pdeathsig is what reliably
kills Chrome. The `/proc` walk is defence in depth. A test hides `setpriv` from
PATH and asserts that the walk alone leaves no `chrome-headless-shell` behind.

**If cleanup cannot be verified,** the service logs it, marks itself unhealthy,
and exits non-zero. The container restarts and takes every leftover process
with it. `DEPLOY.md` requires a restart policy.

**Startup checks.** The service refuses to start unless:
- `setpriv` is on PATH
- the installed renderer is ≥ 4.0.458 and has the setpriv wrapper
- the pinned browser **runs** (`--version` succeeds), which proves its shared
  libraries are present
- the pack passes the JSON Schema gate

**The process tree.** The image runs under `tini` as PID 1, so orphans are
reaped. The container's memory limit is the outer backstop.

The service process runs no native code on the still path: no resvg and no
puppeteer. A crash inside the CLI or Chrome becomes a `render_failed` tool error.

### 5.7 The build and its proofs

**`tsconfig.service.json`:**

```
files:        ["src/service/index.ts"]
include:      []
noEmitOnError: true
outDir:       dist-service
```

The entry is `dist-service/service/index.js`.

**The `project-shape.ts` split.** `findEntryPoint` and the project-shape
helpers move out of `environment.ts` into a leaf module. `src/service/` must
not import `environment.ts` or `browser.ts`. The expected result is that the
service closure loses `browser.ts` and its non-literal `import(...)`. The
dependency check below proves it.

**The absence suite on `dist-service/`:**
- **AST check.** It reads every `registerTool` and `.tool` call site. It allows
  only the one loop in `service/registry.js`. It flags any non-literal name and
  any non-call reference to `registerTool`, such as an alias, `.bind` or
  destructuring. It requires zero forbidden names.
- **Module check.** No file from `tools/*`, `raster`, `tile`, `network`,
  `visualize`, `studio` or `compare` is present.
- **Dependency check.** There is no `@resvg/resvg-js` or `puppeteer-core`
  specifier, and no non-literal `import()`.
- **Live check.** A live `tools/list` returns exactly the four tools.
- **Poisoned build control.** A type-only import of `tools/project.js` must
  fail the AST check and the module check.
- **Poisoned registry control.** A fifth tool must fail the registry check and
  the live check.

**The stdio side.** `test/bundle.test.mjs` is never edited, and it keeps
passing.

### 5.8 Audit inside a deployment

The service writes its own events as JSONL, to a path the deployer chooses.
- **What it records:** request id, principal, tenant, tool, outcome, category
  and duration.
- **Hashes:** keyed SHA-256 hashes and sizes of the params and the result,
  using `AUDIT_HMAC_KEY`.
- **What it never records:** payloads, verbatim error messages, or raw
  argument values.

The service has its own wrapper for this. The local-dev `safeHandler` is left
alone.

The owner's envelope comes from the gateway. Joining the two logs is later
work, and needs the deployer to ship the service log.

### 5.9 The published image

`Dockerfile.service` is multi-stage, on `node:22-bookworm-slim`, linux/amd64.

- **Build stage.** It compiles `dist-service/`.
- **Runtime stage.** It contains:
  - the service
  - `tini`
  - util-linux `setpriv`
  - Chrome Headless Shell's shared libraries (libnss3, libnspr4, libasound2,
    libgbm1, libxkbcommon0, libdbus-1-3, libatk-bridge2.0-0, libcups2,
    libpango-1.0-0, libcairo2)
  - a pinned Latin-Extended font (a Noto family)
  - no `npm`

**Publishing.** CI publishes the image to GHCR by digest from protected `main`,
once the owner enables it.

**`docs/DEPLOY.md`** gives the derived-image recipe:
- a Linux stage that runs `npm ci` and `remotion browser ensure` for the pack
- egress denied (ruling 6)
- a restart policy
- Recreate rollout
- the environment: `SERVICE_PORT`, `SERVICE_AUDIENCE`, `IDENTITY_HMAC_KEY`,
  `AUDIT_HMAC_KEY` and `AUDIT_LOG_PATH`

**Golden-image test.** Inside the image, a test renders the Turkish-glyph
fixture and compares it against a render with the font package removed.

## 6. The ADR set after this design

**ADR-4** keeps two things: the two profiles, and the verified stdio guarantee.
It changes three:
- The unix socket becomes a TCP listener behind the deployer's TLS.
- The identity header becomes the trust boundary.
- One central gateway, outside the repository, fronts many deployments.

**ADR-5** keeps structural separation, and is **Accepted** with the boundary in
ruling 7. It records:
- the pack format: a prebuilt bundle, JSON Schema, and a Linux `npm ci`
- the two gates
- ajv validation
- the AST absence suite
- egress as the deployer's control

**ADR-6** becomes "the service trusts only the owner's gateway". The gateway is
the owner's private component. This ADR specifies:
- what the service enforces (5.2, 5.3)
- the gateway's transport obligations
- what is left to the gateway: keys, tenant grants, per-key limits, the response
  filter and the envelope

Limb 2 of ADR-2's trigger is now met by the tenants the owner grants.

**ADR-7** becomes "spawn the CLI directly, and kill every group it creates". It
records:
- the owner's change to fixed constraint 6
- the `setpriv`, `tini` and installed-renderer ≥ 4.0.458 requirements
- the exit-on-unverified-cleanup rule

It keeps the pixel-cap clause, which now concerns only local-dev.

The corrected text replaces what PR #19 merged into `build/exclude-service-tree`.
Status lines are set together with the content.

## 7. Left to the builder

- exact names of environment variables, error categories and file paths
- default sizes: the body cap, the PNG cap, the slot count and the skew
- the ajv configuration
- the in-container health check script
- the exact Chrome library list, confirmed by the startup `--version` check

## 8. Calls made without the owner (check these)

1. **Contract names.** The header is `X-Render-Identity` and the `_meta` key is
   `io.github.curasinan/request_id`. They are neutral, and replace the
   TacticLens-specific `X-TL-Identity` and `tacticlens/request_id`.
2. **TLS.** The service speaks plain HTTP. TLS is the deployer's job, and mTLS
   is not required.
3. **Replicas and replay.** One replica per deployment id, with Recreate
   rollout. Tokens signed before the service started are refused.
4. **Timing and capacity.** A 45 s still deadline that returns at once on
   timeout, and a global slot count of 2 that refuses rather than queues.
5. **What a pack brings.** Each pack image brings its own Remotion CLI and
   Chrome, through a Linux `npm ci`. The base image does not pin a Remotion
   version.
6. **zod 4 only.** `build-pack` accepts only zod 4 schemas, which is what every
   Remotion 4 project observed uses.
7. **The `project-shape.ts` split** is done now.
8. **Audit location.** The service's audit stays on the deployment for now.
9. **Unverified cleanup** makes the service exit non-zero, and its container
   restarts.
10. **No HTTP health endpoint.** A Docker `HEALTHCHECK` runs inside the
    container instead.
11. **One contract for the backend.** The backend validates against the
    published JSON Schema, which `list_templates` exposes.
12. **The service owns its spawner.** Local-dev's `runCommand` and `cliLimiter`
    stay as they are.

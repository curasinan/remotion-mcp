# ADR-4: HTTP transport for the service profile; the .mcpb stays stdio only

**Status:** Accepted

**Relation:** Partly supersedes [ADR-1](0001-transport-stdio-only.md)

## Context

The TacticLens project needs a render service its backend can call over a
network. The owner's fixed constraints of 2026-10-17 say who calls it. They are
not committed anywhere else, so the clauses this ADR rests on are quoted here:

> 1. Exactly three principals: (a) the owner via Claude Code, local stdio;
>    (b) one frontend teammate via Claude Code, local stdio, installs the .mcpb;
>    (c) the TacticLens backend (Celery workers) over HTTP through the gateway.
>    The browser NEVER calls the render service directly.
> 2. Two tool profiles.
>    - local-dev: the current 13 tools, stdio only, never deployed to cloud.
>    - service: ONLY list_templates, render_still, render_video_start,
>      render_job_status. [...]
>
> [...]
>
> 4. Deployed to a cloud provider (course requirement). spark (DGX Spark,
>    linux-arm64) is NOT the render host.

Principal (c) needs HTTP, which ADR-1 removed. ADR-1 numbers only its Options,
so the clause reversed here is cited by that number and by line. ADR-1 adopted
**Option 1** (`0001-transport-stdio-only.md:24-25`):

> 1. **Keep stdio, remove HTTP.** Surface stays at the process boundary; loses
>    claude.ai web/mobile.

Its §Decision enacts it (`:33-34`):

> Option 1. `src/transports/` is removed, along with the `MCP_TRANSPORT` branch
> and `MCP_HTTP_*` variables.

The first §Consequences bullet (`:38-40`) follows from Option 1, and it is
reversed too, for the service profile only:

> Authentication leaves the picture entirely: OAuth 2.1, token audience,
> passthrough ban, origin checks, DNS-rebinding defence and rate limiting are
> all moot and none are built.

## What of ADR-1 still binds

- **Option 1 still governs `dist/` and the `.mcpb` on both laptops, and always
  will.** The local-dev profile stays stdio-only and is never deployed to a
  cloud (fixed constraint 2). It keeps `StdioServerTransport`
  (`src/index.ts:87`) as its only transport, and nothing this ADR adds is
  reachable from its module graph.
- **The decision criterion** (`:17-20`). It says the transport question "is
  whether the attack surface stays behind a single trusted client. [...] Over
  HTTP the thing that can reach it is the network, and the only thing in
  between is a bearer token." For the service profile, a bearer token is no
  longer the only thing in between; see Decision.
- **The severity rule** (`:44-45`): "The same defect is not worth the same over
  the two transports." It applies to every finding against the service profile.
- **The claude.ai consequence** (`:49-50`). It is not reversed: no claude.ai
  connector returns, and principal (c) is the TacticLens backend.

## Decision

The decision is ADR-1's Option 3 (`:28-29`), which ADR-1 declined on
maintenance cost:

> 3. **Keep HTTP but exclude it from the production bundle.** Two build
>    variants, ongoing maintenance.

That means two composition roots, two TypeScript projects, two build outputs
and two artifacts:

| | local-dev | service |
| --- | --- | --- |
| entry | `src/index.ts` → `dist/` | `src/service/index.ts` → `dist-service/` |
| transport | stdio | streamable HTTP, stateless |
| artifact | the `.mcpb` | a container image, never the `.mcpb` |
| tools | 13 | 4 ([ADR-5](0005-tool-profiles-and-template-packs.md)) |

### The service listens on a unix domain socket, with no TCP listener

A `node:http` server is bound to the socket path. It answers every HTTP method
other than POST with 405, before it creates anything.

For each POST it creates a fresh `McpServer`, registers the four tools on it,
and connects it to a fresh SDK streamable-HTTP transport with
`sessionIdGenerator: undefined`. That gives:
- no `Mcp-Session-Id` and no session affinity
- no standalone server-to-client stream, because GET is refused

The GET refusal is needed because stateless mode alone does not prevent the
stream. SDK 1.30.0 skips session validation when `sessionIdGenerator` is unset
(`dist/esm/server/webStandardStreamableHttp.js:725-730`), and it dispatches GET
to its stream handler (`:186-187`).

Notifications that belong to a request travel on that request's own response
in SSE mode, which is the SDK default (`:73`). In JSON response mode they are
not sent.

A fresh server and a fresh transport are both needed per request, because SDK
1.30.0 refuses both kinds of reuse:
- a stateless transport that has already handled a request
  (`webStandardStreamableHttp.js:172-175`)
- a server that is already connected to a transport
  (`dist/esm/shared/protocol.js:217`)

**This amends plan Task 6 Step 4.** That step constructs one transport
"listening on the unix socket path" and calls `registerServiceTools` once. A
transport does not listen, and one long-lived server would fail on the second
concurrent request.

### Who can connect

`connect()` needs write permission on the socket file. The service creates the
socket, so the service's uid owns it. A plain `0600` socket would refuse a
gateway running as another user, and handing the file to the gateway's uid
needs privilege the service should not have.

The form that works has two parts:
- **The socket:** mode `0660`, with a group that only the gateway and the
  service share.
- **Its directory:** owned by the service's uid and that group, at mode `2750`.
  The file mode and the directory both govern `connect()`. A uid outside the
  group has no search permission on a `2750` directory, so it cannot reach the
  socket whatever the socket's own mode is. The directory's write bit, which
  only the service's uid holds, governs who can unlink the socket and bind an
  impostor in its place.

The service binds inside that directory, so the moment between `bind()` and
setting the mode exposes nothing to a uid outside the group.

**This amends plan Task 16 Step 2,** which says `0600`. Task 16 must also show
that a third uid on the host is refused.

**What this does not cover.** Every process the service starts runs as the
service's uid, and so can connect too. That covers its render workers, the
Remotion CLI, Chrome, and the pack code they run.

**They also start with the service's whole environment,** including
`TL_IDENTITY_HMAC_KEY` (ADR-6). ADR-7's fork sets no `env`, so the worker gets
`process.env`. `runCommand` then spawns the CLI with
`{ ...process.env, CI: "1", ...env }` (`src/services/exec.ts:73`). Even a child
forked with a scrubbed environment could read the service's own environment
through `/proc`, because it runs as the same uid. So code that runs inside a
render can do whatever the service can.

That is acceptable only because the pack is code the operators chose to bake
(ADR-5). Closing the gap would take two things:
- render children under a uid of their own
- a child environment built from an allowlist instead of inherited

A uid alone would still hand the key to every render. Switching uid needs
privilege the service should not have, so it would take a separate launcher.
No plan task does any of this.

### Where it runs

- **The public endpoint is Caddy, then the gateway, never the service.** The
  gateway is [ADR-6](0006-gateway-for-the-service-profile.md).
- **x86-64 glibc at a cloud provider,** on `node:22-bookworm-slim`.
- **Never Alpine.** Every Linux native target this project ships and tests is
  glibc: `scripts/build-bundle.mjs:63-65` keeps resvg's musl entries disabled.
  v1.2.1 shipped an accidental musl binary.
- **The demo fallback runs the same x86-64 image on the owner's laptop.** spark
  is not a render host, as primary or as fallback. That reads fixed constraint 4
  as covering the fallback too, and **it settles plan Task 15 Step 5 as option
  (a).**

### The stdio guarantee is verified, not intended

PR #18 (plan Task 1) added `src/service/**` and `gateway/**` to
`tsconfig.json`'s `exclude` before any service code existed. Without it,
`include: ["src/**/*"]` compiles `src/service/` into `dist/`, and
`scripts/build-bundle.mjs:269` copies `dist/` into the `.mcpb` wholesale.

Both halves were watched locally:
- **No exclusion.** A planted `src/service/index.ts` constructed
  `StreamableHTTPServerTransport`. `test/bundle.test.mjs:236` ("the server
  ships no HTTP transport") then failed on `server/service/index.js`.
- **Exclusion added.** With the planted file still present, all 12 bundle
  assertions passed.

Separately, CI on PR #18 ran the same 12 assertions with `REQUIRE_BUNDLE=1`
against the committed tree, which has no service code, and they passed.

`test/bundle.test.mjs` is not rescoped, weakened or deleted, by this ADR or a
later one. That it keeps passing unmodified is the evidence that this ADR did
not widen the laptop artifact.

`gateway/**` is defence in depth. `include` is `src/**/*` and `rootDir` is
`./src`, so tsc compiles no `gateway/` file even without it.

### OAuth 2.1 is deferred, not absent

ADR-1's Option 2 (`:26-27`) names the bill for exposing this server over HTTP:
"OAuth 2.1, token audience validation, a passthrough ban, rate limiting and
per-request audit". Its first Consequences bullet adds origin checks and
DNS-rebinding defence. For three fixed principals with pre-shared keys, each
item is paid as follows:

| ADR-1 item | How the service profile pays it | Built by, as of 2026-10-17 |
| --- | --- | --- |
| OAuth 2.1 | **Deferred.** A pre-shared 256-bit key per principal, held as a SHA-256 hash from the environment, compared with `crypto.timingSafeEqual`, over TLS | plan Tasks 8, 16; no plan task fixes the key length or how keys are minted |
| Token audience | One audience: the keys are minted for this gateway alone | by construction |
| Passthrough ban | The gateway never forwards the caller's key; it mints its own signed identity (ADR-6) | no plan task tests it yet |
| Rate limiting | Per-key limits at the gateway, and per-principal render slots in the service (ADR-6, [ADR-7](0007-process-isolation-for-rendering.md)) | **no plan task yet** |
| Per-request audit | The gateway's envelope (ADR-6) | plan Task 9 for calls that reach the service; refused calls have no plan task yet |
| Origin checks, DNS rebinding | The service has no TCP listener. Every MCP request to the gateway needs a bearer key, which a browser never attaches on its own, so a rebound or cross-site request gets 401. Plan Task 17's health endpoint is the exception, and nothing yet says whether it needs a key | plan Tasks 6, 8; the health endpoint has no plan task for this |

The deferral expires when a fourth principal appears, or when any principal
appears that the owner does not control.

That a browser never calls the service (fixed constraint 1) is a property of
the TacticLens architecture, where only Celery workers hold the backend key.
This repository does not enforce it.

## Consequences

- **The service build loads hono; the stdio build still does not.** SDK
  1.30.0's Node transport imports `@hono/node-server`
  (`dist/esm/server/streamableHttp.js:9`), which loads `hono`. That is the
  dependency ADR-1 named when it measured the stdio graph dropping from 15
  resolved packages to 12.
  - The load is confined to `dist-service/`.
  - The packages are already on disk in the `.mcpb`, as SDK dependencies.
    Nothing in the stdio graph loads them, and ADR-1 measured that graph.
  - Plan Task 6 may use `WebStandardStreamableHTTPServerTransport` instead,
    which imports no hono.
- **Long requests are unmeasured.** `render_still` holds a POST open for the
  whole bundle and render. Whether bytes flow meanwhile depends on SSE versus
  JSON response mode, and on every hop forwarding a stream. No plan task does
  either of the two things this needs:
  - a measurement through Caddy and the gateway
  - a documented synchronous ceiling for `render_still`

  There is no asynchronous tool for stills, so a still that cannot finish
  under the ceiling fails rather than being deferred to a job. It fails as a
  timeout, not a refusal, because nothing predicts a still's duration at
  admission. If the ceiling is the child's deadline, the error is ADR-7's
  `render_timeout`.
- **Two build variants is a maintenance cost.** ADR-1 declined Option 3 for
  that reason, and it is accepted here. The absence suite (plan Task 7) is what
  will keep the two from silently converging, once it checks modules as well as
  names (ADR-5, closure requirement 4).
- **Remotion's licence is unverified in this repository.** The owner has read
  the current text and is asking Remotion for written confirmation. An
  unfavourable answer could stop the service profile from running at all. No
  technical decision in this ADR depends on it.
- **Stale readers.** These still describe the whole project as stdio-only and
  need scoping to the local-dev profile:
  - `README.md:226-227`
  - `site/index.html:7`, `:126-127` and `:167-169`
  - `docs/GATEWAY.md:80-81`

  `site/index.html:164` is stale for a different reason: it says "Three
  architecture decision records carry the reasoning", and there are now seven.
  `site/` publishes to GitHub Pages. These edits are follow-ups and are not
  made here.

**Reversal cost: medium.** Reverting deletes `src/service/`,
`tsconfig.service.json` and the image. The leaf modules that plan Tasks 3 and 5
extract change no behaviour, so they would stay.

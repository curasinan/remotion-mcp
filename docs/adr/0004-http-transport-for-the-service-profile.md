# ADR-4: HTTP transport for the service profile; the .mcpb stays stdio only

**Status:** Accepted

**Relation:** Partly supersedes [ADR-1](0001-transport-stdio-only.md)

## Context

The service profile is a render service that backends install and call over a
network. The group's TacticLens backend is the first of them. This ADR follows
the owner's rulings of 2026-10-26, which are §1 of the
[v2 design](../superpowers/specs/2026-10-26-service-profile-v2-design.md). The
numbered rulings are cited here by number. The unnumbered ones in the same
section are cited as design §1.

The owner's fixed constraints of 2026-10-17 say who calls the service. They are
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

Two things moved on 2026-10-26 (design §1). The service profile is now a
product that other backends install and run in their own systems, and the
TacticLens group is one deployer among them. The gateway in constraint 1 is one
central gateway that the owner controls, and it is outside this repository.
This repository hosts nothing, so constraint 4's cloud provider is a deployer's
choice.

Principal (c), and any backend that installs the service, needs HTTP, which
ADR-1 removed. ADR-1 numbers only its Options, so the clause reversed here is
cited by that number and by line. ADR-1 adopted **Option 1**
(`0001-transport-stdio-only.md:24-25`):

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
  longer the only thing in between: a signed identity header is. See Decision.
- **The severity rule** (`:44-45`): "The same defect is not worth the same over
  the two transports." It applies to every finding against the service profile.
- **The claude.ai consequence** (`:49-50`). It is not reversed: no claude.ai
  connector returns. The service's callers are backends, reached through the
  owner's gateway.

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
| transport | stdio | streamable HTTP, stateless, on a TCP port |
| artifact | the `.mcpb` | a container image, never the `.mcpb` |
| tools | 13 | 4 ([ADR-5](0005-tool-profiles-and-template-packs.md)) |

### The service listens on a TCP port, behind the deployer's TLS

A `node:http` server is bound to a TCP port. It speaks plain HTTP inside its
deployment, and the deployer terminates TLS in front of it. The service does not
take a request's network of origin as a reason to trust it. It trusts a request
only when the request's identity header verifies (below).

Only `POST /mcp` passes. Any other method gets 405 and any other path gets 404,
before anything is created. The service serves no health endpoint over HTTP; the
image's Docker `HEALTHCHECK` checks the process from inside the container.

For each POST it creates a fresh `McpServer`, registers the four tools on it,
and connects it to a fresh SDK streamable-HTTP transport with
`sessionIdGenerator: undefined`. That gives:
- no `Mcp-Session-Id` and no session affinity
- no standalone server-to-client stream, because GET is refused

The refusals are needed because stateless mode alone prevents none of these
(spikes of 2026-10-25, design §2):
- a GET opens a stream that never closes
- a DELETE returns a silent 200
- a JSON-RPC batch runs several tool calls under one HTTP request

The service answers the first two with 405, and an array body with 400. SDK
1.30.0 skips session validation when `sessionIdGenerator` is unset
(`dist/esm/server/webStandardStreamableHttp.js:725-730`), and it dispatches GET
to its stream handler (`:186-187`). The SDK client opens that GET by itself
after initialize, and it tolerates a 405.

Notifications that belong to a request travel on that request's own response
in SSE mode, which is the SDK default (`:73`), and the service uses it. In JSON
response mode they are not sent. SSE mode also sends a keep-alive every 15 s,
where JSON mode sends nothing at all until the result.

A fresh server and a fresh transport are both needed per request, because SDK
1.30.0 refuses both kinds of reuse:
- a stateless transport that has already handled a request
  (`webStandardStreamableHttp.js:172-175`)
- a server that is already connected to a transport
  (`dist/esm/shared/protocol.js:217`)

**Cancellation.** When the response closes, the service closes the transport.
That aborts the tool's `AbortSignal`, which stops the render (ADR-7). A
`notifications/cancelled` message does nothing in stateless mode, and only a
closed connection cancels. So every hop between a caller and the service must
pass a disconnect on (ADR-6).

### The identity header is the trust boundary

The service refuses every request whose `X-Render-Identity` header does not
verify. The header is an HMAC-SHA256 over claims that bind a request to one
deployment, one tool, one body and a short time window. The service checks it
against the raw body bytes, before it parses anything and before any
`McpServer` exists. A failure is a 401 with no detail, and no tool runs.
[ADR-6](0006-gateway-for-the-service-profile.md) specifies the header and the
full list of refusals.

Each deployment has its own key, from the environment only. An operator of one
deployment cannot forge a request to another. The spike ran an HMAC check in
the HTTP handler, ahead of any server, against 12 forgery and replay cases. It
refused all 12, and no tool ran for any of them (design §2).

**What this does not cover.** Every process the service starts runs as the
service's uid. That covers the Remotion CLI, Chrome, and the pack code they run.

The service spawns them with an allowlisted environment: `PATH`, `HOME` and the
Remotion and Chrome variables. Neither HMAC key is passed on. Even so, a child
could read the service's own environment through `/proc`, because it runs as
the same uid. So code that runs inside a render can do whatever the service can.

That is acceptable only because the pack is code its operator chose to bake
(ADR-5, owner ruling 7). Closing the gap would take render children under a uid
of their own. Switching uid needs privilege the service should not have, so it
would take a separate launcher. Nothing in the design does this.

### Where it runs

- **The deployer runs it.** This repository hosts nothing (design §1). The
  deployer terminates TLS, and denies the container egress (ADR-5, owner
  ruling 6).
- **x86-64 glibc,** on `node:22-bookworm-slim`. The published image is
  linux/amd64 only (owner ruling 8). arm64 can be added later. Constraint 4
  keeps spark, which is linux-arm64, from being a render host.
- **Never Alpine.** Every Linux native target this project ships and tests is
  glibc: `scripts/build-bundle.mjs:63-65` keeps resvg's musl entries disabled.
  v1.2.1 shipped an accidental musl binary.
- **Distribution.** This repository's CI publishes the image to GitHub
  Container Registry, pinned by digest, once the owner enables it (owner
  ruling 3). A deployer builds a small derived image that adds their template
  pack (ADR-5).

### One gateway, outside this repository, fronts many deployments

The owner owns and controls one central gateway (design §1). It is not in this
repository. It authenticates callers, applies the owner's tenant grants, and
signs one identity header per deployment. It reaches each deployment over HTTPS
through that deployer's TLS proxy. This repository specifies the contract the
gateway signs to (ADR-6) and ships a test signer and test vectors for it. It
does not ship a gateway.

**Considered and not chosen: a unix domain socket.** A socket makes file modes
the access control, which works when the gateway and the service share a host
and a group. One central gateway and several deployments run by different
operators share neither. A signed header can cross the network between them, and
file modes cannot.

### The stdio guarantee is verified, not intended

PR #18 added `src/service/**` to `tsconfig.json`'s `exclude` before any service
code existed. It added a second pattern, `gateway/**`, that no longer names
anything in this repository, because the gateway is outside it.
`test/profiles.test.mjs` asserts both exclusions.

Without the exclusion, `include: ["src/**/*"]` compiles `src/service/` into
`dist/`, and `scripts/build-bundle.mjs:269` copies `dist/` into the `.mcpb`
wholesale.

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

### OAuth 2.1 is deferred, not absent

ADR-1's Option 2 (`:26-27`) names the bill for exposing this server over HTTP:
"OAuth 2.1, token audience validation, a passthrough ban, rate limiting and
per-request audit". Its first Consequences bullet adds origin checks and
DNS-rebinding defence. Callers authenticate to the owner's gateway, and the
service authenticates the gateway. Each item is paid as follows:

| ADR-1 item | How the service profile pays it | Specified in |
| --- | --- | --- |
| OAuth 2.1 | **Deferred.** The service has no caller credentials of its own. It verifies an HMAC identity header from the gateway, with a key per deployment, compared with `crypto.timingSafeEqual` | design §5.3; ADR-6 |
| Token audience | The `aud` claim names one deployment, and the service refuses any other | design §5.3 |
| Passthrough ban | The service accepts only a header signed for its own deployment, and it holds no caller credential to pass on | ADR-6 |
| Rate limiting | Per-key limits at the owner's gateway. In the service, a global count of render slots that refuses at once when none is free | ADR-6; [ADR-7](0007-process-isolation-for-rendering.md) |
| Per-request audit | The owner's envelope at the gateway, and the service's own hash-only audit log | design §5.8; ADR-6 |
| Origin checks, DNS rebinding | A browser holds no key. A rebound or cross-site request cannot carry a header that verifies against its own body, so it gets 401. The service also refuses GET | design §5.2 |

The deferral expires when anything other than the owner's gateway has to reach a
deployment, or when a deployment has to trust more than one issuer of identity
headers.

That a browser never calls the service (fixed constraint 1) is a property of the
callers' architecture. This repository does not enforce it, and does not rely on
it: the header check refuses a browser's request whatever its origin.

## Consequences

- **The service build loads hono; the stdio build still does not.** SDK
  1.30.0's Node transport imports `@hono/node-server`
  (`dist/esm/server/streamableHttp.js:9`), which loads `hono`. That is the
  dependency ADR-1 named when it measured the stdio graph dropping from 15
  resolved packages to 12.
  - The load is confined to `dist-service/`.
  - The packages are already on disk in the `.mcpb`, as SDK dependencies.
    Nothing in the stdio graph loads them, and ADR-1 measured that graph.
  - The design connects the Node transport (design §5.2).
    `WebStandardStreamableHTTPServerTransport` imports no hono, if that cost
    ever matters.
- **A long request meets a 60 s client default.** `render_still` holds a POST
  open for the whole render. The SDK client's default request timeout is 60 s,
  and after it the client gives up while the server keeps working. So the
  service enforces its own deadline of 45 s and answers `render_timeout` at once
  (ADR-7), which leaves room within 60 s for the hops and the error path.
  - The spikes measured this against the SDK client (design §2).
  - The deployer's TLS proxy is one more hop. This repository has no
    measurement through one. Whether a proxy buffers SSE or cuts a quiet
    connection is for the deployer to check, and the gateway's side of the same
    problem is in ADR-6.
  - There is no asynchronous tool for stills, so a still that cannot finish
    under the deadline fails rather than being deferred to a job.
- **Two build variants is a maintenance cost.** ADR-1 declined Option 3 for
  that reason, and it is accepted here. The absence suite (design §5.7) is what
  keeps the two from silently converging. It checks call sites and modules as
  well as names (ADR-5).
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
`tsconfig.service.json` and the image, and every deployment that runs it. The
leaf modules extracted for the service, such as `src/services/entrypoint.ts`,
change no behaviour, so they would stay.

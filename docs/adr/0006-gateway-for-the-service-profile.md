# ADR-6: The service profile trusts only the owner's gateway

**Status:** Accepted

**Relation:** Partly supersedes [ADR-2](0002-no-gateway.md), for the service
profile. ADR-2 still describes the local-dev profile.

## Context

This ADR follows the owner's rulings of 2026-10-26, which are §1 of the
[v2 design](../superpowers/specs/2026-10-26-service-profile-v2-design.md). The
numbered rulings are cited by number. The unnumbered ones in the same section
are cited as design §1, and two of them matter here:
- One central gateway fronts every deployment. The owner owns and controls it,
  and it is not in this repository.
- The owner grants each tenant permission, and receives the audit envelopes.

ADR-2 decided "No gateway." (`0002-no-gateway.md:12`). It named its own
reversal trigger (`:33-34`):

> **When this changes:** if ADR-1 is reversed and HTTP returns, **and** there is a
> multi-user goal. Without both, a gateway is a layer with nothing to do.

The trigger is a conjunction, and both limbs are met for the service profile.

### Limb 1: "ADR-1 is reversed and HTTP returns"

[ADR-4](0004-http-transport-for-the-service-profile.md) reverses ADR-1 only in
part, so this limb has to be argued rather than asserted. ADR-2's own rationale
(`:16-18`) supplies the operative condition:

> A gateway is a policy point at a network boundary. After ADR-1 this server has
> no network boundary: it is a single-user, local, stdio subprocess of one trusted
> client.

ADR-4 restores that boundary for exactly the profile this ADR concerns. Limb 1
does not hold where HTTP does not return, in `dist/` and the `.mcpb`. There the
conjunction fails, and ADR-2 keeps describing that profile. So this ADR partly
supersedes ADR-2 and does not supersede it whole. The narrowing follows from
fixed constraint 2, under which local-dev stays stdio-only.

### Limb 2: "a multi-user goal"

The tenants the owner grants meet it (design §1, §6). Several tenants, each with
its own grant, reach several deployments through one gateway. That is a
multi-user, multi-tenant goal.

The grants are the owner's operational data. They are not committed here,
because this repository is public and carries no key, hostname or tenant id. The
service sees only their result, a signed `tenant` claim.

The owner's fixed constraints of 2026-10-17 first met this limb. They are quoted
here because they are not committed anywhere else:

> 1. Exactly three principals: (a) the owner via Claude Code, local stdio;
>    (b) one frontend teammate via Claude Code, local stdio, installs the .mcpb;
>    (c) the TacticLens backend (Celery workers) over HTTP through the gateway.
>    The browser NEVER calls the render service directly.
>
> [...]
>
> 5. A gateway fronts the service profile. It is a real control, not a pass-through:
>    per-principal credentials (keys never in the public repo), service-profile
>    allowlist enforcement, body size limit, per-key concurrency and rate limits,
>    and a per-call audit envelope (principal, tool, start/end, outcome, upstream
>    failure class, request id; payload HASHES AND SIZES ONLY, never raw payloads —
>    they contain user-uploaded data). Tenant identity comes from the authenticated
>    principal's context, NEVER from a tool argument (confused-deputy guard). The
>    backend key may assert a team id; dev keys are pinned to a fixed dev tenant.

Constraint 1 counted three principals. The owner's tenant grants replace that
count, and the team-id and dev-tenant rules in constraint 5 belonged to it.
Constraint 5's controls remain, and the table under Decision says where each one
now lives.

The service profile cannot be exposed safely without something that
authenticates callers, because the service accepts no caller credential of its
own (ADR-4).

The gateway is necessary, not sufficient. It does not bind Chrome's own fetches;
only the deployer's egress deny does (ADR-5, owner ruling 6). And fixed
constraint 6 makes [ADR-7](0007-process-isolation-for-rendering.md)'s isolation
a separate prerequisite.

### What this changes in ADR-2, and what stays

Two rows of ADR-2's table change for the service profile (`:26-27`):

> | Authorization / multi-tenancy | Moot. One user, one client. |
> | Rate limiting / resource protection | In-process semaphore. The code that owns the processes is there; a gateway cannot see that `viz_render_html` launched 45 browsers. |

Neither holds as written for the service:
- **Authorization is not moot.** There are several tenants, each granted by the
  owner. The service takes the tenant from the verified identity and nowhere
  else.
- **Resource protection is split between the gateway and the service, not
  moved.**
  - The gateway adds per-key request bounds (constraint 5).
  - Running renders stay bounded in the service, for the row's own reason: the
    code that owns the processes is there, and the gateway cannot see them. A
    request can end while its render's processes are still being killed, so a
    bound on requests is not a bound on renders. ADR-7's render slots do that
    bounding.
  - Today's in-process limiter is not that bound. It is a per-process singleton
    for local-dev's spawn path (`cliLimiter`, `src/services/limit.ts:56-60`).
    The service does not use it.

The third row (`:28`) stays true, and it scopes this ADR:

> | Audit trail | In-process structured logging. A gateway sees only the JSON-RPC envelope, not which path was written or which process was spawned. |

The owner's envelope is the only record of the calls the gateway refuses, and
the owner's own record of every call. The service's events remain the only
record of what was rendered, spawned or killed. Joining the two logs is later
work, and it needs the deployer to ship the service's log (design §5.8).

**A correction, for the record.** ADR-2's "**Reversal cost: none** - nothing is
built." (`:36`) was imprecise. Nothing that enforced anything was built, but the
seam was:
- `src/services/audit.ts:13` declares `decision: "observe" | "allow" | "block"`.
- `:38` defaults it to `"observe"`.
- `docs/GATEWAY.md:84` names `detail` as "The seam for redaction".

The accurate cost was low, and partly pre-paid.

## Decision

The service trusts a request only when its `X-Render-Identity` header verifies
against the deployment's own key (ADR-4). The only party that signs for a
deployment is the owner's gateway. That gateway is the owner's private
component, and it is not in this repository.

This repository does three things about it. It specifies what the service
enforces. It specifies what the gateway must do for the service to work. And it
will ship a test signer (`scripts/sign-identity.mjs`) and test vectors
(`test/vectors/identity-v1.json`) of valid, forged, expired, wrong-audience,
body-tampered and replayed cases, with the exact bytes. The owner's gateway can
then check itself against them. Whether it does is an owner checkpoint, not a
condition of the repository's proof (owner ruling 5).

### What the service enforces

The service will handle each request with a `node:http` server, in this order
(design §5.2). No server is created until the identity has been checked.

1. **Route and method.** Only `POST /mcp` passes. Any other method gets 405, and
   any other path gets 404.
2. **Raw body.** It is read under a cap (default 256 KiB), and counted as it
   arrives, so chunked bodies are capped too.
3. **Identity on raw bytes.** The header must parse, the signature must match,
   and `aud`, `iat`, `exp` and `body_sha256` must hold. On failure the service
   answers 401 with no detail. No server is created.
4. **Parse.** The body is parsed once. An array body gets 400, so a batch cannot
   run several calls under one request.
5. **Identity against the body.** The signed `tool` and `request_id` must match
   the parsed body.
6. **Replay.** Only after every other check passes is `request_id` added to the
   seen set. A replay gets 401.
7. **Server and transport.** A fresh `McpServer` and a fresh transport are
   created (ADR-4). The verified identity reaches the tools as `authInfo`.
8. **Cancellation.** When the response closes, the transport is closed, which
   aborts the tool's `AbortSignal` and stops the render (ADR-7).

**The header.** `X-Render-Identity` is
`base64url(claims) "." base64url(HMAC-SHA256(key, base64url(claims)))`. The
claims are a JSON object:

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
- the signature matches its key, compared with `timingSafeEqual`
- `aud` equals its deployment id
- `now` is within `[iat − skew, exp + skew]`, with skew defaulting to 30 s
- `exp − iat` is at most 120 s
- `iat` is no earlier than the service's own start time minus skew
- `body_sha256` matches
- `tool` matches the body
- `request_id` equals `params._meta["io.github.curasinan/request_id"]`
- that `request_id` has not been seen within the window

The start-time rule exists because the seen set lives in memory. Without it, a
restart would reopen the replay window.

**Deployments.** A deployment runs one replica per `aud`, and is rolled out with
Recreate, never with surge. Each deployment has its own HMAC key, from the
environment only, so a deployment's operator cannot forge requests to another
deployment.

**Ignored fields.** A tenant or team field in `_meta` or in tool arguments has
no effect, and is recorded as a protocol violation.

**The service's own audit.** It will write its events as JSONL to a path the
deployer chooses (design §5.8).
- **What it records:** request id, principal, tenant, tool, outcome, category
  and duration, plus keyed hashes and byte sizes of the params and the result.
- **The hashes are keyed.** They are HMAC-SHA256 under an audit key,
  `AUDIT_HMAC_KEY`, that exists only in the environment.
- **What it never records:** payloads, verbatim error messages or raw argument
  values.
- **Why it has its own wrapper.** Local-dev's `safeHandler` records every
  `ToolInputError` message verbatim (`src/services/format.ts:96`) and every
  other error's message (`:102`), and its argument summary keeps short strings
  and numbers as they are (`src/services/log.ts:24-40`). The design gives the
  service its own wrapper and leaves `safeHandler` alone (design §5.8).

### The gateway's transport obligations

The spikes of 2026-10-25 (design §2) showed what the gateway must do for the
service to work at all. These are obligations of any gateway, and each has a
reason:
- **Inject `_meta` into every message it forwards,** initialize and
  notifications included, and sign the rewritten bytes. The service checks every
  POST, and it checks `request_id` against `_meta`.
- **Forward the signed body bytes unchanged.** `body_sha256` covers the exact
  bytes.
- **Forward `accept` with both `application/json` and `text/event-stream`.** The
  SDK answers a POST that lacks either with 406
  (`dist/esm/server/webStandardStreamableHttp.js:468-471`).
- **Forward `content-type: application/json`.** The SDK answers anything else
  with 415 (`:474-477`).
- **Send no `mcp-protocol-version`, or one the service's SDK supports.** The SDK
  answers an unsupported one with 400 (`:762-770`).
- **Not buffer SSE.** In SSE mode the SDK sends a keep-alive every 15 s. In JSON
  mode it sends nothing until the result. A buffering hop makes a long render
  look silent.
- **Use upstream timeouts of at least 60 s.** The SDK client's default request
  timeout is 60 s. A hop that gives up sooner than the client would cuts a
  request the client still wants.
- **Close the upstream connection when its caller disconnects.**
  `notifications/cancelled` does nothing in stateless mode. Only a closed
  connection cancels the render.

### What the gateway keeps

The service holds no caller credential. Each control in fixed constraint 5 now
lives with the owner's gateway, in the service, or in both:

| Constraint 5 control | Where it lives now |
| --- | --- |
| Per-principal credentials, keys never in the public repo | The owner's gateway. The service holds only its deployment's identity key, from the environment |
| Tenant identity from the principal, never a tool argument | The owner's gateway grants a tenant and signs it. The service reads the tenant only from the verified header and ignores any other |
| Service-profile allowlist enforcement | Structural, in the service: exactly four tools will be registered (ADR-5), and a live `tools/list` will prove it. The owner's gateway keeps a response filter as well |
| Body size limit | The service: 256 KiB by default, counted as bytes arrive. The gateway may add its own |
| Per-key concurrency and rate limits | The owner's gateway. The service keeps a global count of render slots (ADR-7) |
| Per-call audit envelope, hashes and sizes only | The owner's gateway, for every call it sees. The service will write its own hash-only log (above) |

So the gateway keeps its keys, its tenant grants, its per-key limits, its
response filter and its envelope. This ADR does not specify them further,
because they are not in this repository.

### Which software the gateway runs

That is the owner's choice. The earlier plan to compare a thin gateway with
LiteLLM, against the same five criteria, now concerns the owner's gateway and
not this repository:

> LiteLLM will be re-evaluated against the same five criteria when it is
> deployed as the TacticLens LLM gateway.

The five criteria are fixed constraint 5's controls:
1. per-principal credentials, with tenant taken from the principal
2. allowlist enforcement
3. a body size limit, including chunked bodies
4. per-key concurrency and rate limits
5. an audit envelope that records hashes and sizes only, and covers refused
   calls

Any comparison must also send one call slower than any default timeout, through
every hop. A comparison without that probe repeats an earlier spike, whose
slowest probe was 30 seconds.

### Naming

From this ADR on, "gateway" means the network policy point in front of the
deployments. The local, read-only view of a laptop's audit log keeps a legacy
name for now:
- `npm run gateway` (`package.json:29`)
- `README.md:280` and `:283`, which tell users to ask for "the gateway" and to
  run `npm run gateway`
- `docs/GATEWAY.md`, titled "Audit log and gateway dashboard"
- `dashboard/template.html`, titled "Gateway Audit Dashboard"

In prose it is the **audit dashboard**. Renaming the script is a separate
change.

## Consequences

- **Build status.** As of 2026-10-26 none of the service files and checks this
  ADR names exist yet: the service itself, the test signer and vectors, the live
  `tools/list` check, and the service's audit log. This ADR records the
  decision, and `docs/superpowers/plans/final_script.md` builds them.
- **The gateway is a single point of failure for the service path, for every
  deployment.** It is the owner's component, and this repository does not ship
  it. Losing it does not affect local-dev, which is a deliberate asymmetry.
- **One replica per deployment id means a rollout drops in-flight renders.**
  Recreate leaves a gap between the old container and the new one. The design
  pairs this rule with the replay set (design §8, call 3): the seen set lives
  in memory.
- **A restart refuses requests signed just before it.** The start-time rule
  refuses any header whose `iat` is earlier than the start time minus skew, so a
  request signed shortly before a restart is refused for about one skew
  interval.
- **The proof stops at the repository's edge.** The test signer and the vectors
  will show the service side end to end. They will not show that the owner's
  gateway signs the same bytes, which is an owner checkpoint (ruling 5).
- **Open risk: unauthenticated refusals, at the gateway.** If the owner's
  gateway writes a 401 to its envelope log, no per-key limit applies to a caller
  without a key. A flood of bad-key requests could then rotate authenticated
  envelopes out of a log whose retention is bounded by size. Two fixes are
  possible: bound retention by time rather than size, or rate-limit
  unauthenticated refusals per source address. That is the owner's to decide.
- **Open risk: unauthenticated requests, at the service.** A caller that can
  reach a deployment's port without a valid header costs the service a bounded
  body read and the identity check, and nothing else, because no server is
  created. Keeping the port off the internet is the deployer's.
- **Stale readers.** These readers explain the absence of enforcement by citing
  ADR-2, and need repointing:
  - `docs/GATEWAY.md:78-81`
  - the public site's "ADR-2 — no gateway" (`site/index.html:172-174`)

  These edits are follow-ups and are not made here.

**Reversal cost: medium.** Without a gateway that signs for each deployment, the
service would need its own caller authentication, which is the layering this ADR
exists to avoid. Replacing the owner's gateway with another costs nothing in
this repository, as long as the new one signs the same contract.

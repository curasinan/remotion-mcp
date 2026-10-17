# ADR-6: A gateway fronts the service profile

**Status:** Accepted

**Relation:** Partly supersedes [ADR-2](0002-no-gateway.md), for the service
profile. ADR-2 still describes the local-dev profile.

## Context

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

ADR-4 restores that boundary for exactly the profile this ADR fronts. Limb 1
does not hold where HTTP does not return, in `dist/` and the `.mcpb`. There the
conjunction fails, and ADR-2 keeps describing that profile.

**This narrows plan Task 4 Step 3,** which says "Supersedes ADR-0002". The
narrowing follows from fixed constraint 2, under which local-dev stays
stdio-only.

### Limb 2: "a multi-user goal"

The owner's fixed constraints of 2026-10-17 meet it. They are quoted here
because they are not committed anywhere else:

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

Distinct credentials, distinct tenants and one principal that may assert a team
id add up to a multi-user, multi-tenant goal.

That evidence is an owner's constraint, not a committed charter, because
`ISE304-project` is empty. The weakness is stated rather than hidden. This ADR
does not wait for the charter, because the service profile cannot be exposed
safely without a gateway, whatever the charter says.

The gateway is necessary, not sufficient. It does not bind Chrome's own
fetches; only ADR-5's container egress deny does. And fixed constraint 6 makes
[ADR-7](0007-process-isolation-for-rendering.md)'s isolation a separate
prerequisite.

### What this changes in ADR-2, and what stays

Two rows of ADR-2's table change for the service profile (`:26-27`):

> | Authorization / multi-tenancy | Moot. One user, one client. |
> | Rate limiting / resource protection | In-process semaphore. The code that owns the processes is there; a gateway cannot see that `viz_render_html` launched 45 browsers. |

Neither holds as written for the service:
- **Authorization is not moot.** There are three principals. There are also
  several tenants: the fixed dev tenant, plus one per team id the backend
  asserts.
- **Resource protection is split between the gateway and the service, not
  moved.**
  - The gateway adds per-key request bounds (item 5).
  - Running renders stay bounded in the service, for the row's own reason: the
    code that owns the processes is there, and the gateway cannot see them. A
    render can also outlive its request, so a bound on requests is not a bound
    on renders. ADR-7's render slots do that bounding.
  - Today's in-process limiter is not that bound. It is a per-process singleton
    (`cliLimiter`, `src/services/limit.ts:56-60`). Once each render runs in its
    own child, each child has its own limiter.

The third row (`:28`) stays true, and it scopes this ADR:

> | Audit trail | In-process structured logging. A gateway sees only the JSON-RPC envelope, not which path was written or which process was spawned. |

The gateway's envelope is the only record of two things: the calls the gateway
refuses, and the authenticated principal. The service's own events remain the
only record of what was written or spawned. Which log is authoritative for
reporting is an owner decision, and this ADR does not make it.

**A correction, for the record.** ADR-2's "**Reversal cost: none** - nothing is
built." (`:36`) was imprecise. Nothing that enforced anything was built, but the
seam was:
- `src/services/audit.ts:13` declares `decision: "observe" | "allow" | "block"`.
- `:38` defaults it to `"observe"`.
- `docs/GATEWAY.md:84` names `detail` as "The seam for redaction".

The accurate cost was low, and partly pre-paid.

## Decision

The render gateway is a separate process, in its own container and under its
own OS user. Caddy terminates TLS and forwards only to the gateway, and the
service has no TCP listener at all (ADR-4).

The gateway lives in this repository, under `gateway/`:
- It is compiled by its own TypeScript project.
- It is excluded from the stdio build (`tsconfig.json`, PR #18).
- It runs on Node 22 with `node:http` and no framework.
- Its code encodes no tenant id, hostname or key. All three come from the
  environment.

Fixed constraint 3 puts the football templates outside this repository, not the
gateway.

It is not a pass-through: a request that fails any check never reaches the
service socket. It enforces seven things.

1. **Per-principal credentials.**
   - A bearer token maps to `{ keyId, tenant, kind: "backend" | "dev" }` by
     SHA-256 hash, compared with `crypto.timingSafeEqual`.
   - An unknown key gets 401 with no detail.
   - Key hashes come from the environment, never from a file in either
     repository.
   - A key is revoked by removing its hash from the gateway's environment and
     restarting the gateway. Nothing else caches a key, so the restart is the
     whole revocation window.
2. **Tenant from the principal, never from the request body.**
   - Dev keys are pinned to the fixed dev tenant. A team id asserted by a dev
     key is refused.
   - Only a `backend` principal may assert a team id. It does so in a request
     header, not in tool arguments and not in `params._meta`.
   - The gateway validates the header's format. The tenant it signs is the team
     id namespaced under the backend principal, so it can never equal the dev
     tenant or another principal's tenant.
3. **The allowlist, in both directions.**
   - **HTTP method.** On the MCP route, only POST is forwarded. Any other
     method there gets 405 and an envelope, and takes no limit slot.
     - A GET carries no JSON-RPC method, so the method set below could not
       catch it.
     - The SDK transport alone would answer a GET with an endless stream. The
       service's own 405 (ADR-4) is a second refusal, so this one is defence
       in depth.
     - Plan Task 17's health endpoint in `gateway/server.ts` is the only other
       route. The gateway answers it itself and never forwards it. Nothing yet
       fixes its method, or whether it needs a key (ADR-4).
   - **No batches.** A JSON-RPC batch (an array body) is refused. One request
     is one call, so a batch cannot multiply renders behind one limit slot and
     one envelope.
   - **Tools and methods.** A `tools/call` naming a tool outside the four is
     refused before forwarding, as is any JSON-RPC method outside a fixed set.
   - **The response.** The `tools/list` result is filtered to the four before
     it reaches the caller. A fifth tool registered upstream is neither
     callable nor advertised.
   - **Two lists, compared.** The four names are a hand-written frozen list in
     `gateway/allowlist.ts`, which does not import `src/service/registry.ts`. A
     test compares the two. If they ever disagree, the system fails closed:
     - a tool only in the registry is registered but unreachable
     - a tool only in the allowlist is forwarded, and the service refuses it as
       unknown
4. **A body cap that counts bytes as they arrive.** A chunked body with no
   `Content-Length` is capped at the same threshold. A request over the cap
   gets 413.
5. **Per-key concurrency and rate limits.**
   - Each key has an in-flight bound and a request-rate limit.
   - A request over the in-flight bound waits in the key's bounded FIFO queue.
     A request that finds the queue full, or that exceeds the rate limit, is
     refused with 429 and `Retry-After`, and is never forwarded.
   - The initial values are hand-set and unmeasured: backend 2 in flight, each
     dev key 1, queue depth 4.
   - These limits bound requests, not renders. A `render_video_start` returns
     a job id while its render keeps running. A dropped `render_still`
     connection frees its request slot before its child exits. Running renders
     are bounded where they run, by ADR-7's per-principal render slots.
6. **A signed identity for the second hop.**
   - **What is sent.** The gateway never forwards the caller's key. It sends
     `X-TL-Identity` instead: an HMAC-SHA256 over a canonical encoding of
     `{request_id, principal, tenant, tool, body_sha256, iat, exp}`. The HMAC
     key, `TL_IDENTITY_HMAC_KEY`, exists only in the environment.
   - **The request id.** The gateway writes it into the forwarded call's
     `params._meta["tacticlens/request_id"]`, replacing any value the caller
     sent.
   - **The tool.** For a method other than `tools/call`, the signed `tool` is
     the JSON-RPC method name.
   - **The body.** `body_sha256` is a SHA-256 of the exact bytes the gateway
     forwards. The header is never written to either log, so this is not the
     bare payload hash that item 7 avoids.
   - **Timing.** The gateway signs at the moment it forwards, so time spent in
     the key's queue does not count against `exp`. `exp` is short.
   - **What the service checks.** Before it trusts any field of the header or
     runs the call, the service checks four things:
     - the signature
     - `exp`
     - that the signed `request_id`, `tool` and `body_sha256` match the
       request the header arrived with
     - that the `request_id` has not been seen before within the `exp` window

     If any check fails, it refuses with `identity_unverified`.
   - **`_meta` tenants.** A tenant in `params._meta` is a protocol violation
     upstream. It is recorded as `meta_identity_mismatch`, and the signed
     header wins.
7. **One envelope per inbound call, including refused calls.**
   - **What it records:** request id, principal, tenant, tool, start and end,
     outcome, refusal reason, upstream failure class, and payload hashes and
     byte sizes. It never records a raw payload.
   - **The hashes are keyed.** They are an HMAC-SHA256 under an audit key that
     exists only in the environment, not a bare SHA-256. Props are short,
     bounded values (ADR-5), so a bare hash could be confirmed by guessing the
     payload.
   - **What the request hash covers.** It is taken over a canonical encoding of
     the JSON-RPC `params` as the caller sent them, with `_meta` removed.
     Neither the JSON-RPC `id` nor the request id the gateway writes into
     `_meta` enters it. So a keyed hash still shows that a retry with the same
     arguments is the same request.
   - **Why refused calls count.** A call the gateway refuses never reaches the
     service. If the gateway did not record it, the most security-relevant
     events would be the ones that vanish.
   - **The service is held to the same rule.** In the service profile:
     - a refusal records its category
     - a failure records its class and no message
     - an argument summary records keyed hashes and sizes

     None of these can echo a caller's value.

     Today `safeHandler` meets only the first rule: it records a refusal's
     category (`src/services/format.ts:95`). It also does three things the rule
     forbids:
     - It records every `ToolInputError` message verbatim (`:96`).
     - It records every other error's message (`:102`).
     - Its argument summary keeps short strings and numbers as they are.

### LiteLLM

There is no LiteLLM spike this window; the plan is the thin gateway.

> LiteLLM will be re-evaluated against the same five criteria when it is
> deployed as the TacticLens LLM gateway.

The five criteria are fixed constraint 5's controls:
1. per-principal credentials, with tenant taken from the principal
2. allowlist enforcement
3. a body size limit, including chunked bodies
4. per-key concurrency and rate limits
5. an audit envelope that records hashes and sizes only, and covers refused
   calls

The re-evaluation must also send one call slower than any default timeout,
through the gateway and Caddy. A comparison without that probe repeats the
spike the design killed, whose slowest probe was 30 seconds.

Until then, two gateways are accepted.

### Naming

From this ADR on, "gateway" means this network policy point. The local,
read-only view of a laptop's audit log keeps a legacy name for now:
- `npm run gateway` (`package.json:29`)
- `README.md:280` and `:283`, which tell users to ask for "the gateway" and to
  run `npm run gateway`
- `docs/GATEWAY.md`, titled "Audit log and gateway dashboard"
- `dashboard/template.html`, titled "Gateway Audit Dashboard"

In prose it is the **audit dashboard**. Renaming the script is a separate
change.

## Consequences

- **One more process to deploy, and one more log to ship.** The gateway log's
  retention is aligned with the service's. The gateway is a single point of
  failure for the service path. Losing it does not affect local-dev, which is a
  deliberate asymmetry.
- **What the plan does not yet build.** As of 2026-10-17, none of the following
  has a plan task:
  - **The gateway itself:** its TypeScript project and build script, and its
    own container and OS user. Plan Task 15's only Dockerfile is
    `Dockerfile.service`.
  - **Item 5:** the per-key limits, the queue and `Retry-After`. The
    benchmark's `K_safe` (plan Task 18) is the basis for replacing the initial
    values, but no step does so.
  - **Item 3:**
    - the HTTP-method and batch refusals
    - the method set
    - the response filter, which needs a test against a stub upstream that
      advertises a canary tool, asserting that the gateway returns exactly four
    - the test that compares the allowlist with the registry
  - **Item 2:** the positive case, the backend's team id.
  - **Item 6:**
    - writing the request id into `params._meta["tacticlens/request_id"]`,
      over any value the caller sent
    - the `tool`, `body_sha256` and `exp` checks
    - the seen-id check
    - the `meta_identity_mismatch` rule

    Of item 6, plan Task 9 Step 1 tests only the signature, through an absent
    and a forged header, and the `request_id` match, through a header
    "replayed ... from a different request id". Neither of those is the
    seen-id check.
  - **Item 7:**
    - envelopes for refused calls
    - keyed hashes
    - the service's category-only refusals and its hashed argument summaries
  - **Tests:** that the caller's key is never forwarded, and of revocation.
- **These amend the plan.**
  - **Plan Task 16 waits for the controls above and for ADR-7's render slots.**
    The service profile is not deployed until they exist.
    - Fixed constraint 5 requires the limits, the allowlist and the envelope.
    - Item 5 shows that the gateway's limits bound requests, not renders.

    This puts the 2026-11-21 deploy milestone at risk.
  - **Plan Task 9 Step 3 changes.** As written, it signs
    `requestId || tenant || keyId`, which has two defects:
    - With no delimiter, two different `(tenant, keyId)` pairs can sign the
      same bytes.
    - With no expiry, a captured header stays valid indefinitely.

    It must match item 6, and `signIdentity` needs the tool and the body hash.
  - **Plan Task 9's Interfaces change.** The envelope's `reqSha256` and
    `respSha256` name bare SHA-256 digests. Under item 7 they become keyed
    hashes and are renamed to say so. Task 9's canary test cannot tell the
    difference, because a bare hash also keeps the sentinel out of every field.
- **Open risk: unauthenticated refusals.** A 401 is written to the envelope log,
  but no per-key limit applies to a caller without a key. A flood of bad-key
  requests could therefore rotate authenticated envelopes out of a log whose
  retention is bounded by size. Two fixes are possible: bound retention by time
  rather than size, or rate-limit unauthenticated refusals per source address.
  Neither is decided or planned yet.
- **Stale readers.** These readers explain the absence of enforcement by citing
  ADR-2, and need repointing:
  - `docs/GATEWAY.md:78-81`
  - the public site's "ADR-2 — no gateway" (`site/index.html:172-174`)

  These edits are follow-ups and are not made here.

**Reversal cost: medium.** Without the gateway, the service would need its own
auth, which is the layering this ADR exists to avoid.

# ADR-2: No gateway

**Status:** Accepted

## Context

Putting a gateway in front of an MCP server - for policy enforcement, audit,
rate limiting, multi-tenant authorization - is a common recommendation.

## Decision

No gateway.

## Rationale

A gateway is a policy point at a network boundary. After ADR-1 this server has
no network boundary: it is a single-user, local, stdio subprocess of one trusted
client. Adding a gateway would mean first restoring HTTP and then adding a layer
to protect it - reintroducing the risk that was removed and stacking complexity
on top.

The three things a gateway promises map elsewhere in this architecture:

| Gateway promise | Where it actually belongs here |
| --- | --- |
| Authorization / multi-tenancy | Moot. One user, one client. |
| Rate limiting / resource protection | In-process semaphore. The code that owns the processes is there; a gateway cannot see that `viz_render_html` launched 45 browsers. |
| Audit trail | In-process structured logging. A gateway sees only the JSON-RPC envelope, not which path was written or which process was spawned. |

Each belongs in the server, where the context to make the decision exists. A
gateway would do all three worse.

**When this changes:** if ADR-1 is reversed and HTTP returns, **and** there is a
multi-user goal. Without both, a gateway is a layer with nothing to do.

**Reversal cost: none** - nothing is built.

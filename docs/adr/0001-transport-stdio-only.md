# ADR-1: stdio only, no HTTP transport

**Status:** Accepted

## Context

The server shipped with two transports: stdio (default) and streamable HTTP,
selected by `MCP_TRANSPORT=http`. The documented HTTP path fronted the server
with an ngrok tunnel so it could be registered as a claude.ai custom connector.
So the question was not "should we add HTTP" but "what happens to the HTTP that
is already here".

## Decision criterion

This server spawns child processes, compiles and runs code out of the workspace,
and writes files to paths given as tool arguments. For a server like that the
transport question is not about performance or reach; it is whether the attack
surface stays behind a single trusted client. Over stdio the only thing that can
reach the server is the process that launched it. Over HTTP the thing that can
reach it is the network, and the only thing in between is a bearer token.

## Options

1. **Keep stdio, remove HTTP.** Surface stays at the process boundary; loses
   claude.ai web/mobile.
2. **Keep HTTP, harden it.** Preserves web/mobile but requires OAuth 2.1, token
   audience validation, a passthrough ban, rate limiting and per-request audit.
3. **Keep HTTP but exclude it from the production bundle.** Two build variants,
   ongoing maintenance.

## Decision

Option 1. `src/transports/` is removed, along with the `MCP_TRANSPORT` branch
and `MCP_HTTP_*` variables.

## Consequences

- Authentication leaves the picture entirely: OAuth 2.1, token audience,
  passthrough ban, origin checks, DNS-rebinding defence and rate limiting are
  all moot and none are built.
- Two verified findings weigh here. Argument injection through `output_path`
  reaches code execution, and the SVG rasteriser read arbitrary local files.
  Over stdio both need content that steers the model; over HTTP anyone holding
  the token calls them directly. The same defect is not worth the same over the
  two transports.
- Measured side effect: `index.ts` imported the transport statically, so hono
  was pulled into every stdio session. The runtime graph drops from 15 resolved
  packages to 12.
- claude.ai web and mobile lose access. Claude Desktop and Claude Code, which
  launch a local subprocess, are unaffected.

**Reversal cost: low.** `src/transports/http.ts` was one 139-line file and stays
in git history. Restoring it is that file plus one branch in `index.ts`, which
is what makes removing it a safe default rather than a one-way door.

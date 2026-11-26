# Audit log and gateway dashboard

Every interaction with the remotion-viz MCP server is logged to a local audit trail. This document describes what is recorded, where it lives, how to view it, and the design decisions that shape it.

**About the name.** "Gateway" in this file's name, its title and `npm run gateway` is a legacy name for the **audit dashboard**, kept for now. Since [ADR-6](adr/0006-gateway-for-the-service-profile.md), "gateway" means the network policy point in front of service-profile deployments, which this document does not describe.

## What is recorded

The audit log records multiple events per tool call: a `tool_call` event on entry, followed by one of `tool_result`, `tool_rejected`, or `tool_failed`, plus a `network_block` event for any HTTP request blocked by network policy. Together these capture:

- **Tool call**: The tool name and summarised arguments
- **Outcome**: On `tool_result`, whether the call succeeded (`ok`) or returned an error (`error`); a refusal is recorded separately as `tool_rejected`, and an unexpected failure as `tool_failed`
- **Duration**: Execution time in milliseconds
- **Security refusal category** (when applicable): One of:
  - `path_traversal` — an argument tried to escape the workspace root
  - `svg_reference` — SVG contained an external network reference or local file read attempt
  - `argv_injection` — a tool argument looked like a shell flag or injection
  - `raster_budget` — output exceeded pixel count limits
  - `concurrency` — a tool call was refused because the process/browser pool was full
  - `network_block` — an HTTP request was blocked by network policy
- **Tool result**: Outcome data and any error message
- **Decision field**: Always `"observe"` (see below)

Summarised tool arguments and refusal/failure messages are recorded, and these can include file paths (for example a rejected `output_path` or a path-traversal refusal message names the candidate path). No credentials or tokens are included — this server does not handle any — and long string arguments are truncated to a length marker (`<string:N chars>`) rather than recorded in full. Recording paths is exactly why the log stays on the machine and is never sent anywhere; see Privacy below.

## Where it lives

The audit log is a line-delimited JSON file (`.jsonl`), one event per line.

**Default location** (per platform):

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\remotion-viz\audit.jsonl` |
| macOS | `~/Library/Application Support/remotion-viz/audit.jsonl` |
| Linux | `$XDG_STATE_HOME/remotion-viz/audit.jsonl` (i.e. `~/.local/state/remotion-viz/audit.jsonl`) |

To override the path, set the `REMOTION_MCP_AUDIT_LOG` environment variable.

**Log rotation:** The log is bounded to approximately 5 MB across two rotating segments. When the active segment fills, the oldest segment is discarded and a new one begins.

**Privacy:** The audit log stays on your machine. Nothing is sent to your AI provider, the MCP registry, or any other service.

**If your log predates this fix, it may be mostly test data.** `smoke-test.mjs` and
`test/protocol.test.mjs` used to spawn the server without redirecting the audit log,
so running the test suite from a source checkout appended to this file. On one real
install, 418 of 420 recorded events were test fixtures — including a 48% "security
refusal" rate that was entirely path-traversal and oversized-SVG *test inputs*, not
anything that happened to a real project. If your dashboard shows an implausible
refusal rate or a flood of `viz_render_svg` calls you do not recognise, that is why.
Delete the log to start clean; it is regenerated on the next tool call.
`test/audit-isolation.test.mjs` now guards against the regression.

## How to view it

You have two ways to view the audit log:

### Via your AI client

Ask your client: **"show me the gateway"**

A client that can read local files and render HTML will read your local audit log and build an interactive dashboard from it. The dashboard shows a timeline of all tool calls, their outcomes, duration, and any security events.

### Via command line

To build a self-contained HTML dashboard you can open in any browser:

```bash
npm run gateway
```

This creates a file `gateway.html` in the current directory. Open it in your browser. The dashboard works offline and contains the entire log snapshot at the time you ran the command.

## The `decision` field and the future path

Every event in the audit log includes a `decision` field set to `"observe"`. This field is a placeholder for future enforcement.

**Why it exists:** The audit schema was designed to support real-time blocking — a future version could record `decision: "allow"` or `decision: "block"` alongside `decision: "observe"`. Because the schema anticipates this, neither the log format nor the dashboard need to change if enforcement is added later.

**Why the local-dev profile does not enforce:** See [`docs/adr/0002-no-gateway.md`](adr/0002-no-gateway.md), which still governs that profile. In brief:

- The local-dev profile (`dist/` and the `.mcpb`) runs as a trusted, single-user subprocess over stdio.
- Enforcement (allow/block policies per tool) makes sense only where there is multi-user access or a network boundary. The local-dev profile has neither.
- Audit logging is more valuable in a local context where it lives on your machine and you decide what to do with it.

The service profile has both: backends reach it over HTTP, for tenants the owner grants. So [ADR-6](adr/0006-gateway-for-the-service-profile.md) puts it behind the owner's gateway, which holds the keys, the tenant grants, the per-key limits and the per-call audit envelope, and the service accepts only requests that gateway has signed. That gateway is not part of this repository, and it is unrelated to the audit dashboard this document describes.

**The seam for redaction:** The `detail` field in each event is designed to support redaction. A future cloud deployment could redact sensitive information before sending the log elsewhere, but the local audit log always contains full detail.

## Further reading

- Architecture decisions: [`docs/adr/`](adr/)
- Tool reference: [`docs/TOOLS.md`](TOOLS.md)

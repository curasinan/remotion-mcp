# Audit log and gateway dashboard

Every interaction with the remotion-viz MCP server is logged to a local audit trail. This document describes what is recorded, where it lives, how to view it, and the design decisions that shape it.

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

**Privacy:** The audit log stays on your machine. Nothing is sent to Anthropic, the MCP registry, or any other service.

## How to view it

You have two ways to view the audit log:

### Via Claude (recommended)

In Claude, simply ask: **"show me the gateway"**

Claude will read your local audit log and publish an interactive dashboard as an artifact. The dashboard shows a timeline of all tool calls, their outcomes, duration, and any security events.

### Via command line

To build a self-contained HTML dashboard you can open in any browser:

```bash
npm run gateway
```

This creates a file `gateway.html` in the current directory. Open it in your browser. The dashboard works offline and contains the entire log snapshot at the time you ran the command.

## The `decision` field and the future path

Every event in the audit log includes a `decision` field set to `"observe"`. This field is a placeholder for future enforcement.

**Why it exists:** The audit schema was designed to support real-time blocking — a future version could record `decision: "allow"` or `decision: "block"` alongside `decision: "observe"`. Because the schema anticipates this, neither the log format nor the dashboard need to change if enforcement is added later.

**Why enforcement is not built yet:** See [`docs/adr/0002-no-gateway.md`](adr/0002-no-gateway.md). In brief:

- Today, this server runs as a trusted, single-user subprocess over stdio.
- Enforcement (allow/block policies per tool) makes sense only if a future design introduces multi-user access or a network boundary — neither of which exist now.
- Audit logging is more valuable in a local context where it lives on your machine and you decide what to do with it.

**The seam for redaction:** The `detail` field in each event is designed to support redaction. A future cloud deployment could redact sensitive information before sending the log elsewhere, but the local audit log always contains full detail.

## Further reading

- Architecture decisions: [`docs/adr/`](adr/)
- Tool reference: [`docs/TOOLS.md`](TOOLS.md)

# ADR-3: Isolation boundary — separate the in-process native code, no container

**Status:** Accepted

## Context

This server runs code. But "main process, worker, or container" has no single
answer, because there are three render paths and their isolation already
differs:

| Path | Isolation today | Phase 1 evidence |
| --- | --- | --- |
| Remotion render/still/compositions | already a separate process (CLI spawn) | cannot crash the main process |
| `viz_render_html` (puppeteer) | Chrome is a separate process | orphan chrome, 180s wedge |
| `viz_render_svg` (resvg) | **native addon in the main process** | a 120-byte SVG aborted the whole server |

The isolation problem is not "rendering", it is **resvg**. Remotion is already
isolated. Chrome is already a separate process. The only thing running in the
main process that can kill it is resvg.

## Options

1. Everything in the main process (the starting state). The oversized SVG kills
   the server.
2. **Isolate resvg only** — move rasterization to a short-lived child.
3. Move all tools to a worker pool. Remotion and Chrome are already separate, so
   there is no gain, and the lifecycle complexity is real.
4. Container (Docker). A mandatory Docker requirement for a single-user desktop
   tool distributed as an `.mcpb` on Windows: install friction, filesystem
   mapping, font and GPU issues.

## Decision

**Input validation first** (the T-1 fix: a pixel-count cap read from resvg's
intrinsic dimensions before render), **then** Option 2 if it is still warranted.
Options 3 and 4 are rejected.

## Rationale

- T-1's root cause is not missing isolation, it is an unvalidated size. The fix
  is a six-line check; isolating the process would only move which process dies.
  Fix the bug first, then discuss isolation.
- Moving resvg to a child would protect the main process from *unknown* native
  crashes - a real gain, but one to measure after T-1, when the only known crash
  path is closed and the remaining risk is speculative.
- A container breaks the tool's reason to exist: it renders the user's local
  Remotion project using their Chrome, fonts and workspace. Mandating Docker is
  the textbook over-engineering this project was warned against.
- Chrome-side isolation is won by removing `--no-sandbox`, which is part of this
  ADR and was done.

## Consequences

- With T-1 closed there is no known path that kills the main process.
- Zero new dependencies, zero deployment complexity.
- A future native crash in resvg could still take the server down. This is the
  accepted residual risk, stated so it is not a surprise. `REMOTION_MCP_DISABLE_BROWSER_SANDBOX=1`
  remains as a deliberate, named escape hatch for environments that cannot
  provide a sandbox.

**Reversal cost: low.** The pixel cap is one check in one function. Moving to
Option 2 later keeps `rasterizeSvg`'s signature and moves its body behind a
child process, so no calling code changes.

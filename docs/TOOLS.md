# Tool reference

Twelve tools in three groups. Every tool takes `response_format` (`markdown` |
`json`, default `markdown`). Annotations shown are the MCP hints a client reads;
they are UX signals, not access control — the enforcement is in the server.

**Where parameter detail lives.** The tables below name each tool's arguments; the
types, defaults, ranges and per-field explanations live in the tool's `inputSchema`,
which every MCP client sends to the model alongside the description. The descriptions
used to restate all of it in an `Args:` block — 4,256 characters of duplication across
the twelve tools, re-sent on every conversation. That block is gone. This file
deliberately does not reproduce it either: a third copy is a third thing to keep in
step with `src/schemas/common.ts`, and the schema is the one that cannot go stale.
`smoke-test.mjs` asserts no description reintroduces an `Args:` block, and that
`tools/list` stays inside a 30,500-character budget.

## Diagnostics

| Tool | Args | Annotations | Notes |
| --- | --- | --- | --- |
| `remotion_check_environment` | `project_dir` | not read-only, open-world | Probes by running the CLI, which npx may fetch. |
| `remotion_ensure_browser` | `project_dir` | not read-only, open-world, idempotent | Downloads the Chrome Headless Shell. |
| `remotion_get_workspace_info` | — | read-only | Reports the workspace root. Executes nothing. |

## Remotion

| Tool | Args | Annotations | Notes |
| --- | --- | --- | --- |
| `remotion_init_project` | `project_dir`, `remotion_version`, `install` | not read-only, open-world | Refuses a non-empty directory. `install:true` runs npm. |
| `remotion_list_compositions` | `project_dir`, `entry_point` | not read-only, open-world, idempotent | Bundles and **executes** the project's code; doubles as a compile check. |
| `remotion_render_still` | `project_dir`, `entry_point`, `composition_id`, `output_path`, `frame` \| `frames`, `scale`, `props_json`, `return_image` | destructive, open-world, idempotent | Renders one frame and attaches the PNG. `frames` (2–24) renders several and tiles them into one labelled strip, in a single CLI invocation — measured at ~21 ms per additional frame, because the bundle is the cost and the frames are nearly free. Mutually exclusive with `frame`. |
| `remotion_render_video` | `project_dir`, `entry_point`, `composition_id`, `output_path`, `codec`, `frames`, `scale`, `concurrency`, `props_json` | destructive, open-world, idempotent | Renders video/audio. |
| `remotion_start_studio` | `project_dir`, `entry_point`, `port` | not read-only, open-world | Detached dev server; survives the session. Stop with `remotion_stop_studio`. |
| `remotion_stop_studio` | `pid` | destructive, idempotent | Only stops PIDs this server started; registry survives a restart. The registry lives in the per-user state directory beside the audit log, not `os.tmpdir()`, and the target process is checked against the OS before signalling so a recycled PID is refused. |

`composition_id` and `entry_point` are charset-restricted and may not begin with
`-`; `output_path` may not contain a flag-like segment. These are the argument-
injection guards, not cosmetic limits.

## Visualization

| Tool | Args | Annotations | Notes |
| --- | --- | --- | --- |
| `viz_validate_svg` | `svg` | read-only | Lints against renderer constraints. No files, no network. |
| `viz_render_svg` | `svg`, `width`, `output_path`, `return_image` | not read-only, **closed-world**, idempotent | Rasterizes via resvg. Refuses any reference that is not a `data:` URI, and caps output by total pixel count. |
| `viz_render_html` | `html`, `width`, `height`, `full_page`, `device_scale_factor`, `output_path`, `project_dir`, `return_image` | not read-only, open-world, idempotent | Screenshots via headless Chrome, sandbox on, **no network by default**. `blocked_requests` lists what was refused. |
| `viz_compare` | `before`, `after`, `threshold`, `output_path`, `return_image` | not read-only, **closed-world**, idempotent | Pixel-diffs two PNGs already inside the workspace. Refuses mismatched dimensions rather than resizing. The only tool whose inputs are files it *reads*. |

`viz_render_svg` is the one visualization tool that is a closed world, and only
because it refuses off-document references; `viz_render_html` reaches the network
(under policy) so it is open-world.

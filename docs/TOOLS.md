# Tool reference

Twelve tools in three groups. Every tool takes `response_format` (`markdown` |
`json`, default `markdown`). Annotations shown are the MCP hints a client reads;
they are UX signals, not access control — the enforcement is in the server.

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
| `remotion_render_still` | `project_dir`, `entry_point`, `composition_id`, `output_path`, `frame`, `scale`, `props_json`, `return_image` | destructive, open-world, idempotent | Renders one frame; attaches the PNG. |
| `remotion_render_video` | `project_dir`, `entry_point`, `composition_id`, `output_path`, `codec`, `frames`, `scale`, `concurrency`, `props_json` | destructive, open-world, idempotent | Renders video/audio. |
| `remotion_start_studio` | `project_dir`, `entry_point`, `port` | not read-only, open-world | Detached dev server; survives the session. Stop with `remotion_stop_studio`. |
| `remotion_stop_studio` | `pid` | destructive, idempotent | Only stops PIDs this server started; registry survives a restart. |

`composition_id` and `entry_point` are charset-restricted and may not begin with
`-`; `output_path` may not contain a flag-like segment. These are the argument-
injection guards, not cosmetic limits.

## Visualization

| Tool | Args | Annotations | Notes |
| --- | --- | --- | --- |
| `viz_validate_svg` | `svg` | read-only | Lints against renderer constraints. No files, no network. |
| `viz_render_svg` | `svg`, `width`, `output_path`, `return_image` | not read-only, **closed-world**, idempotent | Rasterizes via resvg. Refuses any reference that is not a `data:` URI, and caps output by total pixel count. |
| `viz_render_html` | `html`, `width`, `height`, `full_page`, `device_scale_factor`, `output_path`, `project_dir`, `return_image` | not read-only, open-world, idempotent | Screenshots via headless Chrome, sandbox on, **no network by default**. `blocked_requests` lists what was refused. |

`viz_render_svg` is the one visualization tool that is a closed world, and only
because it refuses off-document references; `viz_render_html` reaches the network
(under policy) so it is open-world.

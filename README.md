# remotion-viz-mcp-server

An MCP server that gives Claude two things it does not have on its own: the ability to actually **run** Remotion, and the ability to **look at** what an SVG or HTML visualization renders to.

## Why this exists

Asking a chat model for "a Remotion animation" or "a visualization" fails for structural reasons, not because the model wrote bad code:

| Failure | Cause |
| --- | --- |
| Remotion code that never runs | Remotion needs a Node project, a bundler and a headless Chrome. A chat artifact sandbox has none of these, and `remotion` / `@remotion/player` are not in the artifact import allowlist. |
| Renders that hang or die on first run | Remotion downloads its Chrome Headless Shell lazily on the first render. On a slow or restricted network that surfaces as a render error, not a download error. |
| SVG that renders blank | SVG is XML. `<rect>` without a closing slash, `&nbsp;`, a missing `xmlns`, a `<script>` block, or an external `href` will each produce an empty frame with no useful message. |
| No feedback loop | Without rasterization, nobody can see whether the markup worked. The model guesses, you paste the error back, repeat. |

This server addresses each one directly. Every tool that can fail returns a specific next step rather than a stack trace.

## Install

```bash
cd remotion-viz-mcp-server
npm install
npm run build
```

Node 18 or newer. Roughly 200 packages. `puppeteer` is an **optional** dependency used only by `viz_render_html`; if its Chrome download fails, everything else still works. To skip it deliberately:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

Verify:

```bash
node dist/index.js --help
node smoke-test.mjs      # 32 assertions over real JSON-RPC
```

## Connect it

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "remotion-viz": {
      "command": "node",
      "args": ["/absolute/path/to/remotion-viz-mcp-server/dist/index.js"],
      "env": {
        "REMOTION_MCP_WORKSPACE": "/absolute/path/to/your/projects"
      }
    }
  }
}
```

Restart Claude Desktop. On Windows use double backslashes in paths.

### Claude Code

```bash
claude mcp add remotion-viz \
  --env REMOTION_MCP_WORKSPACE=/absolute/path/to/your/projects \
  -- node /absolute/path/to/remotion-viz-mcp-server/dist/index.js
```

### MCP Inspector

```bash
npm run inspect
```

## `REMOTION_MCP_WORKSPACE`

Every file path argument is resolved against this directory and **cannot escape it**. Symlinks are resolved before the check, so a symlink pointing outside is rejected rather than followed. Set it explicitly: when unset it falls back to the server process working directory, which under Claude Desktop is not somewhere you want.

Call `remotion_get_workspace_info` if a path is ever rejected.

## Tools

### Diagnostics

| Tool | Does |
| --- | --- |
| `remotion_check_environment` | Checks Node version, Remotion install, entry point, Chrome Headless Shell, FFmpeg. Returns a fix per failure. **Run this first when anything breaks.** |
| `remotion_ensure_browser` | Downloads the Chrome Headless Shell up front so the first real render is not what discovers it is missing. Idempotent. |
| `remotion_get_workspace_info` | Reports the workspace root and how it was configured. |

### Remotion

| Tool | Does |
| --- | --- |
| `remotion_init_project` | Scaffolds a minimal, correct Remotion 4 project. Refuses to overwrite a non-empty directory. |
| `remotion_list_compositions` | Lists compositions with dimensions/fps/duration. Bundles the project, so it doubles as the cheapest compile check. |
| `remotion_render_still` | Renders one frame to PNG **and attaches it to the response**, so Claude can see the result. |
| `remotion_render_video` | Renders to h264/h265/vp8/vp9/prores/gif/mp3/aac/wav, with frame ranges, scale and concurrency. |
| `remotion_start_studio` / `remotion_stop_studio` | Runs the Studio dev server detached. Stop only accepts PIDs this server started. |

### Visualization

| Tool | Does |
| --- | --- |
| `viz_validate_svg` | Lints SVG against what renderers actually enforce. Milliseconds, no files, no network. |
| `viz_render_svg` | Rasterizes to PNG via resvg and attaches it. Refuses invalid SVG rather than emitting a blank image. |
| `viz_render_html` | Screenshots HTML via headless Chrome. Reports page script errors instead of returning a blank capture. |

## The two workflows

**Remotion.** `remotion_check_environment` → `remotion_ensure_browser` → `remotion_init_project` (if needed) → `remotion_list_compositions` → `remotion_render_still` at `scale=0.5` until a frame looks right → `remotion_render_video` with a short `frames` range → full render.

The still step is the point. A still takes seconds; a full render takes minutes. Most layout, colour and timing mistakes are visible in one frame.

**Visualization.** `viz_validate_svg` → fix what it names → `viz_render_svg` → look at the PNG → iterate.

## What `viz_validate_svg` catches

| Code | Severity | Why it matters |
| --- | --- | --- |
| `malformed_xml` | error | SVG is XML. HTML tolerates unclosed tags; SVG does not. |
| `html_entity_in_xml` | error | `&nbsp;` `&mdash;` `&eacute;` are undefined in XML. Use `&#160;` etc. |
| `missing_xmlns` | error | Standalone rasterizers refuse a document without it. |
| `script_element` | error | Sandboxes strip it, often taking the graphic with it. |
| `external_reference` | error | Network fetches are blocked during rendering; the element silently vanishes. |
| `bad_viewbox` / `zero_viewbox` | error | A zero-area viewBox draws nothing. |
| `missing_viewbox` | warning | The graphic will not scale to its container. |
| `foreign_object` | warning | resvg ignores it entirely, so content disappears in exported PNGs. |
| `external_font_or_css` | warning | The import fails silently and text falls back to a default font. |
| `very_large_document` | warning | Slow to rasterize; inline renderers may reject it outright. |

## Security posture

- **stdio only.** No network transport. This server spawns processes and writes files, so it is built to run as a subprocess of one trusted client.
- **No shell.** Every command is spawned with an explicit argv array and `shell: false`. Composition ids, props JSON and filenames can never be interpreted as shell metacharacters.
- **Workspace confinement.** All paths resolve through one choke point that rejects traversal, including via symlinks.
- **Input validation.** Zod schemas on every tool: composition ids are charset-restricted, `props_json` must parse as a JSON object before any process is spawned, dimensions and scale are range-capped.
- **Bounded resources.** Child output capped at 400 KB, responses at 25,000 characters, source input at 2 MB, inline images at 1.5 MB, timeouts at 30 s / 5 min / 30 min by command class.
- **Scoped process control.** `remotion_stop_studio` only accepts PIDs recorded by this server in the current session.

## Troubleshooting

| Symptom | Do this |
| --- | --- |
| Server does not appear in Claude | Use an absolute path to `dist/index.js`. Run `node dist/index.js --help` manually first. |
| "resolves outside the workspace root" | `remotion_get_workspace_info`, then set `REMOTION_MCP_WORKSPACE` to a directory containing your project. |
| "could not determine executable to run" | No local Remotion install; the server fell back to npx. Run `npm install` in the project. |
| Render hangs on first run | `remotion_ensure_browser`. It is downloading Chrome. |
| Render dies with a heap error | `concurrency=2`, `scale=0.5`. |
| `viz_render_html` unavailable | `npm install puppeteer` in this directory, then restart. |
| Text renders in the wrong font | Fonts must exist on the system or be embedded as a base64 data URI. resvg does not fetch remote fonts. |

## References

- Remotion CLI: https://www.remotion.dev/docs/cli
- `remotion render`: https://www.remotion.dev/docs/cli/render
- `remotion still`: https://www.remotion.dev/docs/cli/still
- Stills overview: https://www.remotion.dev/docs/stills
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP specification: https://modelcontextprotocol.io/specification
- resvg-js: https://github.com/thx/resvg-js

## License

MIT

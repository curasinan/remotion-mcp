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

Node 18 or newer. `viz_render_html` needs a Chrome/Chromium/Edge/Brave already
on the machine, or `PUPPETEER_EXECUTABLE_PATH` pointing at one; nothing is
downloaded. Every other tool works without a browser.

Verify:

```bash
node dist/index.js --help
npm test            # unit, protocol and process-lifecycle regression tests
node smoke-test.mjs # 32 assertions over real JSON-RPC
```

CI runs the test suite plus type-check, `npm audit` and SBOM generation on
Windows, macOS and Linux; see `.github/workflows/ci.yml`.

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

## Configuration

All configuration is through environment variables; there is no config file (see
`docs/adr` and `docs/BUNDLE.md`). Invalid values stop the server at startup with
a specific message rather than failing later.

| Variable | Default | Effect |
| --- | --- | --- |
| `REMOTION_MCP_WORKSPACE` | process cwd | Directory every file path resolves against and cannot escape. Set it explicitly; the cwd under Claude Desktop is not where you want it. |
| `REMOTION_MCP_ALLOWED_HOSTS` | empty (deny all) | Comma-separated hostnames `viz_render_html` may load from. Loopback, private and link-local stay blocked regardless. |
| `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` | auto-detect | Chrome binary for `viz_render_html`, if auto-detection fails. |
| `REMOTION_MCP_DISABLE_BROWSER_SANDBOX` | unset | Set to `1` only in an environment that cannot provide a Chrome sandbox. It weakens the boundary around rendered HTML; leave it unset. |

Every file path argument is resolved against the workspace root and **cannot
escape it**, symlinks resolved before the check. Call `remotion_get_workspace_info`
if a path is ever rejected.

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

## Security model

This is a high-privilege tool by design. It spawns child processes, compiles and
runs code out of the workspace, starts a headless browser, and writes files to
paths passed as tool arguments. The model below is what keeps that capability
from being turned against the machine it runs on. It assumes **the client is
trusted but the content is not**: the model may be steered by a shared project,
a web page it read, or a file it was handed, so every control has to hold even
when the model is fooled.

**What it does not do**

- No network transport. stdio only, so the only thing that can reach the server
  is the process that launched it. See `docs/adr/0001-transport-stdio-only.md`.
- No shell. Every command is spawned with an explicit argv array and
  `shell: false`, and tool arguments are validated so they cannot become CLI
  flags: a value like `--config=…` in an output path or composition id is
  rejected, not passed through.
- No reading files off disk through a rendered SVG. `viz_render_svg` refuses any
  `<image href>` that is not a `data:` URI, so it cannot be used to read local
  files into the returned image.
- No network access while rendering HTML. `viz_render_html` denies all requests
  by default; `REMOTION_MCP_ALLOWED_HOSTS` opts specific hosts back in, and
  loopback, private and link-local addresses stay blocked regardless.

**What confines it**

- **Workspace confinement.** Every file path resolves against the workspace root
  and cannot escape it, symlinks resolved, and the parent directory is
  re-checked after creation. This governs writes and, since the SVG change,
  reads too. Choose the narrowest workspace that holds your work: `viz_render_svg`
  can decode image files anywhere beneath it.
- **Input validation.** Zod schemas on every tool. Composition ids and entry
  points are charset-restricted and may not begin with `-`; output paths may not
  contain a flag-like segment; `props_json` must parse as a JSON object before
  any process is spawned; dimensions and scale are range-capped.
- **Bounded resources.** One browser and two CLI runs at a time, past which
  calls are refused with a clear message. Raster output is capped by total pixel
  count, so a tall SVG cannot exhaust memory. Child output 400 KB, responses
  25,000 characters, source input 2 MB, inline images 1.5 MB; page load bounded
  at 30 s including a script that blocks the renderer.
- **Process lifecycle.** Timeouts kill the whole process tree, not just the
  direct child, and a wedged browser is force-killed. `remotion_stop_studio`
  accepts only PIDs this server started, checks they are still alive, and its
  registry survives a restart so an orphaned Studio can still be stopped.
- **Audit trail.** Every tool call is logged to stderr as one JSON line, with
  large arguments summarised rather than dumped.

**What it is not**

- Not a defence against a malicious *client*. A client that can call these tools
  can already run code on the machine; the model above is about untrusted
  content reaching a trusted client, not about the client itself.
- Not immune to prompt injection. No output filter can be, so the defences are
  capability limits that hold regardless: untrusted CLI output is length-bounded
  and cannot forge a markdown fence, but the real protection is that a fooled
  model still cannot escape the workspace, read arbitrary files, or reach the
  network.
- Not hardened against a native crash inside resvg beyond the known size bug.
  That residual risk is accepted and explained in `docs/adr/0003-isolation-boundary.md`.

The architecture decisions behind this are recorded in `docs/adr/`, and the
`.mcpb` bundle's requested permissions in `docs/BUNDLE.md`.

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

## Further reading

- Tool reference: [`docs/TOOLS.md`](docs/TOOLS.md)
- Architecture decisions: [`docs/adr/`](docs/adr/)
- Bundle permissions and dependency auditing: [`docs/BUNDLE.md`](docs/BUNDLE.md)

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

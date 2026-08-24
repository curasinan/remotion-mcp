# Building and auditing the `.mcpb` bundle

The `.mcpb` is a zip: `manifest.json`, the compiled `dist/` under `server/`, the
runtime `node_modules`, and an icon. This document says what the bundle asks for
and how to check it, because a bundle user never runs `npm install` and so never
sees a lockfile or an advisory unless they go looking.

## What the bundle requests

The manifest declares its inputs in `user_config`, which the host maps to
environment variables at launch:

| Setting | Required | Default | Effect |
| --- | --- | --- | --- |
| Workspace directory | yes | **none** | `REMOTION_MCP_WORKSPACE`. Every file path resolves against it and cannot escape it. `viz_render_svg` can read image files anywhere beneath it, so it should be the narrowest folder that holds your work. |
| Chrome executable | no | auto-detect | `PUPPETEER_EXECUTABLE_PATH`. Only `viz_render_html` needs it, and only if auto-detection fails. |
| Allowed network hosts | no | empty (deny all) | `REMOTION_MCP_ALLOWED_HOSTS`. Comma-separated hostnames `viz_render_html` may load from. |

The workspace has **no default**. An earlier bundle defaulted it to `${HOME}`,
which combined with the SVG file-read finding meant the whole home tree was
reachable. The user now chooses the directory deliberately.

## Capabilities the running server exercises

The bundle grants a Node process, and that process:

- **spawns child processes** — the Remotion CLI, `npm`/`npx`, and a headless
  browser. Never through a shell: `spawn` is called with an explicit argv array
  and `shell:false`, and tool arguments are rejected before they can become CLI
  flags.
- **executes workspace code** — `remotion_list_compositions` and the render
  tools bundle and run the project's own TSX/JS. This is inherent to Remotion;
  it is why those tools are annotated `readOnlyHint:false, openWorldHint:true`.
- **starts a headless browser** — `viz_render_html`, sandbox on, with no network
  access unless a host is allowlisted. Loopback, private and link-local
  addresses stay blocked regardless.
- **writes files** — only under the workspace root, re-checked after directory
  creation.
- **reads image files** — `viz_render_svg` will decode an image referenced by a
  `data:` URI. It refuses any other reference, so it cannot read files off disk.

## Checking the dependencies without reinstalling

The bundle is a zip and carries a full lockfile, so "am I affected by advisory
X" is answerable without touching the install:

```bash
unzip -p remotion-viz-1.1.0.mcpb node_modules/.package-lock.json > pl.json
# then run npm audit against a directory holding pl.json as package-lock.json
npm audit --package-lock-only
```

The three `npm audit` "high" advisories that appear against this tree are all in
`extract-zip` via `@puppeteer/browsers`, on the browser-download path this
server never calls (`puppeteer-core` does not import `install`). They are
documented as unreachable rather than force-upgraded; see the CI notes.

## Rebuilding

`npm run build` compiles `src/` to `dist/`. The bundle's `server/` must be
`dist/` from the same commit as its `manifest.json`; `verify-roundtrip.mjs`
checks a built tree against an installed one byte for byte.

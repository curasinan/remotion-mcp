# Template pack contract

A template pack is the Remotion project a deployment of the service profile
renders. The deployment's operator builds it with `scripts/build-pack.mjs` and
bakes the result into their own derived image. No tool accepts code with a
request: a pack is the operator's code, and its risk is theirs (design §1,
ruling 7).

| Piece | Where |
| --- | --- |
| Design | [design §5.4](superpowers/specs/2026-10-26-service-profile-v2-design.md) |
| Builder | `scripts/build-pack.mjs` |
| zod 4 gate and discovery | `scripts/lib/zod-gate.mjs` |
| Loading `src/Root`, and each composition's checks in order | `scripts/lib/pack-templates.mjs` |
| packHash, dependencies and the output dir | `scripts/lib/pack-files.mjs` |
| JSON Schema gate and loader | `src/service/templates.ts` (`checkSchemaVocabulary`, `loadPack`) |
| Limits both gates share | `src/service/constants.ts` (`MAX_TEMPLATE_ID`, `MAX_SCHEMA_DEPTH`, `MAX_EXPANDED_NODES`) |
| Tests | the build side: `test/zod-gate.test.mjs`, `test/build-pack.test.mjs` and `test/pack-files.test.mjs`; the service side: `test/templates.test.mjs` |
| Fixture pack | `fixtures/pack/`, built by the CI `pack` job ([CI.md](CI.md)) |

## Building a pack

```
npm ci && npm run build:service            # in this repository: build-pack loads the service's own gate
npm ci --prefix <project>                  # on Linux
node scripts/build-pack.mjs <project> [--out <dir>]
```

If build-pack cannot load its own rules from `scripts/lib/`, it prints why:
`cannot load scripts/lib/pack-templates.mjs: <error>`. It suggests
`npm run build:service` only when `dist-service/` lacks a module or an export
the rules import, as a service build older than the scripts does.

**The project needs:**
- `package.json` and `package-lock.json`. The derived image installs the pack
  with `npm ci --omit=dev`.
- An entry point at `src/index.ts`. `src/index.tsx`, `src/index.js` and
  `src/index.jsx` also work.
- `src/Root.tsx`, `.jsx`, `.ts` or `.js`, exporting the component as
  `RemotionRoot`.
- **The entry point must call `registerRoot(RemotionRoot)` with the
  `RemotionRoot` from `src/Root`.** Discovery reads `src/Root`, but the bundle
  registers whatever `src/index` registers. An entry that registers another
  root ships compositions the manifest never checked.

**What build-pack does, in order.** Any failure exits 1 and prints every
problem found. A problem with a composition starts with its id.
1. **Bundles** the project with the project's own `remotion bundle`, or with
   `@remotion/bundler`'s `bundle()` when the CLI has no `bundle` command. A
   fallback logs why: `@remotion/cli` did not resolve (with the error),
   `remotion bundle --help` could not be started (with the spawn error), or
   it exited non-zero.
2. **Loads `RemotionRoot`** by bundling a generated entry with the project's
   own esbuild. It then calls `RemotionRoot()` in Node.
3. **Discovers** the compositions in the tree it returns.
4. **Checks each schema:**
   1. the zod gate below
   2. export with the project's own `z.toJSONSchema`
   3. a check that every bound the gate accepted survived the export
   4. the service's JSON Schema gate
5. **Writes** `<out>` (default `<project>/dist-pack/`): `pack-manifest.json`,
   `bundle/`, and copies of `package.json` and `package-lock.json`.
6. **Loads** the result with the service's own `loadPack`, so a pack the
   service would refuse is never built.

**The output dir is replaced.** An existing `--out` may hold only what
build-pack writes: `pack-manifest.json`, `bundle/`, `package.json` and
`package-lock.json`. Anything else is refused, never deleted. A build that
fails after it has emptied or created the output dir removes it, so no
half-built pack is left behind. A build that fails before that point leaves
an existing output dir as it was: a bad command line, a missing or stale
`dist-service/`, rules that will not load, a missing `package.json` or
`package-lock.json`, a dependency rule, an uninstalled renderer, or an output
dir build-pack refuses. So check build-pack's exit status before you build an
image.

**Build on Linux.** The derived image runs its own `npm ci --omit=dev`, so a
pack never ships a `node_modules` built on Windows or macOS (design §5.4).

## The manifest

```json
{
  "packHash": "sha256:<64 hex digits>",
  "remotionVersion": "4.0.532",
  "templates": [
    {
      "id": "swatch",
      "compositionId": "swatch",
      "width": 1280,
      "height": 720,
      "defaultFps": 30,
      "maxFrames": 1,
      "propsSchema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "...": "..." }
    }
  ]
}
```

| Field | What it holds |
| --- | --- |
| `packHash` | `sha256:` plus the hex SHA-256 over every file under `bundle/`. Files are sorted by their `/`-separated relative path, compared by UTF-16 code unit. For each file, the hash covers its path relative to `bundle/` in UTF-8, a NUL byte, its byte length as decimal ASCII digits, a NUL byte, then its bytes. |
| `remotionVersion` | the `version` of the *installed* `@remotion/renderer`, never the declared range |
| `templates[].id` | the composition id, verbatim |
| `templates[].compositionId` | the same id, passed to `remotion still` |
| `width`, `height` | the composition's static size |
| `defaultFps` | its `fps` |
| `maxFrames` | its `durationInFrames`. `render_still` accepts frames from 0 to `maxFrames - 1`. |
| `propsSchema` | the schema's export: JSON Schema draft 2020-12, from the pack's own `z.toJSONSchema` |

The service checks `packHash` and `remotionVersion` only as non-empty strings.
It treats `packHash` as an opaque label: it never re-hashes `bundle/`, and
never compares `remotionVersion` with the renderer installed in the image,
which its startup check reads for itself. Nor does it check that `id` equals
`compositionId`; build-pack writes them equal.

`packHash` identifies the exact bundle: it changes whenever any byte of
`bundle/` does. build-pack bundles with `--disable-git-source`, so the commit a
pack was built from is not in it. Remotion 4.0.532's `index.html` does record
four things beyond the sources:
- the directory the pack was built in (`window.remotion_cwd`, also in some
  source maps)
- that directory's name (`window.remotion_projectName`)
- each `public/` file's modification time (`window.remotion_staticFiles`)
- the build host's CPU count (`maxConcurrency` in
  `window.remotion_renderDefaults`, and `concurrency` beside it: half the CPU
  count, rounded, from 1 to 8)

So a rebuild of the same checkout on the same host gives the same hash, but a
fresh checkout, another directory or another machine, as in CI, gives a new
one. A hash identifies one build; it does not prove two builds came from the
same sources.

**The template-id rule.** A template's id is its composition's id, verbatim.
- Remotion allows `a-z`, `A-Z`, `0-9`, `-` and CJK characters. The service also
  refuses a leading `-`, because the CLI would read it as a flag.
- Ids must be unique.
- An id may be at most 100 characters (`MAX_TEMPLATE_ID`, counted in UTF-16
  units), the longest `template_id` that `render_still` accepts.

The service's `loadPack` applies the whole rule at startup to each `id`, and
the character rule to each `compositionId`, so a manifest written by hand
cannot list a template that `render_still` could never accept. build-pack's
discovery refuses an id over 100 characters, and its final `loadPack` applies
the rest.

## Registering compositions

build-pack calls `RemotionRoot()` in Node, without rendering it, and walks the
elements it returns.

**Where a composition must sit.** Register every composition directly in that
tree. It may sit inside fragments, arrays, `<Folder>` and other elements.
- Discovery looks into every element's `children` prop without rendering the
  element. **Any element around a `<Composition>` must render its children**,
  as `<Folder>` does. A wrapper that drops them would list a composition
  Remotion never registers.
- A component that registers compositions from its own render is not seen.
- `RemotionRoot` must not call hooks.
- A `<Still>` counts as one frame at 1 fps, as in Remotion.

**Module scope must be safe in Node.** Every module `src/Root` imports is
loaded in Node. Do not call `loadFont`, `delayRender` or any browser API at
module scope. Start the work on first render instead, as the fixture's
`Swatch.tsx` does with its font. A module that fails as it loads is reported
in one line:
`loading src/Root in Node failed: <message>; module scope must not use browser APIs (docs/CONTRACT-pack.md)`.

The design lists four discovery limits as untested: `<Folder>`, hooks,
module-scope font loading and pnpm layouts. build-pack now walks `<Folder>`
children, and reports a module that touches `document` or `FontFace` as it
loads. Only the unit tests exercise those, with hand-built elements and
hand-written modules, not a real Remotion project.

**Every composition must declare a static `width`, `height`, `fps` and
`durationInFrames`.** The manifest records them, and `render_still` checks a
request's frame and raster size against them before it renders. Width times
height may be at most 64 000 000 pixels (`MAX_RASTER_PIXELS`). build-pack's
final `loadPack` refuses a larger composition, and so does the service at
startup.

**Every composition must declare a `schema`.** One without a schema is
refused by its id. Props are validated against nothing else.

**The `calculateMetadata` rule.** A composition may have `calculateMetadata`,
but it still needs a static `width` and `height`, or it is refused. The service
always passes the manifest's width, height and frame to the CLI explicitly, so
a size `calculateMetadata` computes is overridden. A duration it computes that
is shorter than the static `durationInFrames` makes the later frames fail with
`render_failed`.

## The zod gate (build time)

Only zod 4 is accepted. A zod 3 schema is refused with
`<root>: zod 3 is not supported, use zod 4`. The gate reads each node's own
definition and the checks of every node type, so a `.refine` on an enum, a
literal or an optional is still found.

**Allowed:**
- strict objects (`z.strictObject`); the root must be one
- strings with a max (`.max(N)` or `.length(N)`), optionally with at most one
  `.regex()`, without flags. zod exports a second regex as `allOf`, which the
  service refuses, so the gate refuses it first: `at most one .regex() per
  string`. Combine the patterns into one.
- numbers with a lower bound and an upper bound, inclusive (`.min`, `.max`)
  or exclusive (`.gt`, `.lt`), including `.int()` and `z.int()`
- booleans, enums and literals
- arrays with a max (`.max(N)` or `.length(N)`)
- `.optional()` of any of these

**Refused**, each reported as `<path>: <rule>`:
- `url`, `email` and every other string format, whether written as
  `z.url()` or `z.string().url()`
- anything unbounded: a string or array without a max, a number without both
  bounds, and an object that is not strict (`z.object`, `.passthrough()`, or a
  `.catchall()` other than `z.never()`)
- `custom` checks (`.refine`, `.superRefine`) and `overwrite` checks
  (`.trim`, `.toLowerCase`, `.toUpperCase`, `.normalize`), on any type
- pipes and transforms (`.transform`, `z.preprocess`, `.pipe`)
- any check the gate does not know, such as `.multipleOf`
- a regex with flags: the export keeps only its source
- a second `.regex()` on one string
- `any`, `unknown`, `record`, `union` and every other type, including
  `.default()`, `.nullable()` and `z.lazy()`
- a recursive schema, and a schema nested more than 64 levels deep
- a schema of more than 10 000 nodes, a subschema used more than once counted
  at each use, as its export repeats it. The message is
  `<root>: schema expands past 10000 nodes, counting a shared subschema at each use`.
  An `.optional()` is no node of its own.

The longest composition id (100), the depth (64) and the node budget (10 000)
are the service's own values. build-pack reads them from
`dist-service/service/constants.js`, so the two gates' limits cannot drift
apart.

A path starts at `<root>`. `.name` steps into a property, `["a b"]` into a
property whose name is not an identifier, and `[]` into an array's elements.

**After the export**, build-pack checks that every bound the gate accepted is
still in the JSON Schema, and fails if one is missing. The bounds are lengths,
item counts, patterns, number bounds, strict objects, required fields, enums,
literals and types. An exported bound at least as tight still counts. The
export must also admit nothing zod refuses:
- For an enum or a literal, the export's `enum` and `const` must name at
  least one value, and only values zod accepts.
- A strict object's export may name only the properties its shape has.
  `additionalProperties: false` refuses only the names `properties` lacks, so
  an extra name would be admitted.
- Every string, number, boolean, array and object node keeps its `type`, and
  names no other. An integer (`.int()`, `z.int()`) must stay `integer`; a
  number exported as `integer` is tighter, and counts.

Each of these fails with `<path>: the export admits <what>, which zod refuses`,
or with `<path>: type <type> missing from the export`. `.meta()` writes its
keywords straight into the export, which is how an export comes to differ
from its zod schema.

## The JSON Schema gate (service startup)

The service applies this gate to every `propsSchema` it loads. It refuses to
start on a pack that fails, because it cannot trust that the deployer ran the
build gate.
- The root is `type: "object"`, since `render_still`'s `props` is always an
  object. A root of another type, or one that is only an `anyOf` or a
  `$ref`, is refused.
- Every node is a JSON object: a boolean schema (`true` or `false`) is
  refused. A node's `type` is one string, never an array such as
  `["string", "null"]`, and a node without `type` must carry `enum`, `const`,
  `anyOf` or `$ref`.
- Every object has `additionalProperties: false`.
- Every array has `maxItems` and `items`.
- Every string has `maxLength`, unless it has a `const` or a non-empty `enum`.
- Every number and integer has a lower bound (`minimum` or `exclusiveMinimum`)
  and an upper bound (`maximum` or `exclusiveMaximum`), unless it has a
  `const` or a non-empty `enum`.
- The vocabulary is closed. A node may carry only `type`, `properties`,
  `required`, `additionalProperties`, `items`, `minItems`, `maxItems`,
  `minLength`, `maxLength`, `pattern`, `enum`, `const`, the four number
  bounds, `anyOf`, `$ref`, `title`, `description`, `default` and `examples`.
  The root may also carry `$schema`, which must be draft 2020-12, and `$defs`.
  There is no `format`.
- A `$ref` must be `#/$defs/<name>` and name an existing def. Def names use
  `A-Z a-z 0-9 _ . -`. Recursive refs are refused.
- A schema may nest at most 64 deep, and expand, each `$ref` in place, to at
  most 10 000 nodes. A `default`, `examples`, `const` or `enum` value may nest
  at most 64 deep.
- ajv must then compile the schema in strict mode. A schema it refuses stops
  the service too.

The same startup check, `loadPack`, also refuses a manifest whose `packHash`
or `remotionVersion` is not a non-empty string, whose `templates` is not a
non-empty array, or that has a template without a positive integer `width`
and `height`, a positive `defaultFps` and an integer `maxFrames` of at least
1. It refuses a duplicate id, an id or `compositionId` outside
[the template-id rule](#the-manifest), a raster over `MAX_RASTER_PIXELS`
([above](#registering-compositions)), and a pack whose `bundle/index.html` is
not a file. It names every problem it finds, located in the manifest.

**Props at request time.** Props are validated with ajv against `propsSchema`
itself, so no zod runs in the service. ajv runs with `allErrors` off, so it
stops at the first failing keyword in the whole props object, not at the first
in each prop. `invalid_props` therefore names the first failing JSON pointer,
in ajv's order of checks rather than the props' order, never every failing
prop, and never a value. A failed `anyOf` can add the first failure inside
each of its branches. A missing required prop and a prop the schema does not
name each get their own pointer, such as `/label`. A backend that wants every
failure validates against `propsSchema` itself. `allErrors` stays off so that
`maxLength`, `enum` and `const` run before `pattern`.

## One contract for the backend

`list_templates` returns each template's `id`, `width`, `height` and
`propsSchema`. A backend validates props against that published JSON Schema.
That is the same schema the service enforces, so there is one contract.
Validate against `propsSchema`, not against the pack's zod source.

## Authoring guidance

**String length.**
- zod's `.max(N)` counts UTF-16 code units. The service, through ajv and JSON
  Schema, counts code points.
- An emoji outside the Basic Multilingual Plane is 2 units to zod and 1 to
  the service. So a string the service accepts can be longer than zod's limit
  in UTF-16 units, up to twice as long.
- If the template's own code relies on zod's limit, size `.max(N)` for the
  UTF-16 length.

**Regexes must run in linear time.**
- ajv checks `maxLength` before `pattern`, so a caller's string is bounded
  before the regex runs.
- A pattern with catastrophic backtracking still blocks the service's event
  loop, and every request with it, even on a bounded string. Examples are
  nested quantifiers such as `(a+)+` and overlapping alternations such as
  `(a|a)*`.
- Anchor patterns (`^...$`) and keep them simple.

**Keep `maxItems` times the item's size modest.** Each array's bound
multiplies everything under it. 22 players of a few short strings each is
fine. 1 000 items of 1 000-character strings is a megabyte of props. The
service caps request bodies at 256 KiB anyway.

**Replacements for Remotion's zod helpers.** `@remotion/zod-types` helpers fail
the gate: each is unbounded, and `zColor` and `zMatrix` also carry a refine.

| Helper | What it is | Use instead |
| --- | --- | --- |
| `zColor()` | `z.string()` with a refine that parses any CSS colour | `z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/)` |
| `zTextarea()` | `z.string()` with no max | `z.string().max(N)` |
| `zMatrix()` | a flat `z.array(z.number().step(0.01))` with a refine that its length is a square | a fixed size, such as 3 × 3: `z.array(z.number().min(-1000).max(1000)).length(9)` |

**Optional props.** `.default()` is refused because the service never runs
zod, so a zod default would never be applied. Use `.optional()` and handle the
absent value in the component.

## Self-contained packs (ruling 6)

A deployment's container has no outbound route, and cloud metadata is blocked
([design §1](superpowers/specs/2026-10-26-service-profile-v2-design.md),
ruling 6). A pack must render with no network at all:
- **Fonts and images inside the pack.** Put them in `public/` and load them
  with `staticFile()`. Load fonts with `@remotion/fonts`' `loadFont`. Never
  use a web font such as `@remotion/google-fonts` or a CSS `@import` of a
  font URL.
- **No fetches.** No `fetch`, no remote `<Img>` or `<Video>` source, and no
  `calculateMetadata` that calls an API.
- **Props are untrusted tenant input.** A tenant chooses every value the
  schema admits. Remotion 4.0.532 launches Chrome with `--no-sandbox`
  (`@remotion/renderer/dist/open-browser.js:149`), and loopback stays
  reachable from a render: egress denial leaves it open, and it holds the
  service's own port and, while the render runs, Remotion's own server, whose
  `/proxy?src=` downloads any URL it is given
  ([`DEPLOY.md`](DEPLOY.md#ingress-only-your-proxy-only-service_port)). So
  pack code must never:
  - fetch a prop, or use one as a URL: not as the `src` of an `<Img>`,
    `<OffthreadVideo>`, `<Video>` or `<Audio>`, not as an `href`, and not in
    a CSS `url()`;
  - `eval` a prop, or hand one to `new Function` or a `<script>`;
  - inject a prop as HTML, as `dangerouslySetInnerHTML` does, or as raw CSS
    text.

  Render a prop as text. To let a tenant pick an asset, give the prop a
  `z.enum` of the pack's own file names and pass the chosen name to
  `staticFile()`.
- **Ship each asset's licence with it.** The fixture pack ships DejaVu Sans
  Bold 2.37 with `public/LICENSE-DejaVu.txt`. That file is the licence text the
  font carries in its own `name` table: name ID 0, the copyright lines, as a
  header, then name ID 13, verbatim. It covers the Bitstream Vera glyphs
  (Bitstream, Inc.) and the Arev glyphs (Tavmjong Bah), and states that the
  DejaVu changes are in the public domain. The Bitstream Vera and Arev
  licences each permit redistribution only with their copyright and
  permission notice.

## Dependencies

`remotion` and every `@remotion/*` package go under `dependencies`, never
`devDependencies`. The derived image installs with `npm ci --omit=dev`, and the
service runs the pack's own `@remotion/cli` and `@remotion/renderer`. build-pack
refuses a `package.json` that puts any of them under `devDependencies`. It also
refuses one that lacks `@remotion/cli` or `@remotion/renderer` under
`dependencies`. Pin exact versions. The service's startup check requires the
installed renderer to be at least 4.0.458.

## The fixture pack

`fixtures/pack/` is this repository's own pack. It pins Remotion 4.0.532,
zod 4.5.4 and React 19.2.3. It has two templates:
- **`swatch`.** A 1280 × 720 still with
  `z.strictObject({ label: z.string().max(80), color: z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/) })`.
  It renders the label in white, 96 px bold, in the pack's DejaVu Sans Bold,
  centred on the colour. `props/turkish.json` exercises Turkish glyphs.
- **`slow`.** A 64 × 64 still with `z.strictObject({})`. It never finishes its
  frame, because it holds a `delayRender` with a 120 s timeout. That is longer
  than the CLI's `--timeout` (60 s), which is longer than the service's 45 s
  deadline. So the service deadline is what ends it.

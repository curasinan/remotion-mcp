# Service Profile v2 Implementation Plan (final_script)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** By 2026-11-20, ship an installable service image on which a still render, requested under the owner's gateway contract, comes back as an inline PNG. The image must keep the four dangerous tools structurally absent, and must leave no render process orphaned.

**Architecture:**
- **Request path.** A `node:http` server verifies an HMAC identity header against the raw request body. It then creates a fresh `McpServer` and a fresh stateless transport for each request.
- **Tools.** The four tools come from one registration site. `render_still` spawns the pack's Remotion CLI directly against a prebuilt bundle.
- **Packs.** Template packs are baked into a derived image that the deployer builds. A pack's props contract is a JSON Schema, which ajv enforces.
- **Two profiles, one tree.** The stdio local-dev profile and the HTTP service profile are separate builds of the same source tree.

**Tech Stack:**
- TypeScript 5.9, Node 22+
- `@modelcontextprotocol/sdk` 1.30.0 (`server/streamableHttp.js`, `inMemory.js`)
- ajv 8 (draft 2020-12)
- zod 4, in packs only
- `node:test`
- Docker on `node:22-bookworm-slim` (linux/amd64)
- Remotion ≥ 4.0.458; the fixture pack pins 4.0.532

**Spec:** `docs/superpowers/specs/2026-10-26-service-profile-v2-design.md`. It holds the owner's rulings, the spike evidence of 2026-10-25, and the owner-approved calls in its §8. Read it alongside this plan.

**Supersedes:** `docs/superpowers/plans/2026-10-17-tacticlens-service-profile.md`. Task 1 marks that file superseded.

**Already on this branch's ancestry:**
- PR #18: the `tsconfig.json` exclusion, with `test/profiles.test.mjs`.
- PR #20: `requireEntryPoint` lifted into `src/services/entrypoint.ts`.

Baseline: `npm test` gives 116 pass, 0 skipped.

**How this plan was checked.** An adversarial review with four lenses confirmed 104 findings against an earlier draft, and every fix is folded in below. The Remotion facts it relies on were read from the installed 4.0.532 sources:
- The CLI's `--timeout` is a Node-side wait. It defaults to 30 000 ms and adds 3 000 ms (`@remotion/renderer/dist/seek-to-frame.js:45`).
- `browser ensure` takes no destination. It installs under `<nearest package.json dir>/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/`.
- No `REMOTION_DISABLE_BROWSER_DOWNLOAD` switch exists. Passing `--browser-executable` is what prevents a download.

## Deviations from the design (for the owner to confirm)

1. **No `project-shape.ts` split** (design §8 call 7).
   - The service renders against a prebuilt bundle. It never needs `requireEntryPoint`, `environment.ts` or `browser.ts`.
   - Task 8's closure check fails if `environment` or `browser` appears in `dist-service/`. The split is unnecessary, and the check enforces that.
2. **The SDK's own argument-validation errors pass through unchanged.** Examples are a non-string `template_id` or a non-object `props`. These messages describe the caller's own arguments. Every error this code raises still follows design §5.5.
   - The same goes for the SDK's `Tool <name> not found` reply to an unknown tool (`server/mcp.js:104`). It echoes back only the caller's own `params.name`.
3. **`invalid_props` names the failing JSON pointer paths, and never their values.** That lets the backend see which prop failed.

## Global Constraints

**The profiles**
- **Service tools.** Exactly four: `list_templates`, `render_still`, `render_video_start`, `render_job_status`. The last two return `not_implemented`.
- **Absent from the service closure.** `viz_render_html`, `remotion_list_compositions`, `remotion_init_project` and `remotion_start_studio` must be missing from the compiled closure itself, not refused at runtime.
- **Local-dev is unchanged.** It keeps its 13 tools over stdio. `test/bundle.test.mjs` is never edited, and it keeps passing.

**Identity**
- **Header.** `X-Render-Identity` = `base64url(claims) "." base64url(HMAC-SHA256(key, base64url(claims)))`.
- **Claims.** `{v:1, request_id, principal, tenant, aud, tool, body_sha256, iat, exp}`. The `_meta` key is `io.github.curasinan/request_id`.
- **Time rules.**
  - skew 30 s
  - `exp − iat` ≤ 120 s
  - `iat` ≥ (the service's start time − skew)
- **Replay.** `request_id` enters the replay set only after every other check passes.
- **Replicas.** One replica per deployment id (`aud`), with a Recreate rollout.

**Service defaults**
- body cap: 262 144 bytes
- PNG cap: 4 194 304 bytes
- render slots: 2 globally. When none is free the request is refused with `render_busy`; there is no queue.
- `render_still` deadline: 45 000 ms
- CLI `--timeout`: 60 000 ms. It must exceed the deadline.
- kill grace: 5 000 ms
- kill verification: 10 000 ms after the SIGKILL

**What the service never does**
- It never uses `runCommand`, `cliLimiter`, `environment.ts` or `browser.ts`.
- It never falls back to `npx`.

**Startup checks.** The service refuses to start unless all of these hold:
- `setpriv` is on PATH.
- The installed `@remotion/renderer` is ≥ 4.0.458 and has `dist/linux/wrap-with-setpriv.js`.
- The pinned browser runs `--version`.
- The pack passes the JSON Schema gate.
- `AUDIT_LOG_PATH` can be opened for appending.

If the service cannot verify that a render's processes are gone, it exits with code 70.

**Errors and audit**
- **Errors callers see** are a category plus a fixed message, and for `invalid_props`, JSON pointer paths. Never a filesystem path, a local-dev tool name, or a payload value.
- **Audit** records hashes and sizes only, keyed with `AUDIT_HMAC_KEY`. Never payloads, and never verbatim error messages.

**Child processes**
- Each render gets an allowlisted environment: `PATH`, `HOME`, `LANG`, `NODE_ENV`, `REMOTION_*`, and `TMPDIR` set to the render's own work directory. Keys are never passed.
- Props reach the CLI as a file (`--props=<file>`, mode 0600), never as an argv string.

**The image**
- `node:22-bookworm-slim`, linux/amd64 only, never Alpine.
- `tini` runs as PID 1.
- `setpriv` and Chrome Headless Shell's shared libraries are present.
- There is no `npm` in the runtime stage.

**Packs.** `scripts/build-pack.mjs` accepts zod 4 schemas only. `propsSchema` is draft 2020-12, exported with the pack's own `z.toJSONSchema`.

**Process rules**
- **Keys** never go in the repository.
- **Commits.** `feat:` and `fix:` would cut a release of the stdio package, which this work does not change. Every commit here uses `build(service):`, `refactor:`, `test:`, `ci:` or `docs:`.
- **New test files** go into **both** the `test` and `test:coverage` lists in `package.json`. Helper modules under `test/helpers/` go into neither.
- **Placeholder entry.** Until Task 7 replaces it, `src/service/index.ts` re-exports every service module that exists. The service build compiles only what this entry reaches.
- **Owner actions.** The owner merges PRs and enables publishing. Every PR targets the current stack branch.

## Review Focus

1. **Clock skew between the gateway host and a deployment host.** A request signed 30 s "in the future" is accepted; at 31 s it is refused. One that expired 30 s ago is accepted; at 31 s it is refused. *Owner: Task 3.*
2. **Non-Latin props.** `"Beşiktaş · İstanbul · Şenol Güneş"` validates. `maxLength` counts code points, as JSON Schema and a backend's validator do: exactly `maxLength` emoji pass, and one more fails. *Owner: Task 4.*
3. **A client disconnects mid-render.** The render's processes are killed. The slot stays held until they are gone, then frees exactly once. *Owner: Task 5 and Task 7.*
4. **A PNG at, and one byte over, the cap.** At the cap, the PNG returns. One byte over returns `output_too_large`; the work directory is removed and the slot frees. *Owner: Task 6.*
5. **A restart.** A header signed before the service started is refused (`signed_before_start`), even inside its `exp` window. One signed exactly at `startedAt − skew` is accepted. *Owner: Task 3.*

---

## Task 1: Correct ADRs 0004–0007 to the v2 architecture

PR #19 merged these into `build/exclude-service-tree`, but they are not on `main` yet. Owner ruling 4 lets them be corrected in place.

**Files:**
- Modify: `docs/adr/0004-http-transport-for-the-service-profile.md`
- Modify: `docs/adr/0005-tool-profiles-and-template-packs.md`
- Modify: `docs/adr/0006-gateway-for-the-service-profile.md`
- Modify: `docs/adr/0007-process-isolation-for-rendering.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/superpowers/plans/2026-10-17-tacticlens-service-profile.md` (a top note only)

**Interfaces:** none.

- [ ] **Step 1: Rewrite each ADR's Decision and Consequences per design §6.**
  - Keep every verified quote and file:line citation that still holds.
  - Each ADR cites, as its source, the owner rulings in design §1 by number.

  | ADR | Remove | Add |
  | --- | --- | --- |
  | 4 | unix socket, `0600`/`0660`/`2750`; gateway in this repo | TCP listener behind the deployer's TLS; the identity header as the trust boundary; one central gateway outside this repo in front of many deployments |
  | 5 | the charter gate | Status **Accepted**, with ruling 7's boundary; pack format (prebuilt bundle, JSON Schema, Linux `npm ci`); both gates; ajv; the AST absence suite; egress as the deployer's control (ruling 6) |
  | 6 | `gateway/` and its seven in-repo controls | the service's enforcement (design §5.2–5.3); the gateway's transport obligations; what the gateway keeps (keys, tenant grants, per-key limits, response filter, envelope); limb 2 satisfied by the owner's tenant grants |
  | 7 | the forked Node worker; IPC-reported groups; the environment marker | "the owner changed fixed constraint 6's mechanism on 2026-10-26 (ruling 1)"; direct CLI spawn; `/proc` walk plus `setpriv` pdeathsig; `tini`; renderer ≥ 4.0.458; exit 70 on unverified cleanup. It still states that `--max-old-space-size` caps only the V8 heap and that the pixel cap is the native-memory guard, now for local-dev only. |

- [ ] **Step 2: Update `docs/adr/README.md`.**
  - ADR-5: Status `Accepted`, Relation `Builds on 0004`.
  - ADR-7's Decision cell: `Spawn the Remotion CLI directly and kill every process group it creates`.

- [ ] **Step 3: Mark the old plan superseded.** Under its H1, add:
  `> **Superseded 2026-10-26 by docs/superpowers/plans/final_script.md.** Kept for its history; do not execute.`

- [ ] **Step 4: Verify.**
  - Run `git diff --name-only origin/main -- docs/adr/`.
    Expected: only `0004`–`0007` and `README.md`. Never `0001`–`0003`.
  - Run `git grep -nE "unix (domain )?socket|0600|0660|gateway/|render-worker|RENDER_MARK|CHARTER|forked child" -- docs/adr/0004* docs/adr/0005* docs/adr/0006* docs/adr/0007* docs/adr/README.md`.
    Expected: no hits, except lines that explicitly record what was dropped.

- [ ] **Step 5: Commit.**
  `git commit -m "docs: correct ADRs 0004-0007 to the v2 service architecture"`

---

## Task 2: One shared `still` argv builder

**Files:**
- Create: `src/services/render-core.ts`
- Modify: `src/tools/render.ts`. Only the single-frame path changes, at `:351-363`: the `remotion_render_still` handler's `const args = [...]` and its `--props` push.
- Test: `test/unit.test.mjs`, `test/protocol.test.mjs`, `test/profiles.test.mjs`

**Interfaces:**
- Produces:

```ts
export interface StillArgvOptions {
  source: string;             // entry point (local-dev) or bundle dir (service); positional
  compositionId: string;      // positional
  output: string;             // positional, relative to the CLI's cwd
  frame: number;
  scale?: number;
  propsJson?: string;         // local-dev only: --props=<json>
  propsFile?: string;         // service only:   --props=<file>
  width?: number;             // service: --width=
  height?: number;            // service: --height=
  browserExecutable?: string; // service: --browser-executable=
  timeoutMs?: number;         // service: --timeout= (Remotion's Node-side wait); integer >= 7000
}
export function buildStillArgv(o: StillArgvOptions): string[]; // args after cli.prefixArgs
```

- [ ] **Step 1: Write the failing tests.**
  - **`test/unit.test.mjs`:**
    - **Golden argv.** `buildStillArgv({source:"src/index.ts", compositionId:"Main", output:"out/a.png", frame:3, scale:1, propsJson:'{"a":1}'})` deep-equals
      `["still","src/index.ts","Main","out/a.png","--frame=3","--scale=1","--image-format=png","--overwrite","--log=info",'--props={"a":1}']`.
      That is the argv `render.ts` builds today. Also assert there is no `--timeout` in it.
    - **Service argv.** `buildStillArgv({source:"bundle", compositionId:"slow", output:"out.png", frame:0, propsFile:"props.json", width:64, height:64, browserExecutable:"/x/chrome", timeoutMs:60000})` ends with
      `["--log=info","--props=props.json","--width=64","--height=64","--browser-executable=/x/chrome","--timeout=60000"]`.
    - **Positionals.** A value starting with `-` for `source`, `compositionId` or `output` throws `ToolInputError` with category `argv_injection`. The same values without the dash pass.
    - **Props.** `propsJson` together with `propsFile` throws.
    - **Timeout.** `timeoutMs` of `6999` or `7000.5` throws; `7000` passes.
  - **`test/protocol.test.mjs`.** Add `a single-frame still hands the CLI the expected argv`.
    - Use the existing `stubProject` helper. The stub CLI writes `process.argv.slice(2)` to a JSON file and creates the output PNG.
    - Call `remotion_render_still` with `frame: 3` and `props_json`.
    - Assert the recorded argv equals the golden argv from above, with that call's own entry, composition, output and props.
  - **`test/profiles.test.mjs`.** `render-core.ts`'s `importClosure` reaches nothing under `src/tools/`, and none of `services/environment.ts`, `services/browser.ts` or `services/tile.ts`.

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `npm run build && node --test test/unit.test.mjs test/protocol.test.mjs test/profiles.test.mjs`
  - Expected: FAIL. The module does not exist yet.

- [ ] **Step 3: Implement `buildStillArgv` in `src/services/render-core.ts`.**
  - It imports only `assertSafePositional` (`exec.ts`) and `ToolInputError` (`types.ts`).
  - Service options are appended after `--log=info` and `--props=`, in the interface's order.
  - `render.ts`'s single-frame path calls it. The `frames` strip path is untouched.

- [ ] **Step 4: Run the full suite.**
  - Run: `npm run build && npm test && npm run lint`
  - Expected: all pass. The count is 116 plus this task's tests, 0 skipped.

- [ ] **Step 5: Commit.**
  `git commit -m "refactor: share the still argv builder between profiles"`

---

## Task 3: Identity verification, the replay cache, the test signer and vectors

This task also sets up the service build, and the CI and lint wiring that every later task's tests need.

**Files:**
- Create: `src/service/identity.ts`, `src/service/constants.ts`, `src/service/index.ts` (placeholder), `tsconfig.service.json`
- Create: `scripts/sign-identity.mjs`, `scripts/make-identity-vectors.mjs`, `test/vectors/identity-v1.json`, `test/identity.test.mjs`
- Create: `docs/CONTRACT-gateway.md`
- Modify:
  - `package.json`: add the script `"build:service": "tsc -p tsconfig.service.json"`, and add `test/identity.test.mjs` to both `test` and `test:coverage`.
  - `.gitignore`: add `/dist-service/` and `/tmp-poison-*/`.
  - `eslint.config.js`:
    - add `"dist-service/**"` to `ignores`
    - add these to `nodeGlobals`: `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate`, `AbortController`, `AbortSignal`, `TextEncoder`, `TextDecoder`, `structuredClone`, `queueMicrotask`, `performance`, `Headers`, `Response`, `crypto`
  - `.github/workflows/ci.yml` and `.github/workflows/release.yml`: add `- name: Build service` / `run: npm run build:service` straight after the `Build` step, before every `Test` step.
  - `docs/CI.md`: note the build step, and that service tests import `dist-service/`.

**Interfaces:**
- **`src/service/constants.ts` produces:**
  - `IDENTITY_HEADER = "x-render-identity"`
  - `REQUEST_ID_META_KEY = "io.github.curasinan/request_id"`
  - `IDENTITY_SKEW_S = 30`, `IDENTITY_MAX_TTL_S = 120`
  - `SERVICE_BODY_CAP_BYTES = 262_144`, `SERVICE_PNG_CAP_BYTES = 4_194_304`
  - `RENDER_STILL_DEADLINE_MS = 45_000`, `RENDER_CLI_TIMEOUT_MS = 60_000`
  - `RENDER_KILL_GRACE_MS = 5_000`, `RENDER_VERIFY_DEADLINE_MS = 10_000`
  - `RENDER_SLOTS_DEFAULT = 2`
  - `MIN_REMOTION_RENDERER = "4.0.458"`
  - A module-load assertion throws if `RENDER_CLI_TIMEOUT_MS <= RENDER_STILL_DEADLINE_MS`.
- **`src/service/identity.ts` produces:**

```ts
export interface IdentityClaims { v: 1; request_id: string; principal: string; tenant: string; aud: string;
  tool: string; body_sha256: string; iat: number; exp: number }
export type IdentityRefusal = "missing" | "malformed" | "unsupported_version" | "bad_signature" | "wrong_audience"
  | "not_yet_valid" | "expired" | "ttl_too_long" | "signed_before_start" | "body_mismatch"
  | "tool_mismatch" | "request_id_mismatch" | "replayed";
export type VerifyResult = { ok: true; claims: IdentityClaims } | { ok: false; reason: IdentityRefusal };
export type RequestVerdict =
  | { ok: true; claims: IdentityClaims; message: unknown }
  | { ok: false; status: 401; reason: IdentityRefusal }
  | { ok: false; status: 400; reason: "parse" | "batch" };
export interface VerifyOptions { key: Buffer; audience: string; nowS: number; skewS: number;
  maxTtlS: number; startedAtS: number }
export function signIdentity(claims: IdentityClaims, key: Buffer): string;
export function verifyIdentityHeader(header: string | undefined, rawBody: Buffer, o: VerifyOptions): VerifyResult; // never throws
export function checkClaimsAgainstMessage(claims: IdentityClaims, message: unknown): VerifyResult; // tool, request_id
export function toolOf(message: unknown): string | null; // params.name for tools/call, else method
export class ReplayCache {
  constructor(skewS: number);
  seen(requestId: string, nowS: number): boolean;           // true while nowS <= exp + skewS
  remember(requestId: string, expS: number, nowS: number): void; // also prunes expired entries
}
export function verifyRequest(header: string | undefined, rawBody: Buffer, o: VerifyOptions,
  cache: ReplayCache): RequestVerdict;
```

`verifyRequest` runs design §5.2 steps 3–6, in order:
1. `verifyIdentityHeader`.
2. Parse the body. A parse failure gives `400/parse`; an array gives `400/batch`.
3. `checkClaimsAgainstMessage`.
4. `cache.seen` gives `401/replayed`.
5. `cache.remember`, and only then return ok.

- [ ] **Step 1: Set up the service build.**
  - Create `tsconfig.service.json`:
    `{ "extends": "./tsconfig.json", "files": ["src/service/index.ts"], "include": [], "compilerOptions": { "outDir": "./dist-service", "noEmitOnError": true } }`
  - Create the placeholder `src/service/index.ts`:
    `export * from "./constants.js"; export * from "./identity.js";`
  - Write `src/service/constants.ts` in full.
  - Write `src/service/identity.ts` as a stub. It declares every export in the interface above. Each function throws `new Error("identity: not implemented")`, and `ReplayCache`'s methods do the same. This way Step 3's failures name the missing behaviour instead of a build error.
  - Make the package.json, `.gitignore`, ESLint, CI and `docs/CI.md` edits listed under Files.

- [ ] **Step 2: Write the failing tests in `test/identity.test.mjs`.**
  - **Setup.** Import from `dist-service/service/identity.js` via `pathToFileURL`.
  - **Base inputs.**
    - `KEY = Buffer.alloc(32, 7)`, `AUD = "dep-a"`, `NOW = 1_800_000_000`
    - base claims: `{v:1, request_id:"r-1", principal:"k-1", tenant:"t-1", aud:AUD, tool:"render_still", body_sha256:sha256(BODY), iat:NOW, exp:NOW+60}`
    - `BODY` is a `tools/call render_still` message whose `_meta[REQUEST_ID_META_KEY]` is `"r-1"`
    - options: `startedAtS = NOW − 600`, unless a row overrides it
  - **Every row breaks exactly one rule.**
  - **Tests:**
    - `a valid request verifies`
    - `each refusal reason is produced by its own case`. Table-driven. Each row names the function it calls:
      - Header-level rows call `verifyIdentityHeader` and assert exactly `{ok:false, reason}`.
      - The `tool_mismatch`, `request_id_mismatch` and `replayed` rows call `verifyRequest` and assert exactly `{ok:false, status:401, reason}`.

      | reason | case |
      | --- | --- |
      | `missing` | no header |
      | `malformed` | a header with no dot |
      | `unsupported_version` | `v: 2` |
      | `bad_signature` | signed with another key |
      | `wrong_audience` | `aud: "dep-b"` |
      | `not_yet_valid` | `iat = NOW+31` (`exp = NOW+90`) |
      | `expired` | `iat = NOW−91`, `exp = NOW−31` |
      | `ttl_too_long` | `exp = iat+121` |
      | `signed_before_start` | `startedAtS = NOW−10`, `iat = NOW−41`, `exp = NOW+60` |
      | `body_mismatch` | one body byte flipped |
      | `tool_mismatch` | claims `tool: "list_templates"` |
      | `request_id_mismatch` | the `_meta` id is `"r-2"` |
      | `replayed` | `verifyRequest` twice with the same cache; the second call gets `401/replayed` |

    - `malformed headers never throw`. Each of these returns `malformed`:
      - claims that are not JSON
      - a JSON array
      - a missing field
      - `iat: "1"`
      - `iat: NaN` (encoded as `null`)
      - a signature shorter or longer than 43 base64url characters
      - a non-base64url character
      - three dot-separated parts
    - `time rules report the first failing rule in order`. The order is `not_yet_valid`, `expired`, `ttl_too_long`, `signed_before_start`. Use one case that breaks both `ttl_too_long` and `signed_before_start`; it reports `ttl_too_long`.
    - `REVIEW FOCUS 1: skew boundaries are inclusive at 30 s`
      - `iat = NOW+30` is ok; `NOW+31` is `not_yet_valid`.
      - `exp = NOW−30` is ok; `NOW−31` is `expired`.
    - `REVIEW FOCUS 5: the start-time rule refuses inside the exp window and is inclusive at the boundary`. With `startedAtS = NOW−10`:
      - `iat = NOW−41` is `signed_before_start`.
      - `iat = NOW−40` is ok.
    - `a request that fails a later check does not enter the replay cache`
      - A `tool_mismatch` request with id `"r-9"` is followed by a valid one with `"r-9"`.
      - The second is ok.
    - `400/parse for a non-JSON body and 400/batch for an array body, both after a valid signature`
    - `the replay cache forgets an id only after exp plus skew`
    - `toolOf maps tools/call to params.name and anything else to method`
    - `every vector in test/vectors/identity-v1.json produces its declared verdict`
      - **Record shape.** Each vector is `{ name, options: {audience, nowS, skewS, maxTtlS, startedAtS}, steps: [{ header, body_base64, expected }] }`.
      - **How it runs.** Each vector gets a fresh `ReplayCache`. Its steps run in order through `verifyRequest(header, body, {key, ...options}, cache)`. A replay vector has two steps.
      - **Coverage.** The set of `expected` reasons equals all 13 `IdentityRefusal` values, plus `400/parse`, `400/batch` and at least one `ok`.

- [ ] **Step 3: Run them and watch them fail.**
  - Run: `npm run build:service && node --test test/identity.test.mjs`
  - Expected: FAIL with `identity: not implemented`.

- [ ] **Step 4: Implement `src/service/identity.ts`.**
  - **Shape check.** First, return `malformed` unless all of these hold:
    - the header has exactly two non-empty dot-separated parts
    - the signature part matches `/^[A-Za-z0-9_-]{43}$/`
    - the claims part decodes to a JSON object whose nine fields have the right types, with `iat` and `exp` finite integers
  - **The remaining checks run in this order:**
    1. version
    2. signature (`timingSafeEqual` on two 32-byte buffers)
    3. audience
    4. `not_yet_valid` (`now < iat − skew`)
    5. `expired` (`now > exp + skew`)
    6. `ttl_too_long` (`exp − iat > maxTtl`)
    7. `signed_before_start` (`iat < startedAt − skew`)
    8. body hash
  - **Signature input.** The signature covers the base64url claims string exactly as received; there is no canonical JSON step.
  - **Clock.** Nothing reads the wall clock. `nowS` always comes from the caller.

- [ ] **Step 5: Implement the signer and the vector generator.**
  - **`scripts/sign-identity.mjs`** is a CLI. It takes a claims JSON file and a body file, reads `IDENTITY_HMAC_KEY` (base64url) from the environment, and prints the header. It imports `signIdentity` from `dist-service`.
  - **`scripts/make-identity-vectors.mjs <outPath>`** imports nothing from `src/` or `dist-service/`.
    - It builds each header with `node:crypto` alone:
      - `p = base64url(claimsText)`
      - `header = p + "." + createHmac("sha256", key).update(p).digest("base64url")`
    - It writes, for every vector: `name`, `header`, `body_base64`, `options`, and the expected verdict, which is **hand-declared in the script**. The script never computes a verdict by calling the implementation.
    - The key is the throwaway `Buffer.alloc(32, 7)`. The file's `_comment` says so.

- [ ] **Step 6: Run the tests and watch them pass.**
  - Run: `npm run build:service && node scripts/make-identity-vectors.mjs test/vectors/identity-v1.json && node --test test/identity.test.mjs && npm run lint`
  - Expected: PASS.

- [ ] **Step 7: Write `docs/CONTRACT-gateway.md`.**
  - the header format and the claims table
  - every refusal reason and its HTTP status
  - the check order
  - the gateway's transport obligations (design §5.3)
  - one replica per `aud`, with a Recreate rollout
  - how to check a gateway against the vectors
  - the vector record shape and its replay semantics: one fresh cache per vector, with its steps run in order

- [ ] **Step 8: Commit.**
  `git commit -m "build(service): verify the gateway identity header"`

---

## Task 4: Pack loader, JSON Schema gate and props validation

**Files:**
- Create: `src/service/templates.ts`, `test/templates.test.mjs`
- Create: `test/fixtures/packs/`. Each pack below has a `pack-manifest.json`. Every pack except `missing-bundle` and `bundle-no-index` also has a committed `bundle/index.html` containing `<!doctype html><title>stub</title>`, because git does not track empty directories.

  | Pack | What it holds |
  | --- | --- |
  | `good` | valid. Its schema has `label` (maxLength 40), `color` (maxLength 7, pattern), `players` (maxItems 22 of strict objects `{name maxLength 40, number integer 1..99}`), a `theme` enum, `opacity` (exclusiveMinimum 0, maximum 1), and an optional `short` (maxLength 5) |
  | `no-additional-false` | an object without `additionalProperties: false` |
  | `unbounded-string` | a string without `maxLength` |
  | `url-format` | a string with `format: uri`. Expected problem: `keyword format not allowed` |
  | `no-maxitems` | an array without `maxItems` |
  | `half-bounded-number` | a number with only a lower bound |
  | `hidden-in-oneof` | an unbounded string under `oneOf` |
  | `unknown-keyword` | uses `patternProperties` |
  | `boolean-schema` | a property schema of `true` |
  | `zero-templates` | no templates |
  | `duplicate-ids` | two templates with the same id |
  | `oversize` | `width × height > MAX_RASTER_PIXELS` |
  | `missing-bundle` | no `bundle/` |
  | `bundle-no-index` | `bundle/` holds only `README.txt` |

- Modify:
  - `package.json`: add `"ajv": "^8.17.1"` to `dependencies` (run `npm install ajv@^8.17.1`), and add the test file to both lists.
  - `src/service/index.ts`: append `export * from "./templates.js";`

**Interfaces:**
- Produces:

```ts
export interface TemplateEntry { id: string; compositionId: string; width: number; height: number;
  defaultFps: number; maxFrames: number; propsSchema: Record<string, unknown> }
export interface PackManifest { packHash: string; remotionVersion: string; templates: TemplateEntry[] }
export type PropsResult = { ok: true } | { ok: false; paths: string[] }; // RFC 6901 pointers, never values
export interface LoadedPack { dir: string; bundleDir: string; manifest: PackManifest;
  template(id: string): TemplateEntry | undefined; validateProps(id: string, props: unknown): PropsResult }
export class PackError extends Error { readonly problems: string[] }
export function checkSchemaVocabulary(schema: unknown): string[]; // "<pointer>: <rule>"; [] = pass
export function loadPack(dir: string): LoadedPack; // throws PackError naming every problem
```

- [ ] **Step 1: Write the failing tests in `test/templates.test.mjs`.**
  - `the good pack loads and lists its templates`
  - `each bad pack is refused with its problem named at the right pointer`. Table-driven. Each pack's `PackError.problems` includes the expected `<pointer>: <rule>` string. For example, `hidden-in-oneof` gives `"/properties/x: keyword oneOf not allowed"`.
  - `enum and const strings need no maxLength, and exclusive bounds count as bounds`
  - `checkSchemaVocabulary reports nested and untyped holes at full pointers`. These are direct calls, each expecting the given pointer:
    - `{}` as a property gives `type required`
    - `{type:["string","null"]}` gives `type must be a single string`
    - `{type:"array", maxItems:2}` gives `items required`
    - an unbounded string inside `players.items` gives `/properties/players/items/properties/name: maxLength required`
    - an unbounded string inside an `anyOf` branch
    - an unbounded string inside `$defs` reached by `$ref`
    - a `$ref` to a missing def
  - `the zod 4 toJSONSchema export of the realistic template passes the gate`. Build it with the repo's `zod/v4` `toJSONSchema`, and assert `[]`.
  - `invalid props map to pointers and never echo values`
    - An over-long name gives `["/players/0/name"]`.
    - A missing required `label` gives `["/label"]`.
    - An unknown key `extra` gives `["/extra"]`.
    - A key `a/b~c` gives `"/a~1b~0c"`.
    - The JSON-stringified result never contains the offending value.
  - `REVIEW FOCUS 2: Turkish text validates, and maxLength counts code points`
    - `"Beşiktaş · İstanbul · Şenol Güneş"` passes `maxLength: 40`.
    - Against `good`'s `short` (maxLength 5), with otherwise valid props: `"😀😀😀😀😀"` passes, and `"😀😀😀😀😀😀"` fails with paths `["/short"]`.
  - `template() returns undefined for an unknown id`

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `npm run build:service && node --test test/templates.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement `src/service/templates.ts`.**
  - **ajv.**
    - Import it with `import { Ajv2020 } from "ajv/dist/2020.js";`. ajv 8 has no `exports` map, so the `.js` extension is required.
    - Construct it with `{ allErrors: true, strict: true }` and the default `unicode: true`.
    - Compile one validator per template, at load time.
  - **The vocabulary walker is closed.** It runs before ajv compiles anything.
    - **Allowed at the root only:** `$schema`, which must equal `https://json-schema.org/draft/2020-12/schema` when present, and `$defs`.
    - **What a node must be.** Every node must be a JSON object. A boolean schema is a violation.
    - **What every node must carry.** Exactly one of:
      - a single-string `type`
      - `enum`
      - `const`
      - `anyOf`
      - a `$ref` to an existing `#/$defs/<name>`

      Otherwise the walker reports `<ptr>: type required`. A `type` array is `<ptr>: type must be a single string`.
    - **The walk** visits every `properties` value, `items`, every `anyOf` branch and every `$defs` entry.
    - **Allowed keywords:**
      - `type`, `properties`, `required`, `additionalProperties` (only the literal `false`), `items`
      - `minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`
      - `enum`, `const`
      - `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
      - `anyOf`, `$ref`
      - `title`, `description`, `default`, `examples`

      `format` is **not** allowed. ajv's strict mode has no formats loaded and throws on any of them, and the zod gate refuses url and email anyway.
    - **Any other keyword** is reported as `<ptr>: keyword <k> not allowed`.
    - **Rules:**
      - every `type: object` has `additionalProperties: false`
      - every array has `maxItems`, and has `items` as a schema object
      - every string has `maxLength`, unless it has `enum` or `const`
      - every number or integer has a lower bound (`minimum` or `exclusiveMinimum`) and an upper one (`maximum` or `exclusiveMaximum`)
  - **Pointer mapping.**

    | ajv error | pointer |
    | --- | --- |
    | `required` | `instancePath + "/" + esc(params.missingProperty)` |
    | `additionalProperties` | `instancePath + "/" + esc(params.additionalProperty)` |
    | anything else | `instancePath` |

    `esc` replaces `~` with `~0` and `/` with `~1`. Paths are de-duplicated.
  - **Manifest checks:**
    - `width × height ≤ MAX_RASTER_PIXELS` (`src/constants.ts:33`)
    - `maxFrames ≥ 1`
    - template ids are unique
    - `bundle/index.html` exists
  - **Imports:** `ajv`, `node:fs`, `node:path` and `../constants.js` only.

- [ ] **Step 4: Run the tests and watch them pass.**
  - Run: `npm run build:service && node --test test/templates.test.mjs && npm run lint`
  - Expected: PASS.

- [ ] **Step 5: Commit.**
  `git commit -m "build(service): load template packs and validate props against their JSON Schema"`

---

## Task 5: The render-process spawner and render slots

**Files:**
- Create: `src/service/render-process.ts`, `src/service/slots.ts`, `test/render-process.test.mjs`
- Create: `test/fixtures/proc-tree/fake-cli.mjs`, `test/fixtures/proc-tree/fake-browser.mjs`
- Modify:
  - `package.json`: add the test file to both lists.
  - `src/service/index.ts`: append `export * from "./render-process.js"; export * from "./slots.js";`
  - `.github/workflows/ci.yml`:
    - In the shared `Test` step's `env:`, add `REQUIRE_LINUX_PROCESS_TESTS: ${{ matrix.os == 'ubuntu-latest' && '1' || '' }}`.
    - In `Test (with coverage)`, which is ubuntu-only, add `REQUIRE_LINUX_PROCESS_TESTS: "1"`.
    - Never set a static `"1"` on the shared step.

**Interfaces:**
- Consumes: `killTree(pid, signal)` from `src/services/exec.ts`.
- Produces:

```ts
export interface CleanupReport { verified: boolean; survivors: number[] }
export interface RenderProcessOptions { cwd: string; env: NodeJS.ProcessEnv; deadlineMs: number;
  graceMs: number; verifyDeadlineMs: number; signal?: AbortSignal;
  kill?: (pid: number, signal: NodeJS.Signals) => void } // defaults to killTree; tests inject
export interface RenderProcessResult { exitCode: number | null; signal: NodeJS.Signals | null;
  timedOut: boolean; aborted: boolean; outputTail: string; cleanup: Promise<CleanupReport> }
export function runRenderProcess(file: string, args: string[], o: RenderProcessOptions): Promise<RenderProcessResult>;
export function parseProcStat(line: string): { pid: number; ppid: number; pgid: number } | null; // fields after the LAST ")"
export function descendantsOf(rootPid: number, opts?: { procDir?: string; selfPgid?: number }):
  { pids: number[]; pgids: number[] }; // Linux /proc; empty elsewhere; never <= 1, never selfPgid
export function childEnv(source: NodeJS.ProcessEnv, workDir: string): NodeJS.ProcessEnv;
// allowlist PATH HOME LANG NODE_ENV REMOTION_*; TMPDIR = workDir
// slots.ts
export class RenderSlots { constructor(capacity: number); tryAcquire(): (() => void) | null;
  get inUse(): number; drained(): Promise<void> } // drained resolves when inUse reaches 0
```

- [ ] **Step 1: Write the fixtures.**
  - **`fake-cli.mjs`** spawns `fake-browser.mjs` with `detached: true`, as Remotion's BrowserRunner does. It forwards `--write-file`, then sleeps.
  - **`fake-browser.mjs`** spawns one grandchild, then writes `{"cli":<ppid>,"browser":<pid>,"browserPgid":<pgid>,"grandchild":<pid>}` to `--write-file`, then sleeps.
  - **Flags:**
    - `--exit-on-file=<path>`: fake-cli exits 0 once that file exists, polled every 50 ms
    - `--ignore-sigterm`: a SIGTERM handler that does not exit, as the real CLI does
    - `--write-file=<path>`
    - `--no-browser`: fake-cli spawns nothing
  - **After the handshake,** fake-cli prints `ready` to stdout. That makes `runRenderProcess` take a descendant snapshot (Step 4).
  - **Backstop.** Every fixture arms `setTimeout(() => process.exit(0), 60_000)`, never unref'd, so a test failure never leaves a process behind for long.
  - **The handshake.** Tests learn the tree is built by polling for the handshake file to a 10 s deadline, never by sleeping a guess. A failure says "fake-browser never wrote its pids".
  - **Cleanup after each test.** Every spawning test registers `t.after()` to SIGKILL the pids and pgids in its handshake file, ignoring ESRCH.

- [ ] **Step 2: Write the failing tests in `test/render-process.test.mjs`.**
  - **Linux-only cases** use `{ skip: process.platform !== "linux" && "needs /proc and process groups" }`.
  - **The gate** is `linux process tests ran where required`. It is never skipped. It fails if `REQUIRE_LINUX_PROCESS_TESTS === "1"` and either the platform is not linux or `/proc/self/stat` is unreadable.
  - **Tests:**
    - `parseProcStat reads fields after the last ")"`. Fixtures:
      - `"123 (a b) S 1 123 ..."` gives `ppid 1`, `pgid 123`.
      - `"124 (x) (y)) S 7 9 ..."` gives `ppid 7`, `pgid 9`.
      - garbage gives `null`.
      - This runs on every OS.
    - `descendantsOf never returns pid or pgid <= 1 or its own group`. Use a fake `procDir` of stat files that includes those cases, on every OS.
    - `a normal exit kills the detached browser the CLI left behind`
      1. Start fake-cli with a browser and `--exit-on-file`.
      2. Wait for the handshake, and for the `ready` line to be printed.
      3. Create the exit file.
      4. Assert `exitCode 0`, then `cleanup.verified === true`.
      5. Assert the browser pid and pgid from the handshake file are gone, polled to a deadline.
    - `the deadline returns timedOut before cleanup finishes`
      - Use `--no-browser --ignore-sigterm`, so no tree is still being built when the deadline fires.
      - Assert by ordering: the result settles while `cleanup` is pending.
      - Then `cleanup` gives `verified: true`, and the CLI pid is gone.
    - `a CLI that ignores SIGTERM is SIGKILLed after the grace`. Use `--no-browser --ignore-sigterm`.
    - `REVIEW FOCUS 3: aborting the signal after the handshake kills every descendant group, including the one the CLI created`
    - `cleanup reports unverified with the survivor when a kill is skipped`. The injected `kill` skips the browser's pgid.
    - `childEnv keeps PATH, HOME and REMOTION_*, sets TMPDIR to the work dir, and drops IDENTITY_HMAC_KEY and AUDIT_HMAC_KEY`
    - `RenderSlots refuses past capacity; a release frees exactly once; drained resolves only at zero`

- [ ] **Step 3: Run them and watch them fail.**
  - Run: `npm run build:service && node --test test/render-process.test.mjs`
  - Expected: FAIL. Also run it in WSL Ubuntu with `REQUIRE_LINUX_PROCESS_TESTS=1`, where the Linux cases execute.

- [ ] **Step 4: Implement `render-process.ts` and `slots.ts`.**
  - **Spawning.** Call `spawn(file, args, { cwd, env, detached: true, shell: false, stdio: ["ignore","pipe","pipe"] })`. `outputTail` keeps the last 2 500 characters of the combined output.
  - **Snapshots while the CLI is alive.**
    - Take a `descendantsOf(pid)` snapshot on every stdout or stderr chunk (Remotion prints progress continuously), and every 250 ms.
    - Keep the union of every pid and pgid seen.
    - Once the CLI has exited, its orphans are reparented, and a walk by ppid finds nothing. So the union recorded while it was alive is what cleanup uses.
  - **On deadline, abort or exit:**
    1. Take one more snapshot, if the CLI is still alive.
    2. Send SIGTERM to the CLI's group and to every recorded pgid. On a normal exit, skip SIGTERM and go straight to SIGKILL for any recorded pid still alive.
    3. After `graceMs`, send SIGKILL to the same groups.
    4. Poll `process.kill(pid, 0)` for every recorded pid until `verifyDeadlineMs` after the SIGKILL.
  - **Settling.** The returned promise settles on the child's exit or on the deadline, whichever comes first. `cleanup` settles after verification.

- [ ] **Step 5: Run the tests.**
  - Run: `npm run build:service && node --test test/render-process.test.mjs && npm run lint`
  - Expected:
    - In WSL with `REQUIRE_LINUX_PROCESS_TESTS=1`: every case passes.
    - On Windows: the gate and the parser cases pass, and only the Linux cases skip.

- [ ] **Step 6: Commit.**
  `git commit -m "build(service): spawn and reliably kill the render process tree"`

---

## Task 6: The four service tools, their errors and the service audit

**Files:**
- Create: `src/service/registry.ts`, `src/service/tools.ts`, `src/service/errors.ts`, `src/service/audit.ts`, `test/service-tools.test.mjs`
- Create: `test/helpers/service-harness.mjs`. This is a helper, not a test, so it goes in neither test list.
  - `fakeRun(opts)` returns a function compatible with `ctx.run`. Its options:
    - `{ pngBytes, hold /* Promise */, timedOut, aborted, exitCode, outputTail, throwError, noFile, onCall, cleanup /* Promise<CleanupReport>, default Promise.resolve({ verified: true, survivors: [] }) */ }`
    - It writes a valid PNG of exactly `pngBytes` bytes (padded in a tEXt chunk) to `<cwd>/<output argv>`.
    - `onCall` receives `(file, args, options)`.
  - `connectWithClaims(server, claims)` returns a connected `Client`. It links an `InMemoryTransport` pair and wraps the client side's `send` so every message carries `{ authInfo: { token: "", clientId: claims.principal, scopes: [], extra: { claims } } }`. `InMemoryTransport.send` forwards `options.authInfo` (`sdk/dist/esm/inMemory.js:40`).
- Modify:
  - `package.json`: add `test/service-tools.test.mjs` to both lists.
  - `src/service/index.ts`: append `export * from` the four new modules.

**Interfaces:**
- Consumes:
  - `LoadedPack` (Task 4)
  - `runRenderProcess`, `RenderSlots`, `childEnv`, `CleanupReport` (Task 5)
  - `buildStillArgv` (Task 2)
  - `IdentityClaims` (Task 3)
- Produces:

```ts
// registry.ts
export const SERVICE_TOOLS: readonly ["list_templates", "render_still", "render_video_start", "render_job_status"];
export interface ServiceContext { pack: LoadedPack; slots: RenderSlots; run: typeof runRenderProcess;
  cli: { file: string; prefixArgs: string[] }; browserExecutable: string; tempRoot: string; audit: AuditSink;
  stillDeadlineMs: number; cliTimeoutMs: number; graceMs: number; verifyDeadlineMs: number;
  pngCapBytes: number; shutdown: AbortSignal; onUnverifiedCleanup: () => void }
export function registerServiceTools(server: McpServer, ctx: ServiceContext): void; // the ONE registerTool loop
// tools.ts — imports only `type ServiceContext` from registry.ts and re-exports nothing from it
export const TOOL_DEFS: { [K in (typeof SERVICE_TOOLS)[number]]: { description: string;
  inputSchema?: ZodRawShape; handler(args: unknown, extra: RequestHandlerExtra, ctx: ServiceContext): Promise<CallToolResult> } };
// errors.ts
export type ServiceErrorCategory = "unknown_template" | "frame_out_of_range" | "invalid_props" | "render_busy"
  | "render_timeout" | "render_failed" | "output_too_large" | "not_implemented" | "internal";
export function serviceError(category: ServiceErrorCategory, paths?: string[]): CallToolResult;
// { isError: true, content: [{ type: "text", text: "<category>: <fixed message>" }],
//   structuredContent: { category, paths? } }
// audit.ts
export interface ServiceAuditEvent { ts: string; outcome: "ok" | "error" | "refused" | "violation";
  request_id?: string; principal?: string; tenant?: string; tool?: string; category?: string;
  fields?: string[]; http_status?: number; duration_ms?: number;
  params_hash?: string; params_bytes?: number; result_hash?: string; result_bytes?: number }
export interface AuditSink { record(e: ServiceAuditEvent): void;
  hash(data: string | Uint8Array): string } // hex HMAC-SHA256 under the sink's key
export function createAuditSink(path: string, key: Buffer): AuditSink;
```

**Notes on the interfaces:**
- **Identity.** Tools read it from `extra.authInfo.extra.claims`.
- **Input schemas.**
  - `list_templates` and `render_video_start` declare **no** `inputSchema`. Clients may omit `arguments` for a no-argument tool.
  - `render_still` uses the strict zod object `{ template_id: z.string().max(100), frame: z.number().int().min(0).optional(), props: z.record(z.string(), z.unknown()) }`.
  - `render_job_status` takes `{ job_id: z.string().max(100) }`.

- [ ] **Step 1: Write the failing tests in `test/service-tools.test.mjs`.**
  - **Setup.** Use `connectWithClaims` and `test/fixtures/packs/good`. `ctx.tempRoot` is a fresh temp directory per test.
  - **Tests:**
    - `tools/list returns exactly SERVICE_TOOLS in order`
    - `list_templates works with arguments omitted and returns id, width, height and propsSchema only`
    - `render_still returns the PNG as image content and removes its work dir`
    - `boundaries are permitted at the limit and refused one past it`
      - `frame = maxFrames − 1` is ok; `frame = maxFrames` is `frame_out_of_range`.
      - **REVIEW FOCUS 4:**
        - a PNG of exactly `SERVICE_PNG_CAP_BYTES` returns
        - `+1` byte gives `output_too_large`, its work dir is removed, and the slot frees
    - `unknown template and invalid props return their category and no render runs`. The fake runner's `onCall` is never invoked.
    - `invalid_props text and structuredContent carry pointers and never the value`
    - `render_busy when every slot is taken`. The fake runner holds two calls on a latch. The third gets `render_busy`. After release, a fourth succeeds.
    - `render_timeout returns at the deadline while the slot stays held until cleanup settles`. `inUse` stays 1 until `cleanup` resolves.
    - `unverified cleanup calls onUnverifiedCleanup`
    - `the CLI is called with the manifest size, the frame, the pinned browser, a --timeout above the deadline, props as a 0600 file, and an allowlisted env`
      - Set `process.env.IDENTITY_HMAC_KEY` and `AUDIT_HMAC_KEY` to sentinels for the test, and restore them afterwards.
      - Assert the argv the runner received contains:
        - `--width=<w>`, `--height=<h>`, `--frame=<f>`
        - `--browser-executable=<ctx value>`
        - exactly one `--timeout=<n>` with `n > stillDeadlineMs`
        - `--props=props.json`, and no JSON in argv
      - Assert the runner's `options.env` contains neither sentinel, and has `TMPDIR` equal to the work dir.
      - On POSIX, the props file mode is `0o600`.
    - `failures map to categories, and nothing escapes`
      - Runner modes:
        - `exitCode: 1` gives `render_failed`
        - `noFile` gives `render_failed`
        - `throwError` gives `internal`
        - `aborted` returns no result to a closed connection
      - In every mode, the slot frees and the work dir is removed.
    - `no caller-visible text leaks a path, a tool name or the CLI output`
      - The fake runner's `outputTail` and thrown message include `LEAK=/pack/bundle/x C:\\x\\y remotion_init_project`.
      - Every error case's text and `structuredContent` is matched against `/[A-Za-z]:\\|\/(pack|app|home|usr|tmp|var|mnt|root)\/|remotion_|viz_|LEAK/`.
      - **Positive control:** the same regex matches the raw `LEAK` string.
    - `the audit holds keyed hashes and sizes, and never the payload`
      - Props include `"CANARY-7f3a"` and a Turkish string.
      - After the call, exactly one `outcome: "ok"` line exists, with:
        - `params_hash` equal to the HMAC computed in the test
        - `params_bytes` equal to `Buffer.byteLength(JSON.stringify(arguments))`
        - `result_bytes` equal to the PNG size
      - `CANARY-7f3a` appears nowhere in the file.
    - `render_video_start and render_job_status return not_implemented`

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `npm run build:service && node --test test/service-tools.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement the four modules.**
  - **`registry.ts`.** There is exactly one `server.registerTool(` call, inside `for (const name of SERVICE_TOOLS)`. It reads each tool's config and handler from `TOOL_DEFS[name]`. It registers a wrapper, never the raw handler. The wrapper:
    - catches every throw
    - records `outcome: "error"`, `category: "internal"`
    - returns `serviceError("internal")`

    No exception reaches the SDK.
  - **`render_still`, in order:**
    1. Check the template, then the frame.
    2. Validate the props.
    3. Acquire a slot.
    4. Make `dir = await fs.mkdtemp(path.join(ctx.tempRoot, "r-"))` (0700), then write `dir/props.json` with `{ mode: 0o600, flag: "wx" }`.
    5. Build the argv with `buildStillArgv({ source: pack.bundleDir, compositionId, output: "out.png", frame, propsFile: "props.json", width, height, browserExecutable, timeoutMs: ctx.cliTimeoutMs })`.
    6. Call `ctx.run(cli.file, [...cli.prefixArgs, ...argv], { cwd: dir, env: childEnv(process.env, dir), deadlineMs: stillDeadlineMs, graceMs, verifyDeadlineMs, signal })`. Here `signal` combines the tool's abort signal with `ctx.shutdown`.
    7. Map the result, in this order:
       - `timedOut` gives `render_timeout`
       - `aborted` gives `render_failed`; the connection is gone
       - `exitCode !== 0`, a non-null `signal`, or a missing or empty `out.png` gives `render_failed`
       - a size over `pngCapBytes` gives `output_too_large`
       - otherwise, the image content
    8. **Slot and work dir.**
       - If step 4, 5 or 6 throws before `ctx.run` resolves, release the slot and remove `dir` at once.
       - Otherwise, release the slot and remove `dir` in `cleanup.finally`, after the response has been built.
       - If cleanup is unverified, first `await fs.rm(dir, { recursive: true, force: true })`, then call `ctx.onUnverifiedCleanup()`. That handler exits the process, so the caller's props must already be off disk when it runs.
  - **`audit.ts`.**
    - Create the parent directory once (`mkdirSync` recursive, in a try/catch).
    - `record` writes with `fs.appendFileSync`, swallowing errors as `src/services/audit.ts:56` does. Task 7's preflight refuses to start when the path is not writable, so an error swallowed here never means "no audit at all".
    - `hash` is `createHmac("sha256", key).update(data).digest("hex")`.
    - The registry wrapper sets `params_hash = ctx.audit.hash(JSON.stringify(args))` and `result_hash = ctx.audit.hash(pngBytes)`, with `*_bytes` as the UTF-8 byte length of the same data.

- [ ] **Step 4: Run the tests and watch them pass.**
  - Run: `npm run build:service && node --test test/service-tools.test.mjs && npm run lint`
  - Expected: PASS.

- [ ] **Step 5: Commit.**
  `git commit -m "build(service): the four service tools with inline still rendering"`

---

## Task 7: The HTTP service root, config, preflight and start

**Files:**
- Create: `src/service/http.ts`, `src/service/config.ts`, `src/service/preflight.ts`, `src/service/start.ts`
- Replace: `src/service/index.ts` with the runner below
- Create: `test/service-http.test.mjs`, `test/service-start.test.mjs`
- Create: `test/helpers/signing-client.mjs`. A helper, in neither test list. It exports `makeSigningFetch({ key, audience, principal, tenant, nowS?, ttlS? })`. That returns a `fetch` that, for each POST:
  1. parses the body
  2. sets `params._meta[REQUEST_ID_META_KEY]` to a fresh UUID
  3. re-serializes the body
  4. sets `X-Render-Identity` over the final bytes with the right `tool`

  Every later task and `scripts/image-e2e.mjs` import it.
- Modify: `package.json`, adding the script `"start:service": "node dist-service/service/index.js"` and both test files to both lists.

**Interfaces:**
- Consumes: Tasks 3–6, and `test/helpers/service-harness.mjs`.
- Produces:

```ts
// config.ts
export interface ServiceConfig { host: string; port: number; audience: string; identityKey: Buffer;
  auditKey: Buffer; auditLogPath: string; packDir: string; browserExecutable: string; slots: number;
  skewS: number; bodyCapBytes: number; stillDeadlineMs: number; pngCapBytes: number; tempRoot: string }
export class ConfigError extends Error {}
export function parseServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig;
// preflight.ts
export interface PreflightDeps { which(cmd: string, pathVar: string): string | null; // in-process PATH scan, never spawns
  runVersion(file: string): Promise<boolean> } // execFile(file,["--version"],{env: childEnv(process.env, os.tmpdir()), shell:false})
export const defaultPreflightDeps: PreflightDeps;
export async function preflight(cfg: ServiceConfig, deps?: PreflightDeps):
  Promise<{ pack: LoadedPack; cli: { file: string; prefixArgs: string[] } }>; // throws "preflight: <check>: <what was missing>"
// http.ts
export interface ServiceHandlerDeps { clock?: { nowS(): number; startedAtS: number };
  createServer?: () => McpServer } // tests count servers through this
export function createServiceHandler(ctx: ServiceContext, cfg: ServiceConfig,
  deps?: ServiceHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void;
// start.ts
export interface StartDeps { preflight?: typeof preflight; run?: typeof runRenderProcess;
  exit?: (code: number) => void; log?: (msg: string) => void }
export async function startService(env: NodeJS.ProcessEnv, deps?: StartDeps):
  Promise<{ server: Server; port: number; shutdown(): Promise<void> }>;
```

**Config.** These are read from the environment. A missing or short key throws a `ConfigError` that names the variable and never prints its value.

| Variable | Default | Rule |
| --- | --- | --- |
| `SERVICE_HOST` | `0.0.0.0` | |
| `SERVICE_PORT` | `8080` | |
| `SERVICE_AUDIENCE` | — | required |
| `IDENTITY_HMAC_KEY` | — | required; base64url, ≥ 32 decoded bytes |
| `AUDIT_HMAC_KEY` | — | required; base64url, ≥ 32 decoded bytes |
| `AUDIT_LOG_PATH` | `/var/log/remotion-viz/service-audit.jsonl` | |
| `PACK_DIR` | `/pack` | |
| `BROWSER_EXECUTABLE` | — | required |
| `RENDER_SLOTS` | `2` | |
| `IDENTITY_SKEW_S` | `30` | |
| `RENDER_TEMP_ROOT` | `path.join(os.tmpdir(), "remotion-viz-service")` | `startService` empties and recreates it, mode 0700, before `listen`, so no earlier run's props survive a restart |

`bodyCapBytes`, `stillDeadlineMs` and `pngCapBytes` are **not** read from the environment. They are the constants `SERVICE_BODY_CAP_BYTES`, `RENDER_STILL_DEADLINE_MS` and `SERVICE_PNG_CAP_BYTES`, so the module-load check `RENDER_CLI_TIMEOUT_MS > RENDER_STILL_DEADLINE_MS` keeps holding.

**CLI resolution in `preflight`.**
- Read `<packDir>/node_modules/@remotion/cli/package.json`, and take `bin.remotion` (or `bin` if it is a string).
- Return `{ file: process.execPath, prefixArgs: [<absolute path to that script>] }`.
- If the package or the script is missing, throw. **Never** call `resolveRemotionCli`, which falls back to `npx`.

**The renderer check.**
- It reads `<packDir>/node_modules/@remotion/renderer/package.json`'s `version`, and requires `dist/linux/wrap-with-setpriv.js`.
- It compares versions numerically, part by part. A string comparison would accept `4.0.99`.

**The audit check.** It runs `mkdirSync(dirname(auditLogPath), { recursive: true })`, then `closeSync(openSync(auditLogPath, "a", 0o600))`. On failure it throws `preflight: AUDIT_LOG_PATH is not writable`, with no OS text.

- [ ] **Step 1: Write the failing tests in `test/service-http.test.mjs`.**
  - **Setup.**
    - Start `createServiceHandler` on `127.0.0.1:0` with `fakeRun`, the good pack, and the clock `{ nowS: () => NOW, startedAtS: NOW − 600 }`.
    - Count servers through `createServer`.
    - The client is the real SDK `Client` with `StreamableHTTPClientTransport` and `makeSigningFetch`.
  - **Tests:**
    - `a signed SDK client completes initialize, tools/list and render_still and gets a PNG`
    - `GET and DELETE get 405, any other path gets 404, and the SDK client still works`
    - `a JSON-RPC batch gets 400, runs nothing and creates no server`
    - `a body of exactly 262144 bytes is accepted and 262145 gets 413, including chunked without Content-Length`
      - This test and the batch test send raw bytes with `node:http`'s `request`, not the SDK client: the signing fetch re-serializes bodies, and the SDK always sends a Content-Length.
      - Build the body as a valid JSON-RPC message padded inside a `_meta` string, and sign it with `signIdentity` over the exact bytes.
      - The chunked case uses `req.write(chunk)` with no Content-Length.
    - `each identity refusal gets 401 with an empty body and creates no server`
    - `a replayed request id gets 401 and the first request had succeeded`
    - `two concurrent render_still calls overlap`. The fake runner holds both on one latch, released once both have entered. Assert the in-flight maximum is exactly 2. There is no wall-clock bound.
    - `REVIEW FOCUS 3: closing the client connection mid-render aborts the run; the slot frees after cleanup`
    - `a tenant field in _meta or in tool arguments has no effect and is audited as a violation with field paths only`
      - The `_meta.tenant` case calls `render_still`.
      - The `arguments.tenant` case calls `list_templates`, which declares no input schema and so ignores its arguments. `render_still`'s strict schema would refuse the call outright.
      - There is exactly one `outcome: "violation"` event, with `fields: ["_meta.tenant"]` or `["arguments.tenant"]`.
      - The audited tenant is the claims' tenant.
      - The value appears nowhere in the file.
    - `HTTP-level refusals are audited with outcome refused, the reason as category and http_status, and no claims fields`
  - **In `test/service-start.test.mjs`:**
    - `parseServiceConfig names the missing variable and never prints a key`. Set each key to a sentinel that is too short, and assert the error message does not contain it.
    - `preflight refuses each failed check, naming it`
      - **Each preflight pack is built at test time.** Use `fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"))`, then `fs.cpSync(test/fixtures/packs/good, tmp, { recursive: true })`, then write:
        - `node_modules/@remotion/cli/package.json` (`{"bin":{"remotion":"cli.js"}}`) and `cli.js`
        - `node_modules/@remotion/renderer/package.json` (`{"version":"4.0.458"}`)
        - `dist/linux/wrap-with-setpriv.js`

        Never commit these. The root `.gitignore`'s unanchored `node_modules` and `dist` would drop them on checkout.
      - Use injected `PreflightDeps`. Each case removes or changes exactly one thing:
        - no `setpriv`
        - renderer `4.0.457`
        - renderer `4.0.99`
        - no `wrap-with-setpriv.js`
        - a browser that will not run
        - a missing CLI package, whose message says no `npx` fallback is used
        - a failing pack
        - an `AUDIT_LOG_PATH` under a regular file
      - **Positive controls:** with renderer `4.0.458` and with `4.1.0`, every check passes and `preflight` resolves with the CLI's absolute path.
    - `startService exits 70 when a cleanup is unverified`. Inject `run` whose `cleanup` reports unverified, and `exit` that records the code.
    - `shutdown aborts in-flight renders, waits for slots to drain, then closes`. Inject a held run; assert its signal aborts and `shutdown()` resolves after `drained()`.

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `npm run build:service && node --test test/service-http.test.mjs test/service-start.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement the modules.**
  - **The handler, per request:**
    1. Route and method (404 or 405).
    2. Read the raw body under the cap, counting chunked bodies as they arrive; over the cap is 413.
    3. `verifyRequest(header, raw, opts, cache)`. A failure returns 401 or 400 with an empty body.
    4. Scan `params._meta` and `params.arguments` for the keys `tenant`, `team` and `team_id`. If any is present, record a violation event with key paths only, and continue.
    5. Set `req.auth = { token: "", clientId: claims.principal, scopes: [], extra: { claims } }`.
    6. Build the server: `const server = deps.createServer?.() ?? new McpServer({ name: "remotion-viz-service", version: SERVER_VERSION })`, then `registerServiceTools(server, ctx)`.
    7. `const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`.
    8. `await server.connect(transport)`.
    9. `await transport.handleRequest(req, res, message)`.
    10. On `res.on("close")`, call `transport.close()` and `server.close()`.
  - **`start.ts`:**
    1. `parseServiceConfig`.
    2. `preflight`.
    3. Build the context. `onUnverifiedCleanup` logs and calls `exit(70)`. `shutdown` is an `AbortController` signal.
    4. `listen`.
    - **On `shutdown()`:**
      1. Stop accepting new connections.
      2. Abort the controller.
      3. Await `slots.drained()`, bounded by `graceMs + verifyDeadlineMs`.
      4. Close the server.
  - **`index.ts`** contains only the runner:
    `startService(process.env).then(s => { process.on("SIGTERM", () => s.shutdown().then(() => process.exit(0))) }, e => { console.error(e.message); process.exit(1) })`.
    It does not re-export the other modules.

- [ ] **Step 4: Run the tests and watch them pass.**
  - Run: `npm run build:service && node --test test/service-http.test.mjs test/service-start.test.mjs && npm run lint`
  - Expected: PASS.

- [ ] **Step 5: Run the whole suite.**
  - Run: `npm run build && npm run build:service && npm test`
  - Expected: all pass. Only the Linux-only cases skip, and only off Linux.

- [ ] **Step 6: Commit.**
  `git commit -m "build(service): serve the service profile over HTTP behind a verified identity"`

---

## Task 8: The absence suite

**Files:**
- Create: `scripts/check-service-closure.mjs`, `test/absence.test.mjs`
- Modify:
  - `package.json`: add the script `"test:absence": "node --test test/absence.test.mjs"` and the test file to both lists.
  - `docs/CI.md`: document T1–T6 and the poisoned controls.

**Interfaces:**
- Produces:

```js
// scripts/check-service-closure.mjs — importable and runnable
export function analyzeClosure(distDir) // -> { files: string[] /* forward-slash, relative */,
  // registrations: {file, name: string|null, line}[], registerToolRefs: {file, line, kind}[],
  // specifiers: {file, spec: string|null, line}[] }
export function verdict(analysis) // -> string[] problems; [] = pass
```

**Problems `verdict` reports:**
- **Registrations.**
  - Any registration call (`.registerTool(` or `.tool(`, including `["registerTool"](` and `["tool"](`) outside `service/registry.js`.
  - In `service/registry.js`, more than one registration call site, or a non-literal name outside its `for…of` loop.
  - Any non-call reference to `registerTool` (an alias, an initializer, an argument, destructuring, `.bind`/`.call`/`.apply`), and any `.tool` used as the object of `.bind`/`.call`/`.apply`.
  - Plain reads of a `tool` property, such as `claims.tool`, `{ tool } = claims` or `tool: x.tool`, are **not** reported: the gateway contract's claim is named `tool`.
- **Names and files.**
  - Any of the four forbidden names as a registration name.
  - Any file under `tools/`.
  - Any file named `raster`, `tile`, `network`, `visualize`, `studio`, `compare`, `environment` or `browser`.
- **Specifiers.**
  - Any `@resvg/resvg-js` or `puppeteer-core` specifier.
  - Any non-literal `import()`.

- [ ] **Step 1: Write the failing tests in `test/absence.test.mjs`.**
  - **Poisoned builds.**
    1. Each runs `fs.mkdtempSync(path.join(REPO, "tmp-poison-"))`. Never `os.tmpdir()`: module resolution, `@types/node` and `"type": "module"` must find the repo's own copies as ancestors.
    2. Copy `src/`, `tsconfig.json` and `tsconfig.service.json` into it.
    3. Apply the poison by a text edit.
    4. Run the repo's `tsc -p <tmp>/tsconfig.service.json`. Assert `<tmp>/dist-service/service/index.js` exists, so a failed compile can never pass as "poison detected".
    5. `after()` removes the directory.
  - **Tests:**
    - `T1: the registry exports exactly the frozen four, in order`
    - `T2: a live tools/list against dist-service returns exactly the four`. Use `createServiceHandler` from `dist-service` with `makeSigningFetch`.
    - `T3: verdict on dist-service is empty, even though services/exec.js names remotion_list_compositions in a hint string`. That string pins why the check reads syntax rather than text.
    - `T4: exactly one registration call site, in service/registry.js, inside its loop`
    - `T5 poisoned build: a type-only import of src/services/entrypoint.ts and tools/project.ts`. Add `import type {} from "../tools/project.js"; import type {} from "../services/entrypoint.js";` to `src/service/tools.ts`. Assert `verdict` reports all of:
      - `tools/project.js`
      - `remotion_init_project`
      - `services/environment.js`
      - `services/browser.js`
      - `services/browser.js`'s non-literal `import()`
    - `T6 poisoned registry: a fifth tool`. Append `"viz_render_html"` to `SERVICE_TOOLS`, and add a matching entry to `TOOL_DEFS` in `src/service/tools.ts`. Assert:
      - T1's equality fails.
      - A live `tools/list` from the poisoned build returns five.
      - `verdict` reports `viz_render_html`.
    - `verdict catches each evasion`. These are small hand-written `.js` fixtures, written by the test into the tmp dist:
      - `const r = server.registerTool`
      - `server["registerTool"]("x", …)`
      - `server.tool.bind(server)`
      - `const { registerTool } = server`
      - `server.registerTool(name, …)` outside the registry
      - `import("@resvg/resvg-js")`
      - `import(variable)`
    - **Positive control:** `claims.tool !== toolOf(m)` is not reported.

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `npm run build:service && node --test test/absence.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement `scripts/check-service-closure.mjs`.** Use the repo's `typescript` parser on the emitted `.js` files. Normalize paths to forward slashes.

- [ ] **Step 4: Run the tests and watch them pass.**
  - Run: `npm run build:service && node --test test/absence.test.mjs && npm run lint`
  - Expected: PASS. T5, T6 and the evasion cases must report their poison, which is what proves T1–T4 are live.

- [ ] **Step 5: Commit.**
  `git commit -m "test: prove the four forbidden tools are absent from the service build"`

---

## Task 9: Pack tooling, the zod gate and the fixture pack

**Files:**
- Create: `scripts/build-pack.mjs`, `scripts/lib/zod-gate.mjs`, `test/zod-gate.test.mjs`
- Create, in the fixture project:
  - `fixtures/pack/package.json`, `fixtures/pack/package-lock.json`
  - `fixtures/pack/src/index.ts`, `Root.tsx`, `Swatch.tsx`, `Slow.tsx`, `schemas.ts`
  - `fixtures/pack/public/` holding a Latin-Extended font file, with its licence
  - `fixtures/pack/props/turkish.json`
- Create: `docs/CONTRACT-pack.md`
- Modify:
  - `package.json`: add the test file to both lists.
  - `eslint.config.js`: ignore `fixtures/pack/**`.
  - `.gitignore`: add `fixtures/pack/dist-pack/` and `fixtures/pack/node_modules/`.
  - `.github/workflows/ci.yml`: add a `pack` job and add `pack` to `ci-ok`'s `needs` (Step 6).
  - `docs/CI.md`: the `pack` job.

**Pinned versions.**
- `remotion`, `@remotion/cli`, `@remotion/renderer`, `@remotion/bundler` and `@remotion/fonts`: exactly `4.0.532`.
- `zod`: exactly `4.5.4`.
- All of them, plus `react` and `react-dom`, go under `dependencies`, never `devDependencies`. The derived image installs with `npm ci --omit=dev`, and preflight needs the CLI and the renderer at runtime.
- First run `npm view remotion@4.0.532 version` and `npm view zod@4.5.4 version`. If either prints nothing, stop and report.

**Interfaces:**
- Produces:

```js
// scripts/lib/zod-gate.mjs
export function zodMajor(schema)            // -> 3 | 4 (zod 4 has `_zod`)
export function gateSchema(schema)          // -> string[] "<path>: <rule>"; zod 3 -> ["<root>: zod 3 is not supported, use zod 4"]
export function boundsSurvived(schema, jsonSchema) // -> string[] bounds the export lost
export function discoverCompositions(rootElement) // -> {id, width, height, fps, durationInFrames, schema, hasCalculateMetadata}[]
// scripts/build-pack.mjs  CLI: node scripts/build-pack.mjs <projectDir> [--out <dir>]; exit 1 + message on any failure
```

**What `build-pack.mjs` does, in order:**
1. Bundle the project. Use `npx remotion bundle` if its `--help` succeeds; otherwise use `@remotion/bundler`'s `bundle()`.
2. Load the schemas by bundling a generated entry with the project's own esbuild, then call `RemotionRoot()`.
3. Run `discoverCompositions`. Each of these is a failure that names the composition:
   - zero compositions
   - `calculateMetadata` without static `width` and `height`
   - a composition with no `schema`
4. For each composition, run these and fail on any problem, listing every one:
   1. `gateSchema` (a zod 3 schema stops here)
   2. export with the project's own `z.toJSONSchema`
   3. `boundsSurvived`
   4. the service's own `checkSchemaVocabulary` (imported from `dist-service`)
5. Write `<projectDir>/dist-pack/`, holding:
   - `pack-manifest.json`, with one template per composition. `id` is the composition id, verbatim; `defaultFps` is `fps`; `maxFrames` is `durationInFrames`.
   - `bundle/`
   - copies of `package.json` and `package-lock.json`

   `packHash` is the SHA-256 over the sorted relative paths and contents of `bundle/`. `remotionVersion` comes from the installed `@remotion/renderer`.

**The fixture pack.** `Root.tsx` registers exactly two compositions, with these literal lower-case ids, which are also the template ids.
- **`swatch`.**
  - A 1280×720 still, `durationInFrames 1`.
  - Schema: `z.strictObject({ label: z.string().max(80), color: z.string().max(7).regex(/^#[0-9a-fA-F]{6}$/) })`.
  - It renders a full-frame `backgroundColor: color`, with the label centred on one line: white, `fontSize 96`, weight 700, in the pack font loaded from `public/` with `@remotion/fonts`, never from the web.
- **`slow`.**
  - A 64×64 still, `durationInFrames 1`, schema `z.strictObject({})`.
  - It holds the frame with `delayRender("slow", { timeoutInMilliseconds: 120_000 })`. That has to exceed `RENDER_CLI_TIMEOUT_MS` (60 000), and the service's `--timeout=60000` has to exceed the 45 s deadline. Only then is it the service deadline, and not one of Remotion's two timeouts, that ends the render.
- **`props/turkish.json`** is `{"label":"Beşiktaş · İstanbul · Şenol Güneş","color":"#1d4ed8"}`.

- [ ] **Step 1: Write the failing tests in `test/zod-gate.test.mjs`.**
  - **Schemas** are built with the repo's `zod/v4` subpath. Every refused row sits on a base that is otherwise valid:
    `z.strictObject({ a: z.string().max(10), …row })`
  - **Each row** asserts that `gateSchema` returns **exactly one** violation, matching that row's rule. Its **positive twin**, the same base without the construct, returns `[]`.
    - `z.url().max(10)`, `z.string().max(9).url()`, `z.email().max(10)`, `z.string().max(10).email()`. Each is bounded, so the only rule it breaks is its format. The twin is `z.string().max(10)`.
    - `z.string()` with no max
    - `z.number().min(0)` with no max
    - `z.array(z.string().max(5))` with no max
    - `z.object({})` that is not strict
    - `.passthrough()`
    - `.catchall(z.string().max(5))`
    - `z.string().max(9).refine(...)`
    - `z.enum(["a","b"]).refine(...)`
    - `z.literal("a").refine(...)`
    - `z.string().max(9).optional().refine(...)`
    - `.superRefine`
    - `.transform`
    - `z.preprocess`
    - `.trim()`
    - `z.record(...)`
    - `z.any()`
    - `z.unknown()`
    - `z.union([...])`
  - `it permits the realistic template`
    - `title` max 80
    - `color` max 7 with an anchored regex
    - `players` max 22 of strict `{name max 40, number int 1..99}`
    - a `theme` enum
    - an optional field
  - `boundsSurvived reports nothing for z.toJSONSchema of the realistic template, and reports a removed maxLength`. The negative control deletes `maxLength` from the export.
  - `zod 3 schemas are refused with the clear message`. Use the repo's root `zod` (3.25.76).
  - `discoverCompositions finds none in an empty root, flags calculateMetadata without static size, and flags a composition with no schema by id`. Use hand-built React elements.

- [ ] **Step 2: Run them and watch them fail.**
  - Run: `node --test test/zod-gate.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement `scripts/lib/zod-gate.mjs`.**
  - It normalizes zod 4 nodes from `schema._zod.def`.
  - It reads `def.checks` on **every** node type, enum, literal and optional included.
  - It reads `def.format` on top-level format schemas.
  - A `catchall` other than `never` counts as not strict.

- [ ] **Step 4: Run the tests and watch them pass.**
  - Run: `node --test test/zod-gate.test.mjs && npm run lint`
  - Expected: PASS.

- [ ] **Step 5: Build the fixture pack, and verify the two Remotion assumptions no spike tested.** Run these in WSL Ubuntu with Node 22.
  0. In the repo root, run `npm run build:service`, because `build-pack.mjs` imports `checkSchemaVocabulary` from `dist-service`. Then, in `fixtures/pack`, run `npm install` once to create `package-lock.json`, and commit it.

  Run the rest from `fixtures/pack`:
  1. `npm ci`
  2. `npx remotion bundle --help`. If it fails, `build-pack.mjs` uses the `bundle()` API instead.
  3. `node ../../scripts/build-pack.mjs .`
  4. `npx remotion still dist-pack/bundle swatch out.png --props=props/turkish.json --timeout=60000`. **If the CLI refuses a bundle directory as its source, stop and report.** Design §5.4 would then need a different source.

  Expected:
  - `dist-pack/pack-manifest.json` has exactly the templates `swatch` and `slow`.
  - `loadPack("fixtures/pack/dist-pack")` succeeds.
  - The Turkish props validate.
  - Editing `Swatch.tsx` and rebuilding changes `packHash`. Compare the two values.

- [ ] **Step 6: Add the CI `pack` job.**
  - It runs on `ubuntu-latest`, with the existing pins:
    - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
    - `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0` (Node 22)
  - Its steps:
    1. `npm ci`
    2. `npm run build:service`
    3. `npm ci --prefix fixtures/pack`
    4. `node scripts/build-pack.mjs fixtures/pack`
    5. Upload `fixtures/pack/dist-pack/` with `actions/upload-artifact`, `with: { name: pack, path: fixtures/pack/dist-pack/ }`. Use the SHA already pinned in `ci.yml`, or verify a new one against the action's release page before committing.
  - Add `pack` to `ci-ok.needs`.

- [ ] **Step 7: Write `docs/CONTRACT-pack.md`.**
  - the manifest shape, and the template-id rule
  - both gates' rules
  - authoring replacements for `zColor` (`z.string().max(7).regex(...)`), `zTextarea` (`z.string().max(N)`) and `zMatrix`
  - self-contained packs: fonts and images inside the pack, no web fonts, no fetches (ruling 6)
  - the `calculateMetadata` rule
  - that every composition must declare a `schema`
  - that `remotion` and the `@remotion/*` packages go under `dependencies`
  - that the backend validates against `list_templates`' `propsSchema`
  - **String length.** zod's `.max(N)` counts UTF-16 units, while the service (ajv) counts code points. Size `.max(N)` for the UTF-16 length if the template's own code relies on zod's limit.

- [ ] **Step 8: Commit.**
  `git commit -m "build(service): build template packs with a zod 4 vocabulary gate"`

---

## Task 10: The service image, the end-to-end proof and the deploy guide

**Files:**
- Create:
  - `Dockerfile.service`
  - `fixtures/pack/Dockerfile.derived`
  - `.dockerignore`. It applies only to the `Dockerfile.service` build, whose context is the repo root, and excludes `node_modules`, `dist`, `tmp-*`, `.git` and `fixtures/`.
  - `fixtures/pack/.dockerignore`, for the derived build, whose context is `fixtures/pack`. It excludes `node_modules`, `src`, `public`, `props` and `out.png`, so only `dist-pack/` and the Dockerfile are sent.
  - `scripts/walk-only-proof.mjs`
  - `src/service/healthcheck.ts`
  - `test/healthcheck.test.mjs`
  - `scripts/image-checks.sh`, `scripts/image-e2e.mjs`
  - `docs/DEPLOY.md`
  - `.github/workflows/service-image-publish.yml`
- Modify:
  - `tsconfig.service.json`: `"files": ["src/service/index.ts", "src/service/healthcheck.ts"]`. It is a second entry, never imported by `index.ts`, because importing it would run the probe.
  - `package.json`: add the test file to both lists.
  - `.github/workflows/ci.yml`: add an `image` job, and add it to `ci-ok.needs`.
  - `docs/CI.md`

**Interfaces:**
- Consumes: everything above. This task proves goal 1 (owner ruling 5).

**The images.**

- **`Dockerfile.service`** has two stages, both `FROM node:22-bookworm-slim` and linux/amd64.
  - **Build stage:**
    1. `WORKDIR /app`
    2. `npm ci`
    3. `npm run build:service`
    4. `npm prune --omit=dev`
  - **Runtime stage:**
    1. `WORKDIR /app`.
    2. `apt-get install --no-install-recommends` these packages:
       - `tini`, `util-linux`, `fonts-noto-core`
       - Chrome's libraries: `libnss3`, `libnspr4`, `libasound2`, `libgbm1`, `libxkbcommon0`, `libdbus-1-3`, `libatk-bridge2.0-0`, `libcups2`, `libpango-1.0-0`, `libcairo2`
    3. Remove npm: `rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx`.
    4. Copy `package.json`, `dist-service/` and the pruned `node_modules/`.
    5. `RUN mkdir -p /var/log/remotion-viz && chown node:node /var/log/remotion-viz && chmod 0750 /var/log/remotion-viz`.
    6. `USER node`.
    7. `ENTRYPOINT ["/usr/bin/tini","--","node","dist-service/service/index.js"]`.
    8. `HEALTHCHECK CMD ["node","dist-service/service/healthcheck.js"]`.
- **`src/service/healthcheck.ts`** imports only `node:http`.
  - It sends `GET http://127.0.0.1:${SERVICE_PORT ?? 8080}/mcp`, with a 3 s request timeout.
  - It exits 0 only on status 405, and 1 otherwise.
- **`fixtures/pack/Dockerfile.derived`** is the recipe deployers copy.
  - **Pack stage**, `FROM node:22-bookworm-slim AS pack`:
    1. `WORKDIR /pack`
    2. `COPY dist-pack/ /pack/`
    3. `RUN npm ci --omit=dev && npx remotion browser ensure && mv /pack/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64 /pack/browser && test -x /pack/browser/chrome-headless-shell`
    - `browser ensure` takes no destination, so the `mv` gives the browser a fixed path, and `test -x` fails the build if Remotion's layout changes.
  - **Final stage**, `FROM ${SERVICE_IMAGE}`:
    1. `COPY --from=pack /pack /pack`
    2. `ENV PACK_DIR=/pack BROWSER_EXECUTABLE=/pack/browser/chrome-headless-shell`
    - `--browser-executable` on every render is what prevents a runtime download. No download-disable variable exists.

- [ ] **Step 1: Write the failing healthcheck test** in `test/healthcheck.test.mjs`. It spawns `dist-service/service/healthcheck.js` with `SERVICE_PORT` set:
  - against a live `createServiceHandler`, it exits 0
  - against a port nothing listens on, it exits 1

  Run it, watch it fail, implement `healthcheck.ts`, and watch it pass.

- [ ] **Step 2: Write `scripts/image-checks.sh`.**
  - **How it runs.** It is piped into a **running** derived-image container started with its real entrypoint, and with throwaway configuration (without it, the service exits at once):
    - `docker run -d --name rv -e SERVICE_AUDIENCE=ci`
    - `-e IDENTITY_HMAC_KEY=<random 32 bytes, base64url>`
    - `-e AUDIT_HMAC_KEY=<random 32 bytes, base64url>`
    - `rv-pack:dev`

    Then run `docker exec -i rv sh -s < scripts/image-checks.sh`. The script is never copied into the image.
  - **Checks.** Each failure message names what was missing.
    - `command -v setpriv`
    - `! command -v npm`
    - `cat /proc/1/cmdline` contains `tini`
    - `"$BROWSER_EXECUTABLE" --version` exits 0
    - `ldd "$BROWSER_EXECUTABLE"` reports no `not found`
    - the renderer version is ≥ 4.0.458
    - `/var/log/remotion-viz` is writable by the current user

- [ ] **Step 3: Write `scripts/image-e2e.mjs <derived image>`.**
  - **Setup.**
    - It generates throwaway keys, starts the container with them (`--init` is not needed, because `tini` is the entrypoint), and waits for the healthcheck to report healthy, polled to a deadline.
    - It uses `test/helpers/signing-client.mjs`.
    - **The orphan scan** is a `docker exec <c> node -e <SCAN>`. The image has no `ps`, and a process's comm is cut to 15 characters, so the scan reads `/proc/<pid>/cmdline` directly for every numeric pid.
      - Before each case, the script takes a **baseline** pid set.
      - A survivor is any pid that is not in the baseline, is not 1, is not the service, and is not the scan itself.
      - A non-zero `docker exec` exit **fails the case**. It never counts as an empty scan.
    - **Scan positive control:** during case 4, before the deadline, the scan finds at least one new pid whose cmdline contains `chrome-headless-shell`.
  - **Cases:**
    1. `render_still swatch` with `props/turkish.json` returns a PNG. Its first eight bytes are the signature, and its IHDR is 1280 × 720.
    2. A replayed request id gets 401.
    3. A forged header gets 401.
    4. `render_still slow` gets `render_timeout`, and its result arrives **after** `RENDER_STILL_DEADLINE_MS`. Afterwards, the orphan scan is empty, polled to a 20 s deadline. A failure lists the surviving cmdlines.
    5. **Crash.** Start `render_still slow`. Once the scan shows the CLI, run `docker exec -u 0 <c> sh -c 'kill -KILL <cli pid>'`. The image has no `/usr/bin/kill`, so this uses the shell's builtin. Assert the exec exits 0, then `render_failed`, then an empty scan, polled to a deadline. This is pdeathsig doing its job.
    6. **Audit.** After cases 1–3, read `/var/log/remotion-viz/service-audit.jsonl` with `docker exec`. Assert:
       - an `ok` line for case 1's `request_id`
       - `refused` lines for the replayed and forged requests
       - no string value from `props/turkish.json` anywhere in the file
    7. **Golden glyphs.**
       1. In the same container, render `swatch` with `{"label":"ŞşİığĞüÜ","color":"#000000"}`, and again with `{"label":"\u{10FFFD}\u{10FFFD}\u{10FFFD}\u{10FFFD}\u{10FFFD}\u{10FFFD}\u{10FFFD}\u{10FFFD}","color":"#000000"}`, which is guaranteed tofu.
       2. Count each image's ink pixels: non-black, after thresholding.
       3. Assert the Turkish render differs from the tofu render in at least half of the tofu render's ink pixels, using `pixelmatch`.
       4. Record the measured counts in a comment the first time it passes.

- [ ] **Step 3b: Write `scripts/walk-only-proof.mjs`, the `/proc` walk alone (design §5.6).**

  Case 4 cannot prove this through the service. On SIGTERM, Remotion's own BrowserRunner kills Chrome's group within about 11 ms, setpriv or not, so a passing scan proves nothing about the walk. This proof therefore runs below the service, and sends SIGKILL only.

  - **How it runs.** It is bind-mounted read-only into the derived image, and run with `docker run --rm --entrypoint /usr/bin/tini -e SERVICE_AUDIENCE=proof -e IDENTITY_HMAC_KEY=<k> -e AUDIT_HMAC_KEY=<k> -v "<abs>/scripts:/proof:ro" rv-pack:dev -- node /proof/walk-only-proof.mjs`. Keep `tini` as PID 1 so orphans are reaped.
  - **What it does:**
    1. Import `parseServiceConfig`, `preflight`, `runRenderProcess`, `childEnv` and `buildStillArgv` from `dist-service` by `pathToFileURL`.
    2. Run `preflight`.
    3. Build the argv for `slow`.
    4. Set `env = { ...childEnv(process.env, workDir), PATH: "/usr/local/bin" }`, and assert that `setpriv` cannot be found on that PATH. Remotion resolves `setpriv` against the child's PATH, so it now runs Chrome without pdeathsig.
    5. Poll `/proc` until a `chrome-headless-shell` process exists.
    6. Abort through the signal.
  - **Two runs, each with an injected `kill` that only ever sends SIGKILL**, so no SIGTERM listener can run:
    - **Control.** `kill` SIGKILLs only the CLI's own group. Assert `cleanup.verified === false`, and that Chrome survives. Then reap it.
    - **Proof.** `kill` SIGKILLs every group `runRenderProcess` passes it. Assert `cleanup.verified === true`, and that no new pid survives, polled to a deadline.

  The control is what shows the proof run can fail.

- [ ] **Step 4: Run it locally.**
  1. Start Docker Desktop's Linux engine.
  2. Build the fixture pack in WSL (Task 9 Step 5).
  3. `docker build -f Dockerfile.service -t rv-service:dev .`
  4. `docker build -f fixtures/pack/Dockerfile.derived --build-arg SERVICE_IMAGE=rv-service:dev -t rv-pack:dev fixtures/pack`
  5. Start the checks container with throwaway keys, as in Step 2, and run `image-checks.sh` against it.
  6. `node scripts/image-e2e.mjs rv-pack:dev`
  7. Run `walk-only-proof.mjs` as in Step 3b.

  Expected: every check, every case and both proof runs pass. Each failure names what was missing.

- [ ] **Step 5: Add the CI `image` job to `ci.yml`.**
  - It runs on `ubuntu-latest` and `needs: pack`.
  - Its steps:
    1. Checkout, then `actions/setup-node` with Node 22, using the same pins as the `pack` job.
    2. `npm ci`, then `npm run build:service`. The e2e script's signing client imports from `dist-service`.
    3. Download the `pack` artifact with `actions/download-artifact`, `name: pack, path: fixtures/pack/dist-pack`. Verify its SHA pin against the action's release page.
    4. Build both images.
    5. Start the checks container and run `image-checks.sh`.
    6. Run `image-e2e.mjs`.
    7. Run `walk-only-proof.mjs`.
  - Add `image` to `ci-ok.needs`.

- [ ] **Step 6: Write `.github/workflows/service-image-publish.yml`.**
  - It triggers on push to `main` and runs only when `vars.PUBLISH_SERVICE_IMAGE == 'true'`, with `permissions: contents: read, packages: write`.
  - It builds `Dockerfile.service` for linux/amd64 and pushes it to `ghcr.io/curasinan/remotion-viz-service`. The resulting digest goes in the job summary.
  - Every third-party action is SHA-pinned. Verify each SHA against the action's release page before committing.

- [ ] **Step 7: Write `docs/DEPLOY.md`.**
  - the derived-image recipe
  - the required environment variables, and how to generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
  - one replica per `SERVICE_AUDIENCE`, with a Recreate rollout
  - restart policy `always`, which recovers exit code 70
  - a stop grace period of at least 20 s, so shutdown can finish its kill grace and verification: `docker run --stop-timeout 20`, compose `stop_grace_period: 20s`, Kubernetes `terminationGracePeriodSeconds: 20`
  - **mandatory egress deny** (ruling 6): no default route, and `169.254.169.254` blocked
  - TLS in front of the service
  - a volume at `/var/log/remotion-viz` for the audit log, writable by uid 1000 (`node`). Otherwise the service refuses to start.
  - "never put keys in a Dockerfile or an image"

- [ ] **Step 8: Verify and commit.**
  - Run: `npm run build && npm run build:service && npm test && npm run lint`
  - Expected: PASS.
  - `git commit -m "build(service): the service image, its end-to-end proof and the deploy guide"`

---

## Owner checkpoints (not implementer tasks)

1. **Merge the stack.** Review and merge the stacked PRs. Merging PR #18 accepts the corrected ADRs.
2. **Gateway against the vectors.** Run your gateway against `test/vectors/identity-v1.json`, following `docs/CONTRACT-gateway.md`.
3. **Publishing.** Set the repository variable `PUBLISH_SERVICE_IMAGE=true` when you want images published to GHCR.
4. **The group's pack.** Give the group `docs/DEPLOY.md` and `docs/CONTRACT-pack.md` for its football pack.
5. **Remotion licence.** It stays an open risk, unverified in this repository.

# CI and release pipeline

Four workflows. This file says what each gate proves, and — where it matters —
what evidence exists that the gate actually catches something, rather than only
that it has stayed quiet.

That distinction is the organising idea here. A gate nobody has watched fail is
indistinguishable from a gate that is switched off, so several of the checks
below have a recorded moment where they caught a deliberately planted defect.

## `ci.yml` — on every push and pull request

| Job | Needs | What it is for |
| --- | --- | --- |
| `build-and-test` | — | 3 OS × Node 22/24/26 = 9 legs. Type-check, build, browser-presence assertion, the suite, coverage on one leg, MCP conformance, lint, `npm audit`. |
| `sbom` | — | CycloneDX and SPDX SBOMs, plus a Trivy filesystem scan (advisory). |
| `bundle` | `build-and-test` | Builds the `.mcpb`, enforces the size ceiling, runs the bundle assertions. |
| `verify-bundle` | `bundle` | 6 platforms. Extracts the shipped artifact and *runs* it. |
| `lint-workflows` | — | `actionlint` over `.github/workflows/`. |
| `ci-ok` | all of the above | One aggregate check, so branch protection has a single required status instead of 15 that change name whenever the matrix does. |

### The browser-presence assertion is not decoration

`test/html.test.mjs` gates all seven of its tests on `locateBrowser()` evaluated
at module scope. On a runner without Chrome the file *skips* and `npm test`
still exits 0 — a green gate that ran nothing, which is worse than no gate
because it looks like coverage. The assertion turns that into a hard failure.

### `verify-bundle` exists because presence is not loadability

`test/bundle.test.mjs` asserts the six `@resvg/resvg-js` platform binaries are
present in the zip. That is not the same as them working. `verify-bundle`
extracts the artifact on each target platform, completes a real MCP handshake
against the bundled server, and calls `viz_render_svg`, which forces that
platform's own native addon to load.

**Recorded evidence.** Corrupting the `darwin-arm64` binary inside an otherwise
valid `.mcpb` leaves all ten `bundle.test.mjs` assertions green while the
artifact is unusable for every macOS ARM user; only the `macos-latest` leg
catches it. Corrupting the *build platform's own* binary is the one case the
older assertions already caught (9 of 10). Before this job existed, exactly one
of the six binaries was ever loaded, and only incidentally.

### The lint gate, and the canary that proved it

`npm run lint` is blocking as of PR #7. Before it was made blocking, a temporary
`canary.yml` workflow planted a deliberate lint violation to establish that the
linter actually reported it. It did, and the canary was removed in `f205528`
with the message *"remove the canary now that the linter has been seen catching
it"*.

**That evidence is a single failed workflow run, and it is deliberately not
deleted:**

```
workflow id 347516519  (.github/workflows/canary.yml, file since removed)
  run: 2026-09-01, branch ci/pipeline-hardening, conclusion: failure
```

GitHub keeps the workflow *entity* registered as `active` even though the file
is gone, so it still appears in `gh api .../actions/workflows`. Deleting that one
run would drop the ghost from the listing — and would destroy the only record
that the lint gate was ever observed catching a planted violation. The confusing
API line is the cheaper of the two costs. If you are tidying workflows and
wondering why a non-existent `canary.yml` is listed, this is why; leave it.

## `release.yml` — on push to `main`, and `workflow_dispatch`

semantic-release decides the version from commit types, `@semantic-release/exec`
runs `scripts/sync-version.mjs` so `package.json`, `manifest.json` and
`SERVER_VERSION` move together, then builds, bundles, and enforces the size gate
before anything is tagged. cosign signs the artifact keyless and verifies its own
signature before the job ends.

Three things worth knowing:

- **The gate runs before `npx semantic-release`,** so a failure leaves no tag.
  It covers type-check, build, the browser assertion and the suite on
  ubuntu/Node 24 — *not* the full matrix, not `verify-bundle`, not the
  conformance check. A green release is not a green matrix.
- **A downgrade guard refuses any computed version at or below the one in
  `package.json`.** It exists because with no tags in the repository
  semantic-release restarts at `1.0.0` and would have published a downgrade,
  rewriting all three version files and pushing that to `main`. Confirmed in a
  dry run before it could happen; after tagging `v1.2.0` the same dry run
  correctly computed `1.2.1`.
- **Most merges produce no release, by design.** Only `feat:` and `fix:` (and
  breaking changes) trigger one. A run of `ci:`, `docs:`, `test:`, `build:` and
  `refactor:` commits correctly publishes nothing — the workflow still runs the
  full gate before deciding.

See [`../README.md#verifying-a-release`](../README.md) for the verification
recipe, including why cosign 3 cannot verify these artifacts and a 2.x binary is
required.

## `pages.yml` — the landing site

Publishes `site/` to GitHub Pages. **Nothing derived from the audit log belongs
here.** The log's `detail` field records file paths verbatim for strings under 64
characters, and Pages is public; see [`GATEWAY.md`](GATEWAY.md) for where audit
data may and may not go.

## `ruleset-drift.yml` — daily at 07:00 UTC

Asserts the `protect-main` ruleset is still `active`. Branch protection that
silently lapses is worse than none, because the absence of failures reads as
health. This is the one check that fails when *nothing* happened.

## Supply chain

Third-party actions are SHA-pinned, not tag-pinned — a tag is mutable and the
release workflow holds `id-token: write` and `contents: write`. `sigstore/cosign-installer`
is pinned to the v3 line deliberately: v4 installs cosign 3, which replaced the
detached `--output-signature`/`--output-certificate` form of `sign-blob` with
`--bundle`, changing both the published files and the command a user runs to
check them.

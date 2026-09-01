# Release Integrity Implementation Plan

**Goal:** the release path defends itself. The artifact's contents stop depending
on the build host, `main` stops accepting unchecked pushes, the pipeline's own
config gets the same gates the code has, and lint goes blocking.

**Context:** executed after the 2026-09-01 continuity review of the CI-hardening
phase. The review found (verified against the shipped bytes) that v1.2.1 carried
an accidental `@resvg/resvg-js-linux-x64-musl` binary — npm installs it on the
ubuntu release runner because resvg's platform packages declare no `libc` field —
and that the size-gate baseline had been recorded from a Windows build, so the
gate compared different artifact classes. `bare-*` (~2 MB compressed, in every
bundle since the first lockfile) is Bare-runtime-only and unreachable under Node.

**Ground rules carried over:** every gate proven against a known-bad input before
it is trusted; cite what was executed vs. inferred; no tag, release, or publish
without the owner asking. All commits in this phase use non-releasing
conventional-commit types (`build:`/`ci:`/`test:`/`docs:`/`refactor:`) so
semantic-release stays quiet until a release is wanted.

## Task 1: Bundle determinism (PR: `build/bundle-determinism`)

- [x] Guards first, proven red against the *shipped* v1.2.1 (not a synthetic
      fixture): set-equality on `@resvg/*` vs `NATIVE_TARGETS`, zero `bare-*`,
      and the partial-musl rule (one binary without its sibling is an accident,
      not a backed claim). 3/12 fail against v1.2.1 naming the exact offenders.
- [x] `build-bundle.mjs` step 3b: enforce `NATIVE_TARGETS` as an allowlist and
      prune the five `bare-*` packages after `npm ci`. 12/12 green on the pruned
      build; `verify-bundle-runtime.mjs` confirms 13 tools + resvg loads.
- [x] Re-record the baseline from the deterministic build: 20,463,297 →
      18,440,458 (down, not up — the old number measured a Windows-built bundle
      while CI measures ubuntu-built ones).
- [x] Docs: BUNDLE.md platform section, ci.yml musl comment.
- [ ] CI green on the PR — the ubuntu `bundle` job is the cross-host proof.

## Task 2: Branch protection on `main`

- [ ] Add a `ci-ok` aggregate job (`needs:` all four CI jobs) so protection
      requires one stable context instead of seventeen matrix-shaped names.
- [ ] Repository ruleset: require PR + the `ci-ok` check, block force-push and
      deletion; bypass for the GitHub Actions app so `@semantic-release/git`
      can still push the release version-bump commit. The bypass cannot be
      proven until the next real release — stated as unverified, watch it there.

## Task 3: Pipeline hardening (PR: `ci/pipeline-hardening`)

- [ ] actionlint on the workflows, proven red in-PR against the empty-`${{ }}`
      class that made release.yml uncompilable.
- [ ] Couple `MIN_NODE_MAJOR` (src/services/environment.ts) into
      `test/engines.test.mjs` — the one Node-floor statement of four the test
      does not read; drift proven invisible by execution during the review.
- [ ] SHA-pin `aquasecurity/trivy-action` (tag `v0.36.0` verified to exist).
- [ ] First-party actions: all 14 `@v4` pins → SHA-pinned current majors
      (checkout v7, setup-node v7, upload-artifact v7, download-artifact v8).
      v4 targets deprecated Node 20; the repo dropped EOL Node 20 from its own
      matrix while running on actions that target it.
- [ ] Verify the six resvg tarballs `build-bundle.mjs` fetches against the
      committed lockfile's `integrity` hashes — today the signature attests the
      workflow, not the vendored bytes.
- [ ] `sync-version.mjs` writes package-lock.json too (it drifts one release
      behind), and the release git assets include it.
- [ ] Fix the `verifyStudioProcess` doc comment: "unknown" is reachable on a
      busy stock Windows machine (5 s PowerShell cold start), not only in
      stripped environments.

## Task 4: ESLint to blocking

- [ ] Fix the 5 findings (3× no-useless-escape, 2× no-unused-vars) —
      `refactor:`, regex semantics proven unchanged by tests.
- [ ] Flip `continue-on-error` in its own commit, per the Task 3 plan note.

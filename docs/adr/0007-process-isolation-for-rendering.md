# ADR-7: Process isolation for rendering in the service profile

**Status:** Accepted

**Relation:** Completes [ADR-3](0003-isolation-boundary.md) for the service
profile. Does not supersede it.

## Context

This ADR follows the owner's rulings of 2026-10-26, which are §1 of the
[v2 design](../superpowers/specs/2026-10-26-service-profile-v2-design.md), cited
here by number: ruling 1 (isolation), ruling 2 (output) and ruling 3
(distribution).

ADR-3's Decision (`0003-isolation-boundary.md:34-36`):

> **Input validation first** (the T-1 fix: a pixel-count cap read from resvg's
> intrinsic dimensions before render), **then** Option 2 if it is still warranted.
> Options 3 and 4 are rejected.

Its Option 2 (`:25`) reads: "**Isolate resvg only** — move rasterization to a
short-lived child."

**The first half shipped.** It is a raster size cap with three checks against
`MAX_RASTER_DIMENSION = 8_000` (`src/constants.ts:29`):
- `rasterizeSvg`'s width check (`src/services/raster.ts:64`)
- `assertRasterBudget`'s output-height check (`:46`), called at `:98`
- `assertRasterBudget`'s pixel check (`:54`), against `MAX_RASTER_PIXELS`

That pixel check cannot fire. `MAX_RASTER_PIXELS` is
`MAX_RASTER_DIMENSION * MAX_RASTER_DIMENSION` (`src/constants.ts:33`), and the
width and height are each already capped at `MAX_RASTER_DIMENSION`. It is the
height check that refuses the T-1 SVG.

**The second half did not ship.** Outside `src/service/`, `grep -rnE
"child_process|fork\(|Worker|worker_threads" src/` hits only
`src/services/exec.ts` and `src/services/process.ts`. Inside it, the service
profile's own `src/service/preflight.ts` runs the browser's `--version`, and
`src/service/render-process.ts` spawns the Remotion CLI; neither touches
resvg. resvg parses (`raster.ts:84`) and renders (`:102`) on the stdio
server's main thread.

**No known input kills the server today.** The cap refuses the T-1 SVG, and
`test/protocol.test.mjs:111-118` asserts that the server survives it. ADR-3's
consequence still stands: "With T-1 closed there is no known path that kills the
main process." (`:54`)

**A correction to ADR-3's context table, for the record.** ADR-3 says the
Remotion path is "already a separate process (CLI spawn)" and "cannot crash the
main process" (`:13`). That is incomplete: a multi-frame
`remotion_render_still` tiles its frames inside the server process, through
resvg:
- `render.ts:244` calls `tilePanels`.
- `tile.ts:100` calls `rasterizeSvg`.
- `raster.ts:84` and `:102` follow.

The cap bounds that path too. Its residual risk belongs to local-dev (see
Scope), but ADR-3 never recorded it.

The table is also silent on a second gap, which does not contradict it. A
separate process can leave things behind: the CLI starts Chrome, and a CLI that
is killed or hangs does not always take Chrome with it. The spikes of 2026-10-25
measured this (see Decision).

**The constraints.** These are the owner's fixed constraints of 2026-10-17,
quoted because they are not committed anywhere else:

> 6. Process isolation (ADR-0003's unshipped half) is a PREREQUISITE for the service
>    profile: render per forked child, stdio ignored in the child, timeout + SIGKILL,
>    crash surfaces as a tool error. --max-old-space-size does NOT cap resvg's native
>    memory; the pixel cap remains the native-memory guard and the ADR must say so.
> 7. Video renders are asynchronous: render_video_start returns a job id. A frame
>    budget guardrail is required (the video analogue of the pixel cap).

**The owner changed fixed constraint 6's mechanism on 2026-10-26 (ruling 1).**
The service spawns the Remotion CLI directly, with no forked Node worker. The
intent of constraint 6 stays. Design §3 states it as a goal: a render that hangs
or crashes "cannot leave processes behind, and cannot take the service down
silently". The failure surfaces as a tool error. The image must carry `setpriv`
and `tini`, and at startup the service must check that the installed Remotion
renderer is at least 4.0.458.

Ruling 1 dropped the worker. The design records two facts about the still path
(design §5.6). The service process runs no native code on it, with no resvg and
no puppeteer (ADR-5 keeps `raster.ts` out of `dist-service/`). And a crash
inside the CLI or Chrome becomes a `render_failed` tool error. The native code a
render runs is in the CLI and Chrome, which are already separate processes.

**Why "completes" and not "supersedes".** Nothing in ADR-3 is reversed.
Local-dev keeps ADR-3's decision and its accepted residual risk (see Scope).
ADR-3 makes Option 2 conditional on "if it is still warranted" (`:35`). Its
context records that the Remotion CLI and Chrome already run as separate
processes (`:13`, `:17-18`), and its rationale gives Option 2's gain as
protecting the main process from unknown native crashes (`:43-45`). The service
process never loads resvg (design §5.6). What this ADR adds for the service
profile is the guarantee that a render's processes are all killed (owner
ruling 1, design §3 goal 3).

## Decision

The service spawns the Remotion CLI directly, and on any stop it kills every
process group the CLI created. Owner ruling 1 chose this in place of a forked
Node worker. It is not ADR-3's Option 2 as written, which moves resvg behind a
child, and the service never reaches resvg (design §5.6).

### The service owns its spawner

The spawner will be `src/service/render-process.ts`.
- It reuses only `killTree` from `src/services/exec.ts` (`:20-45`).
- It does not go through `runCommand` or `cliLimiter`, and local-dev code is not
  changed. `runCommand` spawns with `{ ...process.env, CI: "1", ...env }`
  (`exec.ts:73`), which would hand the service's keys to the CLI. The service
  gives its children an allowlisted environment instead (ADR-4).
- It takes an `AbortSignal`. It spawns the CLI `detached`, as `runCommand` does
  on POSIX (`exec.ts:72`), so the CLI leads its own process group. It records
  the CLI's pid.
- **stdio.** Fixed constraint 6's "stdio ignored in the child" applies to the
  CLI as follows. Stdin is ignored. Stdout and stderr are piped and drained
  continuously into a bounded tail, the last 2 500 characters, so a render that
  writes megabytes cannot wedge on an undrained pipe. The tail serves the
  service's own diagnosis and never reaches a caller (ADR-5).
- It runs `remotion still` on the pack's prebuilt `bundle/`. The service mints
  the output path, pins the browser executable, and passes width, height and
  frame explicitly.

### Killing a render kills every process it started

A render spans more than one process group, and the spikes of 2026-10-25 (design
§2) measured what each stop leaves behind:
- Chrome leads its own process group. Killing the CLI's group takes Chrome down
  only when Remotion is at least 4.0.458, which wraps Chrome in
  `setpriv --pdeathsig SIGKILL`, and `setpriv` is on the PATH. With `setpriv`
  hidden, all five Chrome processes survived.
- On SIGTERM the CLI kills Chrome, but then usually does not exit. In the render
  phase it hung until SIGKILL in 4 of 4 re-check runs, so the SIGKILL is
  load-bearing.
- If SIGTERM arrives before Chrome's handler is registered, only pdeathsig kills
  Chrome. Without `setpriv`, Chrome leaked in 3 of 3 runs.
- An inherited environment marker cannot find Chrome, because Chrome rewrites
  its own `/proc/<pid>/environ`.
- A walk of parent pids from the CLI, taken before the kill, finds every Chrome
  process. Killing the groups it finds was not separately tested.
- Node as PID 1 leaves orphaned processes as zombies.

The required property is that **no process from the render survives its deadline
or its abort.**

**How it stops a render.** On deadline, abort or shutdown, the spawner will:
1. Walk `/proc` from the CLI's pid to record every descendant and its process
   group.
2. Send SIGTERM to the CLI's group and to every recorded group.
3. Send SIGKILL to all of them 5 s later, the same grace that `exec.ts:117`
   uses.
4. Poll, to a deadline, until every recorded pid has exited.

It signals only ids it recorded from this render's own tree, and never an id of
1 or below. The service runs on Linux only. The `taskkill /T /F` branch of
`killTree` serves local-dev on Windows, and has no graceful phase.

**Which part carries the guarantee.** `setpriv`'s pdeathsig is what reliably
kills Chrome. The `/proc` walk is defence in depth. A test will hide `setpriv`
from the PATH and assert that the walk alone leaves no `chrome-headless-shell`
behind. That test is what establishes the walk's effect, because the spike did
not test it separately.

**The arbiter is a test.** The test will run a render that spawns a process
leading its own group. It will record every process of the render by an
independent means. After the kill, it will poll until none of them is alive, up
to a deadline. The grace is a policy, not a wait, and the test never sleeps it.

**Considered and not chosen.** An environment marker that the render's processes
inherit, scanned for after the fact. It cannot find Chrome (above).

### If cleanup cannot be verified, the service exits

When the service cannot verify that every recorded pid has exited, it logs that,
marks itself unhealthy, and exits non-zero (exit code 70). The container
restarts, and takes every leftover process with it. `docs/DEPLOY.md` will
require a restart policy.

### Startup checks

The service must refuse to start unless all of these hold:
- `setpriv` is on the PATH
- the installed renderer is at least 4.0.458 and has the setpriv wrapper
  (`dist/linux/wrap-with-setpriv.js`)
- the pinned browser runs, meaning `--version` succeeds, which proves its shared
  libraries are present
- the pack passes the JSON Schema gate (ADR-5)
- `AUDIT_LOG_PATH` can be opened for appending

The version check reads the *installed*
`node_modules/@remotion/renderer/package.json`. The declared range in
`package.json` is never used.

### The process tree

The image must run under `tini` as PID 1, so that orphans are reaped. The
container's memory limit is the outer backstop (below).

### Output and errors

- **Output.** The CLI writes the PNG to a path the service mints. The service
  returns it inside the MCP response as image content (owner ruling 2), up to a
  cap of 4 MiB by default, and then deletes the file (design §5.5). There is no
  storage and no download token. That path stays internal: no service
  response carries a filesystem path (ADR-5). A timed-out render's partial
  output is deleted, as `src/tools/render.ts:176-183` already does for
  local-dev's CLI.
- **A crash, a timeout or a busy service surfaces as a tool error,** not a
  protocol error. A crash inside the CLI or Chrome becomes `render_failed`.
  - **The deadline.** `render_still` will have 45 s
    (`RENDER_STILL_DEADLINE_MS`). At the deadline it returns `render_timeout` at
    once, and finishes the kill in the background while the slot stays held. The
    45 s leaves room within the SDK client's 60 s default for the hops and the
    error path (ADR-4).
  - **Other tenants.** A crash that stays inside the CLI's tree leaves other
    tenants' jobs running. An allocation over the container's memory limit may
    not stay inside it; see below.
- **Crash testing needs a purpose-built CLI.** No known input aborts a render,
  so a test of a crash, a hang or a leak will use a stub CLI built to do it.

### Render slots bound running renders

The gateway's per-key limits bound requests (ADR-6). A request can end while its
render's processes are still being killed, so the service bounds running renders
itself, at admission.

**Taking a slot.** A render takes one slot from a single global count. The
default is 2. If none is free, the render is refused at admission with
`render_busy`.
- The service holds no queue, and local-dev's `cliLimiter` is not used.
- So a request whose caller has gone cannot wait inside the service and start a
  render later.
- The slots are not per principal. Per-key limits are the owner's gateway's job
  (ADR-6), and the service keeps one count.

**Releasing a slot.** A render holds its slot from admission until every process
it started is gone, whether or not its request is still open.
- The CLI's exit alone does not release it, because the CLI can exit during the
  grace while its browser still runs.
- A spawn that throws, or that emits `error` before `spawn`, never started a
  process, so it releases its slot at once.
- Slots are released exactly once.

**The value.** 2 is the default, a call the design made without the owner
(design §8, call 4).

### The heap cap is not the native-memory guard

`--max-old-space-size` sets V8's old-generation heap limit. resvg allocates its
pixmap in native code, outside that heap. So the pixmap:
- is not counted toward the limit
- will not trigger a V8 out-of-memory error
- will not produce a catchable JavaScript error

The allocation either succeeds or the process aborts, which is the T-1 failure.

**The pixel cap remains the only guard on resvg's native memory,** and with the
forked worker gone it is a guard for local-dev only. That cap is the raster size
cap described in Context. It covers `viz_render_svg` and multi-frame
`remotion_render_still`. No service path reaches `raster.ts`, which ADR-5 keeps
out of `dist-service/`, so the service has no resvg memory to guard. Its native
memory belongs to the CLI and Chrome, and the container's memory limit backstops
it. The service has its own bound on a still's size: before it takes a slot, it
will check the still's `width × height` against the raster bound.

Process isolation changes the blast radius of a native abort, not its
probability. In local-dev, resvg still runs in the stdio server's own process,
so the pixel cap is the only control there. A reader who sees
`--max-old-space-size` anywhere and relaxes the cap has misread this ADR.

### The container's memory limit is the outer backstop

When that limit is hit, the kernel's OOM killer chooses its victim by
`oom_score`, not by which process allocated. That score is mostly the process's
memory footprint, shifted by its `oom_score_adj`. A render's processes are
usually the largest, so they are usually chosen, but nothing stops the service
from being chosen instead.

Nothing in the design raises the render children's `oom_score_adj`, or stops the
container runtime from killing the whole cgroup on OOM. So an allocation over
the limit can take the service down with it. The restart policy that `DEPLOY.md`
will require recovers the service, and the restart takes every leftover process
with it. The renders in flight are lost.

### The frame budget, the video analogue of the pixel cap

Video renders are asynchronous: `render_video_start` returns a job id, and
`render_job_status` polls it (fixed constraint 7). Both tools will be
registered from the first service build and will return a documented
`not_implemented`. The job store, idempotency and enforcing the frame budget on
video are later work, not cut (design §3).

**What stills get first.** Each template's manifest entry will carry
`maxFrames`. `render_still` will refuse a `frame` at or past it, and pass width,
height and frame to the CLI explicitly, so a composition's own computed size
never decides what renders.

**The video path has no bound in local-dev.**
- `frames` is an optional string (`src/tools/render.ts:96-100`), and its regex
  admits the open-ended `"100-"`.
- Omitting it renders the whole composition.
- A timed-out render's output is deleted (`:176-183`), so a render that the
  timeout kills yields nothing for its occupancy.

So the service schema for video must not reuse that argument. When video is
implemented, a frame budget refuses those renders up front:
- **When:** at admission, before a process is spawned or a render slot is taken.
- **What is counted:** the frame range resolved against `pack-manifest.json`,
  never guessed. The service schema has no open-ended range.
- **How the range is enforced:** the CLI is invoked with the admitted range
  explicitly, so a template's own computed duration never decides how many
  frames render.
- **The refusal:** a category `frame_budget`, stating the resolved count and the
  budget.
- **The value:** no number is set here; enforcing the frame budget on video is
  later work (design §3).

## Consequences

- **Build status.** Decided 2026-10-26. As of 2026-11-11,
  `docs/superpowers/plans/final_script.md` has built on this branch what this
  ADR names: the spawner `src/service/render-process.ts`, the render slots
  `src/service/slots.ts`, the startup checks `src/service/preflight.ts`, the
  exit 70 in `src/service/start.ts`, `Dockerfile.service` with `tini` and
  `setpriv`, `docs/DEPLOY.md`, the stub-CLI tests in
  `test/render-process.test.mjs`, and `scripts/walk-only-proof.mjs`.
  They join `killTree` and the raster cap with its test. The images were built
  and run locally on 2026-11-13, on Docker Desktop's Linux engine 29.1.3
  (Task 10 Step 4, [`CI.md`](../CI.md#the-image-job-the-images-proved-on-linux)),
  and the walk-only proof ran inside the derived image with `setpriv` hidden
  from the CLI's `PATH` and a kill that only sends `SIGKILL`. The control run,
  which killed only the CLI's group, left four Chrome processes alive, and
  cleanup reported unverified. The proof run's walk handed the kill Chrome's
  own group as well as the CLI's; cleanup reported verified, and no new
  process survived. In `image-e2e.mjs`, a timed-out render and a CLI killed
  mid-render each left no process behind. Still unproven as of 2026-11-13:
  - CI's `image` job has not yet run on GitHub.

  Context, and the future tense above, describe the tree as of 2026-10-26.

## Scope

**The service profile only.** Local-dev keeps ADR-3's accepted residual risk:
resvg stays in the stdio server's process, for both `viz_render_svg` and
multi-frame stills.

ADR-3's rejection of Docker (the option at `:28-30`, the rejection at `:36`)
concerns the desktop `.mcpb`, and it stands for local-dev. The service profile
ships as a container image (owner ruling 3, design §5.9).

**Reversal cost: low,** as ADR-3 said. The spawner is one module,
`src/service/render-process.ts`, and the image's `setpriv` and `tini` are
packages. The cap stays either way.

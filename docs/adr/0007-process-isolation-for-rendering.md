# ADR-7: Process isolation for rendering in the service profile

**Status:** Accepted

**Relation:** Completes [ADR-3](0003-isolation-boundary.md) for the service
profile. Does not supersede it.

## Context

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

**The second half did not ship.** `grep -rnE
"child_process|fork\(|Worker|worker_threads" src/` hits only
`src/services/exec.ts` and `src/services/process.ts`. resvg parses
(`raster.ts:84`) and renders (`:102`) on the server's main thread.

**No known input kills the server today.** The cap refuses the T-1 SVG, and
`test/protocol.test.mjs:111-118` asserts that the server survives it. ADR-3's
consequence still stands: "With T-1 closed there is no known path that kills the
main process." (`:54`)

**A correction to ADR-3's context table, for the record.** ADR-3 says the
Remotion path is "already a separate process (CLI spawn)" and "cannot crash the
main process" (`:13`). That is incomplete. A multi-frame `remotion_render_still`
tiles its frames inside the server process, through resvg:
- `render.ts:243` calls `tilePanels`.
- `tile.ts:100` calls `rasterizeSvg`.
- `raster.ts:84` and `:102` follow.

The cap bounds that path too. Its residual risk belongs to local-dev (see
Scope), but ADR-3 never recorded it.

**The constraints.** These are the owner's fixed constraints of 2026-10-17,
quoted because they are not committed anywhere else:

> 6. Process isolation (ADR-0003's unshipped half) is a PREREQUISITE for the service
>    profile: render per forked child, stdio ignored in the child, timeout + SIGKILL,
>    crash surfaces as a tool error. --max-old-space-size does NOT cap resvg's native
>    memory; the pixel cap remains the native-memory guard and the ADR must say so.
> 7. Video renders are asynchronous: render_video_start returns a job id. A frame
>    budget guardrail is required (the video analogue of the pixel cap).

**Why "completes" and not "supersedes".** Nothing in ADR-3 is reversed. Option
2 sits inside ADR-3's own Decision, conditioned on it being "still warranted",
and the service profile is the warrant. In a shared, long-lived service, a
crash, hang or runaway render costs every tenant's in-flight work, not one
desktop client's restart.

ADR-3 justified Option 2 by protecting the main process from unknown crashes,
and that reasoning applies here at a higher stake. This is defence against the
unknown, not a fix for a known path.

## Decision

Every service-profile render runs in a short-lived child, one job per child.
This takes ADR-3's Option 2 mechanism and applies it to a different scope. The
child wraps the service's whole render, which never reaches resvg, because
ADR-5 keeps `raster.ts` out of `dist-service/`. Its frames are rasterized by
headless Chrome. It is not Option 2 as written.

**Roles.** Both modules come from plan Task 10:
- `src/service/child.ts` (`renderIsolated`) is the parent side. It forks,
  enforces the deadline and kills.
- `src/service/render-worker.ts` is the child's entry point. It performs
  exactly one render and replies once over IPC.

**How the child starts:** `fork(worker, { stdio: ["ignore", "ignore",
"ignore", "ipc"], execArgv: ["--max-old-space-size=512"], detached:
process.platform !== "win32" })`.
- **All three standard streams are ignored, as fixed constraint 6 requires.**
  A caller-influenced render that writes megabytes into a pipe nobody drains
  cannot wedge the job.
- **Diagnostics come back over IPC.** They are a bounded string field in the
  single IPC reply, capped like `MAX_CHILD_OUTPUT_BYTES` (`constants.ts:26`).
- **This amends plan Task 10 Step 3,** which pipes stderr.

### Killing a render kills every process it started

A render spans more than one process group:
- The worker starts the Remotion CLI through `runCommand`, which spawns it
  `detached` on POSIX (`exec.ts:72`). So the CLI leads its own group.
- The browser the CLI launches may lead a group of its own. The CLI creates
  that group, not the worker, so the worker never sees it being spawned.
- A worker that is SIGKILLed, or that aborts natively, never runs its own
  cleanup timers.

So signalling the worker's group alone, or only the groups the worker creates,
can leave the CLI or its browser running.

The required property is that **no process from the render survives its
deadline or its worker's death.**

**How the parent finds the render's processes.** It must find them
independently of anything the worker reports. On the service's Linux host
there are two candidates, and neither has been tried in the service's
container:
- tag every render with a per-render marker that its processes inherit, and
  scan for the marker
- run each render in its own cgroup and kill the cgroup. This needs a writable,
  delegated cgroup v2 subtree, which an unprivileged Docker container does not
  get by default.

Plan Task 10 chooses between them. If it chooses cgroups, the delegation must
be added to plan Tasks 15 and 16, which do not provide it.

**How it kills them.**
- It signals SIGTERM first, then SIGKILL after the same 5 s grace that
  `exec.ts:117` uses, through `killTree` (`exec.ts:20-45`).
- It signals only ids it has verified belong to this render, and never an id of
  1 or below.
- On Windows, where tests may run but the service does not,
  `taskkill /T /F` has no graceful phase.

**The arbiter is a test, and this amends plan Task 10 Steps 1 and 3.** As
written, Step 1 "Counts the process group before and after" and Step 3 kills
"the process group". Both name one group. The amended test runs a render that
spawns a process leading its own group. It records every process of the render
by an independent means. After the kill, it polls until none of them is alive,
up to a deadline. The grace is a policy, not a wait, and the test never sleeps
it.

### Output and errors

- **Output.** The worker writes the PNG into the workspace and returns its path
  over IPC. That path stays internal: no service response carries a filesystem
  path (ADR-5). A timed-out render's partial output is deleted, as
  `src/tools/render.ts:175-182` already does for the CLI.
- **A crash or timeout surfaces as a tool error.** A crash is a non-zero exit,
  a death by signal, or an IPC channel that closes with no reply.
  - A crash rejects with a `ToolInputError` of category
    `render_child_crashed`, and a timeout with category `render_timeout`.
  - `safeHandler` returns `isError: true` and records a `tool_rejected` event
    carrying that category (`src/services/format.ts:88-97`).
  - It is not a protocol error. A crash that stays inside the child leaves
    other tenants' jobs running. An allocation over the container's memory
    limit may not stay inside the child; see below. No plan task tests that a
    concurrent job survives a crash.
- **Crash testing needs a purpose-built worker.** No known input aborts a
  render, so plan Task 10's crash test needs a worker built to crash. **This
  amends Task 10 Step 1,** which names the oversized-viewBox SVG as a
  native-abort input. The cap refuses that SVG, and the service never reaches
  resvg.

### Render slots bound running renders

The gateway's per-key limits bound requests (ADR-6). A render can outlive its
request: `render_video_start` returns a job id while the render keeps running,
and a dropped `render_still` connection does not stop its child. So the service
bounds running renders itself, at admission.

**Who holds slots.** Slots belong to principals. The backend's slots are shared
across all the team-id tenants it asserts.

**Taking a slot.** A render takes one slot of its principal's, and one slot of a
single global count.

**When no slot is free.** The render is refused at admission with a
`ToolInputError` of category `render_busy`.
- The service holds no queue of its own. The gateway's FIFO (ADR-6) is the only
  queue.
- So a request whose caller has gone cannot wait inside the service and start a
  render later.
- For `render_video_start`, an idempotent retry is answered first.
  - A request whose `(tenant, idempotency_key)` already names a job gets that
    `job_id` back and takes no slot, because a duplicate returns the existing
    `job_id` (plan Global Constraints).
  - A new key takes its slots before the job is created (plan Task 11).
  - A claim that reports `created: false` releases its slots at once.

  No Task 11 interface looks a job up by key yet.

**Releasing a slot.** A render holds its slots from admission until every
process it started is gone, whether or not its request is still open.
- The worker's exit alone does not release them, because the worker can die
  during the grace while its CLI and browser still run.
- A fork that throws, or that emits `error` before `spawn`, never started a
  process, so it releases its slots at once.
- Slots are released exactly once.

**The values.**
- **The initial values mirror the gateway's:** backend 2, and each dev key 1.
  That is 4 with two dev keys, and it is unmeasured.
- **The global count is set to the benchmark's `K_safe` once plan Task 18
  measures it.** The benchmark tests concurrency 1 and 2 plus one knee cell, so
  `K_safe` may be below 4.
- **No plan step applies `K_safe` to either value yet.**

No plan task builds render slots yet.

### The heap cap is not the native-memory guard

`--max-old-space-size` sets V8's old-generation heap limit. resvg allocates its
pixmap in native code, outside that heap. So the pixmap:
- is not counted toward the limit
- will not trigger a V8 out-of-memory error
- will not produce a catchable JavaScript error

The allocation either succeeds or the process aborts, which is the T-1 failure.

**The pixel cap remains the only guard on resvg's native memory, wherever
resvg runs.** That cap is the raster size cap described in Context. It covers:
- `viz_render_svg` and multi-frame `remotion_render_still`, in local-dev
- any service path that ever reaches `raster.ts`, which ADR-5 keeps out of
  `dist-service/`

The fork changes the blast radius of a native abort, not its probability. Both
controls are required, and neither substitutes for the other. A reader who sees
`--max-old-space-size=512` and relaxes the cap has misread this ADR.

### The container's memory limit is the outer backstop

When that limit is hit, the kernel's OOM killer chooses its victim by
`oom_score`, not by which process allocated. That score is mostly the process's
memory footprint, shifted by its `oom_score_adj`. A render's processes are
usually the largest, so they are usually chosen, but nothing stops the service
from being chosen instead.

Two settings close that gap:
- **The worker raises its own `oom_score_adj`.** That needs no privilege, and
  its CLI and browser inherit the value at spawn.
- **The container runtime must not kill the whole cgroup on OOM.**

Until both are set and tested, an allocation over the limit can take the
service down with it. No plan task does this yet.

### The frame budget, the video analogue of the pixel cap

Video renders are asynchronous: `render_video_start` returns a job id, and
`render_job_status` polls it (fixed constraint 7). Both tools are registered
from the first service build. They return a documented `not_implemented` until
the Design milestone (2026-12-08), and they are protected scope, not stretch.

**The video path has no bound today.**
- `frames` is an optional string (`src/tools/render.ts:95-99`), and its regex
  admits the open-ended `"100-"`.
- Omitting it renders the whole composition.
- A timed-out render's output is deleted (`:175-182`), so a render that the
  timeout kills yields nothing for its occupancy.

`MAX_RENDER_FRAMES` (`src/constants.ts`, plan Task 12) refuses those renders up
front:
- **When:** at admission, before a child is forked or a render slot is taken.
- **What is counted:** the frame range resolved against `pack-manifest.json`,
  never guessed. The service schema has no open-ended range.
- **How the range is enforced:** the CLI is invoked with the admitted range
  explicitly, so a template's own computed duration never decides how many
  frames render.
- **The refusal:** a `ToolInputError` of category `frame_budget`, stating the
  resolved count and the budget.
- **The formula:**

  ```
  MAX_RENDER_FRAMES = floor((TIMEOUT_RENDER_MS − TIMEOUT_BUNDLE_MS) / C)
                    = floor(1,500,000 / C)
  ```

  The two timeouts are at `src/constants.ts:22-23`. `C` is the p95
  milliseconds per frame at the slowest benchmarked cell, which is plan Task
  12's "slowest benchmarked rate".
- **The provisional value plan Task 12 is to set:** an unmeasured 750 frames, a
  factor-two margin on an assumed 1,000 ms per frame. Plan Task 18 replaces the
  constant, never the formula. Task 18 uses `B` for a rate in frames per second,
  so this ADR does not use `B`.

## Scope

**The service profile only.** Local-dev keeps ADR-3's accepted residual risk:
resvg stays in the stdio server's process, for both `viz_render_svg` and
multi-frame stills.

ADR-3's rejection of Docker (`:28-30`) concerns the desktop `.mcpb`, and it
stands for local-dev. The service runs in a container because it is a deployed
multi-tenant service, which is a different artifact.

**Reversal cost: low,** as ADR-3 said. The cap stays either way.

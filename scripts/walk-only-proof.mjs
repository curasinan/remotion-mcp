// The /proc walk alone (design 5.6): with setpriv hidden from Chrome, does runRenderProcess's walk still leave no
// process behind? Case 4 of scripts/image-e2e.mjs cannot show this through the service: on SIGTERM, Remotion's own
// BrowserRunner kills Chrome's group within milliseconds, setpriv or not, so a clean scan there proves nothing about
// the walk. This runs below the service, and its injected kill only ever sends SIGKILL, so no SIGTERM listener runs.
//
// Two runs of the `slow` template, each aborted once Chrome is up:
// - Control: the kill SIGKILLs only the CLI's own group. Cleanup must report unverified and Chrome must survive,
//   which shows the proof run can fail. The survivors are then killed and reaped.
// - Proof: the kill SIGKILLs every group runRenderProcess passes it. Cleanup must report verified, and no new pid may
//   survive.
//
// It runs inside the derived image, with tini as PID 1 so orphans are reaped, and the repo's scripts/ bind-mounted
// read-only (docs/CI.md):
//
//   docker run --rm --entrypoint /usr/bin/tini -e SERVICE_AUDIENCE=proof -e IDENTITY_HMAC_KEY -e AUDIT_HMAC_KEY \
//     -v "$PWD/scripts:/proof:ro" rv-pack:dev -- node /proof/walk-only-proof.mjs
//
// It imports the service's own modules from dist-service/ under the working directory, the image's /app. Exits 0 when
// both runs pass, 1 when either fails, and 2 when it cannot start.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** How long Chrome may take to appear once the CLI is spawned. */
const CHROME_WAIT_MS = 30_000;
/** How long the reap, and the proof's check that nothing survives, may take. */
const GONE_WAIT_MS = 20_000;
const POLL_MS = 100;
const CHROME = "chrome-headless-shell";

const say = (line) => console.log(`walk-only-proof: ${line}`);

if (process.platform !== "linux") {
  console.error("walk-only-proof: Linux only: it reads /proc and needs the derived image's browser and setpriv");
  process.exit(2);
}
const DIST = path.resolve("dist-service");
if (!fs.existsSync(path.join(DIST, "service", "render-process.js"))) {
  console.error(`walk-only-proof: ${DIST} holds no service build. Run it from the service image's /app, its `
    + "WORKDIR, or from the repo root after `npm run build:service`.");
  process.exit(2);
}
// pathToFileURL, not a bare path, as the tests import dist-service/.
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const { parseServiceConfig } = await load("service/config.js");
const { preflight } = await load("service/preflight.js");
const { runRenderProcess, childEnv } = await load("service/render-process.js");
const { buildStillArgv } = await load("services/render-core.js");
const {
  RENDER_CLI_TIMEOUT_MS, RENDER_KILL_GRACE_MS, RENDER_STILL_DEADLINE_MS, RENDER_VERIFY_DEADLINE_MS,
} = await load("service/constants.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every process in /proc: pid, parent, group, state and cmdline. One that exits mid-read is skipped. */
function processes() {
  const found = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      // `pid (comm) state ppid pgrp ...`: the command name may hold spaces and ")", so read after the last ")".
      const [state, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cmdline = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      found.push({ pid: Number(name), ppid: Number(ppid), pgid: Number(pgid), state, cmdline });
    } catch {
      // Gone since the listing.
    }
  }
  return found;
}

/** The processes not in `baseline`, never this one. A zombie still counts: until it is reaped its pid survives. */
const newSince = (baseline) => processes().filter((p) => !baseline.has(p.pid) && p.pid !== process.pid);
/** Each process as its pid, state and cmdline, cut to 200 characters: Chrome's run to kilobytes. */
const describe = (procs) => procs.map((p) => `${p.pid} [${p.state}] ${(p.cmdline || "(no cmdline)").slice(0, 200)}`)
  .join("; ");
/**
 * A live Chrome process: its argv[0] is the browser. Never a match anywhere in the cmdline, since the CLI's own carries
 * `--browser-executable=<path>/chrome-headless-shell`.
 */
const isLiveChrome = (p) => p.state !== "Z" && path.basename(p.cmdline.split(" ")[0]) === CHROME;

/** Polls `probe` until it returns a value other than undefined, or throws `message()` at the deadline. */
async function pollFor(probe, waitMs, message) {
  const until = performance.now() + waitMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (performance.now() >= until) throw new Error(message());
    await delay(POLL_MS);
  }
}

/** Sends SIGKILL to `id`'s group, or to `id` alone when it leads none, and never anything else. */
function sigkill(id) {
  try {
    process.kill(-id, "SIGKILL");
  } catch {
    try {
      process.kill(id, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// 1-2. The service's configuration and every startup check, exactly as the service runs them. Their messages name
// what failed, never a key.
let cfg;
let pack;
let cli;
try {
  cfg = parseServiceConfig(process.env);
  ({ pack, cli } = await preflight(cfg));
} catch (err) {
  console.error(`walk-only-proof: cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const slow = pack.template("slow");
if (slow === undefined) {
  console.error("walk-only-proof: the pack has no `slow` template");
  process.exit(2);
}

// 3. The argv the service would build for `slow`.
const PROPS_FILE = "props.json";
const argv = buildStillArgv({
  source: pack.bundleDir, compositionId: slow.compositionId, output: "out.png", frame: 0, propsFile: PROPS_FILE,
  width: slow.width, height: slow.height, browserExecutable: cfg.browserExecutable, timeoutMs: RENDER_CLI_TIMEOUT_MS,
});

/** Whether `/bin/sh -c 'command -v setpriv'` finds setpriv on `pathVar`, as Remotion resolves it in the CLI. */
function shellFindsSetpriv(pathVar) {
  try {
    execFileSync("/bin/sh", ["-c", "command -v setpriv"], {
      env: { PATH: pathVar }, stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * One aborted render of `slow`, with setpriv hidden from its environment and `makeKill(cliPid)` as its kill. Resolves
 * with the cleanup report, every id the kill was handed, and the processes still new once cleanup has settled.
 */
async function abortedRender(name, makeKill) {
  fs.mkdirSync(cfg.tempRoot, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(cfg.tempRoot, `proof-${name}-`));
  fs.writeFileSync(path.join(workDir, PROPS_FILE), "{}", { mode: 0o600, flag: "wx" });
  try {
    // 4. The service's allowlisted environment, with a PATH that holds node's directory but not setpriv's. Remotion
    // looks setpriv up on the CLI's PATH, so it now starts Chrome without the pdeathsig.
    const env = { ...childEnv(process.env, workDir), PATH: "/usr/local/bin" };
    if (shellFindsSetpriv(env.PATH)) throw new Error(`${name}: setpriv is still found on PATH=${env.PATH}`);

    const baseline = new Set(processes().map((p) => p.pid));
    const controller = new AbortController();
    const handed = [];
    let kill = () => {
      throw new Error(`${name}: the kill ran before the CLI was found`);
    };
    const settled = runRenderProcess(cli.file, [...cli.prefixArgs, ...argv], {
      cwd: workDir, env, deadlineMs: RENDER_STILL_DEADLINE_MS, graceMs: RENDER_KILL_GRACE_MS,
      verifyDeadlineMs: RENDER_VERIFY_DEADLINE_MS, signal: controller.signal,
      // Whatever signal runRenderProcess asks for, the kill sends SIGKILL, or nothing.
      kill: (id, signal) => {
        handed.push(`${id}:${signal}`);
        kill(id);
      },
    });
    let early;
    void settled.then((result) => { early = result; });

    // 5. Chrome is up, launched by the CLI, which is this process's only child.
    const { cliPid, chrome } = await pollFor(() => {
      if (early !== undefined) {
        throw new Error(`${name}: the render settled before Chrome appeared: exit ${early.exitCode}, signal `
          + `${early.signal}, timed out ${early.timedOut}; output: ${early.outputTail}`);
      }
      const fresh = newSince(baseline);
      const cliProc = fresh.find((p) => p.ppid === process.pid && p.state !== "Z");
      const chromes = fresh.filter(isLiveChrome);
      return cliProc !== undefined && chromes.length > 0 ? { cliPid: cliProc.pid, chrome: chromes } : undefined;
    }, CHROME_WAIT_MS, () => `${name}: no ${CHROME} process appeared within ${CHROME_WAIT_MS} ms; new processes: `
      + describe(newSince(baseline)));
    say(`${name}: CLI ${cliPid}, ${chrome.length} ${CHROME} process(es) up: ${chrome.map((p) => p.pid).join(", ")}`);
    kill = makeKill(cliPid);

    // 6. Abort through the signal, as a closed connection or a shutdown does.
    controller.abort();
    const result = await settled;
    if (!result.aborted) throw new Error(`${name}: the result did not settle as aborted`);
    const report = await result.cleanup;
    return { name, report, handed, cliPid, chrome, baseline, survivors: newSince(baseline) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The walk recorded Chrome's own group, apart from the CLI's: the kill was handed it in the first, SIGTERM round,
 * whatever the kill then did with it.
 */
function assertWalkRecordedChrome(run) {
  const groups = [...new Set(run.chrome.map((p) => p.pgid))].filter((g) => g !== run.cliPid);
  if (groups.length === 0) throw new Error(`${run.name}: Chrome runs in the CLI's own group, ${run.cliPid}`);
  if (!groups.some((g) => run.handed.includes(`${g}:SIGTERM`))) {
    throw new Error(`${run.name}: the kill was never handed Chrome's group (${groups.join(", ")}); it was handed `
      + run.handed.join(", "));
  }
}

async function controlRun() {
  const name = "control";
  // SIGKILLs the CLI's own group, whose id is the CLI's pid, and ignores every other id.
  const run = await abortedRender(name, (cliPid) => (id) => {
    if (id === cliPid) sigkill(id);
  });
  const chrome = run.survivors.filter(isLiveChrome);
  try {
    assertWalkRecordedChrome(run);
    if (run.report.verified !== false) {
      throw new Error(`${name}: cleanup reported verified, though only the CLI's group was killed`);
    }
    if (chrome.length === 0) {
      throw new Error(`${name}: no ${CHROME} survived the CLI's group, so this run cannot tell a walk from none; `
        + `left: ${describe(run.survivors)}`);
    }
    say(`${name}: cleanup unverified as expected (${run.report.cause}); ${CHROME} survived: ${describe(chrome)}`);
  } finally {
    // Then reap: every process the render left, so the proof run starts from a clean table. tini reaps them.
    for (const p of run.survivors) sigkill(p.pid);
    await pollFor(() => (newSince(run.baseline).length === 0 ? true : undefined), GONE_WAIT_MS,
      () => `${name}: the control's leftovers were not gone within ${GONE_WAIT_MS} ms: `
        + describe(newSince(run.baseline)));
  }
  say(`${name}: PASS (the leftovers were killed and reaped)`);
}

async function proofRun() {
  const name = "proof";
  // SIGKILLs every group, or pid, runRenderProcess hands it: what the walk recorded.
  const run = await abortedRender(name, () => sigkill);
  assertWalkRecordedChrome(run);
  if (run.report.verified !== true) {
    throw new Error(`${name}: cleanup reported unverified: ${run.report.cause}`);
  }
  await pollFor(() => (newSince(run.baseline).length === 0 ? true : undefined), GONE_WAIT_MS,
    () => `${name}: processes survived the walk's kill: ${describe(newSince(run.baseline))}`);
  say(`${name}: PASS (cleanup verified, no new pid survived; the kill was handed ${run.handed.join(", ")})`);
}

// setpriv is found on the service's own PATH, so not finding it on the render's PATH means something.
if (!shellFindsSetpriv(process.env.PATH ?? "")) {
  console.error("walk-only-proof: setpriv is not found on this process's PATH, so hiding it would prove nothing");
  process.exit(2);
}
let failed = false;
for (const run of [controlRun, proofRun]) {
  try {
    await run();
  } catch (err) {
    failed = true;
    console.error(`walk-only-proof: FAIL: ${err instanceof Error ? err.message : String(err)}`);
  }
}
say(failed ? "FAILED" : "both runs passed");
process.exit(failed ? 1 : 0);

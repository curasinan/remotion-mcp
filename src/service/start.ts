/**
 * Starts the service (design 5.2, 5.6): the configuration, the startup checks, a clean render temp root, the context
 * the tools share, and the HTTP server. Installs no process-wide error handler: tools.ts rethrows a throwing
 * onUnverifiedCleanup where nothing catches it, so that the process dies, and a handler that swallowed it would keep
 * a service with live render processes running.
 */

import fs from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { createAuditSink } from "./audit.js";
import { parseServiceConfig } from "./config.js";
import { RENDER_CLI_TIMEOUT_MS, RENDER_KILL_GRACE_MS, RENDER_VERIFY_DEADLINE_MS } from "./constants.js";
import { createServiceHandler } from "./http.js";
import { preflight } from "./preflight.js";
import type { ServiceContext } from "./registry.js";
import { runRenderProcess } from "./render-process.js";
import { RenderSlots } from "./slots.js";

export interface StartDeps { preflight?: typeof preflight; run?: typeof runRenderProcess;
  exit?: (code: number) => void; log?: (msg: string) => void }

/** The exit code when a render's processes cannot be verified gone. The restart policy then takes them down. */
const EXIT_CLEANUP_UNVERIFIED = 70;

const wallClockS = (): number => Math.floor(Date.now() / 1000);

/** Removes every entry inside `dir`, each on its own, reporting each failure's error code. */
function removeEntries(dir: string, onError: (code: string) => void): void {
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (err) {
      onError(String((err as NodeJS.ErrnoException | null)?.code ?? "no error code"));
    }
  }
}

/**
 * Empties RENDER_TEMP_ROOT and leaves it at mode 0700, so no earlier run's props survive a restart. Its contents are
 * removed rather than the directory itself, which may be a mount point. Any failure refuses the start.
 */
function resetTempRoot(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    removeEntries(dir, (code) => {
      throw new Error(code);
    });
    // mkdir's mode passes through the umask, and an existing directory keeps its own.
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? (err as Error | null)?.message;
    throw new Error(`start: RENDER_TEMP_ROOT could not be emptied and recreated (${String(code)})`, { cause: err });
  }
}

/**
 * Parses the configuration, runs the startup checks, empties the render temp root, and listens. `shutdown()` stops
 * accepting connections, aborts every in-flight render, waits for the slots to drain (bounded by the kill's grace
 * and verification deadline), then closes the server. It runs once; later calls return the same promise.
 */
export async function startService(env: NodeJS.ProcessEnv, deps: StartDeps = {}):
  Promise<{ server: Server; port: number; shutdown(): Promise<void> }> {
  const startedAtS = wallClockS();
  const log = deps.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  const exit = deps.exit ?? ((code: number): void => {
    process.exit(code);
  });
  /** Never throws, so a failing log cannot stop what follows it. */
  const note = (line: string): void => {
    try {
      log(line);
    } catch {
      // Diagnostics never decide what the service does.
    }
  };

  const cfg = parseServiceConfig(env);
  resetTempRoot(cfg.tempRoot);
  const { pack, cli } = await (deps.preflight ?? preflight)(cfg);

  const shutdownController = new AbortController();
  const slots = new RenderSlots(cfg.slots);
  const ctx: ServiceContext = {
    pack, slots, run: deps.run ?? runRenderProcess, cli, browserExecutable: cfg.browserExecutable,
    tempRoot: cfg.tempRoot, audit: createAuditSink(cfg.auditLogPath, cfg.auditKey),
    stillDeadlineMs: cfg.stillDeadlineMs, cliTimeoutMs: RENDER_CLI_TIMEOUT_MS, graceMs: RENDER_KILL_GRACE_MS,
    verifyDeadlineMs: RENDER_VERIFY_DEADLINE_MS, pngCapBytes: cfg.pngCapBytes, shutdown: shutdownController.signal,
    /**
     * A render's processes may still be alive. tools.ts has logged the cause and removed that render's work dir.
     * Synchronous: the other renders are stopped, every other caller's props come off disk, and the process exits
     * so its restart takes down whatever is left. If this throws anyway, tools.ts rethrows it and the process dies.
     */
    onUnverifiedCleanup: () => {
      note("service: a render's processes could not be verified gone: aborting the other renders, emptying "
        + `RENDER_TEMP_ROOT and exiting with code ${EXIT_CLEANUP_UNVERIFIED}`);
      try {
        shutdownController.abort();
      } catch {
        // Each render's abort handler stops its own processes; none of them decides whether the service exits.
      }
      try {
        removeEntries(cfg.tempRoot, (code) => note(`service: RENDER_TEMP_ROOT entry removal failed: ${code}`));
      } catch {
        // Best effort: the exit below must happen whatever is left on disk.
      }
      exit(EXIT_CLEANUP_UNVERIFIED);
    },
    log,
  };

  const server = http.createServer(createServiceHandler(ctx, cfg, { clock: { nowS: wallClockS, startedAtS } }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  note(`service: listening on ${cfg.host}:${port}`);

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      // 1. No new connections.
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // 2. Every in-flight render stops.
      shutdownController.abort();
      // 3. A render holds its slot until its processes are gone, which the kill bounds by its grace and verification.
      const boundMs = ctx.graceMs + ctx.verifyDeadlineMs;
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        slots.drained().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), boundMs);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) note(`service: shutdown: ${slots.inUse} render slot(s) still held after ${boundMs} ms; closing anyway`);
      // 4. Whatever connections are left, then the server.
      server.closeAllConnections();
      await closed;
    })();
    return stopping;
  };

  return { server, port, shutdown };
}

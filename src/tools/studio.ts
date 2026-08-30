/**
 * Remotion Studio process management.
 *
 * The Studio is a long-lived dev server, so it is spawned detached and tracked
 * in an in-memory registry. Only PIDs this server started can be stopped
 * through it, which keeps the stop tool from becoming a general process killer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stateDirectory } from "../config.js";
import { entryPointField, projectDirField, responseFormatField } from "../schemas/common.js";
import { isRemotionProject } from "../services/environment.js";
import { killTree, resolveRemotionCli, spawnDetached } from "../services/exec.js";
import { verifyStudioProcess, type ProcessIdentity } from "../services/process.js";
import { buildErrorResponse, buildResponse, safeHandler } from "../services/format.js";
import { displayPath, resolveExistingDirectory } from "../services/paths.js";
import { ToolInputError } from "../types.js";
import { requireEntryPoint } from "./project.js";

interface StudioProcess {
  pid: number;
  port: number;
  projectDir: string;
  logFile: string;
  startedAt: number;
}

/**
 * Where the registry lives between sessions.
 *
 * Studios are spawned detached so they survive this process, which means an
 * in-memory registry loses them at exactly the moment they most need stopping:
 * after a restart, remotion_stop_studio - the only tool that exists to clean
 * them up - refused every pid it had itself created, leaving a dev server
 * publishing the user's source on :3000 with no way to stop it through the
 * server that started it.
 *
 * It used to live in os.tmpdir(). That is per-user on Windows but shared on
 * POSIX, and this file is not a cache: it is the list remotion_stop_studio
 * consults to decide whether it may signal a process. A file any account on the
 * machine can create is a poor place to keep an authorization decision, and
 * saveRegistry swallows write failures, so whoever created it first would have
 * kept ownership silently. It now sits beside the audit log, in the per-user
 * state directory, which no tool argument can reach - every path a tool accepts
 * goes through resolveInWorkspace and is confined to the workspace.
 */
const REGISTRY_FILE = path.join(stateDirectory(), "studios.json");

/** Pre-1.2.0 location. Read once on upgrade, then removed. */
const LEGACY_REGISTRY_FILE = path.join(os.tmpdir(), "remotion-viz-studios.json");

function readRegistryFile(file: string): Map<number, StudioProcess> {
  try {
    const entries = JSON.parse(fs.readFileSync(file, "utf8")) as StudioProcess[];
    if (!Array.isArray(entries)) return new Map();
    return new Map(
      entries.filter((e) => typeof e?.pid === "number").map((entry) => [entry.pid, entry]),
    );
  } catch {
    // Absent or corrupt: an empty registry is the correct starting point.
    return new Map();
  }
}

/**
 * Carry entries written before the move, once.
 *
 * Without this an upgrade orphans every running Studio: the tool that exists to
 * stop them stops recognising them, which is the precise failure the persisted
 * registry was added to prevent. The old file is unlinked afterwards so the
 * shared-directory exposure does not outlive the upgrade. Remove one minor
 * release after 1.2.0.
 */
function mergeLegacyRegistry(registry: Map<number, StudioProcess>): boolean {
  // Only when running against the real, default state location. The legacy path is
  // os.tmpdir(), which REMOTION_MCP_STATE_DIR does not redirect - so without this
  // guard an isolated server would reach out of its sandbox, absorb the machine's
  // shared registry, and UNLINK it. That is not hypothetical: it deleted the real
  // file on this machine during the run that added this code.
  //
  // An explicit override means "this is not the user's state", and migrating into
  // it would be wrong even if it were not destructive.
  if (process.env.REMOTION_MCP_STATE_DIR) return false;
  if (!fs.existsSync(LEGACY_REGISTRY_FILE)) return false;
  let merged = false;
  for (const [pid, entry] of readRegistryFile(LEGACY_REGISTRY_FILE)) {
    if (!registry.has(pid)) {
      registry.set(pid, entry);
      merged = true;
    }
  }
  try {
    fs.unlinkSync(LEGACY_REGISTRY_FILE);
  } catch {
    // Another account owns it - which is the exposure this move closes. It is
    // simply never read again.
  }
  return merged;
}

function loadRegistry(): Map<number, StudioProcess> {
  const registry = readRegistryFile(REGISTRY_FILE);
  if (mergeLegacyRegistry(registry)) saveRegistry(registry);
  return registry;
}

function saveRegistry(registry: Map<number, StudioProcess>): void {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify([...registry.values()], null, 2), "utf8");
  } catch {
    // Losing persistence degrades stop_studio to its previous behaviour rather
    // than failing the start that just succeeded.
  }
}

/**
 * The Studio is a dev server: it holds a bundler and a browser of its own, so
 * signalling only its own pid leaves the port occupied.
 */
function killStudioTree(pid: number): boolean {
  try {
    killTree(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const StartStudioShape = {
  project_dir: projectDirField,
  entry_point: entryPointField,
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .default(3000)
    .describe("Port for the Studio dev server"),
  response_format: responseFormatField,
};
type StartStudioInput = z.infer<z.ZodObject<typeof StartStudioShape>>;

const StopStudioShape = {
  pid: z
    .number()
    .int()
    .positive()
    .describe("PID returned by remotion_start_studio"),
  response_format: responseFormatField,
};
type StopStudioInput = z.infer<z.ZodObject<typeof StopStudioShape>>;

export function registerStudioTools(server: McpServer): void {
  server.registerTool(
    "remotion_start_studio",
    {
      title: "Start Remotion Studio",
      description: `Start the Remotion Studio dev server in the background and return its URL, PID and log file path.

The Studio gives a live preview with hot reload and a timeline scrubber. Use it when a human wants to watch and adjust the animation interactively; use remotion_render_still when the goal is to check a frame programmatically.

The process is detached, so it keeps running after this tool returns and after the MCP session ends. Stop it with remotion_stop_studio.

Returns (JSON format):
  {
    "pid": number,          // Pass to remotion_stop_studio
    "url": string,          // e.g. "http://localhost:3000"
    "project_dir": string,
    "entry_point": string,
    "log_file": string      // Absolute path; read this if the Studio does not come up
  }

Examples:
  - Use when: "open the Remotion preview so I can scrub the timeline" -> project_dir="tactics-video"
  - Use when: A render looks wrong and you want to inspect it interactively
  - Don't use when: You only need a frame or a file (use the render tools)

Error Handling:
  - Returns an error if the directory is not a Remotion project
  - Startup failures do not surface here because the process is detached; read log_file to see them`,
      inputSchema: StartStudioShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safeHandler("remotion_start_studio", async (input: StartStudioInput) => {
      const dir = resolveExistingDirectory(input.project_dir);
      if (!isRemotionProject(dir)) {
        throw new ToolInputError(
          `'${displayPath(dir)}' has no remotion dependency in package.json.`,
          "Call remotion_init_project to create a project, or point project_dir at the real one.",
        );
      }

      const entry = requireEntryPoint(dir, input.entry_point);
      const cli = resolveRemotionCli(dir);
      // Beside the registry rather than in os.tmpdir(): it carries the Studio's
      // own output, including workspace paths, and there is no reason for it to
      // be world-readable on POSIX.
      fs.mkdirSync(stateDirectory(), { recursive: true });
      const logFile = path.join(stateDirectory(), `studio-${input.port}.log`);
      fs.writeFileSync(logFile, `# Remotion Studio started ${new Date().toISOString()}\n`);

      const pid = spawnDetached(
        cli.file,
        [...cli.prefixArgs, "studio", entry, `--port=${input.port}`],
        dir,
        logFile,
      );

      if (pid === undefined) {
        return buildErrorResponse(
          "The Studio process was spawned but reported no PID.",
          `Check ${logFile} for the startup output, or run \`npx remotion studio ${entry}\` manually in ${displayPath(dir)}.`,
        );
      }

      const registry = loadRegistry();
      // Drop entries whose process is gone so a recycled pid cannot inherit an
      // older record's identity.
      for (const [knownPid] of registry) {
        if (!isAlive(knownPid)) registry.delete(knownPid);
      }
      registry.set(pid, {
        pid,
        port: input.port,
        projectDir: dir,
        logFile,
        startedAt: Date.now(),
      });
      saveRegistry(registry);

      const structured = {
        pid,
        url: `http://localhost:${input.port}`,
        project_dir: displayPath(dir),
        entry_point: entry,
        log_file: logFile,
      };

      const markdown = [
        "# Remotion Studio starting",
        "",
        `- **URL:** ${structured.url}`,
        `- **PID:** ${pid}`,
        `- **Project:** \`${displayPath(dir)}\``,
        `- **Entry point:** \`${entry}\``,
        `- **Log:** \`${logFile}\``,
        "",
        "Give it a few seconds to bundle. If the URL does not respond, read the log file: startup errors land there, not here.",
      ].join("\n");

      return buildResponse(markdown, structured, input.response_format);
    }),
  );

  server.registerTool(
    "remotion_stop_studio",
    {
      title: "Stop Remotion Studio",
      description: `Stop a Remotion Studio process that was started by remotion_start_studio.

Only PIDs this server recorded when it started them can be stopped, and the record survives a restart, so a Studio left running by an earlier session can still be stopped. Any other PID is refused.

Being in that record is necessary but not sufficient. Before signalling, the process is checked against the operating system: if the Studio has exited and its PID has been reissued to something else, that is detected and nothing is signalled. Where the check cannot run, the response says so rather than staying quiet.

Returns (JSON format):
  {
    "pid": number,
    "stopped": boolean,
    "port": number,
    "uptime_ms": number
  }

Examples:
  - Use when: "close the Remotion preview" -> pid=48213
  - Use when: Freeing a port before starting the Studio on a different project
  - Don't use when: The Studio was started outside this server (stop it yourself)

Error Handling:
  - Returns an error listing the known PIDs when the requested one was not started here
  - Returns stopped=false if the process had already exited`,
      inputSchema: StopStudioShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler("remotion_stop_studio", async (input: StopStudioInput) => {
      const registry = loadRegistry();
      const record = registry.get(input.pid);
      if (!record) {
        const known = [...registry.keys()];
        return buildErrorResponse(
          `PID ${input.pid} was not started by this server.`,
          known.length > 0
            ? `Studio PIDs this server started: ${known.join(", ")}.`
            : "This server has no record of starting a Studio. Stop the process yourself if you started it another way.",
        );
      }

      // The registry outlives the process, so a pid in it may since have been
      // recycled by an unrelated program - and isAlive() is just as true for the
      // new occupant. Being in the registry is therefore necessary but not
      // sufficient; ask the OS what the process actually is before signalling.
      let stopped = false;
      let identity: ProcessIdentity = { verdict: "unknown", commandLine: null };

      if (isAlive(record.pid)) {
        identity = verifyStudioProcess(record.pid, record.port);
        if (identity.verdict === "mismatch") {
          registry.delete(input.pid);
          saveRegistry(registry);
          return buildErrorResponse(
            `PID ${record.pid} is no longer the Remotion Studio this server started. `
            + `It is now: ${(identity.commandLine ?? "").slice(0, 200)}`,
            "The Studio exited and the operating system reissued its PID to something else. "
            + "Nothing was signalled, and the stale entry has been dropped. "
            + "Port " + record.port + " is most likely already free.",
          );
        }
        stopped = killStudioTree(record.pid);
      }
      registry.delete(input.pid);
      saveRegistry(registry);

      const structured = {
        pid: record.pid,
        stopped,
        port: record.port,
        uptime_ms: Date.now() - record.startedAt,
        identity_verified: identity.verdict,
      };

      const markdown = stopped
        ? `Stopped Remotion Studio (PID ${record.pid}) on port ${record.port}.`
          + (identity.verdict === "unknown"
            ? "\n\nThe process identity could not be checked on this platform, so this relied on "
              + "the registry alone. If the Studio had already exited and its PID been reissued, "
              + "the signal went to whatever holds it now."
            : "")
        : `PID ${record.pid} had already exited. Port ${record.port} should be free.`;

      return buildResponse(markdown, structured, input.response_format);
    }),
  );
}

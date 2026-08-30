/**
 * Process identity.
 *
 * remotion_stop_studio tells the model it can only stop Studios this server
 * started, and that "any other PID is refused". A registry of PIDs cannot deliver
 * that on its own. A PID is not an identity: the Studio is spawned detached and
 * outlives the server, so by the time anyone asks to stop it the process may have
 * exited and the number been reissued to something unrelated. isAlive() returns
 * true for the new occupant just as readily.
 *
 * So before signalling, ask the operating system what the process actually is.
 *
 * Deliberately fail-open. When the lookup cannot run at all - no /proc in a
 * stripped container, no PowerShell on a minimal Windows image - the answer is
 * "unknown", and the caller proceeds while saying so. Failing closed would make a
 * Studio unstoppable through the tool in exactly the environments where a stray
 * dev server serving the user's source is hardest to notice.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

export type IdentityVerdict = "confirmed" | "mismatch" | "unknown";

export interface ProcessIdentity {
  verdict: IdentityVerdict;
  /** What the OS reported, trimmed. Null when the lookup could not run. */
  commandLine: string | null;
}

/** How long to wait for the platform's process lookup. */
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The command line of a running process, or null if it cannot be determined.
 *
 * Every branch uses shell:false. The pid is a number by the time it reaches here -
 * Zod's .int().positive() on the tool input - so it cannot carry a shell
 * metacharacter or a PowerShell expression even in principle.
 */
export function readCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    if (process.platform === "linux") {
      // NUL-separated argv. A plain file read: no spawn, no measurable cost.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const joined = raw.split("\0").filter(Boolean).join(" ").trim();
      return joined === "" ? null : joined;
    }

    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8", shell: false, timeout: LOOKUP_TIMEOUT_MS,
      });
      if (r.status !== 0) return null;
      const out = (r.stdout ?? "").trim();
      return out === "" ? null : out;
    }

    if (process.platform === "win32") {
      const r = spawnSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: "utf8", shell: false, windowsHide: true, timeout: LOOKUP_TIMEOUT_MS });
      if (r.status !== 0) return null;
      const out = (r.stdout ?? "").trim();
      return out === "" ? null : out;
    }
  } catch {
    // Any failure is "cannot determine", never "not ours".
    return null;
  }
  return null;
}

/**
 * Whether a PID is the Remotion Studio this server recorded on `port`.
 *
 * Matching on the command line rather than a recorded start time: it is cheap on
 * every platform and it is meaningful to a human reading the refusal.
 *
 * The port is what makes this tight. Two markers alone - "remotion" and "studio"
 * somewhere in the command line - is a loose test that any process mentioning
 * both would pass, including, as it turns out, a script whose own source contains
 * those words. spawnDetached always passes `--port=N`, and the registry records
 * that N, so requiring it ties the running process to the specific entry being
 * stopped rather than to the general shape of a Studio.
 *
 * A recycled PID would have to be a Remotion Studio, serving the same port, to be
 * mistaken for the one we started - at which point signalling it is arguably the
 * right thing anyway.
 */
export function verifyStudioProcess(pid: number, port: number): ProcessIdentity {
  const commandLine = readCommandLine(pid);
  if (commandLine === null) return { verdict: "unknown", commandLine: null };

  const mentionsRemotion = /remotion/i.test(commandLine);
  const runsStudio = /(^|[\s"'/\\])studio([\s"']|$)/i.test(commandLine);
  // `--port=3000` and `--port 3000` both occur depending on how the CLI is invoked.
  const servesPort = new RegExp(`--port[= ]${port}(?![0-9])`).test(commandLine);

  return {
    verdict: mentionsRemotion && runsStudio && servesPort ? "confirmed" : "mismatch",
    commandLine,
  };
}

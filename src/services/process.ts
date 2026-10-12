/** Verifies a PID's identity via its OS command line; fails open to "unknown" when lookup fails. */

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

/** The command line of a running process, or null if it cannot be determined. */
export function readCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    if (process.platform === "linux") {
      // NUL-separated argv.
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

/** Whether a PID's command line is a Remotion Studio serving the recorded `port`. */
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

// A stand-in for Chrome, started detached by fake-cli.mjs, so it leads a process group of its own. It starts
// one grandchild in that group, as Chrome starts its helpers, then writes
// {"cli":<ppid>,"browser":<pid>,"browserPgid":<pgid>,"grandchild":<pid>} to --write-file and waits.
import { spawn } from "node:child_process";
import fs from "node:fs";

// Backstop, never unref'd: a failed test never leaves this process behind for long.
setTimeout(() => process.exit(0), 60_000);

const prefix = "--write-file=";
const writeFile = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
if (!writeFile) throw new Error("fake-browser.mjs needs --write-file=<path>");

// Not detached, so it stays in this process's group. It carries the same backstop.
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 60_000)"], { stdio: "ignore" });

/** This process's group from /proc/self/stat, read after the last ")" (comm may hold one); null off Linux. */
function ownPgid() {
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[2]);
  } catch {
    return null;
  }
}

const pids = { cli: process.ppid, browser: process.pid, browserPgid: ownPgid(), grandchild: grandchild.pid };
// Written then renamed, so a reader never sees a partial file.
fs.writeFileSync(`${writeFile}.tmp`, JSON.stringify(pids));
fs.renameSync(`${writeFile}.tmp`, writeFile);

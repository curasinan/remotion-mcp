// A child that daemonises, for test/render-process.test.mjs. fake-cli.mjs --daemonize starts this file detached,
// with stdio inherited, as the intermediate. The intermediate starts the daemon, also detached with stdio
// inherited, and exits at once. So the daemon is reparented away from the CLI while it still holds the CLI's
// stdout and stderr.
//   --write-file=<path>  the daemon writes {"cli":<pid>,"intermediate":<pid>,"daemon":<pid>} there
//   --cli=<pid>          the CLI's pid, for the handshake
//   --daemon             run as the daemon
// The daemon writes a heartbeat to stdout and to stderr every 50 ms. It exits once a write to each has failed,
// which happens only after every reader of the CLI's pipes has let go of them.
import { spawn } from "node:child_process";
import fs from "node:fs";

// Backstop, never unref'd: a failed test never leaves this process behind for long.
setTimeout(() => process.exit(0), 60_000);

const option = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const writeFile = option("write-file");
if (!writeFile) throw new Error("fake-daemon.mjs needs --write-file=<path>");

if (!process.argv.includes("--daemon")) {
  spawn(process.execPath, [import.meta.filename, ...process.argv.slice(2), "--daemon", `--intermediate=${process.pid}`], {
    detached: true,
    stdio: "inherit",
  });
  process.exit(0);
}

const pids = { cli: Number(option("cli")), intermediate: Number(option("intermediate")), daemon: process.pid };
// Written then renamed, so a reader never sees a partial file.
fs.writeFileSync(`${writeFile}.tmp`, JSON.stringify(pids));
fs.renameSync(`${writeFile}.tmp`, writeFile);

const broken = new Set();
for (const [name, stream] of [["stdout", process.stdout], ["stderr", process.stderr]]) {
  stream.on("error", () => {
    broken.add(name);
    if (broken.size === 2) process.exit(0);
  });
}
setInterval(() => {
  if (!broken.has("stdout")) process.stdout.write(".");
  if (!broken.has("stderr")) process.stderr.write(".");
}, 50);

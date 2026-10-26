// A stand-in for the Remotion CLI, for test/render-process.test.mjs. Like Remotion's BrowserRunner, it starts
// fake-browser.mjs detached, so the browser leads a process group of its own. Then it waits.
//   --write-file=<path>    forwarded to fake-browser, which writes its pids there. With --no-browser this
//                          process writes {"cli":<pid>} there itself.
//   --exit-on-file=<path>  exit 0 once <path> exists, polled every 50 ms
//   --ignore-sigterm       a SIGTERM handler that does not exit, as the real CLI hangs after SIGTERM
//   --no-browser           spawn nothing
// After the handshake it prints "ready" to stdout, then creates <write-file>.ready, so a test knows the line
// is out. That line is what makes runRenderProcess take a snapshot of the tree.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Backstop, never unref'd: a failed test never leaves this process behind for long.
setTimeout(() => process.exit(0), 60_000);

const option = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("ignore-sigterm")) process.on("SIGTERM", () => {});

const writeFile = option("write-file");
const exitOnFile = option("exit-on-file");

if (exitOnFile !== undefined) {
  setInterval(() => {
    if (fs.existsSync(exitOnFile)) process.exit(0);
  }, 50);
}

function announceReady() {
  process.stdout.write("ready\n", () => {
    if (writeFile !== undefined) fs.writeFileSync(`${writeFile}.ready`, "");
  });
}

if (flag("no-browser")) {
  if (writeFile !== undefined) {
    // Written then renamed, so a reader never sees a partial file.
    fs.writeFileSync(`${writeFile}.tmp`, JSON.stringify({ cli: process.pid }));
    fs.renameSync(`${writeFile}.tmp`, writeFile);
  }
  announceReady();
} else {
  if (writeFile === undefined) throw new Error("fake-cli.mjs needs --write-file=<path> unless --no-browser is given");
  spawn(process.execPath, [path.join(import.meta.dirname, "fake-browser.mjs"), `--write-file=${writeFile}`], {
    detached: true,
    stdio: "ignore",
  });
  const handshake = setInterval(() => {
    if (!fs.existsSync(writeFile)) return;
    clearInterval(handshake);
    announceReady();
  }, 50);
}

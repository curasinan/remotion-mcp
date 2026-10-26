// A stand-in for the Remotion CLI, for test/render-process.test.mjs. Like Remotion's BrowserRunner, it starts
// fake-browser.mjs detached, so the browser leads a process group of its own. Then it waits.
//   --write-file=<path>    forwarded to fake-browser, which writes its pids there. With --no-browser this
//                          process writes {"cli":<pid>} there itself.
//   --exit-on-file=<path>  exit 0 once <path> exists, polled every 50 ms
//   --ignore-sigterm       a SIGTERM handler that does not exit, as the real CLI hangs after SIGTERM
//   --no-browser           spawn nothing
//   --silent               print nothing at all, not even "ready", so only the snapshot ticker sees the tree
//   --flood                with --no-browser: instead of "ready", write a block of more than 2 500 characters
//                          ending <<STDOUT-END>> to stdout, then create <write-file>.stdout. Once
//                          <write-file>.go exists, write one ending <<STDERR-END>> to stderr, then create
//                          <write-file>.ready. A test creates .go only after the stdout block has been read, so
//                          the stderr block is the last to arrive.
//   --daemonize            instead of a browser, start fake-daemon.mjs, whose detached child exits at once and
//                          leaves a detached grandchild holding this process's stdout and stderr. That grandchild
//                          writes the handshake.
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

/** Polls every 50 ms until `file` exists, then calls `then`. */
function whenExists(file, then) {
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    then();
  }, 50);
}

function flood() {
  process.stdout.write(`${"o".repeat(3_000)}<<STDOUT-END>>\n`, () => {
    fs.writeFileSync(`${writeFile}.stdout`, "");
    whenExists(`${writeFile}.go`, () => {
      process.stderr.write(`${"e".repeat(3_000)}<<STDERR-END>>\n`, () => fs.writeFileSync(`${writeFile}.ready`, ""));
    });
  });
}

function afterHandshake() {
  if (flag("silent")) return;
  if (flag("flood")) return flood();
  announceReady();
}

if (flag("no-browser")) {
  if (writeFile !== undefined) {
    // Written then renamed, so a reader never sees a partial file.
    fs.writeFileSync(`${writeFile}.tmp`, JSON.stringify({ cli: process.pid }));
    fs.renameSync(`${writeFile}.tmp`, writeFile);
  }
  afterHandshake();
} else {
  if (writeFile === undefined) throw new Error("fake-cli.mjs needs --write-file=<path> unless --no-browser is given");
  const [helper, extra] = flag("daemonize")
    ? ["fake-daemon.mjs", [`--cli=${process.pid}`]]
    : ["fake-browser.mjs", []];
  spawn(process.execPath, [path.join(import.meta.dirname, helper), `--write-file=${writeFile}`, ...extra], {
    detached: true,
    // The daemon's chain inherits this process's stdout and stderr; the browser holds none of them.
    stdio: flag("daemonize") ? "inherit" : "ignore",
  });
  whenExists(writeFile, afterHandshake);
}

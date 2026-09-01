/**
 * Extract a .mcpb and drive the server inside it over stdio.
 *
 * Everything else in CI tests the source tree. This tests the artifact: the
 * manifest's entry point, the vendored node_modules, and - the part nothing
 * else covers - whether the platform's own @resvg/resvg-js binary actually
 * LOADS from inside the bundle. test/bundle.test.mjs asserts those six binaries
 * are present in the zip; presence is not loadability. The two failures are
 * indistinguishable to that test and very distinguishable to a user, who gets
 * "Failed to load native binding" before any of this server's diagnostics run.
 *
 * Deliberately depends on nothing but Node's standard library and
 * test/zip-reader.mjs, so the verify job needs a checkout and a Node - no
 * `npm ci` on six runners to test an artifact that ships its own node_modules.
 *
 * Usage: node scripts/verify-bundle-runtime.mjs <bundle.mcpb|dir> <extract-dir>
 *
 * The first argument may be a directory holding exactly one .mcpb, so the CI
 * step can name the download-artifact folder and stay one plain `node` command
 * with no shell globbing - `ls *.mcpb | head -1` would pin the job to bash,
 * which is not the default shell on the Windows runners.
 *
 * Exit code 0 on success, 1 on any failure. Failure prints the server's stderr,
 * because that is where a native-binding error appears.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// Reuse the pure-Node zip reader written for test/bundle.test.mjs rather than
// shelling out to tar: GNU tar under Git Bash reads C:\... as a remote host
// spec, which is why that reader exists in the first place. Imported statically
// by relative specifier - a dynamic import() of a resolved Windows path fails
// with ERR_UNSUPPORTED_ESM_URL_SCHEME because "C:" is read as a URL scheme.
import { extractZip } from "../test/zip-reader.mjs";

const [, , bundleArg, extractDir] = process.argv;
if (!bundleArg || !extractDir) {
  console.error("usage: verify-bundle-runtime.mjs <bundle.mcpb|dir> <extract-dir>");
  process.exit(1);
}

const PLATFORM = `${process.platform}/${process.arch}`;
const TIMEOUT_MS = 120_000;

if (!fs.existsSync(bundleArg)) {
  console.error(`Nothing at ${bundleArg}. Run \`npm run bundle\` first, or point this at the downloaded artifact.`);
  process.exit(1);
}

let bundlePath = bundleArg;
if (fs.statSync(bundleArg).isDirectory()) {
  const found = fs.readdirSync(bundleArg).filter((f) => f.endsWith(".mcpb"));
  // Not "pick the first": two bundles in the download folder means the job is
  // about to verify an arbitrary one of them and report a platform verdict for
  // whichever it happened to sort first.
  if (found.length !== 1) {
    console.error(`Expected exactly one .mcpb in ${bundleArg}, found ${found.length}: ${found.join(", ") || "(none)"}`);
    process.exit(1);
  }
  bundlePath = path.join(bundleArg, found[0]);
}

// Empty the destination first. extractZip only overwrites the names it is
// carrying, so verifying bundle B into a directory still holding bundle A can
// pass on A's leftovers - a green verdict about an artifact that was never
// tested. That is the same mistake that made the original plan for this
// script's negative test incoherent, and it costs one rmSync to close.
//
// What may be deleted is decided by OWNERSHIP, never by what the directory
// looks like. This recursively deletes a path taken from argv, so the only
// directories it will touch are ones it created and marked itself.
//
// The earlier version of this guard inferred ownership from contents: any
// directory holding manifest.json and server/ was treated as a previous
// extraction. That is precisely the shape of this repo's own build/ staging
// tree - scripts/build-bundle.mjs stages manifest.json, server/, node_modules/,
// package.json, README.md and icon.png there before zipping - so
// `verify-bundle-runtime.mjs bundle.mcpb build` deleted an npm-ci'd staging
// tree and printed "Bundle runtime OK". A signature is not a claim of
// ownership; a sentinel this script wrote is.
const SENTINEL = ".verify-bundle-extraction";
// The first line is the claim of ownership, and it is checked. Keeping it
// separate from the rest of the prose means the explanatory text below can be
// reworded without stranding extraction directories a previous run left behind.
const SENTINEL_MAGIC = "Written by scripts/verify-bundle-runtime.mjs.";
const SENTINEL_BODY = [
  SENTINEL_MAGIC,
  "",
  "This directory holds a .mcpb unpacked for runtime verification. It is deleted",
  "and rewritten in full on every run, and nothing in it is source. Safe to",
  "remove. If this file is absent, the script will refuse to delete the directory",
  "rather than assume it owns it.",
  "",
].join("\n");

/**
 * Whether the sentinel in `dir` is one THIS script wrote.
 *
 * A name is not a claim. `readdirSync(dir).includes(SENTINEL)` was true for a
 * directory that merely contained something called .verify-bundle-extraction -
 * including a *directory* by that name, or a symlink, neither of which this
 * script can ever produce - and the next line then recursively force-deleted a
 * path taken from argv. Anyone who could create one empty directory inside a
 * tree could get the rest of that tree removed.
 *
 * So: it must be a regular file (lstat, so a symlink to a genuine sentinel
 * elsewhere does not qualify either), and its contents must be what this script
 * writes. Both checks fail closed - any error reading it means "not ours",
 * which costs a refusal and never costs data.
 */
function ownsExtractionDir(dir) {
  const marker = path.join(dir, SENTINEL);
  try {
    if (!fs.lstatSync(marker).isFile()) return false;
    return fs.readFileSync(marker, "utf8").startsWith(SENTINEL_MAGIC);
  } catch {
    return false;
  }
}

if (fs.existsSync(extractDir)) {
  const existing = fs.readdirSync(extractDir);
  if (existing.length > 0 && !ownsExtractionDir(extractDir)) {
    // Say which of the two it is: an impostor entry is a different problem from
    // no sentinel at all, and the reader needs to know one is sitting there.
    const impostor = existing.includes(SENTINEL)
      ? `\nThere IS an entry named ${SENTINEL} here, but it is not a regular file `
        + `written by this script, so it does not establish ownership.`
      : "";
    console.error(
      `Refusing to clear ${extractDir}: it is not empty and was not created by `
      + `this script (no ${SENTINEL} file written by it).${impostor}\n`
      + `This script deletes its extraction directory recursively, so it only ever `
      + `removes directories it made itself.\n`
      + `Pass a path that does not exist yet, or delete this one yourself if you are `
      + `certain it holds nothing you need.`,
    );
    process.exit(1);
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
}
fs.mkdirSync(extractDir, { recursive: true });
// Written before extraction, so an interrupted run still leaves the directory
// claimed and the next run can clear it instead of refusing.
fs.writeFileSync(path.join(extractDir, SENTINEL), SENTINEL_BODY);

const files = extractZip(bundlePath, extractDir);
console.log(`Extracted ${files} files from ${path.basename(bundlePath)} into ${extractDir}`);

const entry = path.join(extractDir, "server", "index.js");
if (!fs.existsSync(entry)) {
  console.error(`No server/index.js in the extracted bundle at ${extractDir}`);
  process.exit(1);
}

// The server exits with a ConfigError before serving if REMOTION_MCP_WORKSPACE
// does not name an existing directory. State and audit paths are pinned inside
// the same directory so a CI run leaves nothing in the runner's home.
const workspace = fs.mkdtempSync(path.join(path.resolve(extractDir), "ws-"));
const probeName = "probe.png";
const probePath = path.join(workspace, probeName);

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  env: {
    ...process.env,
    REMOTION_MCP_WORKSPACE: workspace,
    REMOTION_MCP_STATE_DIR: path.join(workspace, "state"),
    REMOTION_MCP_AUDIT_LOG: path.join(workspace, "audit.jsonl"),
  },
});

let stderr = "";
let pending = "";
const responses = new Map();
child.stderr.on("data", (d) => { stderr += d.toString(); });

// One line-buffered parser. A JSON-RPC frame can straddle two chunks, so the
// tail is carried forward rather than re-parsed from the top on every chunk.
child.stdout.on("data", (chunk) => {
  pending += chunk.toString();
  let i;
  while ((i = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, i).trim();
    pending = pending.slice(i + 1);
    if (!line.startsWith("{")) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    } catch { /* not a JSON-RPC frame; ignore */ }
  }
  if (responses.has(1) && responses.has(2) && responses.has(3)) finish();
});

// A bundle whose native addon will not load dies at import time - @resvg's
// js-binding.js throws "Failed to load native binding" before this server's
// code runs - so the process exits without ever answering initialize. Without
// this handler that case burns the full timeout and reports "timed out",
// hiding the one line that says what actually happened. On "close" rather than
// "exit" so the server's stderr has finished flushing before it is printed -
// with "exit" the native-binding stack trace is routinely still in the pipe.
child.on("close", (code, signal) => {
  if (finished) return;
  fail([
    `the server exited before answering (code ${code}, signal ${signal}) - `
    + `it never became usable. Answered ids: [${[...responses.keys()].join(", ") || "none"}]`,
  ]);
});
child.on("error", (error) => {
  if (finished) return;
  fail([`could not spawn the bundled server: ${error.message}`]);
});

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2024-11-05", capabilities: {},
  clientInfo: { name: "bundle-verify", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
// The one call that forces the native addon to load. A 2x2 square is enough:
// this is a linkage test, not a rendering test.
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
  name: "viz_render_svg",
  arguments: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#000"/></svg>',
    width: 2, return_image: false, output_path: probeName,
  } } });

const deadline = setTimeout(() => {
  // Which ids came back is the whole diagnosis, so report them the way the
  // close handler does: none means the server never got as far as answering,
  // [1] means tools/list hung, [1, 2] means the render did - and the render is
  // the only one of the three that can hang inside the native addon.
  fail([
    `timed out after ${TIMEOUT_MS} ms waiting for initialize, tools/list and viz_render_svg. `
    + `Answered ids: [${[...responses.keys()].join(", ") || "none"}]`,
  ]);
}, TIMEOUT_MS);

let finished = false;

function fail(problems) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  child.kill("SIGKILL");
  console.error(`Bundle runtime verification FAILED on ${PLATFORM}:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nserver stderr:\n${stderr || "(empty)"}`);
  process.exit(1);
}

function finish() {
  if (finished) return;

  const problems = [];
  const init = responses.get(1);
  if (!init?.result?.serverInfo?.name) problems.push("initialize returned no serverInfo");

  const tools = responses.get(2)?.result?.tools;
  // Hardcoded at 13 deliberately, matching the conformance step in ci.yml:
  // adding a tool forces someone to touch this line rather than the check
  // silently widening to whatever shipped.
  if (!Array.isArray(tools)) problems.push("tools/list returned no array");
  else if (tools.length !== 13) {
    problems.push(`expected 13 tools, got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  }

  const render = responses.get(3);
  if (render?.error) problems.push(`viz_render_svg errored: ${JSON.stringify(render.error).slice(0, 300)}`);
  else if (render?.result?.isError) {
    problems.push(`viz_render_svg refused: ${JSON.stringify(render.result.content).slice(0, 300)}`);
  } else {
    // A success message is not a rendered image. Check the bytes: resvg only
    // produced these if the native addon ran, so this is the assertion the
    // whole job exists for.
    if (!fs.existsSync(probePath)) {
      problems.push(`viz_render_svg reported success but wrote no PNG at ${probeName}`);
    } else {
      const head = fs.readFileSync(probePath).subarray(0, 8);
      if (!head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        problems.push(`the file resvg wrote is not a PNG (first bytes: ${head.toString("hex")})`);
      }
    }
  }

  if (problems.length > 0) {
    fail(problems);
    return;
  }

  finished = true;
  clearTimeout(deadline);
  child.kill();
  console.log(`Bundle runtime OK on ${PLATFORM}: ${tools.length} tools, resvg loaded and wrote a PNG.`);
  process.exit(0);
}

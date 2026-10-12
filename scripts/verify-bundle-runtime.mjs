// Extracts a .mcpb and drives its server over stdio to check the native resvg binary loads.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// Static relative import: a dynamic import() of a resolved Windows path fails on the "C:" scheme.
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
  // Require exactly one bundle rather than verifying an arbitrary one.
  if (found.length !== 1) {
    console.error(`Expected exactly one .mcpb in ${bundleArg}, found ${found.length}: ${found.join(", ") || "(none)"}`);
    process.exit(1);
  }
  bundlePath = path.join(bundleArg, found[0]);
}

// The extraction dir is cleared first, but only if it carries a sentinel this script wrote.
const SENTINEL = ".verify-bundle-extraction";
// Only this first line is checked for ownership, so the rest of the text can change.
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

// True only if the sentinel is a regular file (not a symlink) with this script's magic line.
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
    // Distinguish an impostor sentinel entry from a missing one.
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
// Written before extraction so an interrupted run still leaves the directory claimed.
fs.writeFileSync(path.join(extractDir, SENTINEL), SENTINEL_BODY);

const files = extractZip(bundlePath, extractDir);
console.log(`Extracted ${files} files from ${path.basename(bundlePath)} into ${extractDir}`);

const entry = path.join(extractDir, "server", "index.js");
if (!fs.existsSync(entry)) {
  console.error(`No server/index.js in the extracted bundle at ${extractDir}`);
  process.exit(1);
}

// The workspace must exist; state and audit paths stay inside it.
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

// Line-buffered parser; a JSON-RPC frame can straddle two chunks.
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

// Report an early exit (e.g. native binding failure); "close" waits for stderr to flush.
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
// Forces the native addon to load; a 2x2 square is enough.
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
  name: "viz_render_svg",
  arguments: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#000"/></svg>',
    width: 2, return_image: false, output_path: probeName,
  } } });

const deadline = setTimeout(() => {
  // The answered ids show which request hung.
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
  // Hardcoded to match the conformance step in ci.yml.
  if (!Array.isArray(tools)) problems.push("tools/list returned no array");
  else if (tools.length !== 13) {
    problems.push(`expected 13 tools, got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  }

  const render = responses.get(3);
  if (render?.error) problems.push(`viz_render_svg errored: ${JSON.stringify(render.error).slice(0, 300)}`);
  else if (render?.result?.isError) {
    problems.push(`viz_render_svg refused: ${JSON.stringify(render.result.content).slice(0, 300)}`);
  } else {
    // Check the PNG bytes, which exist only if the native addon ran.
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

/**
 * Protocol-level regression tests: drive the built server over real JSON-RPC
 * stdio, the way a client does. These prove the guards hold at the tool
 * boundary, not just in the functions underneath.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let child;
let workspace;
let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Cleared on response. An armed 30s timer that outlives the last request
    // makes node --test exit non-zero even with zero failures, and it hung the
    // suite for the full 30s on the POSIX CI legs.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout on ${method}`));
    }, 30_000);
    timer.unref?.();
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(name, args) {
  const r = await request("tools/call", { name, arguments: args });
  return r;
}

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "viz-proto-"));
  child = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, REMOTION_MCP_WORKSPACE: workspace },
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "proto", version: "1.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
});

after(async () => {
  if (!child) return;
  await new Promise((resolve) => {
    child.on("close", resolve);
    child.kill();
    setTimeout(resolve, 3000).unref?.();
  });
});

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#0af"/></svg>';

// Acceptance criterion 1: writing outside the workspace fails.
test("path traversal in output_path is refused", async () => {
  const r = await callTool("viz_render_svg", { svg: GOOD_SVG, output_path: "../../../escape.png" });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /outside the workspace/);
});

test("an absolute output_path outside the workspace is refused", async () => {
  // Absolute on whatever platform runs: "/" on POSIX, the drive root on Windows.
  // A Windows-style "C:/..." is not absolute on POSIX and would resolve inside
  // the workspace, which is why this is built from the real filesystem root.
  const absolute = path.join(path.parse(process.cwd()).root, "viz-escape-test.png");
  const r = await callTool("viz_render_svg", { svg: GOOD_SVG, output_path: absolute });
  assert.equal(r.result.isError, true);
});

// T-2: argv injection through output_path is refused at the tool boundary.
test("output_path that would become a CLI flag is refused", async () => {
  const r = await callTool("remotion_render_still", {
    project_dir: ".", composition_id: "Example",
    output_path: "--config=C:/Users/me/evil.js",
  });
  assert.equal(r.result?.isError === true || Boolean(r.error), true);
});

// T-2: composition_id with a leading hyphen is refused by the schema.
test("composition_id with a leading hyphen is rejected", async () => {
  const r = await callTool("remotion_render_still", {
    project_dir: ".", composition_id: "--config", output_path: "out/x.png",
  });
  assert.equal(r.result?.isError === true || Boolean(r.error), true);
});

// T-3: an SVG referencing a local file is refused before rasterizing.
test("viz_render_svg refuses an SVG that references a local file", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><image href="C:/Windows/System32/drivers/etc/hosts" width="20" height="20"/></svg>';
  const r = await callTool("viz_render_svg", { svg });
  assert.equal(r.result.isError, true);
});

// T-1: the oversized SVG is refused, and the SERVER SURVIVES to answer again.
test("oversized SVG is refused and the server stays up", async () => {
  const tall = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 5000000"><rect width="100" height="5000000"/></svg>';
  const r = await callTool("viz_render_svg", { svg: tall });
  assert.equal(r.result.isError, true);
  // If the process had aborted, this second call would hang and time out.
  const alive = await callTool("viz_validate_svg", { svg: GOOD_SVG, response_format: "json" });
  assert.equal(JSON.parse(alive.result.content[0].text).valid, true);
});

// A legitimate SVG round-trips.
test("a valid SVG rasterizes and writes inside the workspace", async () => {
  const r = await callTool("viz_render_svg", { svg: GOOD_SVG, width: 100, output_path: "out/ok.png", return_image: false });
  assert.equal(r.result.isError, undefined);
  assert.equal(fs.existsSync(path.join(workspace, "out/ok.png")), true);
});

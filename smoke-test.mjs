/**
 * Drives the built server over stdio with real JSON-RPC frames.
 * Run: node smoke-test.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "viz-mcp-"));

const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, REMOTION_MCP_WORKSPACE: workspace },
});

let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 60_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect x="0" y="0" width="200" height="100" fill="#0b0e14"/>
  <circle cx="60" cy="50" r="30" fill="#4f9cf9"/>
  <text x="110" y="56" fill="#e6edf3" font-family="sans-serif" font-size="18">ok</text>
</svg>`;

const BAD_SVG = `<svg viewBox="0 0 200 100">
  <rect x="0" y="0" width="200" height="100" fill="#fff">
  <text x="10" y="50">Caf&eacute; &nbsp; test</text>
  <script>alert(1)</script>
  <image href="https://example.com/logo.png" x="0" y="0" width="50" height="50"/>
</svg>`;

async function main() {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  check("initialize", init.result?.serverInfo?.name === "remotion-viz-mcp-server",
    init.result?.serverInfo?.name);
  notify("notifications/initialized", {});

  const list = await request("tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  check("tools/list returns 12 tools", tools.length === 12, `got ${tools.length}: ${names.join(", ")}`);
  check("every tool has a description", tools.every((t) => (t.description ?? "").length > 100));
  check("every tool has annotations", tools.every((t) => t.annotations && "readOnlyHint" in t.annotations));
  check("every tool has an inputSchema", tools.every((t) => t.inputSchema?.type === "object"));

  // viz_validate_svg on clean input
  const v1 = await request("tools/call", {
    name: "viz_validate_svg",
    arguments: { svg: GOOD_SVG, response_format: "json" },
  });
  const v1data = JSON.parse(v1.result.content[0].text);
  check("valid SVG passes validation", v1data.valid === true && v1data.error_count === 0,
    JSON.stringify(v1data.issues));

  // viz_validate_svg on broken input
  const v2 = await request("tools/call", {
    name: "viz_validate_svg",
    arguments: { svg: BAD_SVG, response_format: "json" },
  });
  const v2data = JSON.parse(v2.result.content[0].text);
  const codes = v2data.issues.map((i) => i.code);
  check("broken SVG is rejected", v2data.valid === false);
  for (const expected of ["html_entity_in_xml", "missing_xmlns", "script_element", "external_reference", "malformed_xml"]) {
    check(`  detects ${expected}`, codes.includes(expected), codes.join(","));
  }
  check("every issue carries a fix", v2data.issues.every((i) => i.fix?.length > 20));

  // viz_render_svg produces a real PNG
  const r1 = await request("tools/call", {
    name: "viz_render_svg",
    arguments: { svg: GOOD_SVG, width: 400, output_path: "out/test.png" },
  });
  const image = r1.result.content.find((c) => c.type === "image");
  check("viz_render_svg attaches a PNG", Boolean(image) && image.mimeType === "image/png");
  const pngHeader = image ? Buffer.from(image.data, "base64").subarray(0, 8) : Buffer.alloc(0);
  check("attached bytes are a real PNG",
    pngHeader.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  check("viz_render_svg dimensions honour width",
    r1.result.structuredContent?.width === 400 && r1.result.structuredContent?.height === 200,
    `${r1.result.structuredContent?.width}x${r1.result.structuredContent?.height}`);
  check("viz_render_svg wrote the file", fs.existsSync(path.join(workspace, "out/test.png")));

  // viz_render_svg refuses broken input rather than emitting a blank image
  const r2 = await request("tools/call", {
    name: "viz_render_svg",
    arguments: { svg: BAD_SVG },
  });
  check("viz_render_svg refuses broken SVG", r2.result.isError === true);
  check("refusal explains the fix", /Fix:/.test(r2.result.content[0].text));

  // Path traversal must be refused
  const trav = await request("tools/call", {
    name: "viz_render_svg",
    arguments: { svg: GOOD_SVG, output_path: "../../../tmp/escape.png" },
  });
  check("path traversal is blocked", trav.result.isError === true, trav.result.content[0].text.slice(0, 90));

  // Zod rejects an out-of-range value
  const bad = await request("tools/call", {
    name: "viz_render_svg",
    arguments: { svg: GOOD_SVG, width: 999999 },
  });
  check("out-of-range width is rejected", bad.result?.isError === true || Boolean(bad.error));

  // Environment check on a non-project directory
  const env = await request("tools/call", {
    name: "remotion_check_environment",
    arguments: { project_dir: ".", response_format: "json" },
  });
  const envdata = JSON.parse(env.result.content[0].text);
  check("environment check runs", Array.isArray(envdata.checks) && envdata.checks.length >= 4);
  check("environment check spots the missing project",
    envdata.is_remotion_project === false && envdata.blocking_problems.length > 0);
  check("blocking problems name a next step",
    envdata.blocking_problems.every((p) => p.length > 30 && /Call |Run |Create |Install /.test(p)),
    JSON.stringify(envdata.blocking_problems));

  // Scaffold a project and confirm it is detected afterwards
  const initProj = await request("tools/call", {
    name: "remotion_init_project",
    arguments: { project_dir: "tactics-video", install: false, response_format: "json" },
  });
  const projData = JSON.parse(initProj.result.content[0].text);
  check("init_project created files", projData.files_created.length === 7, projData.files_created.join(","));
  check("init_project wrote registerRoot",
    fs.readFileSync(path.join(workspace, "tactics-video/src/index.ts"), "utf8").includes("registerRoot"));

  const env2 = await request("tools/call", {
    name: "remotion_check_environment",
    arguments: { project_dir: "tactics-video", response_format: "json" },
  });
  const env2data = JSON.parse(env2.result.content[0].text);
  check("scaffolded project is detected as Remotion",
    env2data.is_remotion_project === true && env2data.remotion_entry_point === "src/index.ts");

  // Refuses to overwrite a non-empty directory
  const dup = await request("tools/call", {
    name: "remotion_init_project",
    arguments: { project_dir: "tactics-video" },
  });
  check("init_project refuses to overwrite", dup.result.isError === true);

  // Rendering against a project with no node_modules must fail with a useful message
  const noDeps = await request("tools/call", {
    name: "remotion_list_compositions",
    arguments: { project_dir: "tactics-video" },
  });
  check("list_compositions fails cleanly without node_modules", noDeps.result.isError === true);
  check("failure points at a next step", /Next step:/.test(noDeps.result.content[0].text),
    noDeps.result.content[0].text.slice(0, 140));
  check("npx-fallback failure blames the install, not the code",
    /npm install/.test(noDeps.result.content[0].text)
      && !/compile error/.test(noDeps.result.content[0].text),
    noDeps.result.content[0].text.split("Next step:")[1]?.slice(0, 100));

  // Bad props JSON
  const badProps = await request("tools/call", {
    name: "remotion_render_still",
    arguments: {
      project_dir: "tactics-video",
      composition_id: "Example",
      output_path: "out/frame.png",
      props_json: "{not json}",
    },
  });
  check("invalid props_json is caught before spawning", badProps.result.isError === true,
    badProps.result.content[0].text.slice(0, 90));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  child.kill();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});

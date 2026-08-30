/**
 * Drives the built server over stdio with real JSON-RPC frames.
 * Run: node smoke-test.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "viz-mcp-"));

// The audit log is redirected into the throwaway workspace. Without this the
// server falls back to defaultAuditLogPath() and every run of this file appends to
// the user's real audit trail — the one `npm run gateway` renders as a usage
// dashboard. See test/audit-isolation.test.mjs.
const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    REMOTION_MCP_WORKSPACE: workspace,
    REMOTION_MCP_AUDIT_LOG: path.join(workspace, "audit.jsonl"),
  },
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
  check("tools/list returns 13 tools", tools.length === 13, `got ${tools.length}: ${names.join(", ")}`);
  check("every tool has a description", tools.every((t) => (t.description ?? "").length > 100));

  // Context budget. Every tool definition is sent on every conversation, so this
  // payload is a standing cost paid before any work happens.
  //
  // History, because the number is a decision and not a fact: 34,547 before the
  // Args: blocks were removed, 30,257 after, 33,393 once viz_compare landed. The
  // ceiling was 30,500 - deliberately just above what twelve tools needed, so a
  // thirteenth had to be argued for rather than absorbed. It was, and the ceiling
  // was raised to 35,000 by decision.
  //
  // Note what that costs: 35,000 is ABOVE the 34,547 this started at, so this
  // assertion no longer catches a drift back to the pre-compression size. It bounds
  // growth; it no longer ratchets. Lowering it to ~33,500 would restore the ratchet
  // at the price of re-deciding on the next tool.
  const listBytes = JSON.stringify(tools).length;
  check("tools/list stays inside the context budget", listBytes <= 35_000,
    `${listBytes} chars (~${Math.round(listBytes / 3.7)} tokens), ceiling 35000`);

  // Args: restated inputSchema, which the client already sends to the model with
  // each field's .describe() text attached. Verified in this client: an MCP tool's
  // per-field descriptions arrive intact, so the prose copy was pure duplication.
  check("no description restates its own parameter list",
    tools.every((t) => !/^Args:/m.test(t.description ?? "")),
    tools.filter((t) => /^Args:/m.test(t.description ?? "")).map((t) => t.name).join(", "));

  // Compression must not eat the two properties that make a description useful:
  // what to do when it fails, and when to reach for something else instead.
  // A substantive Error Handling bullet, or an explicit statement that the tool
  // cannot fail — remotion_get_workspace_info reads a variable and returns it, and
  // padding that to 40 characters would be worse writing, not better documentation.
  const documentsFailure = (t) => {
    const d = t.description ?? "";
    return /Error Handling:\s*\n\s*-\s*.{40,}/.test(d) || /Error Handling:\s*\n\s*-\s*Cannot fail/.test(d);
  };
  check("every description still names its failure modes",
    tools.every(documentsFailure),
    tools.filter((t) => !documentsFailure(t)).map((t) => t.name).join(", "));
  check("every description still says when NOT to use it",
    tools.every((t) => /Don't use when:/.test(t.description ?? "")),
    tools.filter((t) => !/Don't use when:/.test(t.description ?? "")).map((t) => t.name).join(", "));
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

  // ---- viz_compare ----------------------------------------------------------
  // 100x100 white, and the same with one 10x10 black square: a known, countable
  // delta of exactly 100 pixels.
  const BASE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/></svg>`;
  const DELTA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/><rect x="10" y="10" width="10" height="10" fill="#000000"/></svg>`;
  for (const [svg, out] of [[BASE, "cmp/base.png"], [DELTA, "cmp/delta.png"], [BASE, "cmp/base2.png"]]) {
    await request("tools/call", {
      name: "viz_render_svg",
      arguments: { svg, width: 100, output_path: out, return_image: false },
    });
  }
  // A wider render, for the dimension-mismatch case.
  await request("tools/call", {
    name: "viz_render_svg",
    arguments: { svg: BASE, width: 200, output_path: "cmp/wide.png", return_image: false },
  });

  const same = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "cmp/base.png", after: "cmp/base2.png", response_format: "json" },
  });
  const sameData = JSON.parse(same.result.content[0].text);
  check("viz_compare reports identical for two identical renders",
    sameData.identical === true && sameData.changed_pixels === 0,
    JSON.stringify({ identical: sameData.identical, changed: sameData.changed_pixels }));

  const diff = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "cmp/base.png", after: "cmp/delta.png", response_format: "json" },
  });
  const diffData = JSON.parse(diff.result.content[0].text);
  // A 10x10 square is 100 pixels; resvg may anti-alias the edges by a few.
  check("viz_compare counts a known delta rather than just detecting it",
    diffData.changed_pixels >= 90 && diffData.changed_pixels <= 130,
    `changed_pixels=${diffData.changed_pixels}, expected ~100 for a 10x10 square`);
  check("viz_compare locates the change",
    diffData.changed_region.x >= 8 && diffData.changed_region.x <= 12
      && diffData.changed_region.width >= 8 && diffData.changed_region.width <= 14,
    JSON.stringify(diffData.changed_region));

  const diffImg = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "cmp/base.png", after: "cmp/delta.png" },
  });
  const cmpImage = diffImg.result.content.find((c) => c.type === "image");
  check("viz_compare attaches the diff image",
    Boolean(cmpImage) && Buffer.from(cmpImage.data, "base64")
      .subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

  const mismatch = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "cmp/base.png", after: "cmp/wide.png" },
  });
  check("viz_compare refuses mismatched dimensions with a next step",
    mismatch.result.isError === true
      && /Next step:/.test(mismatch.result.content[0].text)
      && /100x100/.test(mismatch.result.content[0].text)
      && /200x200/.test(mismatch.result.content[0].text),
    mismatch.result.content[0].text.slice(0, 120));

  const cmpTrav = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "../../../etc/hosts", after: "cmp/base.png" },
  });
  check("viz_compare confines its READ arguments to the workspace",
    cmpTrav.result.isError === true && /outside the workspace/.test(cmpTrav.result.content[0].text),
    cmpTrav.result.content[0].text.slice(0, 90));

  fs.writeFileSync(path.join(workspace, "cmp/notes.txt"), "not a png");
  const notPng = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "cmp/notes.txt", after: "cmp/base.png" },
  });
  check("viz_compare names a file that is not a PNG",
    notPng.result.isError === true && /not a PNG/i.test(notPng.result.content[0].text),
    notPng.result.content[0].text.slice(0, 90));

  // identical=true is the single most dangerous result to phrase badly: read as a
  // pass, it tells the model its edit worked when the likeliest cause is that the
  // edit never reached the rendered output.
  const sameMd = await request("tools/call", {
    name: "viz_compare",
    arguments: { before: "cmp/base.png", after: "cmp/base2.png" },
  });
  check("an identical result is phrased as a non-event, not a pass",
    /Nothing changed/.test(sameMd.result.content[0].text)
      && /does not say the edit was correct/.test(sameMd.result.content[0].text),
    sameMd.result.content[0].text.slice(0, 100));

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

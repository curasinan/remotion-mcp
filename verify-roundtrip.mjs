/**
 * Round-trip check — HISTORICAL, no longer expected to pass.
 *
 * This proved that the reconstructed source rebuilt byte-for-byte to the JS in
 * the originally installed 1.0.0 bundle. The hardening work has since changed
 * the source deliberately, so it no longer matches that old install and is not
 * meant to. The source tree is now the source of truth; the bundle is rebuilt
 * from it (see docs/BUNDLE.md), not the other way round.
 *
 * Kept for reference and for the case where you want to diff a freshly built
 * dist/ against a specific installed server via REMOTION_MCP_INSTALL_DIR. For
 * ordinary verification use `npm test`.
 *
 * Usage:  npx tsc ; node verify-roundtrip.mjs
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const DIST = path.join(import.meta.dirname, "dist");
const INSTALLED =
  process.env.REMOTION_MCP_INSTALL_DIR ??
  "C:/Users/asus/AppData/Roaming/Claude/Claude Extensions/remotion-viz/server";

/** tsc appends this; it says nothing about behaviour. */
const stripSourceMap = (s) => s.replace(/\/\/# sourceMappingURL=.*$/gm, "").trimEnd();

function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error("No dist/. Run `npx tsc` first.");
  process.exit(1);
}

const built = walk(DIST).sort();
const installedFiles = new Set(walk(INSTALLED));

let identical = 0;
const differing = [];
const missing = [];

for (const rel of built) {
  if (!installedFiles.has(rel)) {
    missing.push(rel);
    continue;
  }
  const a = stripSourceMap(readFileSync(path.join(INSTALLED, rel), "utf8"));
  const b = stripSourceMap(readFileSync(path.join(DIST, rel), "utf8"));
  if (a === b) {
    identical += 1;
  } else {
    // Report the first divergent line so the mismatch is actionable.
    const al = a.split("\n");
    const bl = b.split("\n");
    let i = 0;
    while (i < Math.max(al.length, bl.length) && al[i] === bl[i]) i += 1;
    differing.push({ rel, line: i + 1, installed: al[i], rebuilt: bl[i] });
  }
}

const orphaned = [...installedFiles].filter((f) => !built.includes(f)).sort();

console.log(`identical:  ${identical}/${built.length}`);
if (missing.length) console.log(`\nbuilt but NOT installed:\n  ${missing.join("\n  ")}`);
if (orphaned.length) console.log(`\ninstalled but NOT built (no source):\n  ${orphaned.join("\n  ")}`);
if (differing.length) {
  console.log(`\ndiffering: ${differing.length}`);
  for (const d of differing) {
    console.log(`\n  ${d.rel}  first diff at line ${d.line}`);
    console.log(`    installed: ${(d.installed ?? "<eof>").trim().slice(0, 150)}`);
    console.log(`    rebuilt:   ${(d.rebuilt ?? "<eof>").trim().slice(0, 150)}`);
  }
}

const clean = differing.length === 0 && missing.length === 0 && orphaned.length === 0;
console.log(clean ? "\nROUND-TRIP CLEAN" : "\nROUND-TRIP INCOMPLETE");
process.exit(clean ? 0 : 1);

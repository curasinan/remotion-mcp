// Node floor must match across package.json, the CI matrix, manifest.json and the diagnostic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

/** The major in a floor expression, accepting ">=22" or ">=22.0.0". */
function floorMajor(range, where) {
  const match = /^>=(\d+)(?:\.\d+){0,2}$/.exec(range);
  assert.ok(match, `${where} is '${range}', which is not a plain >=MAJOR floor`);
  return Number(match[1]);
}

function matrixNodeVersions() {
  const match = workflow.match(/node:\s*\[([^\]]+)\]/);
  assert.ok(match, "ci.yml has no `node: [...]` matrix line to read");
  return match[1].split(",").map((v) => Number(v.trim())).sort((a, b) => a - b);
}

test("engines.node names a floor, not a range or a wildcard", () => {
  assert.match(pkg.engines.node, /^>=\d+$/, `engines.node is '${pkg.engines.node}'`);
});

test("the lowest tested Node version is exactly the engines floor", () => {
  // Lower claims an untested runtime; higher tests a runtime the package does not claim.
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.equal(matrixNodeVersions()[0], floor);
});

test("the bundle manifest claims the same Node floor as package.json", () => {
  // manifest.json ships in the .mcpb and is the copy the host app enforces.
  const runtimes = manifest.compatibility?.runtimes;
  assert.ok(runtimes, "manifest.json has no compatibility.runtimes to check");
  assert.ok(runtimes.node, "manifest.json declares no compatibility.runtimes.node");

  assert.equal(
    floorMajor(runtimes.node, "manifest.json compatibility.runtimes.node"),
    floorMajor(pkg.engines.node, "package.json engines.node"),
    `manifest.json says node '${runtimes.node}' but package.json engines says '${pkg.engines.node}'. `
    + "The manifest is the copy the host application enforces; update both together.",
  );
});

test("the runtime diagnostic states the same Node floor as package.json", () => {
  // Read from source because MIN_NODE_MAJOR is not exported.
  const source = fs.readFileSync(path.join(root, "src", "services", "environment.ts"), "utf8");
  const match = /const MIN_NODE_MAJOR = (\d+);/.exec(source);
  assert.ok(match,
    "src/services/environment.ts has no `const MIN_NODE_MAJOR = <n>;` line to check. "
    + "If the constant moved or was renamed, update this test - do not let the diagnostic drift.");
  assert.equal(
    Number(match[1]),
    Number(pkg.engines.node.replace(">=", "")),
    `environment.ts MIN_NODE_MAJOR is ${match[1]} but package.json engines says '${pkg.engines.node}'. `
    + "The diagnostic would tell a user their runtime meets a minimum the package does not claim.",
  );
});

test("no EOL Node major is tested or claimed", () => {
  // Node 20 EOL 2026-04, Node 18 EOL 2025-04.
  const EOL = [18, 20];
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.ok(!EOL.includes(floor), `engines floor ${floor} is EOL`);
  for (const version of matrixNodeVersions()) {
    assert.ok(!EOL.includes(version), `matrix tests EOL node ${version}`);
  }
});

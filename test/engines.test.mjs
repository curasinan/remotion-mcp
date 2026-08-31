/**
 * The engines claim and the CI matrix are two statements of the same fact, in
 * two files, with nothing connecting them. They drifted once already: engines
 * said >=18 while CI tested 20 and 22, so the package claimed support for a
 * runtime no test had ever exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

function matrixNodeVersions() {
  const match = workflow.match(/node:\s*\[([^\]]+)\]/);
  assert.ok(match, "ci.yml has no `node: [...]` matrix line to read");
  return match[1].split(",").map((v) => Number(v.trim())).sort((a, b) => a - b);
}

test("engines.node names a floor, not a range or a wildcard", () => {
  assert.match(pkg.engines.node, /^>=\d+$/, `engines.node is '${pkg.engines.node}'`);
});

test("the lowest tested Node version is exactly the engines floor", () => {
  // Lower would mean claiming support for something never tested. Higher would
  // mean burning CI on a version the package does not claim.
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.equal(matrixNodeVersions()[0], floor);
});

test("no EOL Node major is tested or claimed", () => {
  // Node 20 EOL 2026-04, Node 18 EOL 2025-04. Verified against
  // https://nodejs.org/dist/index.json on 2026-08-31.
  const EOL = [18, 20];
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.ok(!EOL.includes(floor), `engines floor ${floor} is EOL`);
  for (const version of matrixNodeVersions()) {
    assert.ok(!EOL.includes(version), `matrix tests EOL node ${version}`);
  }
});

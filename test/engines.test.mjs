/**
 * The engines claim, the CI matrix and the bundle manifest are three statements
 * of the same fact, in three files, with nothing connecting them. They drifted
 * once already: engines said >=18 while CI tested 20 and 22, so the package
 * claimed support for a runtime no test had ever exercised.
 *
 * Then they drifted again, and this test did not catch it, because it read only
 * package.json and ci.yml. manifest.json went on saying >=18.0.0 after the floor
 * moved to 22 - and manifest.json is the one a user's machine actually reads.
 * It ships INSIDE the .mcpb, and the host application consults
 * compatibility.runtimes.node to decide whether to run the server at all. A
 * source-tree claim that is wrong misleads a reader; that one hands the server
 * to a runtime it does not support.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

/** The major in a floor expression, whichever of the two spellings it uses:
 *  package.json writes ">=22", manifest.json writes ">=22.0.0". */
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
  // Lower would mean claiming support for something never tested. Higher would
  // mean burning CI on a version the package does not claim.
  const floor = Number(pkg.engines.node.replace(">=", ""));
  assert.equal(matrixNodeVersions()[0], floor);
});

test("the bundle manifest claims the same Node floor as package.json", () => {
  // manifest.json is what ships inside the .mcpb and what the host application
  // reads to decide whether this server can run. package.json's engines field
  // never reaches the user's machine, so if these two disagree the one that
  // takes effect is the one nothing else in this repo checks.
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

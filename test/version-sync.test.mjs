/**
 * Three files must state the same version. test/unit.test.mjs guards two of
 * them at test time and scripts/build-bundle.mjs refuses to build on drift, so
 * a release tool that updates only package.json produces a tag that cannot be
 * built.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "sync-version.mjs");

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsync-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.2.0" }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "x", version: "1.2.0" }, null, 2) + "\n");
  // The same nesting the real lockfile has: the version lives at the top AND
  // in packages[""] - npm writes both, and updating only one leaves the file
  // internally inconsistent.
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
    name: "x", version: "1.2.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "x", version: "1.2.0" } },
  }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(dir, "src", "constants.ts"),
    'export const SERVER_NAME = "x";\nexport const SERVER_VERSION = "1.2.0";\n',
  );
  return dir;
}

test("all four files move together", () => {
  const dir = makeFixture();
  execFileSync(process.execPath, [script, "2.0.0"], { cwd: dir, shell: false });

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "2.0.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version, "2.0.0");
  assert.match(fs.readFileSync(path.join(dir, "src", "constants.ts"), "utf8"), /SERVER_VERSION = "2\.0\.0"/);

  // Both statements inside the lockfile, not just the top-level one. After
  // v1.2.1 shipped, the lockfile stayed at 1.2.0 because semantic-release's
  // git assets and this script both ignored it - every checkout of a released
  // tag then carries a lockfile one release behind the package it locks.
  const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "2.0.0");
  assert.equal(lock.packages[""].version, "2.0.0");
});

test("a lockfile with a packages map but no root entry is refused, not half-synced", () => {
  // npm 7+ (lockfileVersion 2/3) always writes packages[""]. If it is absent
  // from a file that HAS a packages map, something mangled the lockfile, and
  // updating only the top-level version would write a success message over a
  // silent partial sync - the exact behaviour this script refuses everywhere
  // else. (A v1 lockfile has no packages map at all; top-level-only is
  // complete there, so that shape stays accepted.)
  const dir = makeFixture();
  const lockPath = path.join(dir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  delete lock.packages[""];
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "2.0.0"], {
        cwd: dir,
        shell: false,
        stdio: "pipe",
        encoding: "utf8",
      }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /packages\[""\]/);
      return true;
    },
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "1.2.0");
});

test("a missing lockfile is refused, not skipped", () => {
  const dir = makeFixture();
  fs.rmSync(path.join(dir, "package-lock.json"));
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "2.0.0"], {
        cwd: dir,
        shell: false,
        stdio: "pipe",
        encoding: "utf8",
      }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /package-lock\.json/);
      return true;
    },
  );
  // Nothing partially written.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "1.2.0");
});

test("a malformed version is refused before anything is written", () => {
  const dir = makeFixture();
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "v2.0"], {
        cwd: dir,
        shell: false,
        stdio: "pipe",
        encoding: "utf8",
      }),
    (err) => {
      // Assert on the specific failure, not just that something threw: a
      // crash for an unrelated reason (broken import, stray process.exit)
      // would also satisfy a bare assert.throws and this test would keep
      // passing while proving nothing about refusal behaviour.
      assert.equal(err.status, 1);
      assert.match(err.stderr, /Expected a bare semver/);
      return true;
    },
  );
  // Nothing partially written.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "1.2.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")).version, "1.2.0");
});

test("a constants.ts that does not match the expected shape is refused, not silently skipped", () => {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, "src", "constants.ts"), "export const SOMETHING_ELSE = 1;\n");
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "2.0.0"], {
        cwd: dir,
        shell: false,
        stdio: "pipe",
        encoding: "utf8",
      }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /has no 'export const SERVER_VERSION/);
      assert.match(err.stderr, /Refusing rather than skipping it/);
      return true;
    },
  );
});

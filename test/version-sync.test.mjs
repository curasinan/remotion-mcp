// sync-version.mjs must update every version statement together and refuse partial syncs.
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
  // Like a real lockfile, the version appears at the top level and in packages[""].
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

  // Both version fields inside the lockfile must move.
  const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "2.0.0");
  assert.equal(lock.packages[""].version, "2.0.0");
});

test("a lockfile with a packages map but no root entry is refused, not half-synced", () => {
  // A packages map without packages[""] is mangled; v1 lockfiles with no map stay accepted.
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
      // Check the specific failure so an unrelated crash cannot satisfy the test.
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

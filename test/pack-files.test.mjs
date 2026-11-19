// The file rules scripts/build-pack.mjs applies (scripts/lib/pack-files.mjs, docs/CONTRACT-pack.md): packHash,
// where package.json puts Remotion, and which output dir build-pack may replace.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dependencyProblems, hashBundle, prepareOutDir } from "../scripts/lib/pack-files.mjs";

test("hashBundle covers every file's relative path and contents, in code-unit order", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "public"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dir, "public", "a.txt"), "a");
  const first = hashBundle(dir);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashBundle(dir), first);

  fs.writeFileSync(path.join(dir, "public", "a.txt"), "b");
  const edited = hashBundle(dir);
  assert.notEqual(edited, first);

  fs.renameSync(path.join(dir, "public", "a.txt"), path.join(dir, "public", "c.txt"));
  assert.notEqual(hashBundle(dir), edited);

  // Moving a byte from one file's end to the next file's start must change the hash: the framing is unambiguous.
  fs.writeFileSync(path.join(dir, "public", "c.txt"), "bx");
  const split = hashBundle(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>b");
  fs.writeFileSync(path.join(dir, "public", "c.txt"), "x");
  assert.notEqual(hashBundle(dir), split);
});

test("hashBundle hashes path, NUL, byte length, NUL and bytes per file, sorted by code unit, not by locale", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Code-unit order puts "B.txt" (0x42) before "a.txt" (0x61); a locale sort, and NTFS's listing, put it after.
  const files = [["B.txt", "upper"], ["a.txt", "ş"], ["sub/z.txt", ""]];
  fs.mkdirSync(path.join(dir, "sub"));
  for (const [rel, content] of files) fs.writeFileSync(path.join(dir, rel), content);
  const expected = crypto.createHash("sha256");
  for (const [rel, content] of files) {
    expected.update(`${rel}\0${Buffer.byteLength(content)}\0`);
    expected.update(content);
  }
  assert.equal(hashBundle(dir), `sha256:${expected.digest("hex")}`);
});

test("dependencyProblems wants remotion and every @remotion/* package under dependencies", () => {
  const remotion = { remotion: "4.0.532", "@remotion/cli": "4.0.532", "@remotion/renderer": "4.0.532" };
  assert.deepEqual(dependencyProblems({ dependencies: remotion, devDependencies: { typescript: "5.7.2" } }), []);
  assert.deepEqual(dependencyProblems({
    dependencies: { remotion: "4.0.532" },
    devDependencies: { "@remotion/cli": "4.0.532", "@remotion/fonts": "4.0.532", typescript: "5.7.2" },
  }), [
    "package.json: @remotion/cli must be under dependencies (the derived image runs npm ci --omit=dev)",
    "package.json: @remotion/renderer must be under dependencies (the derived image runs npm ci --omit=dev)",
    "package.json: @remotion/fonts must be under dependencies (the derived image runs npm ci --omit=dev)",
  ]);
});

test("prepareOutDir empties a previous pack, and refuses a dir holding anything else or holding the project", (t) => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const project = path.join(top, "project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "Root.tsx"), "source");

  const previous = path.join(project, "dist-pack");
  fs.mkdirSync(path.join(previous, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(previous, "pack-manifest.json"), "{}");
  fs.writeFileSync(path.join(previous, "bundle", "index.html"), "old");
  prepareOutDir(previous, project);
  assert.deepEqual(fs.readdirSync(previous), []);

  // A mistyped --out: the sources must survive, untouched.
  assert.throws(() => prepareOutDir(path.join(project, "src"), project), /holds Root\.tsx, which build-pack did not write/);
  assert.equal(fs.readFileSync(path.join(project, "src", "Root.tsx"), "utf8"), "source");
  assert.throws(() => prepareOutDir(project, project), /must not be the project dir or contain it/);
  assert.throws(() => prepareOutDir(top, project), /must not be the project dir or contain it/);
  assert.equal(fs.readFileSync(path.join(project, "src", "Root.tsx"), "utf8"), "source");

  const fresh = path.join(top, "fresh", "out");
  prepareOutDir(fresh, project);
  assert.ok(fs.statSync(fresh).isDirectory());
});

test("hashBundle refuses a link in the bundle rather than hash or follow it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "real"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  // A junction needs no privilege on Windows, and is an ordinary symlink elsewhere.
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linked"), "junction");
  assert.throws(() => hashBundle(dir), /bundle\/linked: neither a file nor a directory/);
});

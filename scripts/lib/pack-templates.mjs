/**
 * Steps 2 to 4 of scripts/build-pack.mjs (design 5.4, docs/CONTRACT-pack.md): loading the discovery bundle in Node,
 * and turning the compositions RemotionRoot() returns into the manifest's templates. They live here, not in the CLI,
 * so tests can run them on hand-built elements without a Remotion project.
 *
 * zod-gate.mjs reads its limits from dist-service, so build-pack imports this module only once it has checked that
 * the service build exists.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { fail } from "./pack-files.mjs";
import { boundsSurvived, compositionProblems, discoverCompositions, gateSchema } from "./zod-gate.mjs";

/**
 * Loads the discovery bundle, CommonJS `code` that esbuild built from build-pack's generated entry: RemotionRoot,
 * Still and the project's zod. It is written to a temp file, never inside the project, and removed after loading.
 * A module that fails at load, typically one that touches `document`, `FontFace` or `loadFont` at module scope, is
 * reported in one line: its stack would point into the temp file, which is gone by the time anyone reads it.
 */
export function requireDiscoveryBundle(code) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-pack-"));
  try {
    const file = path.join(tmp, "discovery.cjs");
    fs.writeFileSync(file, code);
    let loaded;
    try {
      loaded = createRequire(import.meta.url)(file);
    } catch (err) {
      const message = typeof err?.message === "string" ? err.message : String(err);
      fail(`loading src/Root in Node failed: ${message}; module scope must not use browser APIs (docs/CONTRACT-pack.md)`);
    }
    if (typeof loaded?.RemotionRoot !== "function") fail("src/Root must export the RemotionRoot component");
    return loaded;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Steps 3 and 4: the manifest's templates, or a PackBuildError naming every problem of every composition. `loaded`
 * is what requireDiscoveryBundle returned, and `checkSchemaVocabulary` the service's own JSON Schema gate.
 */
export function templatesOf(loaded, checkSchemaVocabulary) {
  let root;
  try {
    root = loaded.RemotionRoot({});
  } catch (err) {
    fail(`calling RemotionRoot() failed (it must return its compositions without hooks): ${err.message}`);
  }
  const compositions = discoverCompositions(root, { Still: loaded.Still });
  const found = compositionProblems(compositions);
  if (found.length > 0) fail(...found);

  const toJSONSchema = loaded.projectZod?.toJSONSchema;
  const problems = [];
  const templates = [];
  for (const c of compositions) {
    const gate = gateSchema(c.schema);
    if (gate.length > 0) {
      problems.push(...gate.map((problem) => `${c.id}: ${problem}`));
      continue;
    }
    if (typeof toJSONSchema !== "function") {
      problems.push(`${c.id}: the project's zod has no toJSONSchema; zod 4 is required`);
      continue;
    }
    let propsSchema;
    try {
      propsSchema = toJSONSchema(c.schema);
    } catch (err) {
      problems.push(`${c.id}: z.toJSONSchema failed: ${err.message}`);
      continue;
    }
    const lost = boundsSurvived(c.schema, propsSchema).map((problem) => `${c.id}: ${problem}`);
    const vocabulary = checkSchemaVocabulary(propsSchema).map((problem) => `${c.id}: propsSchema${problem}`);
    problems.push(...lost, ...vocabulary);
    templates.push({
      id: c.id,
      compositionId: c.id,
      width: c.width,
      height: c.height,
      defaultFps: c.fps,
      maxFrames: c.durationInFrames,
      propsSchema,
    });
  }
  if (problems.length > 0) fail(...problems);
  return templates;
}

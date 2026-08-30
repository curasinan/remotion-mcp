/**
 * The two bounds the README promises and nothing exercised.
 *
 * README's security model claims "responses 25,000 characters" and
 * docs/GATEWAY.md documents a `concurrency` refusal category. Neither had a test:
 * enforceCharacterLimit had never been called by one, and Limiter's queue-depth
 * branch had never executed at all - the only thing that touched the limiter was
 * a Windows-only test that inferred it from a process count.
 *
 * Every assertion here is paired with a control, because a bound that always
 * fires and a bound that never fires both pass a one-sided test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { enforceCharacterLimit, buildErrorResponse, buildResponse } from "../dist/services/format.js";
import { Limiter } from "../dist/services/limit.js";
import { ToolInputError, ResponseFormat } from "../dist/types.js";
import { CHARACTER_LIMIT } from "../dist/constants.js";

// ---------------------------------------------------------------- character cap

test("enforceCharacterLimit truncates an oversized body and says how to get the rest", () => {
  const out = enforceCharacterLimit("x".repeat(30_000), "Narrow the request.");
  assert.ok(out.length <= CHARACTER_LIMIT, `got ${out.length}, cap is ${CHARACTER_LIMIT}`);
  assert.match(out, /Truncated: response was 30000 characters/);
  assert.match(out, /Narrow the request\./, "the remedy must survive truncation - it is the actionable half");
});

test("enforceCharacterLimit leaves an in-budget body untouched", () => {
  // Control: without this, a function that truncated everything would pass above.
  const body = "a short report";
  assert.equal(enforceCharacterLimit(body, "remedy"), body);
});

test("buildResponse applies the cap", () => {
  const r = buildResponse("y".repeat(30_000), { ok: true }, ResponseFormat.MARKDOWN);
  assert.ok(r.content[0].text.length <= CHARACTER_LIMIT);
});

test("buildErrorResponse applies the cap too", () => {
  // This is the path most likely to carry unbounded third-party text: safeHandler's
  // generic catch interpolates error.message raw, and a native library or a bundler
  // can produce a very long one. It was the one response builder that skipped the
  // cap entirely.
  const r = buildErrorResponse("z".repeat(30_000), "Do the thing.");
  assert.equal(r.isError, true);
  assert.ok(r.content[0].text.length <= CHARACTER_LIMIT,
    `error body was ${r.content[0].text.length} chars; the documented limit is ${CHARACTER_LIMIT}. `
    + "README.md states responses are bounded at 25,000 characters, and this path is exempt from it.");
});

test("buildErrorResponse keeps the hint, which is the part worth reading", () => {
  // Control on the fix: truncation must not cut the remedy off the end. A naive
  // slice() would keep 25,000 z's and drop "Next step:" entirely.
  const r = buildErrorResponse("z".repeat(30_000), "Call remotion_ensure_browser.");
  assert.match(r.content[0].text, /Call remotion_ensure_browser\./,
    "the hint was truncated away, so the error tells the user nothing actionable");
});

test("buildErrorResponse leaves a short message intact", () => {
  const r = buildErrorResponse("something broke", "try again");
  assert.equal(r.content[0].text, "something broke\n\nNext step: try again");
});

// ---------------------------------------------------------------- concurrency

test("Limiter admits work up to its concurrency", async () => {
  // Control: proves the limiter is not simply refusing everything, which would
  // make the refusal test below vacuous.
  const limiter = new Limiter({ concurrency: 2, queueDepth: 1, label: "test" });
  const results = await Promise.all([limiter.run(async () => "a"), limiter.run(async () => "b")]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(limiter.stats, { active: 0, queued: 0 });
});

test("Limiter refuses past its queue depth, with the documented category", async () => {
  const limiter = new Limiter({ concurrency: 1, queueDepth: 1, label: "HTML screenshot" });
  let release;
  const running = limiter.run(() => new Promise((r) => { release = r; }));
  const queued = limiter.run(async () => "queued");
  assert.deepEqual(limiter.stats, { active: 1, queued: 1 }, "expected one running and one waiting");

  await assert.rejects(
    () => limiter.run(async () => "third"),
    (error) => {
      assert.ok(error instanceof ToolInputError, `expected ToolInputError, got ${error?.constructor?.name}`);
      // docs/GATEWAY.md lists `concurrency` as an audit category. Nothing had ever
      // produced one, so the dashboard documented a value the code could not emit.
      assert.equal(error.category, "concurrency");
      assert.match(error.message, /HTML screenshot/, "the refusal should name what is saturated");
      assert.ok(error.hint.length > 20, "a refusal without a next step is the thing this server exists to avoid");
      return true;
    },
  );

  release();
  assert.equal(await running, undefined);
  assert.equal(await queued, "queued");
  assert.deepEqual(limiter.stats, { active: 0, queued: 0 }, "slots must be returned once work drains");
});

test("Limiter releases its slot when the task throws", async () => {
  // The release lives in a finally. Without it one failed render would permanently
  // consume a slot, and the limiter would refuse everything from then on - a
  // failure that looks like saturation and never recovers.
  const limiter = new Limiter({ concurrency: 1, queueDepth: 1, label: "test" });
  await assert.rejects(() => limiter.run(async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(limiter.stats, { active: 0, queued: 0 });
  assert.equal(await limiter.run(async () => "still works"), "still works");
});

/** Constants of the HTTP service profile. The stdio build never compiles this tree. */

/** The identity header the owner's gateway signs. node:http lowercases header names. */
export const IDENTITY_HEADER = "x-render-identity";

/** The `params._meta` key under which the gateway puts its `request_id` in every message. */
export const REQUEST_ID_META_KEY = "io.github.curasinan/request_id";

/** Clock skew allowed between the gateway and a deployment, in seconds. */
export const IDENTITY_SKEW_S = 30;

/** Largest `exp - iat` an identity header may carry, in seconds. */
export const IDENTITY_MAX_TTL_S = 120;

/** Largest request body read, counted as it arrives. */
export const SERVICE_BODY_CAP_BYTES = 262_144;

/** Largest PNG a render may return. */
export const SERVICE_PNG_CAP_BYTES = 4_194_304;

/** How long `render_still` may take before the service aborts it. */
export const RENDER_STILL_DEADLINE_MS = 45_000;

/** The CLI's own `--timeout`. It must exceed the deadline, so the service's abort fires first. */
export const RENDER_CLI_TIMEOUT_MS = 60_000;

/** Time between SIGTERM and SIGKILL when a render is stopped. */
export const RENDER_KILL_GRACE_MS = 5_000;

/** How long after the SIGKILL the service waits to see a render's processes gone. */
export const RENDER_VERIFY_DEADLINE_MS = 10_000;

/** Renders that may run at once. With none free, a request is refused; there is no queue. */
export const RENDER_SLOTS_DEFAULT = 2;

/** Oldest `@remotion/renderer` the service starts with. */
export const MIN_REMOTION_RENDERER = "4.0.458";

if (RENDER_CLI_TIMEOUT_MS <= RENDER_STILL_DEADLINE_MS) {
  throw new Error(
    `RENDER_CLI_TIMEOUT_MS (${RENDER_CLI_TIMEOUT_MS}) must exceed RENDER_STILL_DEADLINE_MS `
    + `(${RENDER_STILL_DEADLINE_MS}), or the CLI times out before the service's own deadline fires.`,
  );
}

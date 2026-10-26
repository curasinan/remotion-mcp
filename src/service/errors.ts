/**
 * The errors the service's tools return (design 5.5). A caller sees a category and a fixed message, plus, for
 * `invalid_props`, the JSON pointers of the failing props. Never a filesystem path, a local-dev tool name, CLI output,
 * a raw zod or ajv message, or a value the caller sent.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ServiceErrorCategory = "unknown_template" | "frame_out_of_range" | "invalid_props" | "render_busy"
  | "render_timeout" | "render_failed" | "output_too_large" | "not_implemented" | "internal";

const MESSAGES: Readonly<Record<ServiceErrorCategory, string>> = Object.freeze({
  unknown_template: "no template has this id",
  frame_out_of_range: "the frame is not below the template's maxFrames",
  invalid_props: "the props do not match the template's propsSchema",
  render_busy: "every render slot is in use; retry later",
  render_timeout: "the render did not finish before the deadline",
  render_failed: "the render produced no image",
  output_too_large: "the rendered image is larger than the service returns",
  not_implemented: "this tool is not implemented yet",
  internal: "the service failed to handle the call",
});

/**
 * The pointers as one JSON array on one line. A pointer holds a caller's own key, which may contain ", ", a newline
 * or another control character; encoded, it cannot pass for a second pointer, a second line or a second category.
 * JSON.stringify leaves DEL, the C1 controls and the line and paragraph separators raw, so those are escaped too,
 * and the text still parses back to exactly `paths`.
 */
function pointerList(paths: string[]): string {
  return JSON.stringify(paths).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}

/**
 * `{ isError: true, content: [{ type: "text", text: "<category>: <fixed message>" }], structuredContent: { category,
 * paths? } }`. For `invalid_props` the text ends with ` at ` and the pointers as a JSON array; `paths` holds them
 * as they are.
 */
export function serviceError(category: ServiceErrorCategory, paths?: string[]): CallToolResult {
  const at = paths === undefined || paths.length === 0 ? "" : ` at ${pointerList(paths)}`;
  return {
    isError: true,
    content: [{ type: "text", text: `${category}: ${MESSAGES[category]}${at}` }],
    structuredContent: paths === undefined ? { category } : { category, paths: [...paths] },
  };
}

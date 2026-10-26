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
 * `{ isError: true, content: [{ type: "text", text: "<category>: <fixed message>" }], structuredContent: { category,
 * paths? } }`. For `invalid_props` the text ends with the pointers as well.
 */
export function serviceError(category: ServiceErrorCategory, paths?: string[]): CallToolResult {
  const at = paths === undefined || paths.length === 0 ? "" : ` at ${paths.join(", ")}`;
  return {
    isError: true,
    content: [{ type: "text", text: `${category}: ${MESSAGES[category]}${at}` }],
    structuredContent: paths === undefined ? { category } : { category, paths: [...paths] },
  };
}

/**
 * viz_compare.
 *
 * The render tools let the model look at its output. This one lets it check that
 * a change did what it intended, instead of rendering twice and asserting the
 * difference from memory.
 *
 * Note what it does NOT do: it reads two files that are already inside the
 * workspace and returns a number. No spawn, no browser, no network, no new
 * format. It is the only tool here whose world is genuinely closed.
 */

import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FLAG_LIKE_MESSAGE, hasNoFlagLikeSegment, outputPathField, responseFormatField } from "../schemas/common.js";
import { buildResponse, formatBytes, safeHandler } from "../services/format.js";
import { displayPath, ensureParentDirectory, resolveInWorkspace } from "../services/paths.js";
import { comparePngs } from "../services/png.js";
import { ToolInputError } from "../types.js";

const MAX_INLINE_IMAGE_BYTES = 1_500_000;

/** A path that is READ rather than written. New input class for this server. */
function inputPathField(description: string) {
  return z
    .string()
    .min(1)
    .max(500)
    .refine(hasNoFlagLikeSegment, FLAG_LIKE_MESSAGE)
    .describe(description);
}

const CompareShape = {
  before: inputPathField("PNG to treat as the baseline, relative to the workspace root"),
  after: inputPathField("PNG to compare against the baseline, relative to the workspace root"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe("Colour distance at which a pixel counts as changed. Lower is stricter; 0.1 ignores anti-aliasing noise."),
  output_path: outputPathField(
    "Optional path to write the diff image to, relative to the workspace root",
  ).optional(),
  return_image: z
    .boolean()
    .default(true)
    .describe("Attach the diff image to the response so the change can be looked at, not just counted"),
  response_format: responseFormatField,
};
type CompareInput = z.infer<z.ZodObject<typeof CompareShape>>;

function readPng(relative: string): Buffer {
  const absolute = resolveInWorkspace(relative);
  if (!fs.existsSync(absolute)) {
    throw new ToolInputError(
      `'${relative}' does not exist.`,
      `Resolved to '${displayPath(absolute)}' inside the workspace. Render it first, or check the path.`,
    );
  }
  if (fs.statSync(absolute).isDirectory()) {
    throw new ToolInputError(`'${relative}' is a directory, not a PNG file.`, "Pass the path to a .png file.");
  }
  return fs.readFileSync(absolute);
}

export function registerCompareTools(server: McpServer): void {
  server.registerTool(
    "viz_compare",
    {
      title: "Compare two PNGs",
      description: `Pixel-diff two PNG files and report how much changed, so a fix can be verified rather than assumed.

Use it after changing a visualization: render before, render after, compare. The count answers "did my edit do anything?" and the attached diff image shows where. Reading two files and returning a number - no browser, no network, no rendering.

The two images must have identical dimensions. This is the common case to think about, not an edge case: viz_render_svg derives height from the viewBox, so any edit that touches the viewBox changes the output height and makes a pixel diff the wrong check. It refuses rather than resizing.

Returns (JSON format):
  {
    "identical": boolean,
    "changed_pixels": number,
    "total_pixels": number,
    "changed_fraction": number,        // 0.0 to 1.0
    "width": number, "height": number,
    "changed_region": { "x", "y", "width", "height" },  // bounding box of the change
    "output_path": string|null,
    "image_attached": boolean
  }

Examples:
  - Use when: Confirming a fix changed the rendering -> before="out/a.png", after="out/b.png"
  - Use when: Checking a refactor changed nothing visible; identical=true is the pass
  - Use when: Locating a change you can see but cannot place -> read changed_region
  - Don't use when: The two renders are different sizes (compare them by eye instead)
  - Don't use when: You want to see one image (use viz_render_svg or viz_render_html)

Error Handling:
  - Different dimensions are refused, naming both sizes, rather than being resized
  - A file that is not a PNG, or is truncated by a killed render, is named
  - A pair too large to decode is refused before any memory is allocated
  - identical=true means the pixels match; it does not mean the edit was correct`,
      inputSchema: CompareShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        // Reads two files inside the workspace, runs no subprocess and touches no
        // network. The second closed-world tool in this server; keep it that way.
        openWorldHint: false,
      },
    },
    safeHandler("viz_compare", async (input: CompareInput) => {
      const beforeBuffer = readPng(input.before);
      const afterBuffer = readPng(input.after);
      const result = comparePngs(beforeBuffer, afterBuffer, input.threshold, input.before, input.after);

      let written: string | null = null;
      if (input.output_path) {
        const absolute = resolveInWorkspace(input.output_path);
        ensureParentDirectory(absolute);
        fs.writeFileSync(absolute, result.diffPng);
        written = displayPath(absolute);
      }

      const attached = input.return_image && result.diffPng.byteLength <= MAX_INLINE_IMAGE_BYTES;
      const percent = (result.changedFraction * 100).toFixed(3);

      const markdown = result.identical
        ? [
            "# No visual difference",
            "",
            `\`${input.before}\` and \`${input.after}\` render identically at threshold ${input.threshold} `
            + `(${result.width} x ${result.height}, ${result.totalPixels} pixels compared).`,
            "",
            "Nothing changed. If you expected a change, the edit did not reach the rendered output — "
            + "check that the file you edited is the one being rendered. This result says the pixels "
            + "match; it does not say the edit was correct.",
          ].join("\n")
        : [
            "# Visual difference",
            "",
            `- **Changed:** ${result.changedPixels} of ${result.totalPixels} pixels (${percent}%)`,
            `- **Region:** ${result.changedRegion.width} x ${result.changedRegion.height} at `
            + `(${result.changedRegion.x}, ${result.changedRegion.y})`,
            `- **Size:** ${result.width} x ${result.height}, threshold ${input.threshold}`,
            ...(written ? [`- **Diff written:** \`${written}\``] : []),
            "",
            "Red marks the changed pixels. A non-zero count means the pixels differ — whether the "
            + "difference is the one you wanted is what the image is for.",
          ].join("\n");

      const structured = {
        identical: result.identical,
        changed_pixels: result.changedPixels,
        total_pixels: result.totalPixels,
        changed_fraction: result.changedFraction,
        width: result.width,
        height: result.height,
        changed_region: result.changedRegion,
        output_path: written,
        image_attached: attached,
        diff_size_bytes: result.diffPng.byteLength,
      };

      // Composed before buildResponse rather than appended to content[0] after:
      // content is a union of text and image blocks, so indexing into it to mutate
      // .text is only correct by accident of ordering.
      const body = input.return_image && !attached
        ? `${markdown}\n\nDiff image not attached: ${formatBytes(result.diffPng.byteLength)} exceeds the `
          + `${formatBytes(MAX_INLINE_IMAGE_BYTES)} inline cap. Pass output_path to write it to a file.`
        : markdown;

      const response = buildResponse(body, structured, input.response_format);
      if (attached) {
        response.content.push({
          type: "image",
          data: result.diffPng.toString("base64"),
          mimeType: "image/png",
        });
      }
      return response;
    }),
  );
}

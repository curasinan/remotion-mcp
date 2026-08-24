/**
 * Visualization tools.
 *
 * viz_validate_svg is the cheap pre-flight check: it names exactly which rule
 * an SVG breaks before anything tries to render it. viz_render_svg and
 * viz_render_html close the loop by producing a PNG that can actually be
 * looked at, instead of guessing whether the markup worked.
 */

import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULT_RASTER_WIDTH,
  MAX_RASTER_DIMENSION,
  MAX_SOURCE_BYTES,
} from "../constants.js";
import { outputPathField, projectDirField, responseFormatField } from "../schemas/common.js";
import {
  buildErrorResponse,
  buildResponse,
  formatBytes,
  safeHandler,
  type ToolResponse,
} from "../services/format.js";
import { displayPath, ensureParentDirectory, resolveInWorkspace } from "../services/paths.js";
import { rasterizeHtml, rasterizeSvg } from "../services/raster.js";
import { networkPolicyFromEnvironment } from "../services/network.js";
import { validateSvg } from "../services/svg.js";
import { ToolInputError } from "../types.js";

const MAX_INLINE_IMAGE_BYTES = 1_500_000;

const sourceField = z
  .string()
  .min(1, "source cannot be empty")
  .max(MAX_SOURCE_BYTES, `source must be under ${MAX_SOURCE_BYTES} bytes`);

const ValidateSvgShape = {
  svg: sourceField.describe("Complete SVG markup, starting with the <svg> root element"),
  response_format: responseFormatField,
};
type ValidateSvgInput = z.infer<z.ZodObject<typeof ValidateSvgShape>>;

const RenderSvgShape = {
  svg: sourceField.describe("Complete SVG markup, starting with the <svg> root element"),
  width: z
    .number()
    .int()
    .min(1)
    .max(MAX_RASTER_DIMENSION)
    .default(DEFAULT_RASTER_WIDTH)
    .describe("Output width in pixels. Height follows from the viewBox aspect ratio."),
  output_path: outputPathField(
    "Optional PNG path relative to the workspace root. Omit to only attach the image to the response without writing a file.",
  ).optional(),
  return_image: z
    .boolean()
    .default(true)
    .describe("Attach the rendered PNG to the response so it can be inspected directly"),
  response_format: responseFormatField,
};
type RenderSvgInput = z.infer<z.ZodObject<typeof RenderSvgShape>>;

const RenderHtmlShape = {
  html: sourceField.describe("HTML markup. A fragment is fine; it will be wrapped in a document automatically."),
  width: z
    .number()
    .int()
    .min(1)
    .max(MAX_RASTER_DIMENSION)
    .default(1_280)
    .describe("Viewport width in CSS pixels"),
  height: z
    .number()
    .int()
    .min(1)
    .max(MAX_RASTER_DIMENSION)
    .default(720)
    .describe("Viewport height in CSS pixels"),
  full_page: z
    .boolean()
    .default(false)
    .describe("Capture the entire scrollable page instead of just the viewport"),
  device_scale_factor: z
    .number()
    .min(1)
    .max(3)
    .default(2)
    .describe("Pixel density multiplier. 2 gives crisp text on high-DPI displays."),
  output_path: outputPathField(
    "Optional PNG path relative to the workspace root",
  ).optional(),
  project_dir: projectDirField
    .describe("Optional Remotion project directory. Given one, the tool can reuse the browser Remotion already downloaded instead of needing a separate Chrome install.")
    .optional(),
  return_image: z
    .boolean()
    .default(true)
    .describe("Attach the screenshot to the response"),
  response_format: responseFormatField,
};
type RenderHtmlInput = z.infer<z.ZodObject<typeof RenderHtmlShape>>;

function attachAndWrite(
  response: ToolResponse,
  png: Buffer,
  outputPath: string | undefined,
  returnImage: boolean,
): { written: string | null; attached: boolean } {
  let written: string | null = null;
  if (outputPath) {
    const absolute = resolveInWorkspace(outputPath);
    ensureParentDirectory(absolute);
    fs.writeFileSync(absolute, png);
    written = displayPath(absolute);
  }

  const attached = returnImage && png.byteLength <= MAX_INLINE_IMAGE_BYTES;
  if (attached) {
    response.content.push({
      type: "image",
      data: png.toString("base64"),
      mimeType: "image/png",
    });
  }
  return { written, attached };
}

export function registerVisualizationTools(server: McpServer): void {
  server.registerTool(
    "viz_validate_svg",
    {
      title: "Validate SVG",
      description: `Check SVG markup against the rules that inline and sandboxed renderers actually enforce, and return a specific fix for each violation.

Run this before handing an SVG to any renderer. It catches the failures that otherwise show up as a blank frame or a generic error with no explanation: XML that is not well formed (SVG is XML, so unclosed tags are fatal where HTML would tolerate them), HTML-only entities such as &nbsp; that are undefined in XML, a missing xmlns or viewBox, <script> elements that sandboxes strip, external URLs that are blocked during rendering, and <foreignObject> that rasterizers silently drop.

Runs in milliseconds and touches no files or network.

Args:
  - svg (string, required): Complete SVG markup
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "valid": boolean,             // True when there are no errors; warnings do not block
    "byte_size": number,
    "error_count": number,
    "warning_count": number,
    "issues": [
      {
        "severity": "error"|"warning",
        "code": string,           // e.g. "malformed_xml", "missing_viewbox", "external_reference"
        "message": string,        // What is wrong
        "fix": string,            // How to fix it
        "line": number            // Present for XML parse errors
      }
    ],
    "detected_viewbox": string|null,
    "detected_width": string|null,
    "detected_height": string|null
  }

Examples:
  - Use when: An SVG rendered blank and you want to know why
  - Use when: Checking generated SVG before writing it into a file or a widget
  - Use when: A renderer returned an error with no useful detail
  - Don't use when: You want to see the picture (use viz_render_svg)

Error Handling:
  - Never fails on bad SVG; bad SVG is the expected input and is reported as issues
  - Returns an error only if the source exceeds 2 MB`,
      inputSchema: ValidateSvgShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler("viz_validate_svg", async (input: ValidateSvgInput) => {
      const report = validateSvg(input.svg);

      const lines: string[] = [
        "# SVG Validation",
        "",
        `**Result:** ${report.valid ? "valid" : "invalid"} — ${report.error_count} error(s), ${report.warning_count} warning(s)`,
        `**Size:** ${formatBytes(report.byte_size)}`,
        `**viewBox:** ${report.detected_viewbox ?? "none"}`,
        "",
      ];

      if (report.issues.length === 0) {
        lines.push("No issues found. This SVG should render.");
      } else {
        for (const issue of report.issues) {
          lines.push(
            `### ${issue.severity.toUpperCase()}: ${issue.code}${issue.line ? ` (line ${issue.line})` : ""}`,
          );
          lines.push(issue.message);
          lines.push(`**Fix:** ${issue.fix}`);
          lines.push("");
        }
      }

      return buildResponse(
        lines.join("\n"),
        report as unknown as Record<string, unknown>,
        input.response_format,
      );
    }),
  );

  server.registerTool(
    "viz_render_svg",
    {
      title: "Render SVG to PNG",
      description: `Rasterize SVG markup to a PNG and attach it to the response, so the result can be looked at rather than assumed.

Uses resvg, which needs no browser and produces deterministic output. Note that resvg ignores <foreignObject> and does not fetch external resources, which is exactly why viz_validate_svg flags both: what disappears here disappears in most sandboxed renderers too.

If rasterization fails, call viz_validate_svg on the same source; it names the broken rule.

Args:
  - svg (string, required): Complete SVG markup
  - width (number): Output width in pixels, 1 to 8000 (default: 1200). Height follows the viewBox aspect ratio.
  - output_path (string, optional): PNG path relative to the workspace root. Omit to skip writing a file.
  - return_image (boolean): Attach the PNG to the response (default: true)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "success": boolean,
    "width": number,             // Actual rendered pixel width
    "height": number,            // Actual rendered pixel height
    "file_size_bytes": number,
    "output_path": string|null,  // Null when no file was written
    "image_attached": boolean,
    "validation": { ... }        // Same shape as viz_validate_svg, so warnings surface here too
  }

Examples:
  - Use when: "does this chart SVG actually look right?" -> svg="<svg ...>", width=1200
  - Use when: Saving a diagram for a document -> output_path="docs/architecture.png"
  - Use when: Verifying a fix after viz_validate_svg reported an error
  - Don't use when: The source is HTML rather than SVG (use viz_render_html)

Error Handling:
  - Parse failures return the resvg message plus a pointer to viz_validate_svg
  - Images over 1.5 MB are written but not attached; lower width to inspect inline`,
      inputSchema: RenderSvgShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeHandler("viz_render_svg", async (input: RenderSvgInput) => {
      const validation = validateSvg(input.svg);
      if (!validation.valid) {
        const summary = validation.issues
          .filter((i) => i.severity === "error")
          .map((i) => `- ${i.code}: ${i.message}\n  Fix: ${i.fix}`)
          .join("\n");
        return buildErrorResponse(
          `The SVG has ${validation.error_count} error(s) and cannot be rasterized reliably:\n\n${summary}`,
          "Apply the fixes above and call this tool again. Call viz_validate_svg for the full report including warnings.",
        );
      }

      const raster = rasterizeSvg(input.svg, input.width);

      const structuredBase = {
        success: true,
        width: raster.width,
        height: raster.height,
        file_size_bytes: raster.png.byteLength,
        validation: validation as unknown as Record<string, unknown>,
      };

      const markdown = [
        "# SVG rendered",
        "",
        `- **Dimensions:** ${raster.width} x ${raster.height} px`,
        `- **PNG size:** ${formatBytes(raster.png.byteLength)}`,
        ...(validation.warning_count > 0
          ? [
              "",
              `${validation.warning_count} warning(s) from validation:`,
              ...validation.issues
                .filter((i) => i.severity === "warning")
                .map((i) => `- ${i.code}: ${i.message}`),
            ]
          : []),
      ].join("\n");

      const response = buildResponse(markdown, structuredBase, input.response_format);
      const { written, attached } = attachAndWrite(
        response,
        raster.png,
        input.output_path,
        input.return_image,
      );

      response.structuredContent = {
        ...structuredBase,
        output_path: written,
        image_attached: attached,
      };
      return response;
    }),
  );

  server.registerTool(
    "viz_render_html",
    {
      title: "Render HTML to PNG",
      description: `Screenshot HTML in a headless browser and attach the PNG to the response.

Use this for anything SVG cannot express: CSS grid and flexbox layouts, web fonts, canvas, or a chart library that draws into the DOM. A bare fragment is fine; it gets wrapped in a minimal document with margins reset.

Scripts run before the screenshot is taken. If any script throws during load the tool reports the error rather than returning a blank image, which is the usual silent failure mode.

Drives a browser that already exists on the machine: an explicit PUPPETEER_EXECUTABLE_PATH, a full puppeteer install, a system Chrome/Chromium/Edge/Brave, or the Chrome Headless Shell that Remotion downloaded. Nothing is downloaded by this tool.

Args:
  - html (string, required): HTML markup or fragment
  - width (number): Viewport width in CSS pixels (default: 1280)
  - height (number): Viewport height in CSS pixels (default: 720)
  - full_page (boolean): Capture the whole scrollable page (default: false)
  - device_scale_factor (number): Pixel density, 1 to 3 (default: 2)
  - output_path (string, optional): PNG path relative to the workspace root
  - project_dir (string, optional): Remotion project directory, so the browser Remotion downloaded can be reused
  - return_image (boolean): Attach the screenshot to the response (default: true)
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns (JSON format):
  {
    "success": boolean,
    "viewport_width": number,
    "viewport_height": number,
    "device_scale_factor": number,
    "full_page": boolean,
    "file_size_bytes": number,
    "output_path": string|null,
    "image_attached": boolean
  }

Examples:
  - Use when: "screenshot this dashboard mockup" -> html="<div class=...>", width=1440
  - Use when: Capturing a full scrolling page -> full_page=true
  - Use when: Checking a chart library render before embedding it in a Remotion composition
  - Don't use when: The source is plain SVG (viz_render_svg is faster and needs no browser)

Error Handling:
  - Returns a browser-not-found message naming every location that was searched
  - Returns the script error message when the page throws during load
  - Times out after 30 seconds waiting for the network to go idle; remove external resource loads if that happens`,
      inputSchema: RenderHtmlShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeHandler("viz_render_html", async (input: RenderHtmlInput) => {
      if (Buffer.byteLength(input.html, "utf8") > MAX_SOURCE_BYTES) {
        throw new ToolInputError(
          "HTML source exceeds 2 MB.",
          "Trim the markup, or move large inline data URIs into a file and reference it locally.",
        );
      }

      const policy = networkPolicyFromEnvironment();
      const raster = await rasterizeHtml(
        input.html,
        input.width,
        input.height,
        input.full_page,
        input.device_scale_factor,
        input.project_dir ? resolveInWorkspace(input.project_dir) : undefined,
        policy,
      );

      const structuredBase = {
        success: true,
        viewport_width: input.width,
        viewport_height: input.height,
        device_scale_factor: input.device_scale_factor,
        full_page: input.full_page,
        file_size_bytes: raster.png.byteLength,
      };

      const markdown = [
        "# HTML screenshot",
        "",
        `- **Viewport:** ${input.width} x ${input.height} px at ${input.device_scale_factor}x`,
        `- **Full page:** ${input.full_page ? "yes" : "no"}`,
        `- **PNG size:** ${formatBytes(raster.png.byteLength)}`,
      ].join("\n");

      const response = buildResponse(markdown, structuredBase, input.response_format);
      const { written, attached } = attachAndWrite(
        response,
        raster.png,
        input.output_path,
        input.return_image,
      );

      response.structuredContent = {
        ...structuredBase,
        output_path: written,
        image_attached: attached,
      };
      return response;
    }),
  );
}

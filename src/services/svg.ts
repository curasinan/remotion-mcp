/**
 * SVG validation.
 *
 * Inline SVG renderers fail for a small, predictable set of reasons: XML that
 * is not well formed, a missing viewBox, features the renderer sandbox strips
 * (script, external references, foreignObject), or a payload large enough to
 * be rejected. Each rule below maps to one of those and carries its own fix.
 */

import { XMLValidator } from "fast-xml-parser";
import type { SvgIssue, SvgValidationReport } from "../types.js";

const HTML_ONLY_ENTITIES =
  /&(nbsp|copy|reg|trade|hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo|bull|dagger|permil|eacute|uuml|deg);/g;

/**
 * Read a quoted attribute off a tag.
 *
 * XML allows either quote style, so matching only double quotes made a
 * single-quoted document look like the attribute was absent entirely — a
 * viewBox='0 0 W H' was reported as missing. The leading guard keeps `width`
 * from matching inside `stroke-width` and `height` inside `font-height`.
 */
function readAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?<![-\\w:])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

export function validateSvg(source: string): SvgValidationReport {
  const issues: SvgIssue[] = [];
  const byteSize = Buffer.byteLength(source, "utf8");
  const trimmed = source.trim();

  if (!/^<(\?xml|!DOCTYPE|svg)/i.test(trimmed)) {
    issues.push({
      severity: "error",
      code: "not_svg_root",
      message: "The source does not begin with an <svg> element.",
      fix: "Strip any markdown code fences, prose or leading whitespace so the very first character is '<'.",
    });
  }

  // Well-formedness. HTML-only entities are undefined in XML, so neutralise
  // them before validating and report them as their own issue.
  const entityMatches = [...source.matchAll(HTML_ONLY_ENTITIES)];
  if (entityMatches.length > 0) {
    const names = [...new Set(entityMatches.map((m) => m[0]))].join(", ");
    issues.push({
      severity: "error",
      code: "html_entity_in_xml",
      message: `HTML-only character entities are not defined in XML: ${names}`,
      fix: "Replace them with numeric references, for example &#160; instead of &nbsp; and &#8212; instead of &mdash;.",
    });
  }

  const forValidation = source.replace(HTML_ONLY_ENTITIES, "&#160;");
  const wellFormed = XMLValidator.validate(forValidation, { allowBooleanAttributes: true });
  if (wellFormed !== true) {
    issues.push({
      severity: "error",
      code: "malformed_xml",
      message: `XML is not well formed: ${wellFormed.err.msg} (${wellFormed.err.code})`,
      fix: "SVG is XML, not HTML. Every element must be closed, including <path/>, <circle/>, <rect/> and <line/>. Attribute values must be quoted.",
      line: wellFormed.err.line,
    });
  }

  const rootTag = /<svg\b[^>]*>/i.exec(source)?.[0] ?? "";
  const viewBox = readAttribute(rootTag, "viewBox");
  const width = readAttribute(rootTag, "width");
  const height = readAttribute(rootTag, "height");

  if (rootTag && !/xmlns\s*=/i.test(rootTag)) {
    issues.push({
      severity: "error",
      code: "missing_xmlns",
      message: "The root <svg> element has no xmlns attribute.",
      fix: 'Add xmlns="http://www.w3.org/2000/svg" to the root element. Without it, standalone rasterizers refuse the document.',
    });
  }

  if (rootTag && !viewBox) {
    issues.push({
      severity: "warning",
      code: "missing_viewbox",
      message: "No viewBox on the root <svg>.",
      fix: 'Add viewBox="0 0 W H" matching your coordinate space. Without it the graphic will not scale to its container and often renders at the wrong size or blank.',
    });
  }

  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      issues.push({
        severity: "error",
        code: "bad_viewbox",
        message: `viewBox="${viewBox}" is not four finite numbers.`,
        fix: 'Use the form viewBox="min-x min-y width height", for example viewBox="0 0 800 450".',
      });
    } else if ((parts[2] ?? 0) <= 0 || (parts[3] ?? 0) <= 0) {
      issues.push({
        severity: "error",
        code: "zero_viewbox",
        message: "viewBox width or height is zero or negative, so nothing can be drawn.",
        fix: "Set positive width and height values in the viewBox.",
      });
    }
  }

  if (/<script[\s>]/i.test(source)) {
    issues.push({
      severity: "error",
      code: "script_element",
      message: "The SVG contains a <script> element.",
      fix: "Remove it. Sandboxed SVG renderers strip scripts, and the surrounding graphic often fails to render at all. Use SMIL <animate> or CSS animation instead, or switch to an HTML widget.",
    });
  }

  const externalRef = /(?:xlink:href|href|src)\s*=\s*["'](https?:)?\/\//i.exec(source);
  if (externalRef) {
    issues.push({
      severity: "error",
      code: "external_reference",
      message: "The SVG references an external URL.",
      fix: "Inline the asset instead. Network fetches are blocked during rendering, so the element silently disappears. Embed images as data: URIs and convert text to paths or system fonts.",
    });
  }

  if (/<foreignObject[\s>]/i.test(source)) {
    issues.push({
      severity: "warning",
      code: "foreign_object",
      message: "The SVG uses <foreignObject>.",
      fix: "Rasterizers such as resvg ignore it entirely, so the content vanishes in exported PNGs. Rebuild that region with native <text> and <tspan>, or build the whole thing as HTML.",
    });
  }

  if (/@import|url\(\s*['\"]?https?:/i.test(source)) {
    issues.push({
      severity: "warning",
      code: "external_font_or_css",
      message: "The SVG imports an external stylesheet or font.",
      fix: "Remove the import and rely on generic families (sans-serif, serif, monospace) or embed the font as a base64 data URI inside a <style> block.",
    });
  }

  const openTags = (source.match(/<[a-zA-Z]/g) ?? []).length;
  if (openTags > 5_000) {
    issues.push({
      severity: "warning",
      code: "very_large_document",
      message: `The document has roughly ${openTags} elements.`,
      fix: "Reduce element count with <use>, <symbol> or path merging. Very large SVGs are slow to rasterize and can be rejected outright by inline renderers.",
    });
  }

  return {
    valid: issues.every((i) => i.severity !== "error"),
    byte_size: byteSize,
    error_count: issues.filter((i) => i.severity === "error").length,
    warning_count: issues.filter((i) => i.severity === "warning").length,
    issues,
    detected_viewbox: viewBox,
    detected_width: width,
    detected_height: height,
  };
}

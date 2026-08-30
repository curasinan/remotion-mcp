/**
 * Tile rendered frames into one labelled image.
 *
 * A still cannot show timing, and timing is where compositions actually break: an
 * interpolation with the wrong input range looks perfect at frame 0 and wrong at
 * frame 30. A strip puts several frames side by side so the shape of the motion is
 * visible in one response.
 *
 * The composite is built as an SVG of <image> elements carrying data: URIs and
 * handed to the existing rasterizeSvg. That means no new dependency, and - the
 * part that matters - it goes THROUGH the reference check rather than around it.
 * findFilesystemReferences permits data: and refuses everything else, and the
 * temptation to bypass it "because we generated this SVG ourselves" is exactly how
 * that control would stop being one.
 */

import { MAX_RASTER_DIMENSION, MAX_RASTER_PIXELS } from "../constants.js";
import { readPngSize } from "./png.js";
import { rasterizeSvg } from "./raster.js";
import { ToolInputError } from "../types.js";

/** Height of the caption strip under each row, in tile pixels. */
const LABEL_BAND = 34;
/** Widest single row before wrapping. Past this each panel is too small to read. */
const MAX_COLUMNS = 6;

export interface Panel {
  png: Buffer;
  label: string;
}

export interface TileResult {
  png: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface TileLayout {
  svg: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/**
 * Exported so the reference invariant can be asserted directly.
 *
 * rasterizeSvg refuses any href that is not a data: URI, which is what stops an
 * SVG from being a file-read primitive. This composite is machine-generated, and
 * "we wrote it ourselves" is precisely the argument that would justify skipping
 * that check one day - so a test asserts the generated document carries nothing
 * but data: URIs, rather than relying on the sink to catch it.
 */
export function buildTileSvg(panels: Panel[]): TileLayout {
  if (panels.length === 0) {
    throw new ToolInputError("No frames were rendered.", "Pass at least two frames.", "tile");
  }

  const sizes = panels.map((p, i) => readPngSize(p.png, `frame ${i}`));
  const cellWidth = sizes[0]!.width;
  const cellHeight = sizes[0]!.height;
  const odd = sizes.findIndex((s) => s.width !== cellWidth || s.height !== cellHeight);
  if (odd !== -1) {
    throw new ToolInputError(
      `Rendered frames are not the same size: frame 0 is ${cellWidth}x${cellHeight}, `
      + `frame ${odd} is ${sizes[odd]!.width}x${sizes[odd]!.height}.`,
      "Every frame of one composition should render at the same size. Re-run without a "
      + "per-frame scale, or report this - it means the composition changes its own dimensions.",
      "tile",
    );
  }

  const columns = Math.min(panels.length, MAX_COLUMNS);
  const rows = Math.ceil(panels.length / columns);
  const width = cellWidth * columns;
  const height = (cellHeight + LABEL_BAND) * rows;

  // Caught here rather than inside resvg so the message names the strip and the
  // knob that fixes it, instead of talking about a viewBox the caller never wrote.
  if (width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION || width * height > MAX_RASTER_PIXELS) {
    throw new ToolInputError(
      `A ${columns}x${rows} strip of ${cellWidth}x${cellHeight} frames would be ${width}x${height}, `
      + `beyond the ${MAX_RASTER_DIMENSION}px / ${MAX_RASTER_PIXELS}px limits.`,
      `Lower scale - scale=${(MAX_RASTER_DIMENSION / width).toFixed(2)} or less would fit - `
      + "or ask for fewer frames.",
      "raster_budget",
    );
  }

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" `
    + `width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="#12161c"/>`,
  ];

  panels.forEach((panel, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = col * cellWidth;
    const y = row * (cellHeight + LABEL_BAND);
    parts.push(
      `<image x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" `
      + `href="data:image/png;base64,${panel.png.toString("base64")}"/>`,
      // Labels are what make two identical-looking panels legible as "the
      // composition is holding still" rather than "the tool repeated a frame".
      `<text x="${x + cellWidth / 2}" y="${y + cellHeight + LABEL_BAND - 11}" `
      + `font-family="sans-serif" font-size="20" fill="#9aa4b2" text-anchor="middle">`
      + `${escapeXml(panel.label)}</text>`,
    );
  });
  parts.push("</svg>");
  return { svg: parts.join(""), width, height, columns, rows };
}

export function tilePanels(panels: Panel[]): TileResult {
  const layout = buildTileSvg(panels);
  // Through rasterizeSvg, never around it: that is where findFilesystemReferences
  // runs, and routing the generated document through the same sink as any
  // caller-supplied one is the point.
  const raster = rasterizeSvg(layout.svg, layout.width);
  return {
    png: raster.png,
    width: raster.width,
    height: raster.height,
    columns: layout.columns,
    rows: layout.rows,
  };
}

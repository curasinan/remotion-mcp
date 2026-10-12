/** Tiles rendered frames into one labelled image via an SVG of data: URI images. */

import { MAX_RASTER_DIMENSION, MAX_RASTER_PIXELS } from "../constants.js";
import { readPngSize } from "./png.js";
import { rasterizeSvg } from "./raster.js";
import { ToolInputError } from "../types.js";

/** Height of the caption strip under each row, in tile pixels. */
const LABEL_BAND = 34;
/** Widest single row before wrapping. */
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

/** Builds the tile SVG; exported so tests can assert it contains only data: URIs. */
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

  // Checked here so the error names the strip size and the scale fix.
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
      // Frame label under each panel.
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
  // Goes through rasterizeSvg so the filesystem reference check still applies.
  const raster = rasterizeSvg(layout.svg, layout.width);
  return {
    png: raster.png,
    width: raster.width,
    height: raster.height,
    columns: layout.columns,
    rows: layout.rows,
  };
}

/** PNG decoding and pixel comparison using pure-JS pngjs and pixelmatch. */

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { MAX_RASTER_PIXELS } from "../constants.js";
import { ToolInputError } from "../types.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngSize {
  width: number;
  height: number;
}

/** Reads dimensions from the IHDR so the pixel budget is enforced before decoding. */
export function readPngSize(buffer: Buffer, label: string): PngSize {
  if (buffer.byteLength < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new ToolInputError(
      `'${label}' is not a PNG.`,
      "Both arguments must be PNG files produced by viz_render_svg, viz_render_html or "
      + "remotion_render_still. Other image formats are not read.",
      "png_decode",
    );
  }
  // IHDR is the first chunk and is fixed-position: length(4) type(4) width(4) height(4).
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new ToolInputError(
      `'${label}' declares a zero or negative size (${width} x ${height}).`,
      "The file is corrupt. Re-run whatever produced it.",
      "png_decode",
    );
  }
  return { width, height };
}

export interface CompareResult {
  identical: boolean;
  changedPixels: number;
  totalPixels: number;
  changedFraction: number;
  width: number;
  height: number;
  /** Bounding box of every changed pixel. All zeroes when nothing changed. */
  changedRegion: { x: number; y: number; width: number; height: number };
  diffPng: Buffer;
}

function decode(buffer: Buffer, label: string): PNG {
  try {
    return PNG.sync.read(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(
      `'${label}' is not a readable PNG: ${message}`,
      "A render killed by a timeout leaves a truncated file. Re-run the render that produced it.",
      "png_decode",
    );
  }
}

/** Compares two PNGs: one pass for the visual diff, one diff mask for the changed bounding box. */
export function comparePngs(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  threshold: number,
  beforeLabel: string,
  afterLabel: string,
): CompareResult {
  const beforeSize = readPngSize(beforeBuffer, beforeLabel);
  const afterSize = readPngSize(afterBuffer, afterLabel);

  if (beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height) {
    throw new ToolInputError(
      `'${beforeLabel}' is ${beforeSize.width}x${beforeSize.height} and '${afterLabel}' is `
      + `${afterSize.width}x${afterSize.height}, so they cannot be compared pixel for pixel.`,
      "Re-render both at the same width. If you changed an SVG's viewBox, the output height "
      + "changed with it - that is expected, and it means a pixel diff is the wrong check for "
      + "this edit. Look at the two images instead.",
      "dimension_mismatch",
    );
  }

  const totalPixels = beforeSize.width * beforeSize.height;
  if (totalPixels > MAX_RASTER_PIXELS) {
    throw new ToolInputError(
      `Comparing two ${beforeSize.width}x${beforeSize.height} images means decoding `
      + `${totalPixels} pixels each, and the limit is ${MAX_RASTER_PIXELS}.`,
      "Re-render both at a smaller width. At 4 bytes per pixel a pair this size would "
      + "exhaust the heap and take the server down with it.",
      "raster_budget",
    );
  }

  const before = decode(beforeBuffer, beforeLabel);
  const after = decode(afterBuffer, afterLabel);
  const { width, height } = beforeSize;

  const visual = new PNG({ width, height });
  const changedPixels = pixelmatch(before.data, after.data, visual.data, width, height, { threshold });

  const mask = new PNG({ width, height });
  pixelmatch(before.data, after.data, mask.data, width, height, { threshold, diffMask: true });

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask.data[((y * width) + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const changedRegion = maxX === -1
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  return {
    identical: changedPixels === 0,
    changedPixels,
    totalPixels,
    changedFraction: changedPixels / totalPixels,
    width,
    height,
    changedRegion,
    diffPng: PNG.sync.write(visual),
  };
}

// Pure-Node zip reader (stored and deflate only, no zip64) shared by the bundle tests and scripts.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Parse the central directory.
 *
 * @param {Buffer|string} source zip bytes, or a path to the zip
 * @returns {{name: string, method: number, compSize: number, uncompSize: number, localOffset: number}[]}
 */
export function readZipEntries(source) {
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("not a zip: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompress one entry out of the zip's bytes.
 *
 * @param {Buffer} buf zip bytes
 * @param {{name: string, method: number, compSize: number, localOffset: number}} e
 * @returns {Buffer}
 */
export function readEntry(buf, e) {
  if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) throw new Error(`corrupt local header for ${e.name}`);
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}

/**
 * Extract every file into destDir, rejecting entries that escape it.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {number} how many files were written
 */
export function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const entries = readZipEntries(buf);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const dest = path.resolve(root, e.name);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`zip entry escapes the destination directory: ${e.name}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readEntry(buf, e));
    written++;
  }
  return written;
}

// Shared by the service tests: a fake render runner and an in-memory client that carries verified claims.
// A helper module, not a test file, so it is in neither test list in package.json.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: length, type, data, and the CRC-32 of type and data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A 1x1 grayscale PNG, without its padding chunk. */
const PNG_HEAD = (() => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth; colour type, compression, filter and interlace stay 0
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0])))]);
})();
const PNG_END = chunk("IEND", Buffer.alloc(0));
const PAD_KEYWORD = Buffer.from("pad\0", "latin1");
/** The smallest PNG `makePng` can build: the 1x1 image and an empty tEXt chunk. */
const MIN_PNG_BYTES = PNG_HEAD.length + 12 + PAD_KEYWORD.length + PNG_END.length;

/** A valid PNG of exactly `bytes` bytes, padded in a tEXt chunk. */
export function makePng(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < MIN_PNG_BYTES) {
    throw new RangeError(`makePng: bytes must be an integer >= ${MIN_PNG_BYTES}, got ${bytes}`);
  }
  const filler = Buffer.alloc(bytes - MIN_PNG_BYTES, 0x61); // "a", valid Latin-1 text
  const png = Buffer.concat([PNG_HEAD, chunk("tEXt", Buffer.concat([PAD_KEYWORD, filler])), PNG_END]);
  if (png.length !== bytes) throw new Error(`makePng built ${png.length} bytes, not ${bytes}`);
  return png;
}

/** The positional output path in a `remotion still` argv: the third argument after "still". */
function outputOf(args) {
  const at = args.indexOf("still");
  if (at < 0 || at + 3 >= args.length) throw new Error("fakeRun: no `still <source> <composition> <output>` in argv");
  return args[at + 3];
}

/**
 * A stand-in for `runRenderProcess` that spawns nothing.
 * - `onCall(file, args, options)` runs first, while the work dir and its props file exist.
 * - `throwError` (an Error or a message) makes the call reject, as a spawn failure does.
 * - `hold`, a promise, is awaited before the result settles.
 * - Unless `noFile`, it writes a valid PNG of exactly `pngBytes` bytes to `<cwd>/<output argv>`.
 * - The result carries `exitCode` (default 0), `signal` (default null), `timedOut`, `aborted` and `outputTail`, and
 *   `cleanup` (default: a promise of a verified report).
 */
export function fakeRun(opts = {}) {
  const {
    pngBytes = 256, hold, timedOut = false, aborted = false, exitCode = 0, signal = null, outputTail = "",
    throwError, noFile = false, onCall,
    cleanup = Promise.resolve({ verified: true, survivors: [] }),
  } = opts;
  return async (file, args, options) => {
    onCall?.(file, args, options);
    if (throwError !== undefined) throw throwError instanceof Error ? throwError : new Error(String(throwError));
    if (hold !== undefined) await hold;
    if (!noFile) fs.writeFileSync(path.join(options.cwd, outputOf(args)), makePng(pngBytes));
    return { exitCode, signal, timedOut, aborted, outputTail, cleanup };
  };
}

/**
 * A connected SDK `Client` whose every message reaches `server` with `authInfo` holding `claims`, as the HTTP
 * handler sets it after verifying the identity header. `InMemoryTransport.send` forwards `options.authInfo` to the
 * receiving side's `extra.authInfo`.
 */
export async function connectWithClaims(server, claims) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const authInfo = { token: "", clientId: claims.principal, scopes: [], extra: { claims } };
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, { ...options, authInfo });
  await server.connect(serverTransport);
  const client = new Client({ name: "service-harness", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

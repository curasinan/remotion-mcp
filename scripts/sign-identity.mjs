#!/usr/bin/env node
// Test signer for the gateway identity header (docs/CONTRACT-gateway.md).
//
//   IDENTITY_HMAC_KEY=<base64url key> node scripts/sign-identity.mjs <claims.json> <body-file>
//
// Prints the X-Render-Identity value for the body file's exact bytes. body_sha256 is always
// computed from the body file. The key comes from the environment only and is never printed.
// Signs with dist-service/, so run `npm run build:service` first.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function die(message) {
  console.error(`sign-identity: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 2) {
  die("usage: IDENTITY_HMAC_KEY=<base64url key> node scripts/sign-identity.mjs <claims.json> <body-file>");
}
const [claimsPath, bodyPath] = args;

const encoded = process.env.IDENTITY_HMAC_KEY;
if (!encoded) die("IDENTITY_HMAC_KEY is not set. Put the key, base64url-encoded, in the environment.");
const key = Buffer.from(encoded, "base64url");
if (!/^[A-Za-z0-9_-]+$/.test(encoded) || key.toString("base64url") !== encoded) {
  die("IDENTITY_HMAC_KEY is not unpadded base64url.");
}
if (key.length < 32) die(`IDENTITY_HMAC_KEY decodes to ${key.length} bytes; it must be at least 32.`);

let claims;
try {
  claims = JSON.parse(fs.readFileSync(claimsPath, "utf8"));
} catch (err) {
  die(`cannot read ${claimsPath} as JSON: ${err.message}`);
}
if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
  die(`${claimsPath} must hold a JSON object of claims.`);
}

let body;
try {
  body = fs.readFileSync(bodyPath);
} catch (err) {
  die(`cannot read ${bodyPath}: ${err.message}`);
}
const bodySha256 = createHash("sha256").update(body).digest("hex");
if (claims.body_sha256 !== undefined && claims.body_sha256 !== bodySha256) {
  console.error(`sign-identity: replacing the claims file's body_sha256 with the hash of ${bodyPath}.`);
}
claims.body_sha256 = bodySha256;

const entry = path.join(import.meta.dirname, "..", "dist-service", "service", "identity.js");
if (!fs.existsSync(entry)) die("dist-service/ is not built. Run `npm run build:service` first.");
// pathToFileURL, not a bare path: import() of a Windows absolute path throws.
const { signIdentity } = await import(pathToFileURL(entry).href);
process.stdout.write(`${signIdentity(claims, key)}\n`);

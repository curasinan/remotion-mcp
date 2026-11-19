/**
 * The image's Docker HEALTHCHECK (design 5.2, 10): `GET /mcp` to the service on 127.0.0.1, which a live service
 * answers with 405 and never audits. It exits 0 on that 405 and 1 on anything else: another status, a refused or
 * failed connection, or no answer within 3 s.
 *
 * A second entry of tsconfig.service.json, never imported by index.ts: importing it would run the probe. It imports
 * only node:http, so it loads nothing of the service.
 */

import http from "node:http";

/** The whole request, connection included, must finish within this. */
const TIMEOUT_MS = 3_000;
/** The status the service answers a GET on its one route with. */
const ALIVE = 405;

// As the service's own configuration reads it: unset or empty means 8080.
const port = process.env.SERVICE_PORT === undefined || process.env.SERVICE_PORT === ""
  ? "8080" : process.env.SERVICE_PORT;

const req = http.get(`http://127.0.0.1:${port}/mcp`, { agent: false, signal: AbortSignal.timeout(TIMEOUT_MS) },
  (res) => {
    process.exit(res.statusCode === ALIVE ? 0 : 1);
  });
// A refused connection, a bad port, or the timeout's abort.
req.on("error", () => {
  process.exit(1);
});

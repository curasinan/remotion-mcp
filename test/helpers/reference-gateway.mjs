// A minimal gateway for test/check-gateway.test.mjs. With no faults it does what docs/CONTRACT-gateway.md asks of the
// owner's gateway; each fault breaks one obligation, or differs in a way the contract allows, so the tests can show
// scripts/check-gateway.mjs judges it right. A helper module, not a test file, so it is in neither test list in
// package.json.
//
// Independent of the implementation on purpose, like test/helpers/signing-client.mjs: it signs with node:crypto alone.
import { createHash, createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const REQUEST_ID_META_KEY = "io.github.curasinan/request_id";
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "content-length"];
/** Tools a gateway with a per-caller allow-list might hide: the two the service does not implement yet. */
const HIDDEN_TOOLS = ["render_video_start", "render_job_status"];

const b64url = (text) => Buffer.from(text, "utf8").toString("base64url");
const toolOf = (message) => (message.method === "tools/call" ? message.params?.name : message.method);

/**
 * Starts the gateway on 127.0.0.1. `setUpstream(url)` points it at a deployment. Faults, each off by default.
 * Signing: paddedClaims (keeps = padding, signed with it), hashCallerBody (body_sha256 of the caller's body, before
 * _meta), keyAsText (the key's base64url text as the HMAC key), signJson (signs the claims JSON), clockOffsetS (added to
 * iat), ttlS (exp - iat).
 * request_id: reuseRequestId (always the same), requestIdFromJsonRpcId (derived from the caller's id), adoptCallerRequestId
 * (the caller's own _meta id when it sent one), callerMetaWins (the caller's _meta spread over the injected key).
 * Messages: noMetaOnNotifications, answerNotifications (202 for a notification, never forwarded).
 * Headers: accept, contentType, protocolVersion (send this value), duplicateContentType, duplicateOwnIdentity,
 * passCallerIdentity (the caller's X-Render-Identity beside its own), substituteCallerIdentity (the caller's instead of
 * its own), rejectCallerIdentity (400 to a caller that sends one), forwardCallerHeaders (every caller header),
 * renameCallerAuth (the caller's authorization as x-forwarded-authorization), appendCallerAuth (its own authorization,
 * then the caller's).
 * Sessions: sessionful (gives callers an mcp-session-id on initialize and requires it after).
 * Answers: buffer (holds the whole answer), ownHeartbeat (writes its own SSE comment, the text heartbeatText, while it
 * holds the answer), jsonAnswer (sends JSON headers at once, then the SSE answer's message as one JSON body),
 * crLineEndings (re-frames SSE with lone CRs), filterTools (hides two tools from tools/list), timeoutMs (gives up on the
 * upstream request after this long).
 * Credentials: credentialInMeta (copies the caller's authorization into _meta), credentialInQuery (into the upstream
 * URL), principalFromCaller (signs it as the principal).
 * Copies: hedge (sends each signed request a second time, same header and bytes), refuseIdentityJsonRpc (answers a
 * caller that sends X-Render-Identity with a JSON-RPC error over HTTP 200).
 * Disconnects: keepUpstreamOnDisconnect (never closes it), detectDisconnectOnWrite (closes it only when an upstream
 * chunk arrives for a caller that has gone).
 * Bodies: escapeSlashes (writes / as \/ in the forwarded JSON, as PHP's json_encode does), truncateToCallerLength
 * (forwards only the caller's length of the rewritten body, as a stale Content-Length makes a deployment read).
 * Answers to the caller: dropContentType (streams the answer without its content-type), resetInitialize (resets the
 * caller's connection once the deployment has answered initialize), deferNotificationsMs (answers a notification 202
 * at once and forwards it this much later).
 * Traffic of its own: healthCheck ({ method, path }, sent to the deployment every 50 ms).
 */
export async function startReferenceGateway({ key, audience, principal = "backend-1", tenant = "tenant-1",
  faults = {} }) {
  let upstream;
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => forward(req, res, Buffer.concat(chunks)));
  });
  let health;
  if (faults.healthCheck !== undefined) {
    health = setInterval(() => {
      if (upstream === undefined) return;
      const target = new URL(faults.healthCheck.path ?? "/mcp", upstream);
      http.request(target, { method: faults.healthCheck.method }, (r) => r.resume()).on("error", () => {}).end();
    }, 50);
  }

  function sign(claims) {
    const json = JSON.stringify(claims);
    let claimsPart = b64url(json);
    if (faults.paddedClaims) {
      // Pad the JSON until base64 needs = padding, then keep it, as a padded encoder would.
      let padded = json;
      while (Buffer.byteLength(padded) % 3 === 0) padded = JSON.stringify({ ...claims, pad: padded.length });
      claimsPart = Buffer.from(padded, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    }
    const hmacKey = faults.keyAsText ? Buffer.from(key.toString("base64url"), "utf8") : key;
    const signed = faults.signJson ? Buffer.from(claimsPart, "base64url").toString("utf8") : claimsPart;
    return `${claimsPart}.${createHmac("sha256", hmacKey).update(signed).digest("base64url")}`;
  }

  function requestIdFor(message) {
    if (faults.reuseRequestId) return "the-same-id";
    if (faults.requestIdFromJsonRpcId) return `rpc-${String(message.id)}`;
    const callers = message.params?._meta?.[REQUEST_ID_META_KEY];
    if (faults.adoptCallerRequestId && typeof callers === "string") return callers;
    return randomUUID();
  }

  function forward(req, res, callerBody, deferred = false) {
    const message = JSON.parse(callerBody.toString("utf8"));
    const isNotification = message.id === undefined && !deferred;
    if (faults.answerNotifications && isNotification) return res.writeHead(202).end();
    if (faults.deferNotificationsMs !== undefined && isNotification) {
      res.writeHead(202).end();
      setTimeout(() => forward(req, { writeHead: () => ({ end: () => {} }), on: () => {}, flushHeaders: () => {},
        write: () => {}, end: () => {}, headersSent: false, writableFinished: true }, callerBody, true),
      faults.deferNotificationsMs);
      return undefined;
    }
    if (faults.rejectCallerIdentity && req.headers["x-render-identity"] !== undefined) return res.writeHead(400).end();
    if (faults.refuseIdentityJsonRpc && req.headers["x-render-identity"] !== undefined) {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0",
        id: message.id, error: { code: -32600, message: "X-Render-Identity may not be sent by callers" } }));
    }
    if (faults.sessionful && message.method !== "initialize" && !sessions.has(req.headers["mcp-session-id"])) {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null,
        error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" } }));
    }
    const requestId = requestIdFor(message);
    if (!(faults.noMetaOnNotifications && isNotification)) {
      const params = message.params ?? {};
      const callerMeta = params._meta ?? {};
      message.params = { ...params, _meta: faults.callerMetaWins
        ? { [REQUEST_ID_META_KEY]: requestId, ...callerMeta } : { ...callerMeta, [REQUEST_ID_META_KEY]: requestId } };
      if (faults.credentialInMeta) message.params._meta["io.github.curasinan/caller_authorization"] = req.headers.authorization;
    }
    const json = JSON.stringify(message);
    const body = Buffer.from(faults.escapeSlashes ? json.replaceAll("/", "\\/") : json, "utf8");
    const iat = Math.floor(Date.now() / 1000) + (faults.clockOffsetS ?? 0);
    const claims = { v: 1, request_id: requestId, principal: faults.principalFromCaller ? req.headers.authorization
      : principal, tenant, aud: audience, tool: toolOf(message),
      body_sha256: createHash("sha256").update(faults.hashCallerBody ? callerBody : body).digest("hex"),
      iat, exp: iat + (faults.ttlS ?? 60) };

    const headers = faults.forwardCallerHeaders ? { ...req.headers } : {};
    delete headers.host;
    delete headers["content-length"];
    headers["content-type"] = faults.duplicateContentType ? ["application/json", "application/json"]
      : faults.contentType ?? "application/json";
    headers.accept = faults.accept ?? "application/json, text/event-stream";
    const version = faults.protocolVersion ?? req.headers["mcp-protocol-version"];
    if (version !== undefined) headers["mcp-protocol-version"] = version;
    else delete headers["mcp-protocol-version"];
    delete headers["mcp-session-id"];
    const ours = sign(claims);
    const callerIdentity = req.headers["x-render-identity"];
    headers["x-render-identity"] = faults.duplicateOwnIdentity ? [ours, ours]
      : faults.passCallerIdentity && callerIdentity !== undefined ? [ours, callerIdentity]
        : faults.substituteCallerIdentity && callerIdentity !== undefined ? callerIdentity : ours;
    if (faults.renameCallerAuth && req.headers.authorization !== undefined) {
      headers["x-forwarded-authorization"] = req.headers.authorization;
    }
    if (faults.appendCallerAuth && req.headers.authorization !== undefined) {
      headers.authorization = ["Bearer the-gateway-own-credential", req.headers.authorization];
    }

    const target = faults.credentialInQuery
      ? `${upstream}?access_token=${encodeURIComponent(String(req.headers.authorization).split(" ").pop())}` : upstream;
    const upReq = http.request(target, { method: "POST", headers });
    if (faults.hedge) {
      // A copy of the request, same header and bytes, as a hedging proxy sends; its answer is dropped.
      setTimeout(() => http.request(target, { method: "POST", headers }, (copy) => copy.resume())
        .on("error", () => {}).end(body), 30);
    }
    let timer;
    if (faults.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        upReq.destroy();
        if (!res.headersSent) res.writeHead(504).end();
        else res.destroy();
      }, faults.timeoutMs);
    }
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished && !faults.keepUpstreamOnDisconnect && !faults.detectDisconnectOnWrite) upReq.destroy();
    });
    upReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    upReq.on("response", (upRes) => {
      const out = Object.fromEntries(Object.entries(upRes.headers).filter(([name]) => !HOP_BY_HOP.includes(name)));
      if (faults.sessionful && message.method === "initialize") {
        const session = `s-${randomUUID()}`;
        sessions.add(session);
        out["mcp-session-id"] = session;
      }
      if (faults.resetInitialize && message.method === "initialize") {
        // The deployment's whole answer arrives, and the caller's connection is reset before any of it is sent.
        upRes.resume();
        upRes.on("end", () => res.destroy());
        return;
      }
      const filter = faults.filterTools && message.method === "tools/list";
      if (faults.buffer || faults.ownHeartbeat || faults.jsonAnswer || filter) {
        const parts = [];
        let heartbeat;
        if (faults.ownHeartbeat) {
          res.writeHead(upRes.statusCode, out);
          res.flushHeaders();
          heartbeat = setInterval(() => res.write(`: ${faults.heartbeatText ?? "gateway heartbeat"}\n\n`), 100);
          // A caller that disconnects destroys the upstream request, so its answer never ends: stop here too.
          res.on("close", () => clearInterval(heartbeat));
        }
        if (faults.jsonAnswer) {
          res.writeHead(upRes.statusCode, { ...out, "content-type": "application/json" });
          res.flushHeaders();
        }
        upRes.on("data", (chunk) => parts.push(chunk));
        upRes.on("end", () => {
          clearTimeout(timer);
          clearInterval(heartbeat);
          let answer = Buffer.concat(parts);
          if (faults.jsonAnswer) {
            const data = /^data: (.*)$/m.exec(answer.toString("utf8"));
            answer = Buffer.from(data ? data[1] : "", "utf8");
          }
          if (filter) {
            answer = Buffer.from(answer.toString("utf8").replace(/^data: (.*)$/m, (_line, json) => {
              const reply = JSON.parse(json);
              reply.result.tools = reply.result.tools.filter((tool) => !HIDDEN_TOOLS.includes(tool.name));
              return `data: ${JSON.stringify(reply)}`;
            }), "utf8");
          }
          if (!res.headersSent) res.writeHead(upRes.statusCode, out);
          res.end(answer);
        });
        return;
      }
      if (faults.dropContentType) delete out["content-type"];
      res.writeHead(upRes.statusCode, out);
      res.flushHeaders();
      upRes.on("data", (chunk) => {
        if (faults.detectDisconnectOnWrite && res.destroyed) return upReq.destroy();
        res.write(faults.crLineEndings ? Buffer.from(chunk.toString("utf8").replace(/\r?\n/g, "\r"), "utf8") : chunk);
      });
      upRes.on("end", () => {
        clearTimeout(timer);
        res.end();
      });
    });
    upReq.end(faults.truncateToCallerLength ? body.subarray(0, callerBody.length) : body);
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/route/mcp`,
    setUpstream: (url) => {
      upstream = url;
    },
    close: () => new Promise((resolve) => {
      clearInterval(health);
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

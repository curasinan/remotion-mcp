# Gateway identity contract, v1

This is the contract between the owner's gateway and a deployment of the
service profile. A deployment trusts a request on its service port only when
its `X-Render-Identity` header verifies, whatever network the request arrived
from. The gateway signs that header, one deployment at a time.

The header guards that one port, so the network still matters. While each
render runs, the Remotion CLI the service starts listens on every interface,
on a port from 3000 to 3100, and checks no identity: it serves the pack and
downloads any URL it is asked to. A deployment must therefore admit only its
TLS proxy, and only to the service port
([`DEPLOY.md`](DEPLOY.md#ingress-only-your-proxy-only-service_port)).

| Piece | Where |
| --- | --- |
| Design | [design §5.2 and §5.3](superpowers/specs/2026-10-26-service-profile-v2-design.md) |
| Verifier | `src/service/identity.ts` (`verifyRequest`) |
| Test signer | `scripts/sign-identity.mjs` |
| Test vectors | `test/vectors/identity-v1.json`, written by `scripts/make-identity-vectors.mjs` |
| Tests | `test/identity.test.mjs` runs every vector against the verifier |

## The header

```
X-Render-Identity: <claims>.<signature>

claims    = base64url(the claims object as UTF-8 JSON)
signature = base64url(HMAC-SHA256(key, claims))
```

- **base64url** is RFC 4648 §5: `A-Z a-z 0-9 - _`, with no padding and no
  whitespace. The header has exactly one dot. A part with `=` padding or any
  other character is `malformed`, even when the HMAC was computed over that
  padded text.
- **The signature is always 43 characters**, the canonical encoding of the
  32-byte digest. A standard encoder produces it once its padding is off:
  Node's `base64url`, Go's `base64.RawURLEncoding`, Java's
  `Base64.getUrlEncoder().withoutPadding()`, or Python's
  `base64.urlsafe_b64encode(d).rstrip(b'=')`. Their padded defaults (Go's
  `base64.URLEncoding`, Java's `Base64.getUrlEncoder()`, Python's
  `urlsafe_b64encode`) pad the signature to 44 characters, and the claims part
  whenever the claims JSON's byte length is not a multiple of 3. A part with
  `=` is `malformed`, so strip the `=` from the claims part before you sign
  it, and from the signature. A hand-made spelling whose last character
  carries non-zero spare bits is `malformed` too, although it decodes to the
  same bytes.
- **The HMAC covers the claims part exactly as sent,** the base64url string
  itself, not the decoded JSON. There is no canonical JSON step. Serialise the
  claims however you like, then sign the string you send. Re-encoding the
  claims after signing breaks the signature.

## The claims

All nine fields are required, with these JSON types. Fields beyond these nine
are ignored.

| Field | Type | Rule |
| --- | --- | --- |
| `v` | integer | contract version, `1` |
| `request_id` | string | minted by the gateway, unique per request; must equal the body's `params._meta["io.github.curasinan/request_id"]` |
| `principal` | string | the gateway's key id for the caller |
| `tenant` | string | a tenant id the owner granted |
| `aud` | string | the deployment id; must equal the deployment's audience |
| `tool` | string | `params.name` for `tools/call`, otherwise the JSON-RPC `method` |
| `body_sha256` | string | lowercase hex SHA-256 of the exact body bytes forwarded |
| `iat` | integer | seconds since the epoch, when the header was signed |
| `exp` | integer | seconds since the epoch; `exp - iat` is at most 120 |

`iat` and `exp` must be whole numbers: a fraction, a string or `null` is
`malformed`. The tenant comes from the signed claims only. A tenant or team
field in `_meta` or in tool arguments has no effect (design §5.3).

## Check order and refusals

The verifier runs these checks in this order, and reports the first that
fails. `now` is the deployment's clock in whole seconds, `skew` is 30 s by
default, and `startedAt` is when the deployment's process started.

| # | Check | Refusal | Status |
| --- | --- | --- | --- |
| 1 | the header is present | `missing` | 401 |
| 2 | one dot; both parts base64url; a 43-character canonical signature; the claims decode to a JSON object with the nine typed fields | `malformed` | 401 |
| 3 | `v` is `1` | `unsupported_version` | 401 |
| 4 | the signature matches, compared with `timingSafeEqual` on the two 32-byte digests | `bad_signature` | 401 |
| 5 | `aud` equals the deployment's audience | `wrong_audience` | 401 |
| 6 | `now >= iat - skew` | `not_yet_valid` | 401 |
| 7 | `now <= exp + skew` | `expired` | 401 |
| 8 | `exp - iat <= 120` | `ttl_too_long` | 401 |
| 9 | `iat >= startedAt - skew` | `signed_before_start` | 401 |
| 10 | `body_sha256` matches the body bytes | `body_mismatch` | 401 |
| 11 | the body parses as JSON | `parse` | 400 |
| 12 | the body is one message, not an array | `batch` | 400 |
| 13 | `tool` matches the message | `tool_mismatch` | 401 |
| 14 | `request_id` matches the message's `_meta` id | `request_id_mismatch` | 401 |
| 15 | `request_id` has not been seen | `replayed` | 401 |

Checks 1 to 10 run on the raw bytes, before the body is parsed. A 401 carries
no detail (design §5.2): the reason names are the verifier's results, and what
the vectors declare.

**Every time boundary is inclusive on the accepting side.** A header signed
30 s in the future passes and one signed 31 s ahead is `not_yet_valid`. One
that expired 30 s ago passes and one that expired 31 s ago is `expired`. One
signed exactly at `startedAt - skew` passes.

**The start-time rule** exists because the replay set lives in memory. Without
it, a restart would reopen the replay window. The cost is that requests signed
just before a restart are refused for about one skew interval. The rule does
not close the window entirely: the new process accepts any header signed no
earlier than `startedAt - skew`, so a request the old process accepted in its
last seconds can be accepted once more when the restart is quick.

**Within one process the service's time never moves backward.** The verifier
judges every request at the latest clock reading it has seen, so if the
deployment's clock steps back, `now` stays at that reading until the clock
passes it again. A backward step larger than skew can therefore refuse
requests (`not_yet_valid` or `expired`) until the clock catches up. It never
re-admits an id the replay set has already dropped.

### Before the identity check

These outcomes come before check 1. Each answer has an empty body.

- **Only `POST /mcp` is served.** The path is compared as sent, and a query
  string is ignored.
- **Any other path gets 404,** whatever the method.
- **Any other method on `/mcp` gets 405** with `Allow: POST`. The SDK
  client's own `GET` stream gets it too, and the SDK client tolerates it.
  Neither the 404 nor the 405 is audited. The image's healthcheck relies on
  that 405.
- **A body over 262 144 bytes gets 413,** counted as the bytes arrive, so a
  chunked body is capped too. It is audited as `body_too_large`. The service
  reads and drops the rest of the body before it answers, unless more than
  524 288 bytes arrive in all: then the 413 goes out at once, with
  `Connection: close`. Keep forwarded bodies under the cap.
- **A client that disconnects before its body ends gets no answer.**

A 400 or a 401 from the fifteen checks is audited too, with the reason as its
category. A request that passes every check meets the SDK's own transport
checks next ([below](#what-the-gateway-must-do)). An unexpected failure is a
500 with an empty body, audited as `internal`, or a cut connection once the
answer has begun.

## Tool errors

The service's own tool errors are a tool result with `isError: true`, the
text `<category>: <fixed message>`, and `structuredContent: { category }`.
For `invalid_props` the text ends with ` at ` and a JSON array of pointers,
which `structuredContent.paths` also holds. These errors never carry a path,
a local-dev tool name, CLI output, a raw zod or ajv message, or a value the
caller sent.

One kind of error is not the service's own. The plan records it as deviation
2 (`docs/superpowers/plans/final_script.md:42-43`), which the owner approved
with the plan:

> 2. **The SDK's own argument-validation errors pass through unchanged.** Examples are a non-string `template_id` or a non-object `props`. These messages describe the caller's own arguments. Every error this code raises still follows design §5.5.
>    - The same goes for the SDK's `Tool <name> not found` reply to an unknown tool (`server/mcp.js:104`). It echoes back only the caller's own `params.name`.

Such an error is a tool result with `isError: true` too, but its text is the
SDK's, such as
`MCP error -32602: Input validation error: Invalid arguments for tool render_still: ...`
or `MCP error -32602: Tool viz_render_html not found`, and it has no
`structuredContent` (SDK 1.30.0, `dist/esm/server/mcp.js:141` and
`:152-162`). A backend that dispatches on `structuredContent.category` finds
none on it.

## The replay set

- **Entry.** A `request_id` enters the set only after checks 1 to 14 pass. A
  refused request does not use up its id, so a corrected request may reuse it.
- **Lifetime.** An id stays in the set while `now <= exp + skew`, exactly as
  long as its header could still verify.
- **Retries.** An accepted request does use up its id. A retry of an accepted
  request needs a new `request_id` and a new signature.

## Deployments

A deployment runs **one replica per `aud`**, rolled out with **Recreate**,
never with surge. The replay set belongs to one process. Two processes behind
one `aud` would each accept the same request once, and a surge rollout runs
the old and the new process side by side.

Each deployment has its own HMAC key, held by the gateway and read by the
deployment from its environment only. A deployment's operator therefore
cannot forge requests to another deployment.

## What the gateway must do

These transport obligations are required (design §5.3):

- Inject `_meta` into every message it forwards, `initialize` and
  notifications included, and sign the rewritten bytes.
- Forward the body bytes unchanged after signing.
- Forward `accept` with both `application/json` and `text/event-stream`.
- Forward `content-type: application/json`.
- Send no `mcp-protocol-version`, or one the service's SDK supports.
- Not buffer SSE.
- Use upstream timeouts of at least 60 s.
- Close the upstream connection when its caller disconnects.

## The test signer

```sh
npm run build:service
IDENTITY_HMAC_KEY=<base64url key> node scripts/sign-identity.mjs claims.json body.json
```

It prints the header for the body file's exact bytes. It always computes
`body_sha256` from the body file, and says so on stderr when that replaces a
different value in the claims file. It reads the key from the environment
only, as unpadded base64url of at least 32 bytes, and never prints it. It
signs any JSON object, so it can also make headers the service refuses.

## Checking a gateway against the vectors

`test/vectors/identity-v1.json` holds the exact bytes of every case. Running
`node scripts/make-identity-vectors.mjs test/vectors/identity-v1.json`
rewrites it byte for byte, and the test suite fails when the committed file
differs from the script's output. The script imports nothing from the
implementation, and every expected verdict is declared by hand in it.

Besides one or more cases per verdict, the vectors pin the encoding rules
above (a padded claims part signed over the padded text, and a non-canonical
signature spelling) and the check order. For every two checks that one request
can fail together, a vector breaks both and expects the earlier, or a chain of
such vectors does: one that orders 3 before 4 and one that orders 4 before 5
together order 3 before 5. A vector that breaks more than two checks expects
the first of them. Only two kinds of pair never fail together: `missing` and a
check that reads the claims, and `parse` and checks 12 to 14, which read the
parsed message. `test/identity.test.mjs` checks the file against this claim.

**The key** is the published throwaway `Buffer.alloc(32, 7)`, 32 bytes of
`0x07`, given in the file as `key_base64url`. It protects nothing. Never
configure it on a deployment or a gateway that serves traffic. A deployment
refuses to start with the published test-vector key as either
`IDENTITY_HMAC_KEY` or `AUDIT_HMAC_KEY`. It also refuses an
`AUDIT_HMAC_KEY` equal to its `IDENTITY_HMAC_KEY`. Both checks compare the
decoded keys as HMAC-SHA256 uses them: zero-padded to 64 bytes, after a key
longer than 64 bytes is first replaced by its SHA-256
(`src/service/config.ts:71`). Each message names the variable, never the
value.

**The record shape:**

```jsonc
{
  "_comment": "...",
  "key_base64url": "BwcH...",
  "vectors": [
    {
      "name": "replayed: the same request twice",
      "options": { "audience": "dep-a", "nowS": 1800000000, "skewS": 30, "maxTtlS": 120, "startedAtS": 1799999400 },
      "steps": [
        { "header": "<X-Render-Identity, or null for no header>",
          "body_base64": "<standard base64 of the exact body bytes>",
          "expected": { "ok": true } },
        { "header": "...", "body_base64": "...",
          "expected": { "ok": false, "status": 401, "reason": "replayed" } }
      ]
    }
  ]
}
```

**Replay semantics.** Each vector starts with a fresh, empty replay set. Its
steps run in order against that set, all at the vector's `nowS`. A replay
vector has two steps, the second repeating the first. One vector has three
steps and shows that a refused request does not enter the set. `nowS` is
fixed at 1 800 000 000 (2027-01-15T08:00:00Z), so the vectors never age.

**What to check.**

1. **Signing.** Every vector whose expected verdict is `ok` carries a header
   signed with the vector key. Run your gateway's HMAC-and-encode step over
   that header's claims part, exactly as it appears, with the vector key. The
   result must equal the signature part byte for byte.
2. **Body hashing.** For the same vectors, hash the bytes of `body_base64`
   with your gateway's routine. The result must equal the claims'
   `body_sha256`. Most bodies contain non-ASCII text, so hashing a re-encoded
   string instead of the bytes fails.
3. **Your signer against the reference verifier.** Sign your own requests
   with the vector key, and run them
   through the reference verifier with a vector's `options`:
   `verifyRequest` in `dist-service/service/identity.js`, after
   `npm run build:service`. A port of the verifier must reproduce every
   step's `expected`.
4. **Transport.** The vectors cannot check the obligations above. Check
   those against a test deployment.

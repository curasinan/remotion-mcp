# Deploying the service profile

The service profile is an MCP server over HTTP that renders a deployment's
own template pack to PNGs, for requests signed by the owner's gateway
([design](superpowers/specs/2026-10-26-service-profile-v2-design.md)). A
deployment is one container: the service image, plus your pack, built into
your own derived image.

| You need | Where |
| --- | --- |
| The identity contract your gateway signs to | [`CONTRACT-gateway.md`](CONTRACT-gateway.md) |
| The vectors your gateway is checked against | [`test/vectors/identity-v1.json`](../test/vectors/identity-v1.json) ([how](CONTRACT-gateway.md#checking-a-gateway-against-the-vectors)) |
| How to author and build a pack | [`CONTRACT-pack.md`](CONTRACT-pack.md) |
| The derived-image recipe | [`fixtures/pack/Dockerfile.derived`](../fixtures/pack/Dockerfile.derived) and its [`.dockerignore`](../fixtures/pack/.dockerignore) |
| What CI proves about the images | [`CI.md`](CI.md#the-image-job-the-images-proved-on-linux) |

**Remotion's licence is UNVERIFIED in this repository.** Remotion ships under
its own licence (its packages say `SEE LICENSE IN LICENSE.md`), separate from
this repository's Apache-2.0. Whether a deployment may run automated renders
under it has not been verified here; the owner is asking Remotion for written
confirmation. Read Remotion's licence yourself before you deploy.

## The images

**The service image** (`Dockerfile.service`) is `node:22-bookworm-slim`,
linux/amd64 only, never Alpine. It holds the compiled service, `tini` as PID
1, `setpriv`, Chrome Headless Shell's shared libraries and `fonts-noto-core`.
It has no package manager (no npm, npx, Yarn or corepack), no pack, no browser
and no key. It runs as `node` (uid 1000).

CI publishes it to `ghcr.io/curasinan/remotion-viz-service` once the owner
enables publishing (`.github/workflows/service-image-publish.yml`). Each
publish writes the image's digest to its job summary. Pin that digest, never a
tag.

**The first publish creates a private package.** GHCR makes a new package
private, and a package does not take its repository's visibility. The image's
`org.opencontainers.image.source` label links the package to this
repository. After the first publish, the owner sets the package's visibility
in its Package settings on GitHub. A package made public cannot be made
private again. Until it is public, the `FROM` of your derived build needs
`docker login ghcr.io` with a token that can read the package.

**No check has run against a published digest.** The publish job rebuilds
the image on each push to `main`, from the floating `node:22-bookworm-slim`
base as it is that day. CI's `image` job proves an image it builds itself
from the same commit, which may sit on a different base than the published
one. Before you roll out, run this repository's proofs on the digest you pin,
and `scripts/image-checks.sh` against your own derived image
([below](#running-the-proofs-on-the-digest-you-pin)).

Until publishing is on, build it from this repository:

```sh
docker build --platform linux/amd64 -f Dockerfile.service -t remotion-viz-service:local .
```

**Your derived image** adds your pack. The recipe is
`fixtures/pack/Dockerfile.derived`:

1. Build your pack on Linux with `scripts/build-pack.mjs`
   ([`CONTRACT-pack.md`](CONTRACT-pack.md#building-a-pack)). Its output is
   `dist-pack/`: `pack-manifest.json`, `bundle/`, `package.json` and
   `package-lock.json`.
2. Copy `Dockerfile.derived` and `.dockerignore` from `fixtures/pack/` into
   the directory that holds `dist-pack/`.
3. Build with that directory as the context, pinning the service image by
   digest:

   ```sh
   docker build --platform linux/amd64 -f Dockerfile.derived \
     --build-arg SERVICE_IMAGE=ghcr.io/curasinan/remotion-viz-service@sha256:<digest> \
     -t <your image> .
   ```

What the recipe does:

- **A Linux pack stage.** `npm ci --omit=dev` installs the pack's own
  production dependencies, its `@remotion/cli` and `@remotion/renderer`
  among them, then `npx remotion browser ensure` downloads Remotion's pinned
  Chrome Headless Shell. `browser ensure` takes no destination, so the
  recipe moves the browser to `/pack/browser`, and `test -x` fails the build
  if Remotion's download layout changes. This stage needs the network, at
  build time only.
- **The final stage** is the service image plus `/pack`, with
  `PACK_DIR=/pack` and
  `BROWSER_EXECUTABLE=/pack/browser/chrome-headless-shell`. The service passes
  `--browser-executable` on every render, which is what prevents a download
  at run time. No environment variable disables one.
- **`.dockerignore`** is an allow-list. It excludes everything, then lets
  back in only `dist-pack/` and `Dockerfile.derived`. It then excludes
  `dist-pack/node_modules` again, only the one directly under `dist-pack/`,
  because the pack stage installs its own on Linux. So nothing else in that
  directory reaches the builder, which a remote builder would upload: not a
  `.env`, `.git/`, keys, your sources, a `node_modules` installed on the
  build host beside `dist-pack/` or directly in it, or a test render.

**Never put keys in a Dockerfile or an image.** Not as `ENV`, not as
`ARG`, not as a copied file. Keys reach the container in its environment at
run time, from your secret store.

## The environment

| Variable | Required | Default | Rule |
| --- | --- | --- | --- |
| `SERVICE_AUDIENCE` | yes | | This deployment's id: the `aud` your gateway signs. |
| `IDENTITY_HMAC_KEY` | yes | | The key your gateway signs this deployment's requests with. Unpadded base64url, at least 32 bytes. Never the published test-vector key (`Buffer.alloc(32, 7)`, in `test/vectors/identity-v1.json`). |
| `AUDIT_HMAC_KEY` | yes | | The key the audit log's hashes are made with. Unpadded base64url, at least 32 bytes. Its own key: the service refuses to start when it equals `IDENTITY_HMAC_KEY`, or when it is the published test-vector key. Both checks compare the decoded keys as HMAC-SHA256 uses them: zero-padded to 64 bytes, after a key longer than 64 bytes is first replaced by its SHA-256 (`src/service/config.ts:71`). So a key with zero bytes appended, or a long key's SHA-256, counts as the same key. |
| `SERVICE_PORT` | no | `8080` | A whole number, 1 to 65535 in a container. The service also accepts 0, a port the system picks, but the healthcheck would then probe port 0 and never report healthy. |
| `SERVICE_HOST` | no | `0.0.0.0` | Must accept connections on IPv4 `127.0.0.1`, where the healthcheck probes. `0.0.0.0` (the default) and `127.0.0.1` do. `::1`, or a `localhost` that resolves to `::1`, fails every probe. |
| `AUDIT_LOG_PATH` | no | `/var/log/remotion-viz/service-audit.jsonl` | An absolute path. Must open for appending, or the service refuses to start. |
| `RENDER_SLOTS` | no | `2` | Renders at once, 1 to 64. A request with no free slot gets `render_busy`; there is no queue. |
| `IDENTITY_SKEW_S` | no | `30` | Clock skew allowed between your gateway and this host, 0 to 120 seconds. |
| `RENDER_TEMP_ROOT` | no | `/tmp/remotion-viz-service` | Emptied at every start. Absolute, not a filesystem root, not a symbolic link, and never equal to, inside or containing `PACK_DIR` or the audit log's directory. |
| `PACK_DIR` | no | `/pack` | An absolute path. The derived image sets it; leave it. |
| `BROWSER_EXECUTABLE` | yes | set by the derived image | An absolute path. Leave it as the recipe sets it. |

An empty value counts as unset. A bad value stops the service at startup
with a message that names the variable and its rule, never its value, such as
`BROWSER_EXECUTABLE must be an absolute path`. Each path variable must be
absolute, because the service's startup checks resolve a path from its own
working directory, while each render's CLI runs in the render's work
directory.

`SERVICE_HOST` is the one variable the service does not check. A host it
cannot bind stops the service with Node's own listen error, such as
`getaddrinfo ENOTFOUND <host>`, which names the value and not the variable.

**Generate each key** on a trusted machine and store it in your secret
store:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Give the identity key to your gateway, as
[`CONTRACT-gateway.md`](CONTRACT-gateway.md#deployments) describes: one key
per deployment. Pass keys by name (`docker run -e IDENTITY_HMAC_KEY`, with
the value in the calling environment, or `--env-file` from a file outside any
repository), not as `-e NAME=value`, which puts the value in the host's
process list.

## Running it

**One replica per `SERVICE_AUDIENCE`, rolled out with Recreate.** The replay
set lives in one process. Two processes behind one `aud`, including the old
and the new one during a surge rollout, would each accept the same request
once.

**Restart policy `always`.** When the service cannot verify that a render's
processes are gone, it exits with code 70, and the restart takes every
leftover process down with the container. It exits 1 when a startup check
fails, naming the check, and 0 after a clean `SIGTERM`.

**A stop grace period of at least 20 s.** On `SIGTERM` the service stops
accepting connections, aborts every render and waits for their processes:
the kill's 5 s grace, its 10 s verification and a 2 s margin. A shorter grace
period cuts that short with a `SIGKILL`.

**A memory limit.** The container's memory limit is the outer backstop for
the memory the Remotion CLI and Chrome allocate, which the service bounds no
further than by capping a still's size (ADR-7). Without one, a runaway render
lands on the host's out-of-memory killer instead. When the limit is hit, the
kernel picks its victim by `oom_score`, so it may kill the service along with
the render. The restart policy then brings the service back, and the renders
in flight are lost. This repository has measured no figure: size the limit
for `RENDER_SLOTS` renders at once of your largest template, plus the service.

**Keep the image's entrypoint.** It starts `tini` as PID 1, which reaps a
render's orphaned processes. A Kubernetes `command:` or a
`docker run --entrypoint` that starts `node` directly makes the service PID 1,
and Node reaps only the children it spawned. A Chrome whose CLI died first
then stays a zombie, which the service's cleanup check counts as alive, so the
service exits 70 after such a render. Set neither for the service container.

| Runtime | Restart | Stop grace | Memory limit | One replica, Recreate |
| --- | --- | --- | --- | --- |
| `docker run` | `--restart always` | `--stop-timeout 20` | `--memory <size>` | one container per `aud` |
| Compose | `restart: always` | `stop_grace_period: 20s` | `mem_limit: <size>` | never `--scale` it |
| Kubernetes | `restartPolicy: Always` (the default) | `terminationGracePeriodSeconds: 20` | `resources.limits.memory` | `replicas: 1`, `strategy: { type: Recreate }` |

**The healthcheck** is the image's Docker `HEALTHCHECK`: `GET /mcp` on
`127.0.0.1:$SERVICE_PORT`, healthy only on the `405` a live service answers.
It is not audited. Kubernetes ignores Docker's `HEALTHCHECK`, so give the pod
an exec probe with the same command:
`["node", "dist-service/service/healthcheck.js"]`.

- **Use it as the readiness probe**, so the pod gets traffic only once the
  service answers.
- **Set `timeoutSeconds: 5` or more.** Each probe starts Node, then waits up
  to 3 s for the answer. Kubernetes' default of 1 s fails a healthy service
  whenever the two together take longer than that, as they can while renders
  load the CPU.
- **As a liveness probe it is optional.** If you add one, give it the same
  timeout and a `failureThreshold` of 3 or more, so one slow answer does not
  restart the container.

### Egress is denied, always (ruling 6)

**This is mandatory.** The service renders your pack's code in Chrome, and
ADR-5's security claim holds only when that code cannot reach the network:

- **No default route.** The container has no outbound route at all. Loopback
  still works, which is all a render needs.
- **Cloud metadata is blocked.** `169.254.169.254` must be unreachable, so a
  render can never fetch the host's credentials.

Your pack must therefore be self-contained: fonts and images inside it, no
web fonts, no fetches ([`CONTRACT-pack.md`](CONTRACT-pack.md#self-contained-packs-ruling-6)).

- **Docker or Compose:** attach the service only to an `internal` network
  (`docker network create --internal`, or `internal: true` in Compose),
  which has no route out. Your TLS proxy joins that network and the outside
  one, and nothing else joins it ([ingress](#ingress-only-your-proxy-only-service_port)).
  Use Docker Engine 25.0.5 or later, or 23.0.11 or a later 23.0 release; the
  advisory names no fixed 24.0 release. Older engines carry CVE-2024-29018
  (GHSA-mq39-4gv4-mvpx): on a host whose own resolver listens on a loopback
  address, as many do, the engine forwards a container's DNS queries for
  outside names from the host's network namespace, past the internal
  network. On such an engine a name a render looks up can carry data out
  while both fetch checks below print `blocked`. Docker Desktop is not
  affected.
- **Kubernetes:** a NetworkPolicy for the service's pods whose `policyTypes`
  include `Egress` and that has no `egress` rules: the one in the
  [ingress section](#ingress-only-your-proxy-only-service_port), which limits
  ingress too. It is enforced only if your CNI enforces NetworkPolicy.

Check it from inside the running container. All three must print `blocked`.
The third asks DNS for an outside name, for the engines above. On Kubernetes,
run each with `kubectl exec <pod> --` in place of `docker exec <container>`.

```sh
docker exec <container> node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(3000)}).then(()=>{console.log('REACHABLE');process.exit(1)},()=>console.log('blocked'))"
docker exec <container> node -e "fetch('https://example.com/',{signal:AbortSignal.timeout(3000)}).then(()=>{console.log('REACHABLE');process.exit(1)},()=>console.log('blocked'))"
docker exec <container> node -e "Promise.race([require('dns').promises.lookup('example.com'),new Promise((_,no)=>setTimeout(no,5000))]).then(()=>{console.log('RESOLVES');process.exit(1)},()=>{console.log('blocked');process.exit(0)})"
```

### Ingress: only your proxy, only `SERVICE_PORT`

**This is mandatory too.** While each render runs, the Remotion CLI the
service starts opens an HTTP server of its own. It binds every interface,
`0.0.0.0`, or `::` when the container has a non-loopback IPv6 address, on
the first free port from 3000 to 3100. Remotion 4.0.532, which the fixture
pack pins, has no option to bind it to loopback alone. That server checks no
identity header:

- It serves the pack's `bundle/`, the `public/` files included.
- Its `/proxy?src=` endpoint downloads any `http:` or `https:` URL, or
  writes a `data:` URL to disk, and hands the bytes to Remotion's compositor,
  which decodes them with ffmpeg.
- Its error replies carry stack traces.

So anyone who can reach the container's address during a render can read
your pack, and can make requests from inside the container's network
namespace: to loopback, to the service's own port, and on Kubernetes to the
pod's sidecars. Egress denial does not cover that namespace. They can also
feed bytes of their choosing to native decoding code that runs as the
service's user, which can read the service's keys, and fill the render's
work directory. The identity header guards `SERVICE_PORT` only.

Admit only your TLS proxy, and only to `SERVICE_PORT`:

- **Docker or Compose:** a dedicated `internal` network that holds only the
  service and its TLS proxy. By default Docker does not filter ports between
  containers on one network, so the proxy is the one peer that can reach the
  listener,
  and it must forward only to `SERVICE_PORT`. Publish no port of the
  service's.
- **Kubernetes:** one NetworkPolicy for the service's pods with
  `policyTypes: [Ingress, Egress]`, no `egress` rules, and one ingress rule:
  from your proxy's pods, to `SERVICE_PORT` only. With your own labels:

  ```yaml
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: remotion-viz-service
  spec:
    podSelector:
      matchLabels: { app: remotion-viz-service }
    policyTypes: [Ingress, Egress]
    ingress:
      - from:
          - podSelector:
              matchLabels: { app: your-tls-proxy }
        ports:
          - { protocol: TCP, port: 8080 }   # SERVICE_PORT
  ```

  A proxy in another namespace needs a `namespaceSelector` beside its
  `podSelector`.

**Check it during a render.** The listener exists only while a render runs.
On a test deployment of the fixture pack's derived image
([below](#running-the-proofs-on-the-digest-you-pin)), send one signed
`render_still` of the `slow` template, which holds its render for the
service's 45 s deadline. While it runs, probe the service's address from a
peer with this script, which needs only Node:

```sh
node -e '
const net = require("net");
const [host, svc] = process.argv.slice(1);
const answers = (port) => new Promise((done) => {
  const s = net.connect({ host, port, timeout: 3000 });
  const end = (v) => { s.destroy(); done(v); };
  s.on("connect", () => end(true)).on("timeout", () => end(false)).on("error", () => end(false));
});
const ports = Array.from({ length: 101 }, (_, i) => 3000 + i);
Promise.all([answers(+svc), ...ports.map(answers)]).then(([up, ...rest]) => {
  const open = ports.filter((_, i) => rest[i]);
  console.log(`SERVICE_PORT ${svc}: ${up ? "answers" : "no answer"}`);
  console.log(`3000-3100: ${open.length ? "ANSWER on " + open.join(" ") : "no answer"}`);
});' <service address> <SERVICE_PORT>
```

- **Kubernetes,** from a pod that carries your proxy's labels, such as
  `kubectl run ingress-probe --rm -i --restart=Never --image=node:22-bookworm-slim --labels=app=your-tls-proxy -- node -e '<the script>' <pod IP> 8080`:
  it must print `SERVICE_PORT 8080: answers` and `3000-3100: no answer`.
  From a pod without those labels, both lines must say `no answer`.
- **Docker:** `docker network inspect <network>` must list only the service
  and the proxy. From a container on any other network, both lines must say
  `no answer`.

Without the rule, the same script prints `3000-3100: ANSWER on` and the CLI's
port while the render runs. The script as written here has been run only
against the real Remotion 4.0.532 CLI rendering `slow` in WSL (2026-11-12),
from the host's non-loopback address, with a stand-in answering on the service
port. Before the render it printed `SERVICE_PORT 8080: answers` and
`3000-3100: no answer`, during it `3000-3100: ANSWER on 3000`, and once the
stand-in and the CLI were stopped, `no answer` on both lines. It has not been
run against a deployment.

### TLS in front

The service speaks plain HTTP. Terminate TLS in a proxy in front of it, on
the internal network, and never publish its port anywhere else. The identity
header authenticates a request but does not hide it: the props and the PNG
travel in the body.

### The audit log

**Mount a volume at `/var/log/remotion-viz`, writable by uid 1000** (`node`).
If the service cannot open `AUDIT_LOG_PATH` for appending, it refuses to start
(`preflight: AUDIT_LOG_PATH is not writable`).

- A named Docker volume takes the image directory's owner on first use.
- A bind mount needs a host directory owned by uid 1000, mode `0750`.
- On Kubernetes, `securityContext.fsGroup: 1000`.

**Rotate it.** Refused requests are audited (`400`, `401` and `413`), and a
`401` or a `413` needs no valid identity, so anyone who can reach the port can
grow the file. The service opens the file by path for every line, so
a rename-and-recreate rotation needs no signal; the next line creates a new
file, mode `0600`.

**Rate-limit refused requests** at your gateway or at the network edge. The
service has no rate limiter of its own. Each refused request costs a body
read of up to twice the 256 KiB cap, an HMAC and an audit line.

## Your pack

[`CONTRACT-pack.md`](CONTRACT-pack.md) is the authoring guide. Three of its
rules matter for a running deployment:

- **Patterns must run in linear time.** A regex with catastrophic
  backtracking blocks the service's event loop, and every request with it,
  even on a bounded string.
- **Keep `maxItems` times the item's size modest.** Each array's bound
  multiplies everything under it, and validating a huge array blocks every
  request.
- **`packHash` is per build, not per source.** A rebuild of the same checkout
  on the same host gives the same hash. Another checkout, directory or
  machine gives a new one. Compare hashes to tell builds apart, never to
  prove two builds came from the same sources.

## What this repository proves, and what it does not

The CI `image` job ([`CI.md`](CI.md#the-image-job-the-images-proved-on-linux))
builds both images from the fixture pack and runs three checks:

- `scripts/image-checks.sh`, inside a running derived container: `setpriv`,
  no package manager (npm, npx, yarn, yarnpkg or corepack), `tini` as PID 1,
  the browser runs and has every library, the renderer's version, a writable
  audit directory, and a user that is not root.
- `scripts/image-e2e.mjs`, which drives the derived image directly with this
  repository's test signing client. The owner's gateway is not in it, so it
  is not a test of the backend, gateway and service path. It shows the image
  turning a signed request into a PNG, refusing a replayed and a forged
  header, auditing without payloads, and leaving no process behind after a
  timed-out or a crashed render. Its cases use the fixture pack's `swatch`
  and `slow` templates.
- `scripts/walk-only-proof.mjs`, below the service: with `setpriv` hidden,
  the service's own `/proc` walk alone kills Chrome, and a control run that
  skips the walk's groups leaves Chrome running.

`image-checks.sh` works against any derived image:

```sh
docker exec -i <container> sh -s < scripts/image-checks.sh
```

### Running the proofs on the digest you pin

`image-e2e.mjs` and `walk-only-proof.mjs` need only the fixture pack's
`swatch` and `slow` templates, so they run on any published digest once the
fixture pack is built on top of it. Run them on Linux with Docker, from a
checkout of the commit the digest was built from (the publish job's summary
names it):

```sh
npm ci && npm run build:service
npm ci --prefix fixtures/pack
node scripts/build-pack.mjs fixtures/pack
docker build --platform linux/amd64 -f fixtures/pack/Dockerfile.derived \
  --build-arg SERVICE_IMAGE=ghcr.io/curasinan/remotion-viz-service@sha256:<digest> \
  -t rv-pack:pinned fixtures/pack
node scripts/image-e2e.mjs rv-pack:pinned
key() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }
IDENTITY_HMAC_KEY="$(key)" AUDIT_HMAC_KEY="$(key)" docker run --rm --entrypoint /usr/bin/tini \
  -e SERVICE_AUDIENCE=proof -e IDENTITY_HMAC_KEY -e AUDIT_HMAC_KEY \
  -v "$PWD/scripts:/proof:ro" rv-pack:pinned -- node /proof/walk-only-proof.mjs
```

`image-e2e.mjs` starts its own container with throwaway keys, and exits 0
only when every case passes. `walk-only-proof.mjs` runs the image's own
`dist-service/` and exits 0 only when both of its runs pass.
[`CI.md`](CI.md#the-image-job-the-images-proved-on-linux) gives the local
recipe for `image-checks.sh` against the same image.

Your own gateway's conformance is checked against the vectors, not here
([`CONTRACT-gateway.md`](CONTRACT-gateway.md#checking-a-gateway-against-the-vectors)).

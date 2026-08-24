/**
 * Network policy for rendered content.
 *
 * viz_render_html runs attacker-shaped markup in a real browser. Left open, any
 * <img src>, fetch, @font-face or CSS url() is an egress channel: a probe
 * confirmed both an image request and a fetch() reaching a listener, query
 * string intact. The screenshot then returns to the model, so the same channel
 * reads as well as writes.
 *
 * The default is deny. Rendering self-contained markup - which is what this
 * tool is for - needs no network at all, so an allowlist is opt-in and starts
 * empty.
 */

/** What the renderer may load, in order of increasing trust required. */
export interface NetworkPolicy {
  /** Hostnames that may be fetched over http(s). Empty means none. */
  allowedHosts: string[];
}

export const DENY_ALL: NetworkPolicy = { allowedHosts: [] };

export interface RequestDecision {
  allowed: boolean;
  /** Why it was refused, phrased for the caller rather than for a log. */
  reason?: string;
}

/**
 * Addresses that stay blocked even when a host is allowlisted.
 *
 * Loopback and link-local are the interesting ones: 169.254.169.254 is the
 * cloud instance metadata endpoint, and loopback reaches other services on the
 * machine, including a Remotion Studio this server may have started. An
 * allowlist is a statement about a public host, never a licence to reach the
 * local network.
 */
function isAlwaysBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true;

  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0) return true;              // loopback, "this host"
    if (a === 10) return true;                           // private
    if (a === 169 && b === 254) return true;             // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;    // private
    if (a === 192 && b === 168) return true;             // private
    if (a === 100 && b >= 64 && b <= 127) return true;   // carrier-grade NAT
  }

  return false;
}

/**
 * Decide one request.
 *
 * Note what this cannot do: the check is on the URL, before Chrome resolves it.
 * An allowlisted hostname that resolves to a private address still connects.
 * With the default empty allowlist there is nothing to rebind, which is the
 * reason the default matters more than the mechanism.
 */
export function decideRequest(url: string, policy: NetworkPolicy): RequestDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `unparseable URL '${url.slice(0, 80)}'` };
  }

  const scheme = parsed.protocol.toLowerCase();

  // Self-contained by construction; these carry their own bytes.
  if (scheme === "data:" || scheme === "blob:" || scheme === "about:") {
    return { allowed: true };
  }

  if (scheme === "file:") {
    return {
      allowed: false,
      reason: "file:// is never loaded; it would read local files into the screenshot",
    };
  }

  if (scheme !== "http:" && scheme !== "https:") {
    return { allowed: false, reason: `scheme '${scheme}' is not allowed` };
  }

  if (isAlwaysBlockedHost(parsed.hostname)) {
    return {
      allowed: false,
      reason: `'${parsed.hostname}' is a loopback, private or link-local address, which is blocked even when allowlisted`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = policy.allowedHosts.some((entry) => {
    const candidate = entry.toLowerCase().trim();
    if (candidate === "") return false;
    return host === candidate || host.endsWith(`.${candidate}`);
  });

  if (allowed) return { allowed: true };

  return {
    allowed: false,
    reason:
      policy.allowedHosts.length === 0
        ? `'${host}' was not loaded: rendering runs with no network access by default`
        : `'${host}' is not in the allowed host list`,
  };
}

/**
 * Read the allowlist from the environment.
 *
 * Comma-separated hostnames, for example "fonts.googleapis.com,fonts.gstatic.com".
 * Unset means deny everything, which is the intended out-of-the-box state.
 */
export function networkPolicyFromEnvironment(): NetworkPolicy {
  const raw = process.env.REMOTION_MCP_ALLOWED_HOSTS ?? "";
  const allowedHosts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return { allowedHosts };
}

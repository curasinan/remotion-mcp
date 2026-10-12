import { loadConfig } from "../config.js";

/** Network policy for rendered content: deny by default, with an opt-in host allowlist. */

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

/** Loopback, private, link-local and metadata addresses, blocked even when allowlisted. */
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

/** Decides one request by URL; DNS resolution of allowlisted hosts is not checked. */
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

/** Reads the comma-separated host allowlist from config; unset means deny all. */
export function networkPolicyFromEnvironment(): NetworkPolicy {
  // Validated by the config module at startup.
  return { allowedHosts: loadConfig().allowedHosts };
}

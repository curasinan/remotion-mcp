/**
 * One place that reads and validates the server's own configuration.
 *
 * Every REMOTION_MCP_* knob and the browser-path variables are defined here,
 * with a default, a parser, and a check. loadConfig runs at startup and throws
 * on anything invalid, so a misconfiguration stops the server with a clear
 * message instead of surfacing later as a confusing tool failure.
 *
 * There is deliberately no config-file layer. This ships as an .mcpb bundle and
 * as a Claude Desktop / Claude Code stdio server, and both configure it through
 * environment variables - the manifest maps user_config to env, and the desktop
 * config sets env directly. A file layer would be a parser and a merge order
 * for a source nothing in the deployment uses. Precedence is therefore just
 * default < environment, with tool arguments overriding per call where a tool
 * exposes one.
 *
 * Defaults are the most restrictive that still work: no network, sandbox on,
 * workspace confined to one directory. Loosening any of them is an explicit
 * environment variable, never the out-of-the-box state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  /** Directory every file path resolves against and is confined to. */
  workspaceRoot: string;
  /** How the workspace root was chosen, for diagnostics. */
  workspaceSource: "REMOTION_MCP_WORKSPACE" | "process cwd";
  /** Hosts viz_render_html may reach over http(s). Empty means none. */
  allowedHosts: string[];
  /** Whether the Chrome sandbox is disabled. Default false. */
  disableBrowserSandbox: boolean;
  /** Explicit browser executable, or null to auto-detect. */
  browserExecutable: string | null;
  /** Durable audit log, outside the workspace. */
  auditLogPath: string;
  /** Total bytes kept across the two rotating segments. */
  auditMaxBytes: number;
}

/** A configuration problem that should stop the server at startup. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const hosts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");

  for (const host of hosts) {
    // A value with a scheme or path is a sign the operator meant a URL; reject
    // it rather than silently never matching.
    if (/[/:]/.test(host)) {
      throw new ConfigError(
        `REMOTION_MCP_ALLOWED_HOSTS entry '${host}' looks like a URL. List bare hostnames, comma-separated, for example "fonts.googleapis.com,fonts.gstatic.com".`,
      );
    }
  }
  return [...new Set(hosts)];
}

function parseWorkspace(raw: string | undefined): Pick<ServerConfig, "workspaceRoot" | "workspaceSource"> {
  if (!raw || raw.trim() === "") {
    return { workspaceRoot: process.cwd(), workspaceSource: "process cwd" };
  }

  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    throw new ConfigError(
      `REMOTION_MCP_WORKSPACE points at '${resolved}', which does not exist. Set it to a directory that exists, or unset it to use the process working directory.`,
    );
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new ConfigError(
      `REMOTION_MCP_WORKSPACE points at '${resolved}', which is a file, not a directory.`,
    );
  }
  return { workspaceRoot: resolved, workspaceSource: "REMOTION_MCP_WORKSPACE" };
}

function parseBrowserExecutable(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PUPPETEER_EXECUTABLE_PATH || env.CHROME_PATH;
  if (!explicit) return null;
  if (!fs.existsSync(explicit)) {
    throw new ConfigError(
      `${env.PUPPETEER_EXECUTABLE_PATH ? "PUPPETEER_EXECUTABLE_PATH" : "CHROME_PATH"} points at '${explicit}', which does not exist. Set it to a Chrome, Chromium, Edge or Brave binary, or unset it to auto-detect one.`,
    );
  }
  return explicit;
}

function defaultAuditLogPath(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return path.join(base, "remotion-viz", "audit.jsonl");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "remotion-viz", "audit.jsonl");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  return path.join(base, "remotion-viz", "audit.jsonl");
}

function parseAuditLogPath(raw: string | undefined): string {
  const resolved = raw && raw.trim() !== "" ? path.resolve(raw) : defaultAuditLogPath();
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (error) {
    throw new ConfigError(
      `REMOTION_MCP_AUDIT_LOG's directory '${path.dirname(resolved)}' could not be created: ${error instanceof Error ? error.message : String(error)}. Point it at a writable location, or unset it to use the default.`,
    );
  }
  return resolved;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const workspace = parseWorkspace(env.REMOTION_MCP_WORKSPACE);
  return {
    ...workspace,
    allowedHosts: parseAllowedHosts(env.REMOTION_MCP_ALLOWED_HOSTS),
    disableBrowserSandbox: env.REMOTION_MCP_DISABLE_BROWSER_SANDBOX === "1",
    browserExecutable: parseBrowserExecutable(env),
    auditLogPath: parseAuditLogPath(env.REMOTION_MCP_AUDIT_LOG),
    auditMaxBytes: 5_000_000,
  };
}

/** Reads and validates the server's environment configuration at startup. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TIMEOUT_CDP_PROTOCOL_MS, TIMEOUT_PAGE_LOAD_MS } from "./constants.js";

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
  /** Deadline for one page render, covering setContent and screenshot together. */
  pageLoadTimeoutMs: number;
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
    // Reject URLs; only bare hostnames can match.
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

function parsePageLoadTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return TIMEOUT_PAGE_LOAD_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(
      `REMOTION_MCP_PAGE_TIMEOUT_MS must be a positive whole number of milliseconds, got '${raw}'.`,
    );
  }
  // The page deadline must stay below the CDP backstop or it never fires.
  if (parsed >= TIMEOUT_CDP_PROTOCOL_MS) {
    throw new ConfigError(
      `REMOTION_MCP_PAGE_TIMEOUT_MS is ${parsed} ms, which is not below the ${TIMEOUT_CDP_PROTOCOL_MS} ms CDP backstop. ` +
        `Above the backstop the page deadline never fires, because puppeteer refuses the underlying command first. Choose a smaller value.`,
    );
  }
  return parsed;
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

/** Per-user, out-of-workspace directory for the audit log and the Studio registry. */
export function stateDirectory(): string {
  // Override so tests never touch the real user's state.
  const override = process.env.REMOTION_MCP_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);

  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "remotion-viz");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "remotion-viz");
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "remotion-viz");
}

function defaultAuditLogPath(): string {
  return path.join(stateDirectory(), "audit.jsonl");
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
    pageLoadTimeoutMs: parsePageLoadTimeout(env.REMOTION_MCP_PAGE_TIMEOUT_MS),
  };
}

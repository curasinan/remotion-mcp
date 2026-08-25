/**
 * Shared type definitions.
 */

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ToolCheck {
  name: string;
  found: boolean;
  version?: string;
  detail?: string;
  /** Actionable remediation shown when `found` is false. */
  fix?: string;
}

export interface EnvironmentReport {
  workspace_root: string;
  project_dir: string | null;
  is_remotion_project: boolean;
  remotion_entry_point: string | null;
  checks: ToolCheck[];
  blocking_problems: string[];
  ready_to_render: boolean;
}

export interface CompositionSummary {
  id: string;
  width?: number;
  height?: number;
  fps?: number;
  duration_in_frames?: number;
}

export interface SvgIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  fix: string;
  line?: number;
}

export interface SvgValidationReport {
  valid: boolean;
  byte_size: number;
  error_count: number;
  warning_count: number;
  issues: SvgIssue[];
  detected_viewbox: string | null;
  detected_width: string | null;
  detected_height: string | null;
}

/** Thrown for user-correctable problems; message is surfaced verbatim. */
export class ToolInputError extends Error {
  public readonly hint: string;
  public readonly category?: string;

  constructor(message: string, hint: string, category?: string) {
    super(message);
    this.name = "ToolInputError";
    this.hint = hint;
    this.category = category;
  }
}

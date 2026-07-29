/** Shared types for the agent-term daemon. */

export type JobState =
  | "queued"
  | "running"
  | "awaiting-input"
  | "exited"
  | "killed";

/**
 * The default unit an agent receives about a job: everything it needs to
 * decide whether to read more, and nothing that can blow the context budget.
 */
export interface JobDigest {
  job_id: string;
  session_id: string;
  command: string;
  state: JobState;
  /** Present once the job reached a terminal state. */
  exit_code: number | null;
  /** Milliseconds from command start (OSC 133 C) to finish (OSC 133 D). */
  duration_ms: number | null;
  /** Raw bytes captured for this job (pre-normalization). */
  bytes: number;
  /** Normalized line count. */
  line_count: number;
  /** Estimated tokens of the full normalized output. */
  estimated_tokens: number;
  /** First lines of normalized output (default 10). */
  head: string[];
  /** Last lines of normalized output (default 20). Empty if head covers everything. */
  tail: string[];
  /** Human/agent-readable annotations: collapsed redraws, TUI mode, kill requests... */
  notes: string[];
  /** True if the job entered the terminal's alternate screen (full-screen TUI). */
  tui_mode: boolean;
  /** Set when state is awaiting-input: why the detector thinks so. */
  awaiting_reason?: string;
  /** Set when state is awaiting-input: the trailing output (suspected prompt). */
  awaiting_tail?: string[];
}

/** Query shapes accepted by read_output. */
export type OutputQuery =
  | { mode: "head"; lines: number }
  | { mode: "tail"; lines: number }
  | { mode: "slice"; start: number; end: number }
  | { mode: "grep"; pattern: string; context?: number; max_matches?: number }
  | { mode: "full"; confirm_tokens: number }
  | { mode: "delta"; since_line: number }
  | { mode: "screen" };

/** Every read_output response carries token accounting for what was and wasn't returned. */
export interface QueryResult {
  job_id: string;
  state: JobState;
  mode: OutputQuery["mode"];
  /** The returned text, already joined with newlines. */
  text: string;
  /** 1-indexed line numbers describing what `text` covers, when contiguous. */
  range?: { start: number; end: number };
  /** grep only: total matches found (may exceed what was returned). */
  total_matches?: number;
  /** delta only: pass this back as since_line next time. */
  last_line?: number;
  total_lines: number;
  returned_estimated_tokens: number;
  /** Estimated tokens of the normalized output NOT included in this response. */
  remaining_estimated_tokens: number;
  notes: string[];
}

/**
 * The MCP tool surface. Deliberately boring and explicit: schemas say exactly
 * what they take, and every error message teaches the caller what to do
 * instead — other agents will fumble with this interface, and the error text
 * is the documentation they actually read.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager } from "./manager";
import { QueryError } from "./store";
import type { OutputQuery } from "./types";

/** Wrap a result object as an MCP text content block. Compact JSON on
 * purpose: indentation is pure token overhead for a model reader. */
function jsonResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }] };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true,
  };
}

export function buildServer(manager: SessionManager): McpServer {
  const server = new McpServer({ name: "agent-term", version: "0.1.0" });

  server.registerTool(
    "session_create",
    {
      description:
        "Create a persistent shell session on a real PTY. Returns session_id. " +
        "Sessions survive across many run() calls; create one per workspace or task stream.",
      inputSchema: {
        name: z.string().optional().describe("Human-friendly session name (must be unique among live sessions)"),
        cwd: z.string().optional().describe("Working directory for the shell (default: daemon cwd)"),
        shell: z.string().optional().describe("Shell binary (default: $SHELL or /bin/bash)"),
      },
    },
    async (args) => {
      try {
        const s = await manager.createSession(args);
        return jsonResult({
          session_id: s.id,
          name: s.name,
          shell: s.shell,
          cwd: s.cwd,
          shell_pid: s.shellPid,
          raw_log: s.rawLogPath,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "session_list",
    {
      description: "List sessions with liveness and active job counts.",
      inputSchema: {},
    },
    async () => {
      const sessions = manager.listSessions().map((s) => ({
        session_id: s.id,
        name: s.name,
        alive: s.alive,
        cwd: s.cwd,
        shell: s.shell,
        active_jobs: s.activeJobCount,
        total_jobs: s.jobs.length,
        job_ids: s.jobs.map((j) => j.id),
      }));
      return jsonResult({ sessions });
    },
  );

  server.registerTool(
    "session_kill",
    {
      description: "Kill a session's shell and mark its active/queued jobs killed. Raw logs are kept on disk.",
      inputSchema: {
        session_id: z.string().describe("Session id (\"s1\") or name"),
      },
    },
    async ({ session_id }) => {
      try {
        manager.killSession(session_id);
        return jsonResult({ ok: true, session_id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "run",
    {
      description:
        "Run a command in a session as an async job. Returns a job_id IMMEDIATELY — the command " +
        "keeps running in the background. Follow up with wait(job_id) or job_status(job_id). " +
        "Jobs in one session run one at a time in FIFO order; use multiple sessions for parallelism.",
      inputSchema: {
        session_id: z.string().describe("Session id or name from session_create"),
        command: z.string().describe("Shell command line to execute"),
      },
    },
    async ({ session_id, command }) => {
      try {
        const job = manager.run(session_id, command);
        return jsonResult({
          job_id: job.id,
          state: job.state,
          hint: "Job is async. Call wait(job_id, timeout_ms) for the digest, or job_status(job_id) to poll.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "job_status",
    {
      description:
        "Get a job's state and output digest (exit code, duration, size, estimated tokens, " +
        "first/last lines). Never returns full output — use read_output for targeted reads.",
      inputSchema: {
        job_id: z.string().describe("Job id from run()"),
      },
    },
    async ({ job_id }) => {
      try {
        const { job, session } = manager.getJob(job_id);
        return jsonResult(session.digest(job));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wait",
    {
      description:
        "Block until the job exits, is suspected of awaiting input, or timeout_ms elapses; " +
        "returns the job digest either way (check `state`). Optionally pass since_line to also " +
        "get output lines produced after that line number (streaming deltas for long-running jobs).",
      inputSchema: {
        job_id: z.string().describe("Job id from run()"),
        timeout_ms: z.number().int().min(0).max(600_000).describe("Max time to block (0 = just look)"),
        since_line: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("If set, response includes new_lines after this 1-indexed line number (0 = from start)"),
      },
    },
    async ({ job_id, timeout_ms, since_line }) => {
      try {
        const { job, session } = manager.getJob(job_id);
        await session.wait(job, timeout_ms);
        const digest = session.digest(job);
        if (since_line === undefined) return jsonResult(digest);
        const delta = job.output.query(job.id, job.state, { mode: "delta", since_line });
        return jsonResult({
          ...digest,
          new_lines: delta.text,
          new_lines_range: delta.range ?? null,
          last_line: delta.last_line,
          new_lines_estimated_tokens: delta.returned_estimated_tokens,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const queryShape = {
    job_id: z.string().describe("Job id from run()"),
    mode: z
      .enum(["head", "tail", "slice", "grep", "full", "delta"])
      .describe("How to read: head/tail (n lines), slice (line range), grep (regex search), full (entire output, budget-gated), delta (new lines since since_line)"),
    lines: z.number().int().min(1).optional().describe("head/tail: number of lines"),
    start: z.number().int().min(1).optional().describe("slice: first line (1-indexed, inclusive)"),
    end: z.number().int().min(1).optional().describe("slice: last line (1-indexed, inclusive)"),
    pattern: z.string().optional().describe("grep: JavaScript regex matched per line"),
    context: z.number().int().min(0).optional().describe("grep: context lines around each match (default 2)"),
    max_matches: z.number().int().min(1).optional().describe("grep: max matches returned (default 20)"),
    confirm_tokens: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("full: refuse if estimated output tokens exceed this budget — the error tells you the real size"),
    since_line: z.number().int().min(0).optional().describe("delta: return lines after this line number (0 = from start)"),
  };

  server.registerTool(
    "read_output",
    {
      description:
        "Query a job's normalized output (ANSI stripped, progress redraws collapsed). " +
        "Every response reports estimated tokens returned AND remaining, so you can budget. " +
        "Prefer grep/tail/slice; full requires an explicit confirm_tokens budget.",
      inputSchema: queryShape,
    },
    async (args) => {
      try {
        const { job, session } = manager.getJob(args.job_id);
        const q = parseQuery(args);
        return jsonResult(job.output.query(job.id, job.state, q));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "send_input",
    {
      description:
        "Write text to a session's terminal — for answering interactive prompts " +
        "(passwords, y/n confirmations, pagers). Set end_with_newline=false for single " +
        "keypresses like q or space.",
      inputSchema: {
        session_id: z.string().describe("Session id or name"),
        text: z.string().describe("Text to type into the terminal"),
        end_with_newline: z.boolean().optional().describe("Append Enter after the text (default true)"),
      },
    },
    async ({ session_id, text, end_with_newline }) => {
      try {
        const session = manager.getSession(session_id);
        session.sendInput(text, end_with_newline ?? true);
        return jsonResult({ ok: true });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "job_kill",
    {
      description:
        "Signal a job's foreground process group (default SIGTERM). Escalate to SIGKILL if it " +
        "ignores SIGTERM. Queued jobs are dequeued without running.",
      inputSchema: {
        job_id: z.string().describe("Job id from run()"),
        signal: z
          .enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP"])
          .optional()
          .describe("Signal to send (default SIGTERM)"),
      },
    },
    async ({ job_id, signal }) => {
      try {
        const { job, session } = manager.getJob(job_id);
        session.killJob(job, signal ?? "SIGTERM");
        return jsonResult({
          ok: true,
          job_id,
          state: job.state,
          hint: "If the job is still running after a grace period, call job_kill again with signal=SIGKILL.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

/** Validate the flat read_output args into a typed OutputQuery, teaching on mistakes. */
export function parseQuery(args: {
  mode: string;
  lines?: number;
  start?: number;
  end?: number;
  pattern?: string;
  context?: number;
  max_matches?: number;
  confirm_tokens?: number;
  since_line?: number;
}): OutputQuery {
  switch (args.mode) {
    case "head":
    case "tail":
      if (args.lines === undefined)
        throw new QueryError(`mode "${args.mode}" requires "lines", e.g. {mode:"${args.mode}", lines:20}.`);
      return { mode: args.mode, lines: args.lines };
    case "slice":
      if (args.start === undefined || args.end === undefined)
        throw new QueryError(`mode "slice" requires "start" and "end" (1-indexed, inclusive), e.g. {mode:"slice", start:100, end:160}.`);
      return { mode: "slice", start: args.start, end: args.end };
    case "grep":
      if (args.pattern === undefined)
        throw new QueryError(`mode "grep" requires "pattern" (a JavaScript regex), e.g. {mode:"grep", pattern:"error TS\\\\d+", context:2}.`);
      return { mode: "grep", pattern: args.pattern, context: args.context, max_matches: args.max_matches };
    case "full":
      if (args.confirm_tokens === undefined)
        throw new QueryError(
          `mode "full" requires "confirm_tokens" — an explicit token budget you are willing to spend. ` +
            `Check job_status.estimated_tokens first, then pass at least that number.`,
        );
      return { mode: "full", confirm_tokens: args.confirm_tokens };
    case "delta":
      if (args.since_line === undefined)
        throw new QueryError(`mode "delta" requires "since_line" (use 0 for "from the beginning"; then pass back last_line from each response).`);
      return { mode: "delta", since_line: args.since_line };
    default:
      throw new QueryError(`unknown mode "${args.mode}". Valid: head, tail, slice, grep, full, delta.`);
  }
}

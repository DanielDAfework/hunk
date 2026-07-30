/**
 * Unix-socket transport for the daemon: line-delimited JSON requests over a
 * local socket, so plain CLI processes (and therefore any agent with a bash
 * tool) can drive sessions without speaking MCP.
 *
 * Protocol: one JSON object per line in, one per line out.
 *   { "id": 1, "method": "run", "params": { "session": "s1", "command": "ls" } }
 *   { "id": 1, "ok": true, "result": {...} } | { "id": 1, "ok": false, "error": "..." }
 *
 * Usage: bun run src/ipcDaemon.ts [socket-path]
 * Default socket: $AGENT_TERM_SOCK or /tmp/agent-term.sock
 */

import * as fs from "node:fs";
import { SessionManager } from "./manager";
import { parseQuery } from "./mcp";

export interface IpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** Dispatch one request against a manager. Exported for tests. */
export async function handleIpc(
  manager: SessionManager,
  req: IpcRequest,
): Promise<unknown> {
  const p = (req.params ?? {}) as Record<string, any>;
  switch (req.method) {
    case "session_create": {
      const s = await manager.createSession({ name: p.name, cwd: p.cwd, shell: p.shell });
      return { session_id: s.id, name: s.name, cwd: s.cwd, shell_pid: s.shellPid };
    }
    case "session_list":
      return {
        sessions: manager.listSessions().map((s) => ({
          session_id: s.id,
          name: s.name,
          alive: s.alive,
          active_jobs: s.activeJobCount,
        })),
      };
    case "session_kill":
      manager.killSession(String(p.session));
      return { ok: true };
    case "run": {
      const job = manager.run(String(p.session), String(p.command));
      return { job_id: job.id, state: job.state };
    }
    case "status": {
      const { job, session } = manager.getJob(String(p.job));
      return session.digest(job);
    }
    case "wait": {
      const { job, session } = manager.getJob(String(p.job));
      await session.wait(job, Number(p.timeout_ms ?? 10_000));
      const digest = session.digest(job);
      if (p.since_line === undefined) return digest;
      const delta = job.output.query(job.id, job.state, {
        mode: "delta",
        since_line: Number(p.since_line),
      });
      return { ...digest, new_lines: delta.text, last_line: delta.last_line };
    }
    case "read": {
      const { job } = manager.getJob(String(p.job));
      const q = parseQuery(p as any);
      if (q.mode === "screen") return job.output.queryScreen(job.id, job.state);
      return job.output.query(job.id, job.state, q);
    }
    case "input": {
      const session = manager.getSession(String(p.session));
      session.sendInput(String(p.text), p.end_with_newline !== false);
      return { ok: true };
    }
    case "job_kill": {
      const { job, session } = manager.getJob(String(p.job));
      session.killJob(job, String(p.signal ?? "SIGTERM"));
      return { ok: true, state: job.state };
    }
    // ---- hybrid exec-first surface (post-A/B salvage design): bash in, ----
    // ---- structured state out, one round-trip. --------------------------
    case "exec": {
      // Persistent session per key (auto-created): bash composition works AND
      // cwd/env persist across calls — which a spawn-per-command shim lacks.
      const key = String(p.key ?? "hybrid");
      let session;
      try {
        session = manager.getSession(key);
      } catch {
        session = await manager.createSession({ name: key, cwd: p.cwd ? String(p.cwd) : undefined });
      }
      const job = manager.run(session.id, String(p.command));
      await session.wait(job, Number(p.timeout_ms ?? 30_000));
      const view = execView(manager, job.id);
      // Whatever exec ships now, a later poll must not ship again.
      pollCursors.set(job.id, view.lines.length);
      return view;
    }
    case "reply": {
      // Answer whatever the session's current job is waiting on, then wait again.
      const session = manager.getSession(String(p.key ?? "hybrid"));
      const active = [...session.jobs].reverse().find(
        (j) => j.state === "running" || j.state === "awaiting-input",
      );
      if (!active) {
        throw new Error(`no active job in session "${session.name}" to reply to.`);
      }
      session.sendInput(String(p.text), p.end_with_newline !== false);
      await session.wait(active, Number(p.timeout_ms ?? 30_000));
      const view = execView(manager, active.id);
      pollCursors.set(active.id, view.lines.length);
      return view;
    }
    case "poll": {
      // Only-new-output polling; the cursor lives server-side per job.
      const { job, session } = manager.getJob(String(p.job));
      await session.wait(job, Number(p.timeout_ms ?? 2_000));
      const cursor = pollCursors.get(job.id) ?? 0;
      const delta = job.output.query(job.id, job.state, { mode: "delta", since_line: cursor });
      pollCursors.set(job.id, delta.last_line ?? cursor);
      return { ...execView(manager, job.id), lines: delta.text ? delta.text.split("\n") : [] };
    }
    default:
      throw new Error(
        `unknown method "${req.method}". Valid: session_create, session_list, session_kill, run, status, wait, read, input, job_kill, exec, reply, poll.`,
      );
  }
}

/** Cursors for `poll` (only-new-output reads), keyed by job id. */
const pollCursors = new Map<string, number>();

/** The hybrid surface's one response shape: full normalized lines + job state. */
function execView(manager: SessionManager, jobId: string) {
  const { job, session } = manager.getJob(jobId);
  const snap = job.output.snapshot();
  const digest = session.digest(job);
  return {
    job_id: job.id,
    state: job.state,
    exit_code: job.exitCode,
    duration_ms: digest.duration_ms,
    lines: snap.lines,
    notes: digest.notes,
    awaiting_reason: digest.awaiting_reason ?? null,
  };
}

if (import.meta.main) {
  const sockPath = process.argv[2] ?? process.env.AGENT_TERM_SOCK ?? "/tmp/agent-term.sock";
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* fresh socket */
  }
  const manager = new SessionManager();

  Bun.listen({
    unix: sockPath,
    socket: {
      open(socket) {
        (socket as any).buf = "";
      },
      data(socket, data) {
        const self = socket as any;
        self.buf += data.toString("utf8");
        let nl: number;
        while ((nl = self.buf.indexOf("\n")) !== -1) {
          const line = self.buf.slice(0, nl);
          self.buf = self.buf.slice(nl + 1);
          if (!line.trim()) continue;
          void (async () => {
            let id: IpcRequest["id"] = null as any;
            try {
              const req = JSON.parse(line) as IpcRequest;
              id = req.id;
              const result = await handleIpc(manager, req);
              socket.write(JSON.stringify({ id, ok: true, result }) + "\n");
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              socket.write(JSON.stringify({ id, ok: false, error: msg }) + "\n");
            }
          })();
        }
      },
    },
  });

  process.on("SIGTERM", () => {
    manager.shutdown();
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    process.exit(0);
  });
  console.error(`[agent-term] IPC daemon listening on ${sockPath}`);
}

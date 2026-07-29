/**
 * SessionManager: owns all live sessions and the global job registry, and is
 * the single object the MCP tool layer talks to.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session, type Job } from "./session";

export interface ManagerOptions {
  /** Where raw logs and generated rcfiles live. */
  runtimeDir?: string;
  /** Default quiet window for the awaiting-input detector (ms). */
  quietMs?: number;
}

let sessionCounter = 0;

export class SessionManager {
  readonly runtimeDir: string;
  private sessions = new Map<string, Session>();
  private jobIndex = new Map<string, Job>();
  private quietMs?: number;

  constructor(opts: ManagerOptions = {}) {
    this.runtimeDir =
      opts.runtimeDir ??
      process.env.AGENT_TERM_HOME ??
      path.join(os.homedir(), ".agent-term");
    this.quietMs = opts.quietMs;
    fs.mkdirSync(this.runtimeDir, { recursive: true });
  }

  async createSession(opts: { name?: string; cwd?: string; shell?: string } = {}): Promise<Session> {
    sessionCounter += 1;
    const id = `s${sessionCounter}`;
    const name = opts.name ?? id;
    for (const s of this.sessions.values()) {
      if (s.alive && s.name === name) {
        throw new Error(
          `a live session named "${name}" already exists (${s.id}). ` +
            `Pick another name or session_kill it first.`,
        );
      }
    }
    const cwd = opts.cwd ?? process.cwd();
    if (!fs.existsSync(cwd)) {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
    const session = new Session({
      id,
      name,
      shell,
      cwd,
      runtimeDir: this.runtimeDir,
      quietMs: this.quietMs,
    });
    this.sessions.set(id, session);
    const ok = await session.ready();
    if (!ok) {
      session.kill();
      this.sessions.delete(id);
      throw new Error(
        `shell "${shell}" never painted a prompt (no OSC 133 A within 5s); ` +
          `is it a real interactive shell?`,
      );
    }
    return session;
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  getSession(idOrName: string): Session {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;
    const byName = [...this.sessions.values()].find((s) => s.name === idOrName && s.alive);
    if (byName) return byName;
    const known = [...this.sessions.values()].map((s) => `${s.id} ("${s.name}")`).join(", ");
    throw new Error(
      `no session "${idOrName}". Known sessions: ${known || "(none)"}. Use session_create first.`,
    );
  }

  run(sessionIdOrName: string, command: string): Job {
    const session = this.getSession(sessionIdOrName);
    const job = session.run(command);
    this.jobIndex.set(job.id, job);
    return job;
  }

  getJob(jobId: string): { job: Job; session: Session } {
    const job = this.jobIndex.get(jobId);
    if (!job) {
      throw new Error(
        `no job "${jobId}". Job ids look like "job-3" and come from run(); ` +
          `use session_list to see sessions and their jobs.`,
      );
    }
    const session = this.sessions.get(job.sessionId);
    if (!session) throw new Error(`job ${jobId}'s session ${job.sessionId} is gone`);
    return { job, session };
  }

  killSession(idOrName: string): void {
    const session = this.getSession(idOrName);
    session.kill();
  }

  /** Kill everything (daemon shutdown). */
  shutdown(): void {
    for (const s of this.sessions.values()) s.kill();
  }
}

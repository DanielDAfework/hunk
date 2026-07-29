/**
 * A Session is one persistent shell on a real PTY, plus the job machinery on
 * top: a FIFO queue of commands, OSC 133-driven lifecycle, per-job output
 * capture, an awaiting-input poller, and a raw byte log on disk for the human
 * mirror plane.
 *
 * Job phases relative to the marker stream:
 *   queued        — in the FIFO, command not yet written to the shell
 *   (submitted)   — command written, waiting for OSC 133 C
 *   running       — C seen; data chunks are this job's output
 *   awaiting-input— heuristic says the job is blocked reading input
 *   exited/killed — D seen (exit code recorded); killed if we sent the signal
 *
 * Output outside any job (prompt paints, command echo before C, output from
 * disowned background processes between jobs) lands in `orphanOutput` — see
 * open question 2 in FINDINGS.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type IPty } from "bun-pty";
import { Osc133Parser } from "./markers";
import { JobOutput } from "./store";
import { prepareShell } from "./shellIntegration";
import { assessAwaitingInput } from "./detector";
import { readStat } from "./procfs";
import type { JobDigest, JobState } from "./types";

export interface Job {
  id: string;
  sessionId: string;
  command: string;
  state: JobState;
  exitCode: number | null;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  output: JobOutput;
  lastOutputAt: number;
  /** Signal name if job_kill was requested; colors the terminal state. */
  killRequested: string | null;
  awaitingReason?: string;
  notes: string[];
}

export interface SessionOptions {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  runtimeDir: string;
  cols?: number;
  rows?: number;
  /** Quiet window before the awaiting-input detector runs. */
  quietMs?: number;
  env?: Record<string, string>;
}

let jobCounter = 0;

export class Session {
  readonly id: string;
  readonly name: string;
  readonly shell: string;
  readonly cwd: string;
  readonly createdAt = Date.now();
  readonly rawLogPath: string;
  readonly jobs: Job[] = [];
  /** Data that arrived outside any job's C..D window. */
  orphanOutput = new JobOutput();
  alive = true;

  private pty: IPty;
  private parser = new Osc133Parser();
  private queue: Job[] = [];
  private activeJob: Job | null = null;
  /** True between writing a command and seeing its C marker. */
  private awaitingStart = false;
  private promptReady = false;
  private rawFd: number;
  private rawBytes = 0;
  private quietMs: number;
  private pollTimer: ReturnType<typeof setInterval>;
  private detectorBusy = false;
  private waiters = new Set<() => void>();

  constructor(opts: SessionOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.shell = opts.shell;
    this.cwd = opts.cwd;
    this.quietMs = opts.quietMs ?? 1500;

    const sessionDir = path.join(opts.runtimeDir, "sessions", this.id);
    fs.mkdirSync(sessionDir, { recursive: true });
    this.rawLogPath = path.join(sessionDir, "stream.raw");
    this.rawFd = fs.openSync(this.rawLogPath, "a");

    const launch = prepareShell(opts.shell, sessionDir);
    this.pty = spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...launch.env,
        ...(opts.env ?? {}),
        AGENT_TERM: "1",
        // Sane defaults for agent consumption: no pagers-in-pagers, stable width.
        COLUMNS: String(opts.cols ?? 100),
      },
    });
    this.pty.onData((d) => this.onData(d));
    this.pty.onExit(() => this.onShellExit());
    this.pollTimer = setInterval(() => void this.pollAwaiting(), 500);
  }

  get shellPid(): number {
    return this.pty.pid;
  }

  get activeJobCount(): number {
    return (this.activeJob ? 1 : 0) + this.queue.length;
  }

  /** Wait until the first shell prompt has painted (session is usable). */
  async ready(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.promptReady && this.alive && Date.now() < deadline) {
      await sleep(25);
    }
    return this.promptReady;
  }

  /** Enqueue a command as a job. Returns immediately; the job runs async. */
  run(command: string): Job {
    if (!this.alive) throw new Error(`session ${this.id} is dead (shell exited)`);
    jobCounter += 1;
    const job: Job = {
      id: `job-${jobCounter}`,
      sessionId: this.id,
      command,
      state: "queued",
      exitCode: null,
      queuedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      output: new JobOutput(),
      lastOutputAt: Date.now(),
      killRequested: null,
      notes: [],
    };
    this.jobs.push(job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /** Write raw input to the PTY (for answering prompts). */
  sendInput(text: string, endWithNewline: boolean): void {
    if (!this.alive) throw new Error(`session ${this.id} is dead (shell exited)`);
    this.pty.write(text + (endWithNewline ? "\r" : ""));
    const job = this.activeJob;
    if (job && job.state === "awaiting-input") {
      job.state = "running";
      job.awaitingReason = undefined;
      job.lastOutputAt = Date.now();
    }
  }

  /**
   * Signal the job's foreground process group. The job still terminates via
   * the shell (we'll see D), so state flips to killed/exited on the marker.
   */
  killJob(job: Job, signal: string): void {
    if (job.state === "exited" || job.state === "killed") {
      throw new Error(`job ${job.id} already finished (state=${job.state})`);
    }
    if (job.state === "queued") {
      this.queue = this.queue.filter((j) => j !== job);
      job.state = "killed";
      job.endedAt = Date.now();
      job.notes.push("killed while still queued; never ran");
      this.notifyWaiters();
      return;
    }
    const stat = readStat(this.shellPid);
    job.killRequested = signal;
    if (stat && stat.tpgid > 0 && stat.tpgid !== stat.pgrp) {
      // Negative pid = whole foreground process group.
      process.kill(-stat.tpgid, signal as NodeJS.Signals);
    } else {
      // Foreground group is the shell itself (builtin like `read`): send the
      // signal through the tty instead of nuking the shell.
      if (signal === "SIGINT" || signal === "SIGTERM") {
        this.pty.write("\x03"); // ^C
      } else {
        throw new Error(
          `job ${job.id} has no foreground child to signal (shell builtin?). ` +
            `Sent nothing. Use send_input to answer it, or signal=SIGINT to ^C it.`,
        );
      }
    }
  }

  /** Kill the whole session: shell, pty, timers. */
  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.pollTimer);
    for (const job of [this.activeJob, ...this.queue]) {
      if (job && job.state !== "exited" && job.state !== "killed") {
        job.state = "killed";
        job.endedAt = Date.now();
        job.notes.push("session killed while job was active");
      }
    }
    this.activeJob = null;
    this.queue = [];
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
    fs.closeSync(this.rawFd);
    this.notifyWaiters();
  }

  /** Block until the job reaches a terminal or awaiting-input state, or timeout. */
  async wait(job: Job, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      job.state !== "exited" &&
      job.state !== "killed" &&
      job.state !== "awaiting-input" &&
      Date.now() < deadline
    ) {
      let waiter: (() => void) | null = null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(deadline - Date.now(), 250));
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(waiter);
      });
      if (waiter) this.waiters.delete(waiter);
    }
  }

  digest(job: Job): JobDigest {
    const preview = job.output.digestPreview();
    const digest: JobDigest = {
      job_id: job.id,
      session_id: this.id,
      command: job.command,
      state: job.state,
      exit_code: job.exitCode,
      duration_ms:
        job.startedAt !== null && job.endedAt !== null ? job.endedAt - job.startedAt : null,
      bytes: job.output.bytes,
      line_count: preview.lineCount,
      estimated_tokens: preview.tokens,
      head: preview.head,
      tail: preview.tail,
      notes: [...preview.notes, ...job.notes],
      tui_mode: preview.tuiMode,
    };
    if (job.state === "awaiting-input") {
      digest.awaiting_reason = job.awaitingReason;
      digest.awaiting_tail = preview.tail.length > 0 ? preview.tail.slice(-5) : preview.head.slice(-5);
    }
    return digest;
  }

  // ---- internals ----------------------------------------------------------

  private pump(): void {
    if (!this.alive || !this.promptReady) return;
    if (this.activeJob || this.awaitingStart) return;
    const job = this.queue.shift();
    if (!job) return;
    this.activeJob = job;
    this.awaitingStart = true;
    job.lastOutputAt = Date.now();
    this.pty.write(job.command + "\r");
  }

  private onData(chunk: string): void {
    // Raw log first: byte-faithful, includes markers and escapes.
    const buf = Buffer.from(chunk, "utf8");
    fs.writeSync(this.rawFd, buf);
    this.rawBytes += buf.length;

    for (const ev of this.parser.feed(chunk)) {
      if (ev.kind === "data") {
        const job = this.activeJob;
        if (job && !this.awaitingStart) {
          job.output.feed(ev.data);
          job.output.rawEnd = this.rawBytes;
          job.lastOutputAt = Date.now();
          if (job.state === "awaiting-input") {
            // Output resumed on its own — the heuristic was wrong or the
            // program moved on. Flip back silently.
            job.state = "running";
            job.awaitingReason = undefined;
          }
        } else {
          // Prompt paint / command echo / between-jobs background noise.
          this.orphanOutput.feed(ev.data);
        }
        continue;
      }
      const m = ev.marker;
      if (m.type === "C") {
        const job = this.activeJob;
        if (job && this.awaitingStart) {
          this.awaitingStart = false;
          job.state = "running";
          job.startedAt = Date.now();
          job.output.rawStart = this.rawBytes;
          job.lastOutputAt = Date.now();
        }
      } else if (m.type === "D") {
        const job = this.activeJob;
        if (job && !this.awaitingStart) {
          job.exitCode = m.exitCode;
          job.endedAt = Date.now();
          job.state = job.killRequested !== null ? "killed" : "exited";
          if (job.killRequested !== null) {
            job.notes.push(`terminated after job_kill(${job.killRequested}); shell reported exit code ${m.exitCode}`);
          }
          this.activeJob = null;
          this.notifyWaiters();
        } else if (job && this.awaitingStart) {
          // D with no C: the submitted line never became a command (e.g. the
          // shell treated it as empty). Close the job out honestly.
          job.exitCode = m.exitCode;
          job.endedAt = Date.now();
          job.startedAt = job.startedAt ?? job.endedAt;
          job.state = "exited";
          job.notes.push("no command-start marker seen; command may have been empty or swallowed by the shell");
          this.awaitingStart = false;
          this.activeJob = null;
          this.notifyWaiters();
        }
      } else if (m.type === "A") {
        this.promptReady = true;
        this.pump();
      }
    }
    // A marker can complete a job while another sits queued and no further
    // data arrives; make sure the queue advances.
    this.pump();
  }

  private onShellExit(): void {
    if (!this.alive) return;
    const hadActive = this.activeJob;
    this.kill();
    if (hadActive) hadActive.notes.push("shell process exited while job was active");
  }

  private async pollAwaiting(): Promise<void> {
    const job = this.activeJob;
    if (!job || job.state !== "running" || this.detectorBusy) return;
    if (Date.now() - job.lastOutputAt < this.quietMs) return;
    this.detectorBusy = true;
    try {
      const snap = job.output.snapshot();
      const res = await assessAwaitingInput({
        shellPid: this.shellPid,
        tailLines: snap.lines.slice(-5),
      });
      // Re-check state: output may have arrived while stty ran.
      if (
        res.awaiting &&
        this.activeJob === job &&
        job.state === "running" &&
        Date.now() - job.lastOutputAt >= this.quietMs
      ) {
        job.state = "awaiting-input";
        job.awaitingReason = res.reason;
        this.notifyWaiters();
      }
    } finally {
      this.detectorBusy = false;
    }
  }

  private notifyWaiters(): void {
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

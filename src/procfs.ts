/**
 * Linux /proc helpers used by the awaiting-input detector.
 *
 * The daemon holds no direct handle on the PTY slave (bun-pty doesn't expose
 * it), but the shell's pid is enough: /proc/<pid>/fd/0 names the slave tty,
 * /proc/<pid>/stat carries the process-group and foreground-process-group
 * ids, and `stty -F <slave>` reads the live termios flags.
 */

import * as fs from "node:fs";

export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  pgrp: number;
  /** Foreground process group of the controlling terminal. */
  tpgid: number;
}

/** Parse /proc/<pid>/stat (comm may contain spaces/parens — split after the last ')'). */
export function readStat(pid: number): ProcStat | null {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const comm = text.slice(text.indexOf("(") + 1, close);
  const rest = text.slice(close + 2).split(" ");
  // rest[0]=state rest[1]=ppid rest[2]=pgrp rest[3]=session rest[4]=tty_nr rest[5]=tpgid
  return {
    pid,
    comm,
    state: rest[0] ?? "?",
    pgrp: Number(rest[2]),
    tpgid: Number(rest[5]),
  };
}

/** The tty path the shell's stdin points at (the PTY slave), or null. */
export function ttyOfPid(pid: number): string | null {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/fd/0`);
    return link.startsWith("/dev/") ? link : null;
  } catch {
    return null;
  }
}

/** Command name of the foreground process group leader, if resolvable. */
export function commOfPid(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return null;
  }
}

/** Numeric dirs in /proc whose stat pgrp matches — the foreground process group. */
export function listPgrpMembers(pgid: number, limit = 64): ProcStat[] {
  const out: ProcStat[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const st = readStat(Number(e));
    if (st && st.pgrp === pgid) {
      out.push(st);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** read(2) syscall number by architecture (Linux). */
const READ_SYSCALL_NR: Record<string, number> = { x64: 0, arm64: 63 };

/**
 * True if the process is currently blocked in read(2) on a terminal fd —
 * the most direct "waiting for keyboard input" signal Linux offers.
 * /proc/<pid>/syscall shows "<nr> <arg0> <arg1> ..." while blocked.
 */
export function isBlockedReadingTty(pid: number): boolean {
  const nr = READ_SYSCALL_NR[process.arch];
  if (nr === undefined) return false;
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/syscall`, "utf8").trim();
  } catch {
    return false;
  }
  if (text === "running" || text.startsWith("-1")) return false;
  const parts = text.split(/\s+/);
  if (Number(parts[0]) !== nr) return false;
  const fd = parseInt(parts[1] ?? "", 16);
  if (!Number.isFinite(fd) || fd < 0) return false;
  try {
    const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    return target.startsWith("/dev/pts/") || target.startsWith("/dev/tty");
  } catch {
    return false;
  }
}

export interface TermiosFlags {
  echo: boolean;
  icanon: boolean;
}

/**
 * Read live termios flags off a tty by shelling out to `stty -a -F <tty>`.
 * Spawning a process per check is fine: the detector only runs when a job has
 * gone quiet, not on every output chunk.
 */
export async function readTermios(ttyPath: string): Promise<TermiosFlags | null> {
  try {
    const proc = Bun.spawn(["stty", "-a", "-F", ttyPath], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return {
      echo: !/(^|[\s;])-echo\b/.test(out),
      icanon: !/(^|[\s;])-icanon\b/.test(out),
    };
  } catch {
    return null;
  }
}

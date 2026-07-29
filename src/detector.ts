/**
 * Awaiting-input detection — deliberately a *heuristic*, and labeled as such
 * in the job state ("awaiting-input" is always "suspected").
 *
 * The detector only runs when a job has been quiet for the configured window
 * and has not exited. It then combines three signals:
 *
 *   1. blocked-read (strong): some process in the foreground process group is
 *      blocked in read(2) on a terminal fd (/proc/<pid>/syscall). This is the
 *      most direct "waiting for keyboard" evidence Linux offers and covers
 *      bash `read`, python input(), sudo/su (via /dev/tty), rm -i, apt, git
 *      credential prompts...
 *   2. termios anomaly (strong): the PTY slave has echo off (password prompt)
 *      or canonical mode off with a foreground child (pager/TUI/readline in
 *      raw mode — covers node/npm, less, vim...).
 *   3. trailing-line prompt patterns: strong shapes (password/pager/yes-no)
 *      are sufficient alone; weak shapes (trailing "?" or ":") only *label*
 *      a detection made by signals 1–2 — ordinary build output ends with
 *      colons far too often to trust them alone. The eval in
 *      test/detector-eval.test.ts measures exactly this trade-off.
 */

import {
  isBlockedReadingTty,
  listPgrpMembers,
  readStat,
  readTermios,
  ttyOfPid,
  commOfPid,
} from "./procfs";

export interface PromptPattern {
  name: string;
  re: RegExp;
  /** strong: sufficient alone. weak: only annotates other signals. */
  strength: "strong" | "weak";
}

/** Ordered: first match wins, most specific first. */
export const PROMPT_PATTERNS: PromptPattern[] = [
  { name: "password", re: /pass(word|phrase)[^:]*:?\s*$/i, strength: "strong" },
  { name: "pager", re: /\(END\)\s*$|--More--\s*$|^:\s*$|lines \d+-\d+/, strength: "strong" },
  { name: "yes-no", re: /\[y(es)?\/n[^\]]*\]\s*\??\s*$|\(y(es)?\/no?\)\s*\??\s*:?\s*$/i, strength: "strong" },
  { name: "continue", re: /press\s+.*(enter|return|any key|q)\b.*\s*(to|for)\s+/i, strength: "strong" },
  { name: "question", re: /\?\s*$/, strength: "weak" },
  { name: "colon", re: /:\s*$/, strength: "weak" },
];

/** Match the last non-empty trailing line against the prompt patterns. */
export function matchPromptPattern(tailLines: string[]): string | null {
  const p = matchPattern(tailLines);
  return p ? p.name : null;
}

function matchPattern(tailLines: string[]): PromptPattern | null {
  const last = [...tailLines].reverse().find((l) => l.trim().length > 0);
  if (last === undefined) return null;
  for (const p of PROMPT_PATTERNS) {
    if (p.re.test(last)) return p;
  }
  return null;
}

export interface AwaitingAssessment {
  awaiting: boolean;
  /** e.g. "blocked reading tty (python3); prompt pattern: colon" */
  reason?: string;
}

/**
 * Full assessment for a live job. Caller guarantees: job is running (no OSC
 * 133 D yet) and has produced no output for at least the quiet window.
 */
export async function assessAwaitingInput(opts: {
  shellPid: number;
  tailLines: string[];
}): Promise<AwaitingAssessment> {
  const stat = readStat(opts.shellPid);
  if (!stat) return { awaiting: false };

  const pattern = matchPattern(opts.tailLines);
  const patternLabel = pattern ? `; prompt pattern: ${pattern.name}` : "";

  // Signal 1: someone in the foreground group blocked in read(2) on a tty.
  // (When the fg group is the shell's own group — e.g. the `read` builtin —
  // this still works: the shell itself is the blocked reader.)
  const fgPgid = stat.tpgid;
  if (fgPgid > 0) {
    for (const member of listPgrpMembers(fgPgid)) {
      if (isBlockedReadingTty(member.pid)) {
        return {
          awaiting: true,
          reason: `blocked reading tty (${member.comm})${patternLabel}`,
        };
      }
    }
  }

  // Signal 2: termios flipped on the slave tty.
  const tty = ttyOfPid(opts.shellPid);
  if (tty) {
    const t = await readTermios(tty);
    if (t) {
      if (!t.echo) {
        return {
          awaiting: true,
          reason: `termios: echo off (password-style prompt likely)${patternLabel}`,
        };
      }
      // Raw mode with a foreground child = interactive program reading keys.
      // Not trusted when the shell itself owns the terminal (it toggles modes
      // around command startup).
      if (!t.icanon && fgPgid !== stat.pgrp) {
        const fgComm = commOfPid(fgPgid);
        return {
          awaiting: true,
          reason: `termios: raw mode (pager/TUI reading keys${fgComm ? `: ${fgComm}` : ""})${patternLabel}`,
        };
      }
    }
  }

  // Signal 3: strong trailing-line prompt shapes stand on their own.
  if (pattern && pattern.strength === "strong") {
    return { awaiting: true, reason: `prompt pattern: ${pattern.name}` };
  }

  return { awaiting: false };
}

/**
 * Per-job output store: the queryable, token-accounted view over a job's
 * normalized output. Agents never get raw output by default — they get a
 * digest, then drill in through query modes.
 */

import { StreamNormalizer } from "./normalize";
import { ScreenRenderer, ALT_SCREEN_ENTER_RE } from "./screen";
import { estimateTokens, estimateTokensLines } from "./tokens";
import type { OutputQuery, QueryResult, JobState } from "./types";

export const DIGEST_HEAD_LINES = 10;
export const DIGEST_TAIL_LINES = 20;

/** Thrown for query errors; the message is written to teach the calling agent. */
export class QueryError extends Error {}

export class JobOutput {
  private normalizer = new StreamNormalizer();
  /** Lazily created the first time the job enters the alternate screen. */
  private renderer: ScreenRenderer | null = null;
  private cols: number;
  private rows: number;
  /** Byte offsets of this job's output inside the session raw log. */
  rawStart = 0;
  rawEnd = 0;

  constructor(cols = 100, rows = 30) {
    this.cols = cols;
    this.rows = rows;
  }

  feed(data: string): void {
    this.normalizer.feed(data);
    // TUI detected: from here on, mirror the raw stream into a headless
    // terminal so {mode:"screen"} can render the real viewport.
    if (!this.renderer && ALT_SCREEN_ENTER_RE.test(data)) {
      this.renderer = new ScreenRenderer(this.cols, this.rows);
    }
    this.renderer?.write(data);
  }

  get hasScreen(): boolean {
    return this.renderer !== null;
  }

  /**
   * Render the current terminal viewport (TUI jobs only). Async because
   * xterm parses writes asynchronously and we must flush first.
   */
  async queryScreen(jobId: string, state: JobState): Promise<QueryResult> {
    if (!this.renderer) {
      throw new QueryError(
        `job ${jobId} never entered the alternate screen, so there is no screen to render. ` +
          `{mode:"screen"} is for full-screen TUI programs (less, vim, htop); ` +
          `for ordinary scrollback output use tail, slice, or grep.`,
      );
    }
    await this.renderer.flush();
    const lines = this.renderer.renderLines();
    const text = lines.join("\n");
    const returned = estimateTokens(text);
    return {
      job_id: jobId,
      state,
      mode: "screen",
      text,
      total_lines: lines.length,
      returned_estimated_tokens: returned,
      remaining_estimated_tokens: 0,
      notes: [
        `[rendered ${this.renderer.cols}x${this.renderer.rows} terminal viewport via headless emulation; this is what a human sees right now]`,
      ],
    };
  }

  get bytes(): number {
    return this.normalizer.bytes;
  }

  snapshot() {
    return this.normalizer.snapshot();
  }

  /** head/tail preview used inside the job digest. */
  digestPreview(): { head: string[]; tail: string[]; lineCount: number; tokens: number; notes: string[]; tuiMode: boolean } {
    const snap = this.snapshot();
    const { lines } = snap;
    let head: string[];
    let tail: string[];
    if (lines.length <= DIGEST_HEAD_LINES + DIGEST_TAIL_LINES) {
      head = lines;
      tail = [];
    } else {
      head = lines.slice(0, DIGEST_HEAD_LINES);
      tail = lines.slice(-DIGEST_TAIL_LINES);
    }
    const notes = [...snap.notes];
    if (snap.tuiMode && this.renderer) {
      notes.push('[read_output {mode:"screen"} returns the faithfully rendered current screen]');
    }
    return {
      head,
      tail,
      lineCount: lines.length,
      tokens: estimateTokensLines(lines),
      notes,
      tuiMode: snap.tuiMode,
    };
  }

  /**
   * Execute a read_output query. All line numbers in the public surface are
   * 1-indexed and inclusive, which is what agents (and humans) expect from
   * anything that looks like sed/head/tail addressing.
   */
  query(jobId: string, state: JobState, q: OutputQuery): QueryResult {
    const snap = this.snapshot();
    const lines = snap.lines;
    const totalTokens = estimateTokensLines(lines);

    const base = {
      job_id: jobId,
      state,
      mode: q.mode,
      total_lines: lines.length,
      notes: snap.notes,
    };

    const finish = (
      selected: string[],
      extra: Partial<QueryResult> = {},
    ): QueryResult => {
      const text = selected.join("\n");
      const returned = estimateTokens(text);
      return {
        ...base,
        text,
        returned_estimated_tokens: returned,
        remaining_estimated_tokens: Math.max(0, totalTokens - returned),
        ...extra,
      };
    };

    switch (q.mode) {
      case "head": {
        const n = clampCount(q.lines);
        const sel = lines.slice(0, n);
        return finish(sel, { range: rangeOf(1, sel.length) });
      }
      case "tail": {
        const n = clampCount(q.lines);
        const sel = lines.slice(-n);
        const start = lines.length - sel.length + 1;
        return finish(sel, { range: rangeOf(start, lines.length) });
      }
      case "slice": {
        if (q.start < 1 || q.end < q.start) {
          throw new QueryError(
            `slice needs 1 <= start <= end (got start=${q.start}, end=${q.end}). ` +
              `Lines are 1-indexed and inclusive; this job has ${lines.length} lines.`,
          );
        }
        const sel = lines.slice(q.start - 1, q.end);
        return finish(sel, {
          range: sel.length > 0 ? { start: q.start, end: q.start + sel.length - 1 } : undefined,
        });
      }
      case "grep": {
        let re: RegExp;
        try {
          re = new RegExp(q.pattern);
        } catch (e) {
          throw new QueryError(
            `grep pattern is not a valid JavaScript regex: ${(e as Error).message}. ` +
              `Remember to escape literal special characters like ( ) [ ] . * +`,
          );
        }
        const context = q.context ?? 2;
        const maxMatches = q.max_matches ?? 20;
        const matchIdx: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) matchIdx.push(i);
        }
        const shown = matchIdx.slice(0, maxMatches);
        const blocks: string[] = [];
        let lastEnd = -1;
        for (const idx of shown) {
          const start = Math.max(0, idx - context);
          const end = Math.min(lines.length - 1, idx + context);
          if (start > lastEnd + 1 && blocks.length > 0) blocks.push("--");
          for (let i = Math.max(start, lastEnd + 1); i <= end; i++) {
            blocks.push(`${i + 1}:${lines[i]}`);
          }
          lastEnd = Math.max(lastEnd, end);
        }
        const res = finish(blocks, { total_matches: matchIdx.length });
        if (matchIdx.length > maxMatches) {
          res.notes = [
            ...res.notes,
            `[${matchIdx.length - maxMatches} more matches not shown; raise max_matches or narrow the pattern]`,
          ];
        }
        return res;
      }
      case "full": {
        if (totalTokens > q.confirm_tokens) {
          throw new QueryError(
            `Refusing full read: output is ~${totalTokens} estimated tokens but confirm_tokens=${q.confirm_tokens}. ` +
              `If you really want everything, call read_output again with {mode:"full", confirm_tokens:${totalTokens}} or higher. ` +
              `Cheaper options: {mode:"grep"} to find what you need, {mode:"tail", lines:50} for the end, or {mode:"slice"} for a range.`,
          );
        }
        return finish(lines, { range: rangeOf(1, lines.length) });
      }
      case "screen":
        // Screen rendering must flush the async emulator; the tool layer
        // routes it to queryScreen(). Reaching here is an internal misroute.
        throw new QueryError(`screen mode is handled by queryScreen(); this is a daemon bug.`);
      case "delta": {
        if (q.since_line < 0) {
          throw new QueryError(`delta needs since_line >= 0 (0 means "from the beginning").`);
        }
        const sel = lines.slice(q.since_line);
        return finish(sel, {
          range: sel.length > 0 ? { start: q.since_line + 1, end: lines.length } : undefined,
          last_line: lines.length,
        });
      }
    }
  }
}

function clampCount(n: number): number {
  if (!Number.isFinite(n) || n < 1) {
    throw new QueryError(`lines must be a positive integer (got ${n}).`);
  }
  return Math.floor(n);
}

function rangeOf(start: number, end: number): { start: number; end: number } | undefined {
  return end >= start ? { start, end } : undefined;
}

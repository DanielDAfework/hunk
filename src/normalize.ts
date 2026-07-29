/**
 * Streaming output normalizer: turns a raw PTY byte stream into clean,
 * queryable text lines while counting what it collapsed.
 *
 * Design constraints (from the brief):
 *  - Strip ANSI escapes for the stored queryable text.
 *  - Collapse carriage-return / cursor-movement redraws: a progress bar that
 *    rewrote one line 5,000 times stores the final frame plus an overwrite
 *    count.
 *  - Detect alternate-screen (full-screen TUI) output and flag it; keep a
 *    best-effort "final frame" by treating clear-screen / cursor-home as
 *    frame boundaries.
 *  - Normalization is lossy by design; the raw stream is kept on disk by the
 *    session, so everything here is lossless-recoverable from the raw log.
 *
 * This is intentionally NOT a terminal emulator. Cursor-up redraws (npm,
 * cargo, spinners) are approximated by popping the lines a program moved up
 * over — which matches the overwhelmingly common "move up N, rewrite N lines"
 * repaint pattern — and every such approximation is counted and surfaced in
 * `notes` so an agent knows when to fall back to the raw log.
 */

export interface NormalizedSnapshot {
  lines: string[];
  /** Total single-line overwrites collapsed (CR redraws). */
  collapsedOverwrites: number;
  /** Lines removed by cursor-up repaint approximation. */
  collapsedRepaintLines: number;
  /** Frames dropped inside the alternate screen (clear/home boundaries). */
  droppedTuiFrames: number;
  tuiMode: boolean;
  bytes: number;
  notes: string[];
}

const ESC = "\x1b";
const BEL = "\x07";

/** Overwritten frames matching this are preserved instead of collapsed. */
const INTERESTING_FRAME_RE = /\b(error|warn(ing)?|fail(ed|ure)?|fatal|timeout|refused|denied)s?\b/i;
/** Bound on preserved frames so a progress bar containing "error" in every
 * repaint (e.g. "0 errors") can't flood the store. */
const MAX_KEPT_FRAMES = 20;

export class StreamNormalizer {
  private lines: string[] = [];
  private current = "";
  /** Set when a bare CR was seen; the next printable char overwrites the line. */
  private crPending = false;
  /** Partial escape sequence carried across chunk boundaries. */
  private pendingEsc = "";
  private altScreen = false;
  /** Index into `lines` where the current TUI frame starts. */
  private frameStart = 0;

  bytes = 0;
  tuiMode = false;
  collapsedOverwrites = 0;
  collapsedRepaintLines = 0;
  droppedTuiFrames = 0;
  keptFrames = 0;

  feed(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk, "utf8");
    let buf = this.pendingEsc + chunk;
    this.pendingEsc = "";
    let i = 0;

    while (i < buf.length) {
      const ch = buf[i]!;

      if (ch === ESC) {
        const consumed = this.consumeEscape(buf, i);
        if (consumed === -1) {
          // Partial escape at chunk end: hold it (bounded — a garbage ESC
          // that never terminates gets flushed as data).
          const tail = buf.slice(i);
          if (tail.length <= 512) {
            this.pendingEsc = tail;
            return;
          }
          i += 1; // give up on this ESC, emit nothing for it
          continue;
        }
        i += consumed;
        continue;
      }

      if (ch === "\r") {
        // CR might be part of CRLF (plain newline) — decide on the next char.
        this.crPending = true;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.crPending = false;
        this.pushLine();
        i += 1;
        continue;
      }
      if (this.crPending) {
        // Printable after bare CR: the program is redrawing this line.
        if (this.current.length > 0) {
          // Open question 1 mitigation: a transient frame that looks like a
          // diagnostic ("error: mirror timeout" flashed inside a progress
          // line) is the one thing collapsing could destroy that an agent
          // actually needs. Keep a bounded number of such frames as real
          // lines instead of dropping them.
          if (this.keptFrames < MAX_KEPT_FRAMES && INTERESTING_FRAME_RE.test(this.current)) {
            this.pushLine();
            this.keptFrames += 1;
          } else {
            this.collapsedOverwrites += 1;
            this.current = "";
          }
        }
        this.crPending = false;
      }
      if (ch === "\b") {
        this.current = this.current.slice(0, -1);
        i += 1;
        continue;
      }
      if (ch === BEL || (ch < " " && ch !== "\t")) {
        i += 1;
        continue;
      }
      this.current += ch;
      i += 1;
    }
  }

  /**
   * Consume one escape sequence starting at buf[start] (an ESC).
   * Returns chars consumed, or -1 if the sequence is incomplete (chunk split).
   */
  private consumeEscape(buf: string, start: number): number {
    const next = buf[start + 1];
    if (next === undefined) return -1;

    if (next === "[") {
      // CSI: ESC [ params... final (0x40–0x7E)
      let j = start + 2;
      while (j < buf.length) {
        const c = buf.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          this.handleCsi(buf.slice(start + 2, j), buf[j]!);
          return j - start + 1;
        }
        j += 1;
      }
      return -1;
    }
    if (next === "]") {
      // OSC: ESC ] ... (BEL | ESC \)
      let j = start + 2;
      while (j < buf.length) {
        if (buf[j] === BEL) return j - start + 1;
        if (buf[j] === ESC) {
          if (buf[j + 1] === "\\") return j - start + 2;
          if (buf[j + 1] === undefined) return -1;
        }
        j += 1;
      }
      return -1;
    }
    if (next === "(" || next === ")" || next === "#" || next === "%") {
      // Charset / line-attr sequences: ESC ( B etc — 3 chars.
      return buf[start + 2] === undefined ? -1 : 3;
    }
    // Two-char sequences: ESC =, ESC >, ESC M, ESC 7/8, and the ST tail.
    return 2;
  }

  /** Interpret the CSI sequences that affect our line model; drop the rest. */
  private handleCsi(params: string, final: string): void {
    if (final === "h" || final === "l") {
      // Alternate screen enter/exit (?1049, ?1047, ?47).
      if (/^\?(1049|1047|47)$/.test(params)) {
        if (final === "h") {
          this.enterAltScreen();
        } else {
          this.exitAltScreen();
        }
      }
      return;
    }
    if (final === "A" || final === "F") {
      // Cursor up N: approximate a multi-line repaint by popping the lines
      // the program is about to rewrite.
      const n = Math.max(1, parseInt(params || "1", 10) || 1);
      this.flushCurrent();
      const floor = this.altScreen ? this.frameStart : 0;
      const popped = Math.min(n, this.lines.length - floor);
      if (popped > 0) {
        this.lines.length -= popped;
        this.collapsedRepaintLines += popped;
      }
      return;
    }
    if (final === "J") {
      // Erase display. In the alt screen, 2J/3J starts a fresh frame.
      if (this.altScreen && (params === "2" || params === "3")) this.newFrame();
      return;
    }
    if (final === "H" || final === "f") {
      // Cursor position. Home (no params / 1;1) inside alt screen = repaint start.
      if (this.altScreen && (params === "" || params === "1;1")) this.newFrame();
      return;
    }
    if (final === "K") {
      // Erase-in-line: with CR-collapse semantics there is nothing to erase.
      return;
    }
    if (final === "G") {
      // Cursor-to-column: column 1 (or unspecified) is a carriage return in
      // disguise — npm's spinner redraws with ESC[1G ESC[0K instead of \r.
      if (params === "" || params === "1") this.crPending = true;
      return;
    }
    // Everything else (colors, modes, bracketed paste...) is styling: drop.
  }

  private enterAltScreen(): void {
    if (this.altScreen) return;
    this.altScreen = true;
    this.tuiMode = true;
    this.flushCurrent();
    this.frameStart = this.lines.length;
  }

  private exitAltScreen(): void {
    if (!this.altScreen) return;
    this.altScreen = false;
    this.flushCurrent();
  }

  /** Start a new TUI frame: discard the previous frame's lines. */
  private newFrame(): void {
    this.flushCurrent();
    if (this.lines.length > this.frameStart) {
      this.droppedTuiFrames += 1;
      this.lines.length = this.frameStart;
    }
  }

  private pushLine(): void {
    this.lines.push(this.current);
    this.current = "";
  }

  private flushCurrent(): void {
    if (this.current.length > 0) this.pushLine();
    this.crPending = false;
  }

  /** Point-in-time snapshot; safe to call repeatedly on a live stream. */
  snapshot(): NormalizedSnapshot {
    const lines = [...this.lines];
    if (this.current.length > 0) lines.push(this.current);
    // Trim trailing blank lines that are terminal padding, not content.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const notes: string[] = [];
    if (this.collapsedOverwrites > 0)
      notes.push(`[progress output collapsed: ${this.collapsedOverwrites} line updates]`);
    if (this.keptFrames > 0)
      notes.push(
        `[${this.keptFrames} overwritten progress frames preserved because they looked like diagnostics]`,
      );
    if (this.collapsedRepaintLines > 0)
      notes.push(`[multi-line repaints collapsed: ${this.collapsedRepaintLines} rewritten lines removed]`);
    if (this.tuiMode)
      notes.push(
        `[TUI mode: program used the alternate screen; stored text is the final frame` +
          (this.droppedTuiFrames > 0 ? ` (${this.droppedTuiFrames} earlier frames dropped)` : "") +
          `; raw log preserves everything]`,
      );
    return {
      lines,
      collapsedOverwrites: this.collapsedOverwrites,
      collapsedRepaintLines: this.collapsedRepaintLines,
      droppedTuiFrames: this.droppedTuiFrames,
      tuiMode: this.tuiMode,
      bytes: this.bytes,
      notes,
    };
  }
}

/** One-shot convenience for tests and the benchmark. */
export function normalizeText(raw: string): NormalizedSnapshot {
  const n = new StreamNormalizer();
  n.feed(raw);
  return n.snapshot();
}

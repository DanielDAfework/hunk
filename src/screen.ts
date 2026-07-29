/**
 * True terminal-screen rendering for TUI jobs, via @xterm/headless.
 *
 * The streaming normalizer's frame-boundary approximation is fine for
 * scrollback-shaped output, but full-screen programs (less, vim, htop) are
 * only faithfully represented by actually emulating the terminal. This
 * renderer is created lazily — the first time a job's output enters the
 * alternate screen — and from then on receives the same raw data the
 * normalizer sees. `read_output {mode:"screen"}` renders the current
 * viewport exactly as a human would see it, no escape codes.
 *
 * (Idea validated by Forge's `read_screen`; see the prior-art teardown in
 * FINDINGS.md.)
 */

// @xterm/headless ships CJS; under Bun the namespace import carries the class.
import xterm from "@xterm/headless";

/** Matches the alternate-screen-enter sequences (same set normalize.ts handles). */
export const ALT_SCREEN_ENTER_RE = /\x1b\[\?(?:1049|1047|47)h/;

export class ScreenRenderer {
  readonly cols: number;
  readonly rows: number;
  private term: InstanceType<typeof xterm.Terminal>;
  /** Resolves when everything written so far has been parsed. */
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  }

  write(data: string): void {
    this.lastWrite = new Promise((resolve) => this.term.write(data, resolve));
  }

  /** Wait until all pending writes are parsed (xterm parses asynchronously). */
  flush(): Promise<void> {
    return this.lastWrite;
  }

  /**
   * The current viewport as plain text, trailing blank lines trimmed.
   * While a TUI is on the alternate screen this IS the screen; after exit it
   * is whatever the primary buffer shows.
   */
  renderLines(): string[] {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines;
  }

  dispose(): void {
    this.term.dispose();
  }
}

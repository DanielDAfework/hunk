import { describe, expect, test } from "bun:test";
import { normalizeText, StreamNormalizer } from "./normalize";

describe("StreamNormalizer", () => {
  test("strips ANSI color and style escapes", () => {
    const r = normalizeText("\x1b[1;32mgreen bold\x1b[0m plain\n");
    expect(r.lines).toEqual(["green bold plain"]);
  });

  test("CRLF is a plain newline, not an overwrite", () => {
    const r = normalizeText("one\r\ntwo\r\n");
    expect(r.lines).toEqual(["one", "two"]);
    expect(r.collapsedOverwrites).toBe(0);
  });

  test("collapses CR progress redraws to the final frame with a count", () => {
    let raw = "";
    for (let i = 1; i <= 5000; i++) raw += `\rprogress ${i}/5000`;
    raw += "\ndone\n";
    const r = normalizeText(raw);
    expect(r.lines).toEqual(["progress 5000/5000", "done"]);
    expect(r.collapsedOverwrites).toBe(4999);
    expect(r.notes.join(" ")).toContain("4999");
  });

  test("transient diagnostic frames inside a progress line are preserved", () => {
    const raw =
      "\rdownloading 10%" +
      "\rerror: mirror timed out, retrying" +
      "\rdownloading 55%" +
      "\rdownloading 100%\ndone\n";
    const r = normalizeText(raw);
    expect(r.lines).toEqual(["error: mirror timed out, retrying", "downloading 100%", "done"]);
    expect(r.notes.join(" ")).toContain("preserved");
  });

  test("preserved-frame flood is bounded (a '0 errors' progress bar can't spam)", () => {
    let raw = "";
    for (let i = 1; i <= 500; i++) raw += `\rbuilt ${i}/500, 0 errors`;
    raw += "\n";
    const r = normalizeText(raw);
    // 20 kept frames max, plus the final line.
    expect(r.lines.length).toBe(21);
    expect(r.lines.at(-1)).toBe("built 500/500, 0 errors");
  });

  test("ESC[1G column-reset redraws (npm spinner) collapse like CR", () => {
    // npm draws its spinner as ESC[1G ESC[0K <char> repeatedly.
    let raw = "";
    for (const c of ["\\", "|", "/", "-", "\\", "|"]) raw += `\x1b[1G\x1b[0K${c}`;
    raw += "\x1b[1G\x1b[0Kadded 143 packages in 7s\n";
    const r = normalizeText(raw);
    expect(r.lines).toEqual(["added 143 packages in 7s"]);
    expect(r.collapsedOverwrites).toBe(6);
  });

  test("cursor-up repaint approximation pops rewritten lines", () => {
    // Emulates npm-style multi-line spinner: draw 2 lines, move up 2, redraw.
    const raw = "fetching a\r\nfetching b\r\n\x1b[2A\x1b[Kfetched a\r\n\x1b[Kfetched b\r\n";
    const r = normalizeText(raw);
    expect(r.lines).toEqual(["fetched a", "fetched b"]);
    expect(r.collapsedRepaintLines).toBe(2);
  });

  test("escape sequences split across chunk boundaries survive", () => {
    const n = new StreamNormalizer();
    n.feed("hello \x1b[3");
    n.feed("1mred\x1b");
    n.feed("[0m world\n");
    expect(n.snapshot().lines).toEqual(["hello red world"]);
  });

  test("CR split across chunks still collapses", () => {
    const n = new StreamNormalizer();
    n.feed("progress 1\r");
    n.feed("progress 2\r");
    n.feed("progress 3\n");
    expect(n.snapshot().lines).toEqual(["progress 3"]);
    expect(n.snapshot().collapsedOverwrites).toBe(2);
  });

  test("alternate screen flags TUI mode and keeps the final frame", () => {
    const raw =
      "before\n" +
      "\x1b[?1049h" + // enter alt screen
      "frame1 line1\nframe1 line2\n" +
      "\x1b[2J\x1b[H" + // clear + home = new frame
      "frame2 line1\nframe2 line2\n" +
      "\x1b[?1049l" + // exit alt screen
      "after\n";
    const r = normalizeText(raw);
    expect(r.tuiMode).toBe(true);
    expect(r.droppedTuiFrames).toBeGreaterThanOrEqual(1);
    expect(r.lines).toEqual(["before", "frame2 line1", "frame2 line2", "after"]);
    expect(r.notes.join(" ")).toContain("TUI mode");
  });

  test("backspace erases echoed characters", () => {
    const r = normalizeText("cat\b\b\bdog\n");
    expect(r.lines).toEqual(["dog"]);
  });

  test("OSC window-title sequences are dropped", () => {
    const r = normalizeText("\x1b]0;my title\x07real content\n");
    expect(r.lines).toEqual(["real content"]);
  });

  test("bracketed paste guards are dropped", () => {
    const r = normalizeText("\x1b[?2004hprompt$ \x1b[?2004l\rcmd output\n");
    expect(r.lines).toEqual(["cmd output"]);
  });

  test("preserves verbatim content bytes (diff-like output)", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;\n";
    const r = normalizeText(diff);
    expect(r.lines.join("\n") + "\n").toBe(diff);
  });

  test("counts raw bytes fed", () => {
    const n = new StreamNormalizer();
    n.feed("abc");
    n.feed("def\n");
    expect(n.snapshot().bytes).toBe(7);
  });
});

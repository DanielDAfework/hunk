/**
 * Resilience suite ported from tmux's regression tests (regress/
 * input-malformed.sh, input-osc.sh, UTF-8-test.txt) plus chunk-split
 * invariance properties tmux's incremental parser implies.
 *
 * Naming: `tmux:<case>` marks a direct port of a tmux regress case; the
 * expected surviving text matches tmux's check_capture expectation.
 */
import { describe, expect, test } from "bun:test";
import { normalizeText, StreamNormalizer } from "./normalize";

/** Feed `raw` in chunks of `size` and snapshot. */
function normalizeChunked(raw: string, size: number) {
  const n = new StreamNormalizer();
  for (let i = 0; i < raw.length; i += size) n.feed(raw.slice(i, i + size));
  return n.snapshot();
}

describe("malformed input (tmux regress ports)", () => {
  test("tmux:csi-param-discard — CAN aborts a CSI mid-parameters", () => {
    const raw = "\x1b[" + "1".repeat(80) + "\x18OK\n";
    expect(normalizeText(raw).lines).toEqual(["OK"]);
  });

  test("tmux:csi-interm-discard — CAN aborts a CSI mid-intermediates", () => {
    expect(normalizeText("\x1b[    \x18OK\n").lines).toEqual(["OK"]);
  });

  test("tmux:osc-discard — a megabyte OSC payload is dropped, not leaked", () => {
    const raw = "\x1b]2;" + "x".repeat(1_100_000) + "\x1b\\OK\n";
    const snap = normalizeChunked(raw, 64 * 1024); // arrives in PTY-sized chunks
    expect(snap.lines).toEqual(["OK"]);
  });

  test("tmux:apc-discard — a megabyte APC payload is dropped, not leaked", () => {
    const raw = "\x1b_" + "x".repeat(1_100_000) + "\x1b\\OK\n";
    expect(normalizeChunked(raw, 64 * 1024).lines).toEqual(["OK"]);
  });

  test("tmux:malformed-dcs — DCS body never reaches the text", () => {
    expect(normalizeText("\x1bP$qBAD\x1b\\OK\n").lines).toEqual(["OK"]);
  });

  test("tmux:unknown-csi — unknown finals are consumed cleanly", () => {
    expect(normalizeText("\x1b[?9999zOK\n").lines).toEqual(["OK"]);
  });

  test("tmux:malformed-osc — a chain of broken OSCs leaves only the text", () => {
    const raw =
      "\x1b]8;id=a:id=b;http://bad\x07X" +
      "\x1b]8;id=no-separator\x07Y" +
      "\x1b]9;4;5;200\x07" +
      "\x1b]9;4;z\x07" +
      "\x1b]10;notacolour\x07" +
      "\x1b]52;c;@@@\x07OK\n";
    expect(normalizeText(raw).lines).toEqual(["XYOK"]);
  });

  test("CAN aborts an OSC too", () => {
    expect(normalizeText("\x1b]0;title\x18OK\n").lines).toEqual(["OK"]);
  });

  test("ESC inside an OSC aborts it and starts a fresh sequence", () => {
    // The aborting ESC begins a real CSI; both are consumed, text survives.
    expect(normalizeText("\x1b]0;tit\x1b[31mred\x1b[0m\n").lines).toEqual(["red"]);
  });

  test("double ESC restarts the escape (nothing swallowed)", () => {
    expect(normalizeText("\x1b\x1b[31mred\n").lines).toEqual(["red"]);
  });

  test("PM and SOS strings are discarded like APC", () => {
    expect(normalizeText("\x1b^private message\x1b\\A\x1bXsos data\x1b\\B\n").lines).toEqual(["AB"]);
  });

  test("over-long CSI parameters are consumed but ignored", () => {
    // 500 param chars then final 'A' (cursor up): must not pop lines.
    const raw = "keep\n\x1b[" + "1;".repeat(250) + "Aafter\n";
    const snap = normalizeText(raw);
    expect(snap.lines).toEqual(["keep", "after"]);
    expect(snap.collapsedRepaintLines).toBe(0);
  });

  test("tmux:malformed-utf8 — replacement characters pass through unharmed", () => {
    // The PTY layer decodes; invalid bytes arrive as U+FFFD.
    expect(normalizeText("�A�B\n").lines).toEqual(["�A�B"]);
  });

  test("multibyte text (UTF-8 stress sample) is preserved verbatim", () => {
    const raw = "héllo wörld ✓ 你好 — Δ δ ∂ ∈ ℝ ⌈x⌉\n";
    expect(normalizeText(raw).lines).toEqual(["héllo wörld ✓ 你好 — Δ δ ∂ ∈ ℝ ⌈x⌉"]);
  });
});

describe("chunk-split invariance (incremental-parser property)", () => {
  const STREAMS: Record<string, string> = {
    "sgr+osc+dcs": "a\x1b[1;32mb\x1b]0;t\x07c\x1bP+q\x1b\\d\n",
    "progress+cursor": "x\r\x1b[2Ky 50%\r\x1b[1G\x1b[0Kz done\ntail\n",
    "altscreen": "pre\n\x1b[?1049h\x1b[2J\x1b[Hframe\x1b[?1049lpost\n",
    "aborted-seqs": "\x1b[12\x18A\x1b]x\x18B\x1b\x1b[0mC\n",
  };
  for (const [name, raw] of Object.entries(STREAMS)) {
    test(`every split point yields identical output: ${name}`, () => {
      const whole = normalizeText(raw);
      for (let split = 1; split < raw.length; split++) {
        const n = new StreamNormalizer();
        n.feed(raw.slice(0, split));
        n.feed(raw.slice(split));
        expect(n.snapshot().lines).toEqual(whole.lines);
      }
    });
  }

  test("randomized fragment streams: whole vs 1..7-char chunks agree, never throw", () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0xc0ffee;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const FRAGMENTS = [
      "plain text ",
      "line\n",
      "\r",
      "\r\n",
      "\x1b[31m",
      "\x1b[0m",
      "\x1b[2A",
      "\x1b[1G\x1b[0K",
      "\x1b]0;title\x07",
      "\x1b]8;;http://x\x1b\\",
      "\x1bP$q\x1b\\",
      "\x1b_apc\x1b\\",
      "\x1b[?1049h",
      "\x1b[?1049l",
      "\x1b[",
      "\x1b",
      "\x18",
      "\x07",
      "✓ 你",
      "err: fail\r",
    ];
    for (let round = 0; round < 40; round++) {
      let raw = "";
      const parts = 5 + rnd(25);
      for (let i = 0; i < parts; i++) raw += FRAGMENTS[rnd(FRAGMENTS.length)];
      const whole = normalizeText(raw);
      const chunkSize = 1 + rnd(7);
      const chunked = normalizeChunked(raw, chunkSize);
      expect(chunked.lines).toEqual(whole.lines);
      expect(chunked.tuiMode).toBe(whole.tuiMode);
    }
  });
});

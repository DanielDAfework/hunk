import { describe, expect, test } from "bun:test";
import { Osc133Parser, isPossibleMarkerPrefix } from "./markers";

const C = "\x1b]133;C\x07";
const A = "\x1b]133;A\x07";
const D = (code: number) => `\x1b]133;D;${code}\x07`;

describe("Osc133Parser", () => {
  test("splits data and markers in order", () => {
    const p = new Osc133Parser();
    const evs = p.feed(`prompt$ ${C}output line\n${D(0)}${A}`);
    expect(evs).toEqual([
      { kind: "data", data: "prompt$ " },
      { kind: "marker", marker: { type: "C" } },
      { kind: "data", data: "output line\n" },
      { kind: "marker", marker: { type: "D", exitCode: 0 } },
      { kind: "marker", marker: { type: "A" } },
    ]);
  });

  test("parses exit codes, including multi-digit", () => {
    const p = new Osc133Parser();
    const evs = p.feed(D(143));
    expect(evs).toEqual([{ kind: "marker", marker: { type: "D", exitCode: 143 } }]);
  });

  test("marker split across chunks is reassembled", () => {
    const p = new Osc133Parser();
    const whole = `before${D(7)}after`;
    for (let split = 7; split < whole.length - 5; split++) {
      const p2 = new Osc133Parser();
      const evs = [...p2.feed(whole.slice(0, split)), ...p2.feed(whole.slice(split)), ...p2.flush()];
      const markers = evs.filter((e) => e.kind === "marker");
      const data = evs
        .filter((e) => e.kind === "data")
        .map((e) => (e as { data: string }).data)
        .join("");
      expect(markers).toEqual([{ kind: "marker", marker: { type: "D", exitCode: 7 } }]);
      expect(data).toBe("beforeafter");
    }
    expect(p).toBeDefined();
  });

  test("ST-terminated markers (ESC backslash) are accepted", () => {
    const p = new Osc133Parser();
    const evs = p.feed("\x1b]133;A\x1b\\rest");
    expect(evs).toEqual([
      { kind: "marker", marker: { type: "A" } },
      { kind: "data", data: "rest" },
    ]);
  });

  test("non-133 OSC passes through as data", () => {
    const p = new Osc133Parser();
    const evs = [...p.feed("\x1b]0;title\x07text"), ...p.flush()];
    expect(evs.filter((e) => e.kind === "marker")).toEqual([]);
    expect(evs.map((e) => (e as { data: string }).data).join("")).toBe("\x1b]0;title\x07text");
  });

  test("lone trailing ESC is held, then flushed", () => {
    const p = new Osc133Parser();
    expect(p.feed("data\x1b")).toEqual([{ kind: "data", data: "data" }]);
    expect(p.flush()).toEqual([{ kind: "data", data: "\x1b" }]);
  });

  test("isPossibleMarkerPrefix", () => {
    expect(isPossibleMarkerPrefix("\x1b")).toBe(true);
    expect(isPossibleMarkerPrefix("\x1b]13")).toBe(true);
    expect(isPossibleMarkerPrefix("\x1b]133;D;14")).toBe(true);
    expect(isPossibleMarkerPrefix("\x1b[31m")).toBe(false);
    expect(isPossibleMarkerPrefix("\x1b]0;t")).toBe(false);
  });
});

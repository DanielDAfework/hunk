import { describe, expect, test } from "bun:test";
import { JobOutput, QueryError, DIGEST_HEAD_LINES, DIGEST_TAIL_LINES } from "./store";

function storeWithLines(n: number): JobOutput {
  const o = new JobOutput();
  for (let i = 1; i <= n; i++) o.feed(`line ${i}\n`);
  return o;
}

describe("JobOutput digest", () => {
  test("small outputs go entirely in head", () => {
    const o = storeWithLines(20);
    const d = o.digestPreview();
    expect(d.head.length).toBe(20);
    expect(d.tail).toEqual([]);
  });

  test("large outputs split head/tail at the documented sizes", () => {
    const o = storeWithLines(500);
    const d = o.digestPreview();
    expect(d.head.length).toBe(DIGEST_HEAD_LINES);
    expect(d.tail.length).toBe(DIGEST_TAIL_LINES);
    expect(d.head[0]).toBe("line 1");
    expect(d.tail.at(-1)).toBe("line 500");
    expect(d.lineCount).toBe(500);
  });
});

describe("JobOutput queries", () => {
  const o = storeWithLines(100);
  const q = (query: Parameters<JobOutput["query"]>[2]) => o.query("job-x", "exited", query);

  test("head and tail", () => {
    expect(q({ mode: "head", lines: 3 }).text).toBe("line 1\nline 2\nline 3");
    const t = q({ mode: "tail", lines: 2 });
    expect(t.text).toBe("line 99\nline 100");
    expect(t.range).toEqual({ start: 99, end: 100 });
  });

  test("slice is 1-indexed inclusive", () => {
    const r = q({ mode: "slice", start: 10, end: 12 });
    expect(r.text).toBe("line 10\nline 11\nline 12");
    expect(r.range).toEqual({ start: 10, end: 12 });
  });

  test("slice validates bounds with a teaching message", () => {
    expect(() => q({ mode: "slice", start: 5, end: 2 })).toThrow(/1-indexed/);
  });

  test("grep returns numbered matches with context and totals", () => {
    const r = q({ mode: "grep", pattern: "^line 50$", context: 1 });
    expect(r.total_matches).toBe(1);
    expect(r.text).toBe("49:line 49\n50:line 50\n51:line 51");
  });

  test("grep caps matches and says how many were hidden", () => {
    const r = q({ mode: "grep", pattern: "line", context: 0, max_matches: 5 });
    expect(r.total_matches).toBe(100);
    expect(r.notes.join(" ")).toContain("95 more matches");
  });

  test("grep rejects bad regexes helpfully", () => {
    expect(() => q({ mode: "grep", pattern: "(" })).toThrow(/regex/);
  });

  test("full refuses over budget and teaches the fix", () => {
    let err: QueryError | null = null;
    try {
      q({ mode: "full", confirm_tokens: 5 });
    } catch (e) {
      err = e as QueryError;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/confirm_tokens:\d+/);
    expect(err!.message).toMatch(/grep/);
  });

  test("full succeeds within budget", () => {
    const r = q({ mode: "full", confirm_tokens: 100000 });
    expect(r.text.split("\n").length).toBe(100);
    expect(r.remaining_estimated_tokens).toBe(0);
  });

  test("delta returns lines after since_line and a cursor", () => {
    const r = q({ mode: "delta", since_line: 98 });
    expect(r.text).toBe("line 99\nline 100");
    expect(r.last_line).toBe(100);
    const r2 = q({ mode: "delta", since_line: 100 });
    expect(r2.text).toBe("");
  });

  test("every response accounts returned + remaining tokens", () => {
    const r = q({ mode: "head", lines: 10 });
    expect(r.returned_estimated_tokens).toBeGreaterThan(0);
    expect(r.remaining_estimated_tokens).toBeGreaterThan(0);
    const full = q({ mode: "full", confirm_tokens: 100000 });
    expect(full.remaining_estimated_tokens).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { validateFileViewLayout } from "./layout";

describe("file-view layout validation", () => {
  test("accepts deterministic symbolic rows and measures terminal-width wrapping", () => {
    const result = validateFileViewLayout(
      {
        rows: [
          { id: "heading", spans: [{ text: "# title", tone: "accent", attributes: ["bold"] }] },
          { id: "wide", spans: [{ text: "界界" }] },
        ],
        hunks: [{ index: 0, startRow: 0, endRow: 1 }],
      },
      1,
      3,
    );

    expect(result).toMatchObject({ valid: true });
    if (result.valid) expect(result.value.rowHeights).toEqual([3, 2]);
  });

  test("rejects layouts that cannot supply host-owned hunk geometry", () => {
    const result = validateFileViewLayout(
      {
        rows: [{ id: "one", spans: [{ text: "one" }] }],
        hunks: [{ index: 0, startRow: 0, endRow: 0 }],
      },
      2,
      80,
    );

    expect(result).toEqual({ valid: false, issue: "layout has 1 hunk bounds for 2 hunks" });
  });

  test("rejects duplicate row ids and non-generic presentation values", () => {
    const duplicate = validateFileViewLayout(
      {
        rows: [
          { id: "same", spans: [{ text: "one" }] },
          { id: "same", spans: [{ text: "two" }] },
        ],
        hunks: [],
      },
      0,
      80,
    );
    expect(duplicate).toMatchObject({ valid: false, issue: 'rows[1] repeats id "same"' });

    expect(
      validateFileViewLayout(
        {
          rows: [{ id: "one", spans: [{ text: "one", tone: "heading" }] }],
          hunks: [],
        },
        0,
        80,
      ),
    ).toEqual({ valid: false, issue: "rows[0] contains an invalid span tone" });
  });
});

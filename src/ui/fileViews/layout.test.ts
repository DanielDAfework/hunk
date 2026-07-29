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

  test("accepts bounded custom row painters with fixed host-owned height", () => {
    const component = () => null;
    const result = validateFileViewLayout(
      {
        rows: [{ id: "custom", spans: [{ text: "fallback" }], height: 4, component }],
        hunks: [{ index: 0, startRow: 0, endRow: 0 }],
      },
      1,
      80,
    );

    expect(result).toMatchObject({ valid: true });
    if (result.valid) {
      expect(result.value.rowHeights).toEqual([4]);
      expect(result.value.layout.rows[0]?.component).toBe(component);
    }
  });

  test("rejects unpaired, invalid, and resource-heavy custom row declarations", () => {
    expect(
      validateFileViewLayout(
        { rows: [{ id: "missing", spans: [], component: () => null }], hunks: [] },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0] must declare component and height together",
    });

    expect(
      validateFileViewLayout(
        {
          rows: [{ id: "invalid", spans: [], height: 2, component: "not a component" }],
          hunks: [],
        },
        0,
        80,
      ),
    ).toEqual({ valid: false, issue: "rows[0].component is not a function" });

    expect(
      validateFileViewLayout(
        { rows: [{ id: "tall", spans: [], height: 257, component: () => null }], hunks: [] },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].height must be an integer from 1 to 256",
    });

    const rows = Array.from({ length: 391 }, (_, index) => ({
      id: `row-${index}`,
      spans: [],
      height: 256,
      component: () => null,
    }));
    expect(validateFileViewLayout({ rows, hunks: [] }, 0, 80)).toEqual({
      valid: false,
      issue: "component rows exceed 100000 terminal rows",
    });
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

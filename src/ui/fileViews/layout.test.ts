import { describe, expect, test } from "bun:test";
import { validateFileViewLayout } from "./layout";

describe("file-view layout validation", () => {
  test("accepts deterministic symbolic rows and measures terminal-width wrapping", () => {
    const result = validateFileViewLayout(
      {
        rows: [
          {
            id: "heading",
            spans: [{ text: "# title", tone: "accent", attributes: ["bold"] }],
          },
          { id: "wide", spans: [{ text: "界界" }] },
        ],
        hunkRows: [{ startRow: 0, endRow: 1 }],
      },
      1,
      3,
    );

    expect(result).toMatchObject({ valid: true });
    if (result.valid) expect(result.value.rowHeights).toEqual([3, 2]);
  });

  test("accepts bounded custom row painters with an atomic fixed-height descriptor", () => {
    const render = () => null;
    const result = validateFileViewLayout(
      {
        rows: [
          {
            id: "custom",
            spans: [{ text: "fallback" }],
            component: { height: 4, render },
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      1,
      80,
    );

    expect(result).toMatchObject({ valid: true });
    if (result.valid) {
      expect(result.value.rowHeights).toEqual([4]);
      expect(result.value.layout.rows[0]?.component?.render).toBe(render);
    }
  });

  test("rejects invalid and resource-heavy custom row descriptors", () => {
    expect(
      validateFileViewLayout(
        {
          rows: [{ id: "invalid", spans: [], component: "not an object" }],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({ valid: false, issue: "rows[0].component is not an object" });

    expect(
      validateFileViewLayout(
        {
          rows: [
            {
              id: "invalid",
              spans: [],
              component: { height: 2, render: "nope" },
            },
          ],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].component.render is not a function",
    });

    expect(
      validateFileViewLayout(
        {
          rows: [
            {
              id: "tall",
              spans: [],
              component: { height: 257, render: () => null },
            },
          ],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].component.height must be an integer from 1 to 256",
    });

    const rows = Array.from({ length: 391 }, (_, index) => ({
      id: `row-${index}`,
      spans: [],
      component: { height: 256, render: () => null },
    }));
    expect(validateFileViewLayout({ rows, hunkRows: [] }, 0, 80)).toEqual({
      valid: false,
      issue: "component rows exceed 100000 terminal rows",
    });
  });

  test("rejects layouts that cannot supply positional host-owned hunk geometry", () => {
    const result = validateFileViewLayout(
      {
        rows: [{ id: "one", spans: [{ text: "one" }] }],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      2,
      80,
    );

    expect(result).toEqual({
      valid: false,
      issue: "layout has 1 hunk bounds for 2 hunks",
    });
  });

  test("rejects duplicate row ids and non-generic presentation values", () => {
    const duplicate = validateFileViewLayout(
      {
        rows: [
          { id: "same", spans: [{ text: "one" }] },
          { id: "same", spans: [{ text: "two" }] },
        ],
        hunkRows: [],
      },
      0,
      80,
    );
    expect(duplicate).toMatchObject({
      valid: false,
      issue: 'rows[1] repeats id "same"',
    });

    for (const tone of ["heading", "text"]) {
      expect(
        validateFileViewLayout(
          {
            rows: [{ id: "one", spans: [{ text: "one", tone }] }],
            hunkRows: [],
          },
          0,
          80,
        ),
      ).toEqual({
        valid: false,
        issue: "rows[0] contains an invalid span tone",
      });
    }
  });
});

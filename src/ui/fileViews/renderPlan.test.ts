import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewLayout } from "../../extension-api/types";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import { buildFileViewRenderPlan } from "./renderPlan";

const layout: ExtensionFileViewLayout = {
  rows: [
    {
      id: "old-summary",
      spans: [{ text: "old" }],
      sourceRanges: [{ side: "old", range: [2, 4] }],
    },
    {
      id: "new-summary",
      spans: [{ text: "new" }],
      sourceRanges: [{ side: "new", range: [5, 8] }],
    },
  ],
  hunkRows: [{ startRow: 0, endRow: 1 }],
};

/** Build the minimal host note payload used by alternate-view planning. */
function note(
  id: string,
  ranges: { oldRange?: [number, number]; newRange?: [number, number] },
): VisibleAgentNote {
  return {
    id,
    annotation: { id, summary: id, ...ranges },
  };
}

describe("file-view render plan", () => {
  test("inserts notes before the uniquely bound preferred-side row", () => {
    const plan = buildFileViewRenderPlan(layout, [
      note("both", { oldRange: [3, 3], newRange: [6, 7] }),
    ]);

    expect(plan.unresolvedNoteIds).toEqual([]);
    expect(plan.rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
      "file-view-row:file-view:old-summary",
      "inline-note:inline-note:both:file-view:new-summary:0",
      "file-view-row:file-view:new-summary",
    ]);
    expect(plan.rows[1]).toMatchObject({
      kind: "inline-note",
      anchorRowIndex: 1,
      anchorSide: "new",
      hunkIndex: 0,
    });
  });

  test("groups notes at one anchor in stable input order", () => {
    const plan = buildFileViewRenderPlan(layout, [
      note("first", { newRange: [5, 5] }),
      note("second", { newRange: [8, 8] }),
    ]);
    const notes = plan.rows.filter((row) => row.kind === "inline-note");

    expect(notes.map((row) => row.note.id)).toEqual(["first", "second"]);
    expect(notes.map((row) => [row.noteIndex, row.noteCount])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  test("reports every range-less, unbound, or out-of-hunk note instead of guessing", () => {
    const outsideHunk: ExtensionFileViewLayout = {
      ...layout,
      hunkRows: [{ startRow: 0, endRow: 0 }],
    };
    const plan = buildFileViewRenderPlan(outsideHunk, [
      note("range-less", {}),
      note("unbound", { newRange: [20, 20] }),
      note("outside-hunk", { newRange: [6, 6] }),
    ]);

    expect(plan.unresolvedNoteIds).toEqual(["range-less", "unbound", "outside-hunk"]);
    expect(plan.rows.every((row) => row.kind === "file-view-row")).toBe(true);

    const overlappingHunks = buildFileViewRenderPlan(
      {
        ...layout,
        hunkRows: [
          { startRow: 0, endRow: 1 },
          { startRow: 1, endRow: 1 },
        ],
      },
      [note("ambiguous-hunk", { newRange: [6, 6] })],
    );
    expect(overlappingHunks.unresolvedNoteIds).toEqual(["ambiguous-hunk"]);
  });
});

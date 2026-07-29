import type { AgentAnnotation } from "../../core/types";
import type { ExtensionFileViewLayout, ExtensionFileViewRow } from "../../extension-api/types";
import { annotationAnchor, type VisibleAgentNote } from "../lib/agentAnnotations";

/** One validated extension row or host-owned inline note in an alternate file presentation. */
export type PlannedFileViewRow =
  | {
      readonly kind: "file-view-row";
      readonly key: string;
      readonly stableKey: string;
      readonly row: ExtensionFileViewRow;
      readonly rowIndex: number;
    }
  | {
      readonly kind: "inline-note";
      readonly key: string;
      readonly stableKey: string;
      readonly annotation: AgentAnnotation;
      readonly anchorRowIndex: number;
      readonly anchorSide: "old" | "new";
      readonly hunkIndex: number;
      readonly note: VisibleAgentNote;
      readonly noteCount: number;
      readonly noteIndex: number;
    };

export interface FileViewRenderPlan {
  readonly rows: readonly PlannedFileViewRow[];
  /** Notes without one exact bound anchor force the file back to raw diff. */
  readonly unresolvedNoteIds: readonly string[];
}

/** Resolve unique hunk ownership for every row in one bounded sweep. */
function hunkOwnersByRow(layout: ExtensionFileViewLayout) {
  const starts = Array.from({ length: layout.rows.length + 1 }, () => [] as number[]);
  const ends = Array.from({ length: layout.rows.length + 1 }, () => [] as number[]);
  for (const [hunkIndex, hunkRows] of layout.hunkRows.entries()) {
    starts[hunkRows.startRow]!.push(hunkIndex);
    ends[hunkRows.endRow + 1]!.push(hunkIndex);
  }

  const active = new Set<number>();
  return layout.rows.map((_, rowIndex) => {
    for (const hunkIndex of ends[rowIndex]!) active.delete(hunkIndex);
    for (const hunkIndex of starts[rowIndex]!) active.add(hunkIndex);
    return active.size === 1 ? active.values().next().value! : -1;
  });
}

/** Find the unique validated presentation row containing one note's preferred source anchor. */
function boundRowIndex(layout: ExtensionFileViewLayout, annotation: AgentAnnotation) {
  const anchor = annotationAnchor(annotation);
  if (!anchor) return -1;

  return layout.rows.findIndex((row) =>
    (row.sourceRanges ?? []).some(
      (sourceRange) =>
        sourceRange.side === anchor.side &&
        sourceRange.range[0] <= anchor.lineNumber &&
        anchor.lineNumber <= sourceRange.range[1],
    ),
  );
}

/**
 * Insert host-owned notes into one immutable alternate-view row stream.
 *
 * Placement is all-or-raw: if any visible note lacks one exact bound anchor inside a declared hunk,
 * callers must render the raw Pierre diff rather than dropping or guessing at note placement.
 */
export function buildFileViewRenderPlan(
  layout: ExtensionFileViewLayout,
  visibleAgentNotes: readonly VisibleAgentNote[],
): FileViewRenderPlan {
  const notesByRow = new Map<
    number,
    Array<{ note: VisibleAgentNote; anchorSide: "old" | "new"; hunkIndex: number }>
  >();
  const unresolvedNoteIds: string[] = [];
  const hunkOwnerByRow = hunkOwnersByRow(layout);

  for (const note of visibleAgentNotes) {
    const anchor = annotationAnchor(note.annotation);
    const rowIndex = boundRowIndex(layout, note.annotation);
    const hunkIndex = rowIndex < 0 ? -1 : hunkOwnerByRow[rowIndex]!;
    if (!anchor || rowIndex < 0 || hunkIndex < 0) {
      unresolvedNoteIds.push(note.id);
      continue;
    }
    const notes = notesByRow.get(rowIndex) ?? [];
    notes.push({ note, anchorSide: anchor.side, hunkIndex });
    notesByRow.set(rowIndex, notes);
  }

  const rows: PlannedFileViewRow[] = [];
  for (const [rowIndex, row] of layout.rows.entries()) {
    const anchoredNotes = notesByRow.get(rowIndex) ?? [];
    for (const [noteIndex, placement] of anchoredNotes.entries()) {
      rows.push({
        kind: "inline-note",
        key: `inline-note:${placement.note.id}:file-view:${row.id}:${noteIndex}`,
        stableKey: `inline-note:${placement.note.id}`,
        annotation: placement.note.annotation,
        anchorRowIndex: rowIndex,
        anchorSide: placement.anchorSide,
        hunkIndex: placement.hunkIndex,
        note: placement.note,
        noteCount: anchoredNotes.length,
        noteIndex,
      });
    }
    const key = `file-view:${row.id}`;
    rows.push({ kind: "file-view-row", key, stableKey: key, row, rowIndex });
  }

  return {
    rows: Object.freeze(rows),
    unresolvedNoteIds: Object.freeze(unresolvedNoteIds),
  };
}

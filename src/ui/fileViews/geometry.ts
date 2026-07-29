import type { DiffFile } from "../../core/types";
import { reviewRowId } from "../lib/ids";
import type { PlannedHunkBounds } from "../diff/plannedReviewRows";
import type { DiffSectionGeometry, DiffSectionRowBounds } from "../diff/diffSectionGeometry";
import type { ValidatedFileViewLayout } from "./layout";

/** Build host-owned scroll and hunk geometry for a symbolic file-view layout. */
export function measureFileViewGeometry(
  file: DiffFile,
  resolved: ValidatedFileViewLayout,
): DiffSectionGeometry {
  const { layout, rowHeights } = resolved;
  const rowBounds: DiffSectionRowBounds[] = [];
  const rowBoundsByKey = new Map<string, DiffSectionRowBounds>();
  const rowBoundsByStableKey = new Map<string, DiffSectionRowBounds>();
  let bodyHeight = 0;

  for (const [rowIndex, row] of layout.rows.entries()) {
    const key = `file-view:${row.id}`;
    const entry: DiffSectionRowBounds = {
      key,
      stableKey: key,
      stableKeys: [key],
      top: bodyHeight,
      // Validation and geometry intentionally share one immutable measurement snapshot.
      height: rowHeights[rowIndex]!,
    };
    rowBounds.push(entry);
    rowBoundsByKey.set(key, entry);
    rowBoundsByStableKey.set(key, entry);
    bodyHeight += entry.height;
  }

  const hunkAnchorRows = new Map<number, number>();
  const hunkBounds = new Map<number, PlannedHunkBounds>();
  for (const [hunkIndex, hunk] of layout.hunkRows.entries()) {
    const start = rowBounds[hunk.startRow]!;
    const end = rowBounds[hunk.endRow]!;
    hunkAnchorRows.set(hunkIndex, start.top);
    hunkBounds.set(hunkIndex, {
      top: start.top,
      height: end.top + end.height - start.top,
      startRowId: reviewRowId(start.key),
      endRowId: reviewRowId(end.key),
    });
  }

  return {
    bodyHeight,
    hunkAnchorRows,
    hunkBounds,
    lineNumberDigits: 1,
    // Symbolic rows render through FileView instead of Pierre. Keeping this empty makes the
    // existing raw-diff copy implementation decline the alternate view rather than interpreting
    // a non-Pierre row as code.
    plannedRows: [],
    rowBounds,
    rowBoundsByKey,
    rowBoundsByStableKey,
  };
}

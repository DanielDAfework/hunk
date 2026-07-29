import type { ExtensionFileViewLayout, ExtensionFileViewRow } from "../../extension-api/types";
import { measureSanitizedTextWidth, wrapSanitizedTextByWidth } from "../lib/text";

/** Resource limits keep one extension layout from exhausting the review stream. */
export const FILE_VIEW_MAX_ROWS = 10_000;
export const FILE_VIEW_MAX_SPANS = 40_000;
export const FILE_VIEW_MAX_TEXT_LENGTH = 1_000_000;
export const FILE_VIEW_MAX_COMPONENT_ROW_HEIGHT = 256;
/** Maximum measured terminal height across every symbolic and component row. */
export const FILE_VIEW_MAX_LAYOUT_HEIGHT = 100_000;

const FILE_VIEW_TONES = new Set(["muted", "accent", "accent-muted", "syntax", "added", "removed"]);
const FILE_VIEW_TEXT_ATTRIBUTES = new Set(["bold", "italic", "underline", "strikethrough"]);

export interface ValidatedFileViewLayout {
  layout: ExtensionFileViewLayout;
  /** Number of terminal rows each symbolic row occupies at the requested width. */
  rowHeights: readonly number[];
}

/** Validate finite zero-based row coordinates. */
function isRowIndex(value: unknown, rowCount: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < rowCount;
}

/** Explain why an extension result cannot safely join the host-owned review stream. */
export function validateFileViewLayout(
  value: unknown,
  hunkCount: number,
  width: number,
): { valid: true; value: ValidatedFileViewLayout } | { valid: false; issue: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, issue: "layout is not an object" };
  }

  const layout = value as ExtensionFileViewLayout;
  if (!Array.isArray(layout.rows) || !Array.isArray(layout.hunkRows)) {
    return {
      valid: false,
      issue: "layout must include rows and hunkRows arrays",
    };
  }
  if (layout.rows.length > FILE_VIEW_MAX_ROWS) {
    return {
      valid: false,
      issue: `layout has more than ${FILE_VIEW_MAX_ROWS} rows`,
    };
  }

  const ids = new Set<string>();
  let spanCount = 0;
  let textLength = 0;
  let layoutHeight = 0;
  const rows: ExtensionFileViewRow[] = [];
  const rowHeights: number[] = [];
  const usableWidth = Math.max(1, Math.floor(width));

  for (const [index, row] of layout.rows.entries()) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || row.id.length === 0) {
      return { valid: false, issue: `rows[${index}] has no non-empty id` };
    }
    if (ids.has(row.id)) {
      return { valid: false, issue: `rows[${index}] repeats id "${row.id}"` };
    }
    ids.add(row.id);
    const component = row.component;
    let componentSnapshot: ExtensionFileViewRow["component"];
    if (component !== undefined) {
      if (!component || typeof component !== "object" || Array.isArray(component)) {
        return {
          valid: false,
          issue: `rows[${index}].component is not an object`,
        };
      }
      const render = component.render;
      const height = component.height;
      if (typeof render !== "function") {
        return {
          valid: false,
          issue: `rows[${index}].component.render is not a function`,
        };
      }
      if (!Number.isInteger(height) || height < 1 || height > FILE_VIEW_MAX_COMPONENT_ROW_HEIGHT) {
        return {
          valid: false,
          issue: `rows[${index}].component.height must be an integer from 1 to ${FILE_VIEW_MAX_COMPONENT_ROW_HEIGHT}`,
        };
      }
      componentSnapshot = Object.freeze({ height, render });
    }
    if (!Array.isArray(row.spans)) {
      return { valid: false, issue: `rows[${index}].spans is not an array` };
    }

    let rowText = "";
    const spans: ExtensionFileViewRow["spans"][number][] = [];
    for (const span of row.spans) {
      spanCount += 1;
      if (spanCount > FILE_VIEW_MAX_SPANS) {
        return {
          valid: false,
          issue: `layout has more than ${FILE_VIEW_MAX_SPANS} spans`,
        };
      }
      if (!span || typeof span.text !== "string" || span.text.includes("\n")) {
        return {
          valid: false,
          issue: `rows[${index}] contains an invalid span`,
        };
      }
      if (span.tone !== undefined && !FILE_VIEW_TONES.has(span.tone)) {
        return {
          valid: false,
          issue: `rows[${index}] contains an invalid span tone`,
        };
      }
      if (
        span.attributes !== undefined &&
        (!Array.isArray(span.attributes) ||
          span.attributes.some(
            (attribute: unknown) =>
              typeof attribute !== "string" || !FILE_VIEW_TEXT_ATTRIBUTES.has(attribute),
          ))
      ) {
        return {
          valid: false,
          issue: `rows[${index}] contains invalid span attributes`,
        };
      }
      const text = span.text;
      const tone = span.tone;
      const attributes = span.attributes ? Object.freeze([...span.attributes]) : undefined;
      textLength += text.length;
      if (textLength > FILE_VIEW_MAX_TEXT_LENGTH) {
        return {
          valid: false,
          issue: `layout text exceeds ${FILE_VIEW_MAX_TEXT_LENGTH} characters`,
        };
      }
      rowText += text;
      spans.push(
        Object.freeze({
          text,
          ...(tone === undefined ? {} : { tone }),
          ...(attributes === undefined ? {} : { attributes }),
        }),
      );
    }
    // Measure exactly once at validation. Geometry consumes this retained value without rewrapping.
    const rowHeight = componentSnapshot
      ? componentSnapshot.height
      : Math.max(1, wrapSanitizedTextByWidth(rowText, usableWidth).length);
    layoutHeight += rowHeight;
    if (layoutHeight > FILE_VIEW_MAX_LAYOUT_HEIGHT) {
      return {
        valid: false,
        issue: `layout exceeds ${FILE_VIEW_MAX_LAYOUT_HEIGHT} terminal rows`,
      };
    }
    rowHeights.push(rowHeight);
    rows.push(
      Object.freeze({
        id: row.id,
        spans: Object.freeze(spans),
        ...(componentSnapshot === undefined ? {} : { component: componentSnapshot }),
      }),
    );
  }

  if (layout.hunkRows.length !== hunkCount) {
    return {
      valid: false,
      issue: `layout has ${layout.hunkRows.length} hunk bounds for ${hunkCount} hunks`,
    };
  }
  const hunkRows: ExtensionFileViewLayout["hunkRows"][number][] = [];
  for (const [position, hunk] of layout.hunkRows.entries()) {
    const startRow = hunk?.startRow;
    const endRow = hunk?.endRow;
    if (
      !hunk ||
      !isRowIndex(startRow, layout.rows.length) ||
      !isRowIndex(endRow, layout.rows.length) ||
      startRow > endRow
    ) {
      return {
        valid: false,
        issue: `hunkRows[${position}] is not an in-bounds row range`,
      };
    }
    hunkRows.push(Object.freeze({ startRow, endRow }));
  }

  const snapshot = Object.freeze({
    rows: Object.freeze(rows),
    hunkRows: Object.freeze(hunkRows),
  });
  return {
    valid: true,
    value: Object.freeze({ layout: snapshot, rowHeights: Object.freeze(rowHeights) }),
  };
}

/** Return a terminal-safe line representation for a symbolic row. */
export function fileViewRowText(row: ExtensionFileViewRow, width: number) {
  const text = row.spans.map((span) => span.text).join("");
  return wrapSanitizedTextByWidth(text, Math.max(1, width));
}

/** Exposed only for tests that ensure terminal measurement treats wide text as cells, not UTF-16. */
export function measureFileViewRowWidth(row: ExtensionFileViewRow) {
  return measureSanitizedTextWidth(row.spans.map((span) => span.text).join(""));
}

import { TextAttributes } from "@opentui/core";
import { memo, useMemo } from "react";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewTextAttribute,
  ExtensionFileViewTone,
} from "../../../extension-api/types";
import type { AppTheme } from "../../themes";
import type { DiffSectionGeometry } from "../../diff/diffSectionGeometry";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import { reviewRowId } from "../../lib/ids";

/** Resolve a generic file-view tone only at paint time, keeping layout theme-independent. */
function fileViewToneColor(tone: ExtensionFileViewTone | undefined, theme: AppTheme) {
  switch (tone) {
    case "muted":
      return theme.muted;
    case "accent":
      return theme.accent;
    case "accent-muted":
      return theme.accentMuted;
    case "syntax":
      return theme.syntaxColors.default;
    case "added":
      return theme.fileNew;
    case "removed":
      return theme.fileDeleted;
    default:
      return theme.text;
  }
}

const FILE_VIEW_ATTRIBUTE_BITS: Record<ExtensionFileViewTextAttribute, number> = {
  bold: TextAttributes.BOLD,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  strikethrough: TextAttributes.STRIKETHROUGH,
};

/** Combine generic emphasis attributes into OpenTUI's terminal bitmask. */
function fileViewTextAttributes(attributes: readonly ExtensionFileViewTextAttribute[] | undefined) {
  return (attributes ?? []).reduce(
    (combined, attribute) => combined | FILE_VIEW_ATTRIBUTE_BITS[attribute],
    TextAttributes.NONE,
  );
}

/** Report whether one symbolic row belongs to the currently selected hunk. */
export function isFileViewRowSelected(
  layout: ExtensionFileViewLayout,
  rowIndex: number,
  selectedHunkIndex: number,
) {
  const selectedHunk = layout.hunks.find((hunk) => hunk.index === selectedHunkIndex);
  return Boolean(
    selectedHunk && rowIndex >= selectedHunk.startRow && rowIndex <= selectedHunk.endRow,
  );
}

/** Render the host-owned symbolic rows of an alternate file view. */
function FileViewComponent({
  layout,
  geometry,
  selectedHunkIndex,
  theme,
  visibleBodyBounds,
}: {
  layout: ExtensionFileViewLayout;
  geometry: DiffSectionGeometry;
  selectedHunkIndex: number;
  theme: AppTheme;
  visibleBodyBounds?: VisibleBodyBounds;
}) {
  const rowWindow = useMemo(() => {
    if (!visibleBodyBounds) {
      return {
        bottomSpacerHeight: 0,
        rows: layout.rows.map((row, index) => ({ row, index })),
        topSpacerHeight: 0,
      };
    }
    const top = Math.max(0, visibleBodyBounds.top);
    const bottom = top + Math.max(0, visibleBodyBounds.height);
    const rows = layout.rows.flatMap((row, index) => {
      const bounds = geometry.rowBounds[index];
      return bounds && bounds.top + bounds.height > top && bounds.top < bottom
        ? [{ row, index }]
        : [];
    });
    const first = rows[0] && geometry.rowBounds[rows[0].index];
    const last = rows.at(-1) && geometry.rowBounds[rows.at(-1)!.index];
    return {
      bottomSpacerHeight: last
        ? geometry.bodyHeight - (last.top + last.height)
        : geometry.bodyHeight,
      rows,
      topSpacerHeight: first?.top ?? 0,
    };
  }, [geometry.bodyHeight, geometry.rowBounds, layout.rows, visibleBodyBounds]);

  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {rowWindow.topSpacerHeight > 0 ? (
        <box style={{ width: "100%", height: rowWindow.topSpacerHeight }} />
      ) : null}
      {rowWindow.rows.map(({ row, index }) => {
        const selected = isFileViewRowSelected(layout, index, selectedHunkIndex);
        return (
          <box
            key={row.id}
            id={reviewRowId(`file-view:${row.id}`)}
            style={{
              width: "100%",
              flexDirection: "row",
              backgroundColor: selected ? theme.selectedHunk : theme.panel,
            }}
          >
            {row.spans.map((span, spanIndex) => (
              <text
                key={`${row.id}:${spanIndex}`}
                fg={fileViewToneColor(span.tone, theme)}
                attributes={fileViewTextAttributes(span.attributes)}
              >
                {span.text}
              </text>
            ))}
          </box>
        );
      })}
      {rowWindow.bottomSpacerHeight > 0 ? (
        <box style={{ width: "100%", height: rowWindow.bottomSpacerHeight }} />
      ) : null}
    </box>
  );
}

export const FileView = memo(FileViewComponent);

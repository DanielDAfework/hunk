import { TextAttributes } from "@opentui/core";
import { Component, memo, useMemo, type ReactNode } from "react";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSpan,
} from "../../../extension-api/types";
import type { AppTheme } from "../../themes";
import type { DiffSectionGeometry } from "../../diff/diffSectionGeometry";
import type { VisibleBodyBounds } from "../../diff/rowWindowing";
import { reviewRowId } from "../../lib/ids";

type FileViewTone = ExtensionFileViewSpan["tone"];
type FileViewTextAttribute = NonNullable<ExtensionFileViewSpan["attributes"]>[number];

/** Resolve a generic file-view tone only at paint time, keeping layout theme-independent. */
function fileViewToneColor(tone: FileViewTone, theme: AppTheme) {
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

const FILE_VIEW_ATTRIBUTE_BITS: Record<FileViewTextAttribute, number> = {
  bold: TextAttributes.BOLD,
  italic: TextAttributes.ITALIC,
  underline: TextAttributes.UNDERLINE,
  strikethrough: TextAttributes.STRIKETHROUGH,
};

/** Combine generic emphasis attributes into OpenTUI's terminal bitmask. */
function fileViewTextAttributes(attributes: readonly FileViewTextAttribute[] | undefined) {
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
  const selectedHunk = layout.hunkRows[selectedHunkIndex];
  return Boolean(
    selectedHunk && rowIndex >= selectedHunk.startRow && rowIndex <= selectedHunk.endRow,
  );
}

/** Paint one row through the original symbolic host-rendered path. */
function SymbolicFileViewRow({ row, theme }: { row: ExtensionFileViewRow; theme: AppTheme }) {
  return row.spans.map((span, spanIndex) => (
    <text
      key={`${row.id}:${spanIndex}`}
      fg={fileViewToneColor(span.tone, theme)}
      attributes={fileViewTextAttributes(span.attributes)}
    >
      {span.text}
    </text>
  ));
}

/** Contain custom render failures to one row and retain its symbolic fallback. */
class FileViewRowErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: unknown },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidUpdate(previous: Readonly<{ resetKey: unknown }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Render host-windowed symbolic and custom rows without surrendering outer geometry. */
function FileViewComponent({
  layout,
  geometry,
  selectedHunkIndex,
  theme,
  visibleBodyBounds,
  width,
}: {
  layout: ExtensionFileViewLayout;
  geometry: DiffSectionGeometry;
  selectedHunkIndex: number;
  theme: AppTheme;
  visibleBodyBounds?: VisibleBodyBounds;
  width: number;
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
        const fixedHeight = row.component?.height;
        const View = row.component?.render as
          | ((props: ExtensionFileViewRowComponentProps) => ReactNode)
          | undefined;
        const fallback = <SymbolicFileViewRow row={row} theme={theme} />;
        return (
          <box
            key={row.id}
            id={reviewRowId(`file-view:${row.id}`)}
            style={{
              width: "100%",
              ...(fixedHeight === undefined
                ? {}
                : {
                    height: fixedHeight,
                    minHeight: fixedHeight,
                    maxHeight: fixedHeight,
                    flexShrink: 0,
                    overflow: "hidden" as const,
                  }),
              flexDirection: "row",
              backgroundColor: selected ? theme.selectedHunk : theme.panel,
            }}
          >
            {View && fixedHeight !== undefined ? (
              <FileViewRowErrorBoundary
                key={`${row.id}:${width}:${fixedHeight}:${selected ? 1 : 0}:${index}`}
                fallback={fallback}
                resetKey={View}
              >
                <box
                  style={{
                    width: "100%",
                    height: fixedHeight,
                    minHeight: fixedHeight,
                    maxHeight: fixedHeight,
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  <View
                    width={Math.max(1, Math.floor(width))}
                    height={fixedHeight}
                    selected={selected}
                    rowIndex={index}
                  />
                </box>
              </FileViewRowErrorBoundary>
            ) : (
              fallback
            )}
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

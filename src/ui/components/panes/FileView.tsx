import { TextAttributes } from "@opentui/core";
import { Component, memo, useMemo, type ReactNode } from "react";
import type { DiffFile } from "../../../core/types";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
  ExtensionFileViewSpan,
} from "../../../extension-api/types";
import type { AppTheme } from "../../themes";
import type { DiffSectionGeometry } from "../../diff/diffSectionGeometry";
import { resolveVisibleRowIndexWindow, type VisibleBodyBounds } from "../../diff/rowWindowing";
import { reviewRowId } from "../../lib/ids";
import type { ResolvedFileViewLayout } from "../../fileViews/useFileViews";

type FileViewTone = ExtensionFileViewSpan["tone"];
type FileViewTextAttribute = NonNullable<ExtensionFileViewSpan["attributes"]>[number];

export interface FileViewRowFailure {
  extensionId: string;
  viewId: string;
  fileId: string;
  filePath: string;
  rowId: string;
  layoutGeneration: number;
  message: string;
}

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

/** Contain synchronous render/lifecycle failures to one row and attribute them to the host. */
class FileViewRowErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Render host-windowed symbolic and custom rows without surrendering outer geometry. */
function FileViewComponent({
  file,
  fileView,
  geometry,
  selectedHunkIndex,
  theme,
  visibleBodyBounds,
  width,
  onRowFailure,
}: {
  file: DiffFile;
  fileView: ResolvedFileViewLayout;
  geometry: DiffSectionGeometry;
  selectedHunkIndex: number;
  theme: AppTheme;
  visibleBodyBounds?: VisibleBodyBounds;
  width: number;
  onRowFailure?: (failure: FileViewRowFailure) => void;
}) {
  const { layout } = fileView;
  const rowWindow = useMemo(() => {
    if (!visibleBodyBounds) {
      return {
        bottomSpacerHeight: 0,
        endIndex: layout.rows.length,
        startIndex: 0,
        topSpacerHeight: 0,
      };
    }
    return resolveVisibleRowIndexWindow({
      bodyHeight: geometry.bodyHeight,
      rowBounds: geometry.rowBounds,
      visibleBodyBounds,
    });
  }, [geometry.bodyHeight, geometry.rowBounds, layout.rows.length, visibleBodyBounds]);

  const mountedRows = layout.rows.slice(rowWindow.startIndex, rowWindow.endIndex);
  return (
    <box style={{ width: "100%", flexDirection: "column" }}>
      {rowWindow.topSpacerHeight > 0 ? (
        <box style={{ width: "100%", height: rowWindow.topSpacerHeight }} />
      ) : null}
      {mountedRows.map((row, offset) => {
        const index = rowWindow.startIndex + offset;
        const selected = isFileViewRowSelected(layout, index, selectedHunkIndex);
        const fixedHeight = row.component?.height;
        const View = row.component?.render as
          | ((props: ExtensionFileViewRowComponentProps) => ReactNode)
          | undefined;
        const fallback = <SymbolicFileViewRow row={row} theme={theme} />;
        // Selection is deliberately absent: hook state survives ordinary selected-prop updates.
        // Window unmount or any accepted layout/registration generation creates a fresh identity.
        const paintIdentity = `${file.id}:${fileView.registrationIdentity}:${fileView.layoutGeneration}:${row.id}`;
        return (
          <box
            key={paintIdentity}
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
                fallback={fallback}
                onError={(error) =>
                  onRowFailure?.({
                    extensionId: fileView.extensionId,
                    viewId: fileView.viewId,
                    fileId: file.id,
                    filePath: file.path,
                    rowId: row.id,
                    layoutGeneration: fileView.layoutGeneration,
                    message: error instanceof Error ? error.message || error.name : String(error),
                  })
                }
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

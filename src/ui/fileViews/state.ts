import type { RegisteredFileView } from "../../extensions/types";

/** Raw is implicit: only files explicitly switched away from raw have an entry. */
export type FileViewSelectionState = Readonly<Record<string, string>>;

/** Resolve one registered view key as `<extensionId>:<viewId>`. */
export function registeredFileViewKey(view: RegisteredFileView) {
  return `${view.extensionId}:${view.view.id}`;
}

/** Resolve a bare local or qualified file-view id without reserving extension ids. */
export function resolveRegisteredFileView(
  views: readonly RegisteredFileView[],
  extensionId: string,
  viewId: string,
) {
  const key = viewId.includes(":") ? viewId : `${extensionId}:${viewId}`;
  return views.find((view) => registeredFileViewKey(view) === key);
}

/** Reconcile per-file selections after filtering/reload removes files or views. */
export function reconcileFileViewSelections(
  current: FileViewSelectionState,
  fileIds: readonly string[],
  viewKeys: ReadonlySet<string>,
): FileViewSelectionState {
  const validFileIds = new Set(fileIds);
  const next: Record<string, string> = {};
  for (const [fileId, viewKey] of Object.entries(current)) {
    if (validFileIds.has(fileId) && viewKeys.has(viewKey)) {
      next[fileId] = viewKey;
    }
  }
  return next;
}

/** Select raw or a named view for one file without retaining a redundant raw entry. */
export function selectFileView(
  current: FileViewSelectionState,
  fileId: string,
  viewKey: string | null,
): FileViewSelectionState {
  if (viewKey === null) {
    if (!(fileId in current)) return current;
    const { [fileId]: _removed, ...next } = current;
    return next;
  }
  if (current[fileId] === viewKey) return current;
  return { ...current, [fileId]: viewKey };
}

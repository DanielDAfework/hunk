export const FILE_VIEW_DRAFT_UNAVAILABLE_REASON =
  "File presentations are unavailable while drafting an inline review note • using raw diff";

/** Draft editing remains raw-only; committed notes are resolved from validated source bindings. */
export function fileViewUnavailableReason({ hasDraftNote }: { hasDraftNote: boolean }) {
  return hasDraftNote ? FILE_VIEW_DRAFT_UNAVAILABLE_REASON : null;
}

/** Mask stored choices only while a host constraint requires raw rendering. */
export function availableFileViewSelections(
  selections: Readonly<Record<string, string>>,
  unavailableReasons: ReadonlyMap<string, string>,
) {
  if (unavailableReasons.size === 0) return selections;

  const available: Record<string, string> = {};
  let masked = false;
  for (const [fileId, viewKey] of Object.entries(selections)) {
    if (unavailableReasons.has(fileId)) {
      masked = true;
    } else {
      available[fileId] = viewKey;
    }
  }
  return masked ? available : selections;
}

import type { DiffFile } from "../../core/types";
import { alwaysShowReviewNote } from "../lib/agentAnnotations";

export const FILE_VIEW_NOTES_UNAVAILABLE_REASON =
  "File presentations are unavailable while inline review notes are visible • using raw diff";

/** Explain the one host-owned condition that currently requires raw diff rendering. */
export function fileViewUnavailableReason({
  file,
  hasDraftNote,
  showAgentNotes,
}: {
  file: DiffFile;
  hasDraftNote: boolean;
  showAgentNotes: boolean;
}) {
  const hasVisibleNote = (file.agent?.annotations ?? []).some(
    (annotation) => showAgentNotes || alwaysShowReviewNote(annotation),
  );
  return hasDraftNote || hasVisibleNote ? FILE_VIEW_NOTES_UNAVAILABLE_REASON : null;
}

/** Mask stored choices only while a host constraint requires raw rendering. */
export function availableFileViewSelections(
  selections: Readonly<Record<string, string>>,
  unavailableReasons: ReadonlyMap<string, string>,
) {
  const available: Record<string, string> = {};
  for (const [fileId, viewKey] of Object.entries(selections)) {
    if (!unavailableReasons.has(fileId)) available[fileId] = viewKey;
  }
  return available;
}

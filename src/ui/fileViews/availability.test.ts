import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import {
  availableFileViewSelections,
  FILE_VIEW_NOTES_UNAVAILABLE_REASON,
  fileViewUnavailableReason,
} from "./availability";

function fileWithNote(source = "agent"): DiffFile {
  return {
    id: "readme",
    path: "README.md",
    patch: "",
    stats: { additions: 1, deletions: 0 },
    metadata: { hunks: [] },
    agent: {
      path: "README.md",
      annotations: [{ summary: "Review this", source }],
    },
  } as unknown as DiffFile;
}

describe("file-view availability", () => {
  test("requires raw diff when a visible note or draft needs inline placement", () => {
    expect(
      fileViewUnavailableReason({
        file: fileWithNote(),
        hasDraftNote: false,
        showAgentNotes: true,
      }),
    ).toBe(FILE_VIEW_NOTES_UNAVAILABLE_REASON);
    expect(
      fileViewUnavailableReason({
        file: { ...fileWithNote(), agent: null },
        hasDraftNote: true,
        showAgentNotes: false,
      }),
    ).toBe(FILE_VIEW_NOTES_UNAVAILABLE_REASON);
  });

  test("allows hidden agent notes but not always-visible user notes", () => {
    expect(
      fileViewUnavailableReason({
        file: fileWithNote(),
        hasDraftNote: false,
        showAgentNotes: false,
      }),
    ).toBeNull();
    expect(
      fileViewUnavailableReason({
        file: fileWithNote("user"),
        hasDraftNote: false,
        showAgentNotes: false,
      }),
    ).toBe(FILE_VIEW_NOTES_UNAVAILABLE_REASON);
  });

  test("masks unavailable selections without discarding stored choices", () => {
    const selections = { readme: "preview:rendered", other: "ext:view" };
    expect(
      availableFileViewSelections(
        selections,
        new Map([["readme", FILE_VIEW_NOTES_UNAVAILABLE_REASON]]),
      ),
    ).toEqual({ other: "ext:view" });
    expect(selections).toEqual({ readme: "preview:rendered", other: "ext:view" });
  });
});

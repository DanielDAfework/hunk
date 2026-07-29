import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import {
  availableFileViewSelections,
  FILE_VIEW_DRAFT_UNAVAILABLE_REASON,
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
  test("leaves committed note placement to validated alternate-view bindings", () => {
    for (const showAgentNotes of [false, true]) {
      expect(
        fileViewUnavailableReason({
          file: fileWithNote(showAgentNotes ? "agent" : "user"),
          hasDraftNote: false,
          showAgentNotes,
        }),
      ).toBeNull();
    }
  });

  test("requires raw diff while a draft note is being edited", () => {
    expect(
      fileViewUnavailableReason({
        file: { ...fileWithNote(), agent: null },
        hasDraftNote: true,
        showAgentNotes: false,
      }),
    ).toBe(FILE_VIEW_DRAFT_UNAVAILABLE_REASON);
  });

  test("masks unavailable selections without discarding stored choices", () => {
    const selections = { readme: "preview:rendered", other: "ext:view" };
    expect(
      availableFileViewSelections(
        selections,
        new Map([["readme", FILE_VIEW_DRAFT_UNAVAILABLE_REASON]]),
      ),
    ).toEqual({ other: "ext:view" });
    expect(selections).toEqual({ readme: "preview:rendered", other: "ext:view" });
  });
});

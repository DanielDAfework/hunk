import { describe, expect, test } from "bun:test";
import type { Hunk } from "@pierre/diffs";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { formatHunkHeader } from "./hunkHeader";
import { summarizeHunk } from "./hunkSummary";
import { hunkLineRange } from "./liveComments";

describe("summarizeHunk", () => {
  test("summarizes every hunk Pierre parses with its header and inclusive spans", () => {
    // Two separated changes with zero context parse into two hunks.
    const file = createTestDiffFile({
      before: "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst stable = true;\n",
      after: "const alpha = 10;\nconst beta = 2;\nconst gamma = 30;\nconst stable = true;\n",
      context: 0,
    });
    expect(file.metadata.hunks.length).toBeGreaterThan(1);

    const summaries = file.metadata.hunks.map((hunk, index) => summarizeHunk(hunk, index));

    for (const [index, hunk] of file.metadata.hunks.entries()) {
      // The header and spans come from the same helpers every review surface
      // uses, so a summary can never disagree with rendering or navigation.
      expect(summaries[index]).toEqual({
        index,
        header: formatHunkHeader(hunk),
        ...hunkLineRange(hunk),
      });
      expect(summaries[index]!.header).toMatch(/^@@ -\d/);
      expect(summaries[index]!.oldRange).toBeDefined();
      expect(summaries[index]!.newRange).toBeDefined();
    }
  });

  test("gives a synthesized hunk without line numbers no ranges instead of NaN spans", () => {
    // Transform validation only requires `hunkContent`, so this is the least
    // hunk an extension can legally put in front of the review UI.
    const bare = { hunkContent: [] } as unknown as Hunk;

    expect(summarizeHunk(bare, 3)).toEqual({ index: 3, header: "" });
  });

  test("keeps a synthesized hunk's declared header text when it has one", () => {
    const declared = { hunkContent: [], hunkSpecs: "@@ synthesized @@" } as unknown as Hunk;

    expect(summarizeHunk(declared, 0)).toEqual({ index: 0, header: "@@ synthesized @@" });
  });
});

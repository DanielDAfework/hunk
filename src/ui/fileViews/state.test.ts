import { describe, expect, test } from "bun:test";
import { reconcileFileViewSelections, selectFileView } from "./state";

describe("file-view selection state", () => {
  test("keeps valid per-file choices across reload while dropping stale ids and views", () => {
    expect(
      reconcileFileViewSelections(
        { readme: "hunk:rendered-markdown", gone: "other:view", stale: "removed:view" },
        ["readme", "stale"],
        new Set(["hunk:rendered-markdown"]),
      ),
    ).toEqual({ readme: "hunk:rendered-markdown" });
  });

  test("stores raw implicitly and avoids needless state changes", () => {
    const active = selectFileView({}, "readme", "hunk:rendered-markdown");
    expect(active).toEqual({ readme: "hunk:rendered-markdown" });
    expect(selectFileView(active, "readme", "hunk:rendered-markdown")).toBe(active);
    expect(selectFileView(active, "readme", null)).toEqual({});
  });
});

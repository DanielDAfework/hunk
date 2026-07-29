import { describe, expect, test } from "bun:test";
import { reconcileFileViewSelections, selectFileView } from "./state";

describe("file-view selection state", () => {
  test("keeps valid per-file choices across reload while dropping stale ids and views", () => {
    expect(
      reconcileFileViewSelections(
        { readme: "preview:rendered", gone: "other:view", stale: "removed:view" },
        ["readme", "stale"],
        new Set(["preview:rendered"]),
      ),
    ).toEqual({ readme: "preview:rendered" });
  });

  test("stores raw implicitly and avoids needless state changes", () => {
    const active = selectFileView({}, "readme", "preview:rendered");
    expect(active).toEqual({ readme: "preview:rendered" });
    expect(selectFileView(active, "readme", "preview:rendered")).toBe(active);
    expect(selectFileView(active, "readme", null)).toEqual({});
  });
});

import { describe, expect, test } from "bun:test";
import type { RegisteredFileView } from "../../extensions/types";
import {
  reconcileFileViewSelections,
  registeredFileViewKey,
  resolveRegisteredFileView,
  selectFileView,
} from "./state";

describe("file-view selection state", () => {
  test("keeps valid per-file choices across reload while dropping stale ids and views", () => {
    expect(
      reconcileFileViewSelections(
        {
          readme: "preview:rendered",
          gone: "other:view",
          stale: "removed:view",
        },
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

  test("allows an extension view id named raw because only null is the raw sentinel", () => {
    const rawNamedView = {
      extensionId: "preview",
      view: { id: "raw" },
    } as RegisteredFileView;

    expect(registeredFileViewKey(rawNamedView)).toBe("preview:raw");
    expect(resolveRegisteredFileView([rawNamedView], "preview", "raw")).toBe(rawNamedView);
    expect(resolveRegisteredFileView([rawNamedView], "other", "preview:raw")).toBe(rawNamedView);
  });
});

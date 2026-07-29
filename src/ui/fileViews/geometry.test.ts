import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import type { ExtensionFileViewLayout } from "../../extension-api/types";
import { measureFileViewGeometry } from "./geometry";
import { validateFileViewLayout } from "./layout";

describe("file-view geometry", () => {
  test("uses declared component heights while retaining stable row ids and hunk bounds", () => {
    const file = createTestDiffFile({
      id: "custom-file",
      path: "custom.ts",
      before: "old\n",
      after: "new\n",
    });
    const layout: ExtensionFileViewLayout = {
      rows: [
        { id: "intro", spans: [{ text: "intro" }] },
        {
          id: "custom-a",
          spans: [{ text: "custom fallback" }],
          component: { height: 3, render: () => null },
        },
        {
          id: "custom-b",
          spans: [{ text: "custom fallback" }],
          component: { height: 2, render: () => null },
        },
      ],
      hunkRows: [
        { startRow: 0, endRow: 1 },
        { startRow: 2, endRow: 2 },
      ],
    };

    const checked = validateFileViewLayout(layout, 2, 80);
    if (!checked.valid) throw new Error(checked.issue);
    const geometry = measureFileViewGeometry(file, checked.value);

    expect(geometry.rowBounds.map((row) => row.height)).toEqual([...checked.value.rowHeights]);
    expect(geometry.bodyHeight).toBe(6);
    expect(
      geometry.rowBounds.map(({ stableKey, top, height }) => ({
        stableKey,
        top,
        height,
      })),
    ).toEqual([
      { stableKey: "file-view:intro", top: 0, height: 1 },
      { stableKey: "file-view:custom-a", top: 1, height: 3 },
      { stableKey: "file-view:custom-b", top: 4, height: 2 },
    ]);
    expect(geometry.hunkAnchorRows).toEqual(
      new Map([
        [0, 0],
        [1, 4],
      ]),
    );
    expect(geometry.hunkBounds.get(0)).toMatchObject({ top: 0, height: 4 });
    expect(geometry.hunkBounds.get(1)).toMatchObject({ top: 4, height: 2 });
  });
});

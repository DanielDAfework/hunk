import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import type {
  ExtensionFileViewLayout,
  ExtensionFileViewRowComponentProps,
} from "../../../extension-api/types";
import { measureFileViewGeometry } from "../../fileViews/geometry";
import { reviewRowId } from "../../lib/ids";
import { resolveTheme } from "../../themes";
import { FileView, isFileViewRowSelected } from "./FileView";

const layout: ExtensionFileViewLayout = {
  rows: [
    { id: "heading", spans: [{ text: "Heading" }] },
    { id: "body", spans: [{ text: "Body" }] },
    { id: "tail", spans: [{ text: "Tail" }] },
  ],
  hunkRows: [
    { startRow: 0, endRow: 0 },
    { startRow: 0, endRow: 0 },
    { startRow: 1, endRow: 2 },
  ],
};

describe("FileView hunk selection", () => {
  test("highlights every rendered row inside the selected hunk bounds", () => {
    expect(isFileViewRowSelected(layout, 0, 2)).toBe(false);
    expect(isFileViewRowSelected(layout, 1, 2)).toBe(true);
    expect(isFileViewRowSelected(layout, 2, 2)).toBe(true);
    expect(isFileViewRowSelected(layout, 1, 1)).toBe(false);
  });
});

describe("FileView custom rows", () => {
  test("preserves the symbolic-only renderer", async () => {
    const file = createTestDiffFile({
      id: "symbolic",
      path: "symbolic.ts",
      before: "a",
      after: "b",
    });
    const geometry = measureFileViewGeometry(file, layout, 20);
    const setup = await testRender(
      <FileView
        layout={layout}
        geometry={geometry}
        selectedHunkIndex={2}
        theme={resolveTheme("github-dark-default", null)}
        width={20}
      />,
      { width: 20, height: 4 },
    );

    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Heading");
      expect(frame).toContain("Body");
      expect(frame).toContain("Tail");
      expect(setup.renderer.root.findDescendantById(reviewRowId("file-view:body"))?.height).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("mounts hook-using components only inside the host row window with bounded props", async () => {
    const paintProps: ExtensionFileViewRowComponentProps[] = [];
    const customRow = (label: string) =>
      function CustomRow(props: ExtensionFileViewRowComponentProps) {
        const [captured] = useState(label);
        paintProps.push(props);
        return <text content={`CUSTOM ${captured}`} />;
      };
    const customLayout: ExtensionFileViewLayout = {
      rows: [
        { id: "before", spans: [{ text: "BEFORE" }] },
        {
          id: "custom-a",
          spans: [{ text: "FALLBACK A" }],
          component: { height: 2, render: customRow("A") },
        },
        {
          id: "custom-b",
          spans: [{ text: "FALLBACK B" }],
          component: { height: 2, render: customRow("B") },
        },
      ],
      hunkRows: [
        { startRow: 1, endRow: 1 },
        { startRow: 2, endRow: 2 },
      ],
    };
    const file = createTestDiffFile({
      id: "custom",
      path: "custom.ts",
      before: "a",
      after: "b",
    });
    const geometry = measureFileViewGeometry(file, customLayout, 20);
    const setup = await testRender(
      <FileView
        layout={customLayout}
        geometry={geometry}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        visibleBodyBounds={{ top: 1, height: 2 }}
        width={20}
      />,
      { width: 20, height: 5 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("CUSTOM A");
      expect(frame).not.toContain("CUSTOM B");
      expect(frame).not.toContain("BEFORE");
      expect(paintProps.at(-1)).toEqual({
        width: 20,
        height: 2,
        selected: true,
        rowIndex: 1,
      });
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("clips oversized custom output to fixed host geometry and retains stable row ids", async () => {
    const clippedLayout: ExtensionFileViewLayout = {
      rows: [
        {
          id: "clipped",
          spans: [{ text: "CLIPPED FALLBACK" }],
          component: {
            height: 1,
            render: () => (
              <box style={{ width: 40, height: 3, flexDirection: "column" }}>
                <text content="VISIBLE CUSTOM" />
                <text content="HIDDEN OVERFLOW" />
                <text content="HIDDEN OVERFLOW" />
              </box>
            ),
          },
        },
        { id: "after", spans: [{ text: "AFTER ROW" }] },
      ],
      hunkRows: [{ startRow: 0, endRow: 1 }],
    };
    const file = createTestDiffFile({
      id: "clipped",
      path: "clipped.ts",
      before: "a",
      after: "b",
    });
    const geometry = measureFileViewGeometry(file, clippedLayout, 20);
    const setup = await testRender(
      <FileView
        layout={clippedLayout}
        geometry={geometry}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        width={20}
      />,
      { width: 20, height: 3 },
    );

    try {
      await act(async () => setup.renderOnce());
      const frame = setup.captureCharFrame();
      expect(frame).toContain("VISIBLE CUSTOM");
      expect(frame).not.toContain("HIDDEN OVERFLOW");
      expect(frame.split("\n")[1]).toContain("AFTER ROW");
      expect(setup.renderer.root.findDescendantById(reviewRowId("file-view:clipped"))?.height).toBe(
        1,
      );
      expect(setup.renderer.root.findDescendantById(reviewRowId("file-view:after"))?.height).toBe(
        1,
      );
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("contains a component render error to its symbolic row fallback", async () => {
    const brokenLayout: ExtensionFileViewLayout = {
      rows: [
        {
          id: "broken",
          spans: [{ text: "SAFE FALLBACK" }],
          component: {
            height: 2,
            render: () => {
              throw new Error("broken custom row");
            },
          },
        },
      ],
      hunkRows: [{ startRow: 0, endRow: 0 }],
    };
    const file = createTestDiffFile({
      id: "broken",
      path: "broken.ts",
      before: "a",
      after: "b",
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    const setup = await testRender(
      <FileView
        layout={brokenLayout}
        geometry={measureFileViewGeometry(file, brokenLayout, 20)}
        selectedHunkIndex={0}
        theme={resolveTheme("github-dark-default", null)}
        width={20}
      />,
      { width: 20, height: 3 },
    );

    try {
      await act(async () => setup.renderOnce());
      expect(setup.captureCharFrame()).toContain("SAFE FALLBACK");
    } finally {
      console.error = originalConsoleError;
      await act(async () => setup.renderer.destroy());
    }
  });
});

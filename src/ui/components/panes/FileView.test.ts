import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewLayout } from "../../../extension-api/types";
import { isFileViewRowSelected } from "./FileView";

const layout: ExtensionFileViewLayout = {
  rows: [
    { id: "heading", spans: [{ text: "Heading" }] },
    { id: "body", spans: [{ text: "Body" }] },
    { id: "tail", spans: [{ text: "Tail" }] },
  ],
  hunks: [{ index: 2, startRow: 1, endRow: 2 }],
};

describe("FileView hunk selection", () => {
  test("highlights every rendered row inside the selected hunk bounds", () => {
    expect(isFileViewRowSelected(layout, 0, 2)).toBe(false);
    expect(isFileViewRowSelected(layout, 1, 2)).toBe(true);
    expect(isFileViewRowSelected(layout, 2, 2)).toBe(true);
    expect(isFileViewRowSelected(layout, 1, 1)).toBe(false);
  });
});

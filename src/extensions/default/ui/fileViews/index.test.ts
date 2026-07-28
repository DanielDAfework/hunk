import { describe, expect, test } from "bun:test";
import { getBundledFileViewExtension } from "./index";

describe("bundled file views", () => {
  test("loads the Markdown renderer and its command once through the public factory path", () => {
    const extension = getBundledFileViewExtension();
    expect(extension.views.map((entry) => entry.view.id)).toEqual(["rendered-markdown"]);
    expect(extension.commands.map((entry) => entry.command.id)).toEqual([
      "toggle-rendered-markdown",
    ]);
    expect(getBundledFileViewExtension()).toBe(extension);
  });
});

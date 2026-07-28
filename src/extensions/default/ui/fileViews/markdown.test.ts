import { describe, expect, test } from "bun:test";
import type {
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionFileView,
  HunkExtensionAPI,
} from "../../../../extension-api/types";
import { markdownFileViewExtension } from "./markdown";

function registerMarkdownTestView() {
  let view: ExtensionFileView | undefined;
  let command: ExtensionCommand | undefined;
  let commandHandler: ExtensionCommandHandler | undefined;
  markdownFileViewExtension({
    registerCommand(candidate: ExtensionCommand, handler: ExtensionCommandHandler) {
      command = candidate;
      commandHandler = handler;
    },
    registerFileView(candidate: ExtensionFileView) {
      view = candidate;
    },
  } as HunkExtensionAPI);
  return { view: view!, command: command!, commandHandler: commandHandler! };
}

describe("bundled rendered Markdown file view", () => {
  test("uses only the public registration contract and returns symbolic annotated rows", async () => {
    const { view, command, commandHandler } = registerMarkdownTestView();
    expect(command).toMatchObject({
      id: "toggle-rendered-markdown",
      key: "ctrl+g",
      showInMenu: false,
    });
    const toggled: string[] = [];
    commandHandler({ fileViews: { toggle: (viewId: string) => toggled.push(viewId) } } as never);
    expect(toggled).toEqual(["rendered-markdown"]);
    expect(view.matches({ path: "README.md", isBinary: false, isTooLarge: false } as never)).toBe(
      true,
    );

    const layout = await view.layout(
      {
        file: {
          id: "readme",
          path: "README.md",
          patch: "",
          stats: { additions: 1, deletions: 0 },
          metadata: {},
          agent: null,
          hunks: [{ index: 0, header: "@@", newRange: [2, 2] }],
        },
        changes: [{ hunkIndex: 0, side: "new", range: [2, 2], kind: "added" }],
        documents: {
          read: async () => ({ availability: "exact" as const, text: "# Hello\nnew item\n" }),
        },
      },
      { width: 80, signal: new AbortController().signal },
    );

    expect(layout?.rows).toEqual([
      { id: "new:1", spans: [{ text: "# Hello", style: "heading" }] },
      { id: "new:2", spans: [{ text: "new item", style: "added" }] },
      { id: "new:3", spans: [{ text: " ", style: "plain" }] },
    ]);
    expect(layout?.hunks).toEqual([{ index: 0, startRow: 1, endRow: 1 }]);
  });

  test("falls back to raw diff for unavailable source or malformed fences", async () => {
    const { view } = registerMarkdownTestView();
    const base = {
      file: {
        id: "x",
        path: "x.md",
        patch: "",
        stats: { additions: 0, deletions: 0 },
        metadata: {},
        agent: null,
        hunks: [],
      },
      changes: [],
    } as const;
    await expect(
      view.layout(
        { ...base, documents: { read: async () => null } },
        { width: 80, signal: new AbortController().signal },
      ),
    ).resolves.toBeNull();
    await expect(
      view.layout(
        {
          ...base,
          documents: {
            read: async () => ({ availability: "exact" as const, text: "```ts\nopen" }),
          },
        },
        { width: 80, signal: new AbortController().signal },
      ),
    ).resolves.toBeNull();
  });
});

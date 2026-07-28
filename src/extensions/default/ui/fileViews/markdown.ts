import type { ExtensionFactory, ExtensionFileViewRow } from "../../../../extension-api/types";

const MAX_MARKDOWN_SOURCE_LENGTH = 200_000;

/** Return the semantic style for one conservative Markdown source line. */
function markdownLineStyle(line: string, inFence: boolean) {
  if (inFence || /^\s*```/.test(line)) return "code" as const;
  if (/^\s{0,3}#{1,6}\s+\S/.test(line)) return "heading" as const;
  if (/^\s*>/.test(line)) return "quote" as const;
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) return "plain" as const;
  if (/^\s*\|.*\|\s*$/.test(line)) return "table" as const;
  return "plain" as const;
}

/** Check whether a source line falls in a changed range for the rendered new document. */
function changedStyle(
  line: number,
  ranges: ReadonlyArray<{ range: [number, number]; kind: string }>,
) {
  return ranges.some(
    (range) => range.kind === "added" && line >= range.range[0] && line <= range.range[1],
  )
    ? ("added" as const)
    : undefined;
}

/** Build a conservative host-rendered Markdown presentation from exact source text. */
export const markdownFileViewExtension: ExtensionFactory = (hunk) => {
  hunk.registerCommand(
    {
      id: "toggle-rendered-markdown",
      title: "Toggle rendered Markdown",
      showInMenu: false,
      key: "ctrl+g",
    },
    ({ fileViews }) => fileViews.toggle("rendered-markdown"),
  );
  hunk.registerFileView({
    id: "rendered-markdown",
    title: "Rendered Markdown",
    matches(file) {
      return /\.md(?:own)?$/i.test(file.path) && !file.isBinary && !file.isTooLarge;
    },
    async layout(input, context) {
      const source = await input.documents.read("new", context.signal);
      if (!source || source.text.length > MAX_MARKDOWN_SOURCE_LENGTH || context.signal.aborted) {
        return null;
      }

      const lines = source.text.split("\n");
      let inFence = false;
      const rows: ExtensionFileViewRow[] = [];
      for (const [index, line] of lines.entries()) {
        const lineNumber = index + 1;
        const fence = /^\s*```/.test(line);
        const style = changedStyle(
          lineNumber,
          input.changes.filter((change) => change.side === "new"),
        );
        rows.push({
          id: `new:${lineNumber}`,
          spans: [
            {
              text: line.length === 0 ? " " : line,
              style: style ?? markdownLineStyle(line, inFence),
            },
          ],
        });
        if (fence) inFence = !inFence;
      }
      // An unterminated code fence is ambiguous Markdown; raw diff is clearer than guessing.
      if (inFence || rows.length === 0) {
        return null;
      }

      const hunkBounds = input.file.hunks ?? [];
      const hunks = hunkBounds.map((hunk) => {
        const range = input.changes.find(
          (change) => change.hunkIndex === hunk.index && change.side === "new",
        );
        const row = Math.max(
          0,
          Math.min(rows.length - 1, (range?.range[0] ?? hunk.newRange?.[0] ?? 1) - 1),
        );
        const endRow = Math.max(
          row,
          Math.min(rows.length - 1, (range?.range[1] ?? hunk.newRange?.[1] ?? row + 1) - 1),
        );
        return { index: hunk.index, startRow: row, endRow };
      });

      return {
        rows,
        hunks,
        sourceAnchors: rows.map((_, index) => ({
          side: "new" as const,
          line: index + 1,
          row: index,
        })),
      };
    },
  });
};

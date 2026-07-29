import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const RENDERED_MARKDOWN_EXTENSION = join(
  import.meta.dir,
  "../../examples/extensions/rendered-markdown",
);
const JSX_FILE_VIEW_EXTENSION = join(import.meta.dir, "../../examples/extensions/jsx-file-view");
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Create a direct-file Markdown diff so exact old/new source remains host-readable. */
function createMarkdownPairTest() {
  const directory = mkdtempSync(join(tmpdir(), "hunk-file-view-"));
  const before = join(directory, "before.md");
  const after = join(directory, "after.md");
  const agentContext = join(directory, "agent.json");
  writeFileSync(before, "# Heading\n\n- old item\n", "utf8");
  writeFileSync(after, "# Heading\n\n- new item\n", "utf8");
  writeFileSync(
    agentContext,
    JSON.stringify({
      version: 1,
      files: [
        {
          path: "after.md",
          annotations: [{ newRange: [3, 3], summary: "Review the new item." }],
        },
      ],
    }),
    "utf8",
  );
  return { after, agentContext, before, directory };
}

describe("PTY file views", () => {
  test("does not load the Markdown example unless the user installs it", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack", pair.before, pair.after],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await session.click(/View/);
      const menu = await session.waitForText(/File presentation: Raw diff/);
      expect(menu).not.toContain("File presentation: Rendered Markdown");
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });

  test("loads the Markdown example and keeps hunk navigation live", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        RENDERED_MARKDOWN_EXTENSION,
        "--mode",
        "stack",
        pair.before,
        pair.after,
      ],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await session.click(/View/);
      const menu = await session.waitForText(/File presentation: Rendered Markdown/, {
        timeout: 20_000,
      });
      expect(menu).toContain("File presentation: Raw diff");

      await session.press("escape");
      await session.press("f8");
      await session.waitForText(/• new item/);
      await session.click(/View/);
      const toggled = await session.waitForText(/\[x\] File presentation: Rendered Markdown/, {
        timeout: 20_000,
      });
      expect(toggled).not.toContain("# Heading");

      await session.press("escape");
      await session.press("]");
      await session.waitIdle();
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });

  test("runs the real folder TSX view by key and menu across two hunks", async () => {
    const pair = harness.createMultiHunkFilePair();
    // A fresh folder root avoids Bun reusing an extension module imported by another live test.
    const extension = join(pair.dir, "jsx-runtime-proof");
    cpSync(JSX_FILE_VIEW_EXTENSION, extension, { recursive: true });
    const session = await harness.launchHunk({
      args: ["diff", "--extension", extension, "--mode", "stack", pair.before, pair.after],
      cwd: pair.dir,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.ts/, { timeout: 20_000 });
      await harness.ensureKeyboardIsLive(session);
      await session.press("f8");
      let custom = await session.waitForText(/▶ Hunk 1/, { timeout: 20_000 });
      expect(custom).toContain("Hunk 2");
      expect(custom).toContain("row 0 · click for detail");
      expect(custom).not.toContain("invalid span");

      // This proves the example's current cooperative routing, not a host guarantee that custom
      // rows will continue receiving pointer input through every future renderer integration.
      await session.click(/▶ Hunk 1/);
      custom = await session.waitForText(/lines 1–4 · @@ -1,4 \+1,4 @@/);
      expect(custom).not.toContain("row 0 · click for detail");

      await session.press("]");
      const secondHunk = await session.waitForText(/▶ Hunk 2/);
      expect(secondHunk).not.toContain("▶ Hunk 1");

      await session.press("f8");
      const raw = await session.waitForText(/line60 = 6000/);
      expect(raw).not.toContain("Hunk 1");

      await session.click(/Extensions/);
      const menu = await session.waitForText(/Toggle JSX hunk cards \(POC\)/);
      expect(menu).toMatch(/Toggle JSX hunk cards \(POC\)\s+F8/);
      await session.click(/Toggle JSX hunk cards \(POC\)/);
      const menuDispatched = await session.waitForText(/▶ Hunk 2/);
      expect(menuDispatched).toContain("Hunk 1");
    } finally {
      session.close();
    }
  });

  test("keeps raw diff active and explains why when inline notes are visible", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--extension",
        RENDERED_MARKDOWN_EXTENSION,
        "--mode",
        "stack",
        "--agent-context",
        pair.agentContext,
        "--agent-notes",
        pair.before,
        pair.after,
      ],
      cwd: pair.directory,
      cols: 140,
      rows: 24,
    });

    try {
      await session.waitForText(/before\.md/, { timeout: 20_000 });
      await session.press("f8");
      await session.waitForText(
        /File presentations are unavailable while inline review notes are visible/,
      );
      await session.waitForText(/old item/);
      await session.click(/View/);
      const menu = await session.waitForText(/\[x\] File presentation: Raw diff/);
      expect(menu).not.toContain("File presentation: Rendered Markdown");
    } finally {
      session.close();
      rmSync(pair.directory, { recursive: true, force: true });
    }
  });
});

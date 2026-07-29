import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
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
  test("selects the bundled Markdown presentation from View and keeps hunk navigation live", async () => {
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

  test("keeps raw diff active and explains why when inline notes are visible", async () => {
    const pair = createMarkdownPairTest();
    const session = await harness.launchHunk({
      args: [
        "diff",
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

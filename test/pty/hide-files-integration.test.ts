import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, lineIndexOf } from "./harness";

const harness = createPtyHarness();

/** PTY launches slow down as the suite mounts many renderers in one process; give startup headroom. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("collapsing files in the review stream (PTY)", () => {
  test("h collapses the selected file's body and restores it", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 200,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      // The first file is selected on launch, so its added lines are on screen.
      await harness.waitForSnapshot(session, (text) => text.includes("alphaOnly"), 10_000);

      await session.press("h");
      // Body collapses: the added line goes away while the file keeps its place.
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("alphaOnly"),
        5_000,
      );
      expect(collapsed).toContain("alpha.ts");

      await session.press("h");
      await harness.waitForSnapshot(session, (text) => text.includes("alphaOnly"), 5_000);
    } finally {
      session.close();
    }
  });

  test("right-clicking a sidebar row collapses that file", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 200,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      // Reveal the sidebar so the file rows are clickable.
      await session.press("s");
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => text.includes("beta.ts"),
        5_000,
      );

      const row = lineIndexOf(withSidebar, "beta.ts");
      expect(row).toBeGreaterThanOrEqual(0);

      // SGR right button press/release over the sidebar row. `text()` prefixes a
      // blank line, so a snapshot line index already equals its 1-based row.
      session.writeRaw(`\x1b[<2;4;${row}M`);
      session.writeRaw(`\x1b[<2;4;${row}m`);
      await session.waitIdle();

      // The row stays, marked collapsed.
      const collapsed = await harness.waitForSnapshot(session, (text) => text.includes("⊘"), 5_000);
      expect(collapsed).toContain("beta.ts");
      expect(collapsed).not.toContain("betaOnly");
    } finally {
      session.close();
    }
  });

  test("H restores every collapsed file", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 200,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.waitForSnapshot(session, (text) => text.includes("alphaOnly"), 10_000);

      await session.press("h");
      await harness.waitForSnapshot(session, (text) => !text.includes("alphaOnly"), 5_000);

      await session.type("H");
      await harness.waitForSnapshot(session, (text) => text.includes("alphaOnly"), 5_000);
    } finally {
      session.close();
    }
  });

  test("typing h into the filter does not collapse anything", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 200,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await harness.waitForSnapshot(session, (text) => text.includes("alphaOnly"), 10_000);

      await session.type("/");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );
      // "alpha" contains the collapse chord; a focused filter must swallow it.
      await session.type("alpha");
      // Only alpha.ts matches, so beta's body leaves the stream.
      const filtered = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("betaOnly"),
        5_000,
      );

      expect(filtered).not.toContain("⊘");
      expect(filtered).toContain("alphaOnly");
    } finally {
      session.close();
    }
  });
});

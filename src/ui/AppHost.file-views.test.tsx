import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { loadStartupExtensions } from "../extensions/startup";
import { AppHost } from "./AppHost";

const JSX_FILE_VIEW_EXTENSION = join(import.meta.dir, "../../examples/extensions/jsx-file-view");
const tempDirs: string[] = [];
setDefaultTimeout(20_000);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Copy the real folder extension to a fresh import root so Bun cannot reuse another test's module. */
function copyJsxFileViewExtension() {
  const root = mkdtempSync(join(tmpdir(), "hunk-apphost-jsx-view-"));
  tempDirs.push(root);
  const extension = join(root, "jsx-runtime-proof");
  cpSync(JSX_FILE_VIEW_EXTENSION, extension, { recursive: true });
  return { extension, root };
}

/** Build the separated changes that exercise public summaries and cross-hunk selection. */
function createTwoHunkFile() {
  const beforeLines = Array.from(
    { length: 80 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[0] = "export const line1 = 100;";
  afterLines[59] = "export const line60 = 6000;";
  return createTestDiffFile({
    after: `${afterLines.join("\n")}\n`,
    before: `${beforeLines.join("\n")}\n`,
    context: 3,
    id: "jsx-runtime-proof",
    path: "runtime-proof.ts",
  });
}

/** Paint frames until live extension layout work reaches the renderer. */
async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
    });
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
  }
  throw new Error(`Timed out waiting for AppHost frame:\n${setup.captureCharFrame()}`);
}

describe("AppHost file views", () => {
  test("runs the real folder TSX view with row-safe summaries, navigation, and mouse-up state", async () => {
    const { extension, root } = copyJsxFileViewExtension();
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    expect(extensions.issues).toEqual([]);

    const notices: string[] = [];
    extensions.notifications.subscribe((notice) => notices.push(notice.message));
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:jsx-runtime-proof",
      files: [createTwoHunkFile()],
      initialMode: "stack",
      inputMode: "stack",
      vcsOptions: { extensionPaths: [extension] },
    });
    bootstrap.extensions = extensions;

    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });
    const copied: string[] = [];
    setup.renderer.isOsc52Supported = () => true;
    setup.renderer.copyToClipboardOSC52 = (text: string) => {
      copied.push(text);
      return true;
    };

    try {
      await waitForFrame(setup, (frame) => frame.includes("runtime-proof.ts"));
      await act(async () => {
        await setup.mockInput.pressKey("F8");
      });
      let frame = await waitForFrame(
        setup,
        (nextFrame) => nextFrame.includes("Hunk 1") && nextFrame.includes("Hunk 2"),
      );
      expect(frame).toContain("▶ Hunk 1");
      expect(notices.some((notice) => notice.includes("invalid span"))).toBe(false);

      const cardY = frame.split("\n").findIndex((line) => line.includes("▶ Hunk 1"));
      const cardX = frame.split("\n")[cardY]!.indexOf("Hunk 1");
      expect(cardY).toBeGreaterThanOrEqual(0);
      expect(cardX).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup.mockMouse.pressDown(cardX, cardY);
      });
      frame = setup.captureCharFrame();
      expect(frame).toContain("click for detail");

      await act(async () => {
        await setup.mockMouse.release(cardX, cardY);
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("lines 1–4 · @@"));
      expect(frame).not.toContain("row 0 · click for detail");
      expect(copied).toEqual([]);

      await act(async () => {
        await setup.mockInput.typeText("]");
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("▶ Hunk 2"));
      expect(frame).not.toContain("▶ Hunk 1");

      await act(async () => {
        await setup.mockInput.pressKey("F8");
      });
      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("line60 = 6000"));
      expect(frame).not.toContain("Hunk 1");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});

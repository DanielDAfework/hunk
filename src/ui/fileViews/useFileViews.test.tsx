import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, createElement, useState } from "react";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import type { RegisteredFileView } from "../../extensions/types";
import { registeredFileViewKey } from "./state";
import {
  FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES,
  runFileViewLayoutRequest,
  useFileViewLayouts,
  type ResolvedFileViewLayout,
} from "./useFileViews";

/** Build one registration with a test-controlled layout callback. */
function createTestView(layout: RegisteredFileView["view"]["layout"]): RegisteredFileView {
  return {
    extensionId: "test-extension",
    view: {
      id: "test-view",
      title: "Test view",
      matches: () => true,
      layout,
    },
  };
}

const file = createTestDiffFile({
  id: "request",
  path: "request.ts",
  before: "old\n",
  after: "new\n",
});
const files = [file];
const ignoreIssue = () => {};

describe("file-view layout request lifetime", () => {
  test("aborts its child signal after successful completion", async () => {
    let signal: AbortSignal | undefined;
    const view = createTestView((input) => {
      signal = input.signal;
      return null;
    });

    expect(
      await runFileViewLayoutRequest(view, file, 80, new AbortController().signal, 50),
    ).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  test("aborts on timeout and ignores a late extension result", async () => {
    let signal: AbortSignal | undefined;
    let resolveLate: ((value: null) => void) | undefined;
    const late = new Promise<null>((resolve) => {
      resolveLate = resolve;
    });
    const view = createTestView((input) => {
      signal = input.signal;
      return late;
    });

    let settlements = 0;
    const request = runFileViewLayoutRequest(view, file, 80, new AbortController().signal, 5).then(
      () => settlements++,
      () => settlements++,
    );
    await request;
    expect(signal?.aborted).toBe(true);
    expect(settlements).toBe(1);

    resolveLate?.(null);
    await Promise.resolve();
    expect(settlements).toBe(1);
  });

  test("links parent supersession into the child request signal", async () => {
    let signal: AbortSignal | undefined;
    const parent = new AbortController();
    const view = createTestView((input) => {
      signal = input.signal;
      return new Promise<null>(() => {});
    });
    const request = runFileViewLayoutRequest(view, file, 80, parent.signal, 50).catch(() => null);

    await Promise.resolve();
    parent.abort();
    expect(signal?.aborted).toBe(true);
    await request;
  });
});

describe("file-view layout cache identity", () => {
  test("synchronously hides a stale width generation before effects clean it up", async () => {
    const renderedWidths: [number, string][] = [];
    const view = createTestView(({ width }) => ({
      rows: [{ id: "row", spans: [{ text: String(width) }] }],
      hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
    }));
    const selections = { [file.id]: registeredFileViewKey(view) };
    const views = [view];
    let changeWidth = (_width: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [width, setWidth] = useState(80);
      changeWidth = setWidth;
      latest = useFileViewLayouts({ files, selections, views, width, onIssue: ignoreIssue });
      const text = latest.get(file.id)?.layout.rows[0]?.spans[0]?.text;
      if (text) renderedWidths.push([width, text]);
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (expectedWidth: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.get(file.id)?.layout.rows[0]?.spans[0]?.text === expectedWidth) return;
      }
      throw new Error(`layout did not settle at width ${expectedWidth}`);
    };

    try {
      await settleAt("80");
      renderedWidths.length = 0;
      await act(async () => {
        changeWidth(40);
        await setup.renderOnce();
      });
      expect(renderedWidths).not.toContainEqual([40, "80"]);
      await settleAt("40");
      expect(renderedWidths).toContainEqual([40, "40"]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("replaces stale width variants for one file/view/registration", async () => {
    const layoutWidths: number[] = [];
    const view = createTestView(({ width }) => {
      layoutWidths.push(width);
      return {
        rows: [{ id: "row", spans: [{ text: String(width) }] }],
        hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const selections = { [file.id]: registeredFileViewKey(view) };
    const views = [view];
    let changeWidth = (_width: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [width, setWidth] = useState(80);
      changeWidth = setWidth;
      latest = useFileViewLayouts({ files, selections, views, width, onIssue: ignoreIssue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (expectedWidth: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.get(file.id)?.layout.rows[0]?.spans[0]?.text === expectedWidth) return;
      }
      throw new Error(`layout did not settle at width ${expectedWidth}`);
    };

    try {
      await settleAt("80");
      await act(async () => {
        changeWidth(40);
        await setup.renderOnce();
      });
      await settleAt("40");
      await act(async () => {
        changeWidth(80);
        await setup.renderOnce();
      });
      await settleAt("80");
      expect(layoutWidths).toEqual([80, 40, 80]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("evicts the oldest prepared tree after the cache limit", async () => {
    const candidates = Array.from({ length: FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES + 1 }, (_, index) =>
      createTestDiffFile({
        id: `cache-${index}`,
        path: `cache-${index}.ts`,
        before: "old\n",
        after: "new\n",
      }),
    );
    const layoutCalls = new Map<string, number>();
    const view = createTestView(({ file: inputFile }) => {
      layoutCalls.set(inputFile.id, (layoutCalls.get(inputFile.id) ?? 0) + 1);
      return {
        rows: [{ id: "row", spans: [{ text: inputFile.id }] }],
        hunkRows: (inputFile.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
      };
    });
    const key = registeredFileViewKey(view);
    const candidateFiles = candidates.map((candidate) => [candidate] as const);
    const candidateSelections = candidates.map((candidate) => ({ [candidate.id]: key }));
    const views = [view];
    let choose = (_index: number) => {};
    let latest: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

    function Harness() {
      const [index, setIndex] = useState(0);
      choose = setIndex;
      latest = useFileViewLayouts({
        files: candidateFiles[index]!,
        selections: candidateSelections[index]!,
        views,
        width: 80,
        onIssue: ignoreIssue,
      });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settleAt = async (index: number) => {
      const expectedId = candidates[index]!.id;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
        if (latest.has(expectedId)) return;
      }
      throw new Error(`layout did not settle for ${expectedId}`);
    };

    try {
      await settleAt(0);
      for (let index = 1; index < candidates.length; index += 1) {
        await act(async () => {
          choose(index);
          await setup.renderOnce();
        });
        await settleAt(index);
      }
      await act(async () => {
        choose(0);
        await setup.renderOnce();
      });
      await settleAt(0);
      expect(layoutCalls.get(candidates[0]!.id)).toBe(2);
      expect(layoutCalls.get(candidates.at(-1)!.id)).toBe(1);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("uses a valid cache before matches and invalidates a replaced registration", async () => {
    let matchesCalls = 0;
    let layoutCalls = 0;
    const buildRegistration = () =>
      createTestView(() => {
        layoutCalls += 1;
        return {
          rows: [{ id: "row", spans: [{ text: "row" }] }],
          hunkRows: file.metadata.hunks.map(() => ({ startRow: 0, endRow: 0 })),
        };
      });
    const firstRegistration = buildRegistration();
    firstRegistration.view.matches = () => {
      matchesCalls += 1;
      return true;
    };
    let refreshSelection = () => {};
    let replaceRegistration = () => {};
    let latest = new Map<string, ResolvedFileViewLayout>() as ReadonlyMap<
      string,
      ResolvedFileViewLayout
    >;
    const issue = () => {};

    function Harness() {
      const [selections, setSelections] = useState<Record<string, string>>({
        [file.id]: registeredFileViewKey(firstRegistration),
      });
      const [views, setViews] = useState<RegisteredFileView[]>([firstRegistration]);
      refreshSelection = () => setSelections((current) => ({ ...current }));
      replaceRegistration = () => {
        const replacement = buildRegistration();
        replacement.view.matches = () => {
          matchesCalls += 1;
          return true;
        };
        setViews([replacement]);
      };
      latest = useFileViewLayouts({ files, selections, views, width: 80, onIssue: issue });
      return null;
    }

    const setup = await testRender(createElement(Harness), { width: 10, height: 2 });
    const settle = async () => {
      for (let attempt = 0; attempt < 20 && latest.size === 0; attempt += 1) {
        await act(async () => {
          await Promise.resolve();
          await setup.renderOnce();
        });
      }
    };

    try {
      await settle();
      const first = latest.get(file.id);
      expect(first).toBeDefined();
      expect([matchesCalls, layoutCalls]).toEqual([1, 1]);

      await act(async () => {
        refreshSelection();
        await setup.renderOnce();
      });
      await settle();
      expect([matchesCalls, layoutCalls]).toEqual([1, 1]);
      expect(latest.get(file.id)).toBe(first);

      await act(async () => {
        replaceRegistration();
        await setup.renderOnce();
      });
      await settle();
      expect([matchesCalls, layoutCalls]).toEqual([2, 2]);
      expect(latest.get(file.id)?.registrationIdentity).not.toBe(first?.registrationIdentity);
      expect(latest.get(file.id)?.layoutGeneration).not.toBe(first?.layoutGeneration);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});

import { describe, expect, test } from "bun:test";
import { createGuardedReviewNavigation } from "./extensionNavigation";

/** One navigable file with the given number of parsed hunks. */
function createTestNavigableFile(id: string, hunkCount: number) {
  return { id, metadata: { hunks: Array.from({ length: hunkCount }, () => ({})) } };
}

function createTestNavigation(options?: {
  files?: ReturnType<typeof createTestNavigableFile>[];
  onSelectFile?: (fileId: string) => void;
  onSelectHunk?: (fileId: string, hunkIndex: number) => void;
}) {
  const warnings: string[] = [];
  const selectedFiles: string[] = [];
  const selectedHunks: Array<[string, number]> = [];
  let files = options?.files ?? [createTestNavigableFile("a", 3)];

  const navigation = createGuardedReviewNavigation({
    extensionId: "triage",
    getFiles: () => files,
    notify: (message, type) => {
      if (type === "warning") {
        warnings.push(message);
      }
    },
    onSelectFile: options?.onSelectFile ?? ((fileId) => selectedFiles.push(fileId)),
    onSelectHunk:
      options?.onSelectHunk ?? ((fileId, hunkIndex) => selectedHunks.push([fileId, hunkIndex])),
  });

  return {
    navigation,
    warnings,
    selectedFiles,
    selectedHunks,
    setFiles(next: ReturnType<typeof createTestNavigableFile>[]) {
      files = next;
    },
  };
}

describe("createGuardedReviewNavigation", () => {
  test("routes a visible-file selection through to the host callback", () => {
    const { navigation, selectedFiles, warnings } = createTestNavigation();

    navigation.selectFile("a");

    expect(selectedFiles).toEqual(["a"]);
    expect(warnings).toEqual([]);
  });

  test("refuses a file id the review stream cannot show, with a warning", () => {
    const { navigation, selectedFiles, warnings } = createTestNavigation();

    navigation.selectFile("hidden");

    expect(selectedFiles).toEqual([]);
    expect(warnings).toEqual(['Extension triage selectFile targeted unknown file id "hidden"']);
  });

  test("clamps a hunk index into the file's real range and floors fractions", () => {
    const { navigation, selectedHunks } = createTestNavigation();

    navigation.selectHunk("a", 99);
    navigation.selectHunk("a", -5);
    navigation.selectHunk("a", 1.7);

    expect(selectedHunks).toEqual([
      ["a", 2],
      ["a", 0],
      ["a", 1],
    ]);
  });

  test("refuses a non-numeric hunk index instead of passing garbage through", () => {
    const { navigation, selectedHunks, warnings } = createTestNavigation();

    navigation.selectHunk("a", Number.NaN);
    navigation.selectHunk("a", "2" as unknown as number);

    expect(selectedHunks).toEqual([]);
    expect(warnings).toEqual([
      'Extension triage selectHunk received an invalid hunk index for "a"',
      'Extension triage selectHunk received an invalid hunk index for "a"',
    ]);
  });

  test("turns a host-callback failure into a warning naming the extension", () => {
    const { navigation, warnings } = createTestNavigation({
      onSelectFile: () => {
        throw new Error("controller unavailable");
      },
    });

    navigation.selectFile("a");

    expect(warnings).toEqual(["Extension triage failed selectFile • controller unavailable"]);
  });

  test("refuses every call once the review surface it was minted for is gone", () => {
    // A hard session reload (`resetApp`) remounts the app under an in-flight
    // handler; its navigation must say so rather than silently no-op against
    // the dead instance or judge targets by the old review's file list.
    let alive = true;
    const warnings: string[] = [];
    const selectedFiles: string[] = [];
    const navigation = createGuardedReviewNavigation({
      extensionId: "triage",
      getFiles: () => [createTestNavigableFile("a", 1)],
      isLive: () => alive,
      notify: (message, type) => {
        if (type === "warning") {
          warnings.push(message);
        }
      },
      onSelectFile: (fileId) => selectedFiles.push(fileId),
      onSelectHunk: () => {},
    });

    navigation.selectFile("a");
    alive = false;
    navigation.selectFile("a");
    navigation.selectHunk("a", 0);

    expect(selectedFiles).toEqual(["a"]);
    expect(warnings).toEqual([
      "Extension triage selectFile ignored — the review session was reloaded",
      "Extension triage selectHunk ignored — the review session was reloaded",
    ]);
  });

  test("validates against the files visible at call time, not at creation", () => {
    // A command handler may await a dialog while a reload or filter changes
    // the review; navigation must judge the target against the current list.
    const { navigation, selectedFiles, warnings, setFiles } = createTestNavigation();

    setFiles([createTestNavigableFile("b", 1)]);
    navigation.selectFile("a");
    navigation.selectFile("b");

    expect(selectedFiles).toEqual(["b"]);
    expect(warnings).toEqual(['Extension triage selectFile targeted unknown file id "a"']);
  });
});

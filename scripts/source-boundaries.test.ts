import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CORE_ROOT = join(REPO_ROOT, "src", "core");

/** Return every TypeScript source file below one directory, excluding colocated tests. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Find core modules that reach into the terminal-rendering layer through relative imports. */
function coreUiImports() {
  return sourceFiles(CORE_ROOT).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return /(?:from\s*|import\s*\()["'](?:\.\.\/)+ui\//.test(source)
      ? [relative(REPO_ROOT, path)]
      : [];
  });
}

describe("source architecture boundaries", () => {
  test("keeps UI rendering out of core", () => {
    expect(coreUiImports()).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  isGeneratedPrereleasePreparation,
  isGeneratedReleasePath,
  validateGeneratedPrerelease,
} from "./verify-pr-release-notes";

const generatedPaths = [
  ".changeset/pre.json",
  ".changeset/old-fix.md",
  "CHANGELOG.md",
  "package.json",
  "benchmarks/release/bench-0.18.0-beta.0.json",
];

function validInput() {
  return {
    packageJson: { name: "hunkdiff", version: "0.18.0-beta.0" },
    pre: {
      mode: "pre",
      tag: "beta",
      initialVersions: { hunkdiff: "0.17.7" },
      changesets: ["new-feature", "old-fix"],
    },
    changelog: "# Changelog\n\n## 0.18.0-beta.0\n\n- Added a feature.\n",
    changesetIdsOnDisk: new Set(["new-feature", "old-fix"]),
  };
}

describe("isGeneratedReleasePath", () => {
  test("accepts only generated prerelease metadata", () => {
    for (const filePath of generatedPaths) {
      expect(isGeneratedReleasePath(filePath)).toBe(true);
    }

    expect(isGeneratedReleasePath("src/main.tsx")).toBe(false);
    expect(isGeneratedReleasePath("benchmarks/run.ts")).toBe(false);
    expect(isGeneratedReleasePath("bun.lock")).toBe(false);
  });
});

describe("isGeneratedPrereleasePreparation", () => {
  test("selects a metadata-only diff that changes prerelease state", () => {
    expect(isGeneratedPrereleasePreparation(generatedPaths)).toBe(true);
  });

  test("keeps ordinary changesets on the standard status path", () => {
    expect(isGeneratedPrereleasePreparation(["src/main.tsx", ".changeset/fix.md"])).toBe(false);
    expect(isGeneratedPrereleasePreparation(["CHANGELOG.md", "package.json"])).toBe(false);
  });

  test("does not exempt release preparation mixed with source changes", () => {
    expect(isGeneratedPrereleasePreparation([...generatedPaths, "src/main.tsx"])).toBe(false);
  });
});

describe("validateGeneratedPrerelease", () => {
  test("accepts coherent generated prerelease state", () => {
    expect(() => validateGeneratedPrerelease(validInput())).not.toThrow();
  });

  test("requires package version and tag agreement", () => {
    const input = validInput();
    input.packageJson.version = "0.18.0-next.0";

    expect(() => validateGeneratedPrerelease(input)).toThrow("does not match prerelease tag beta");
  });

  test("requires a stable initial package version", () => {
    const input = validInput();
    input.pre.initialVersions.hunkdiff = "0.17.7-beta.1";

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Missing stable initial version for package hunkdiff",
    );
  });

  test("requires every consumed changeset to remain on disk", () => {
    const input = validInput();
    input.changesetIdsOnDisk.delete("old-fix");

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Missing consumed changeset files: old-fix",
    );
  });

  test("rejects duplicate changeset IDs", () => {
    const input = validInput();
    input.pre.changesets = ["old-fix", "old-fix"];

    expect(() => validateGeneratedPrerelease(input)).toThrow("invalid or duplicate changeset IDs");
  });

  test("requires the exact package version heading", () => {
    const input = validInput();
    input.changelog = "# Changelog\n\n## 0.18.0-beta.1\n";

    expect(() => validateGeneratedPrerelease(input)).toThrow(
      "Changelog is missing the 0.18.0-beta.0 release heading",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { matchPromptPattern } from "./detector";

describe("matchPromptPattern", () => {
  const cases: Array<[string, string | null]> = [
    ["Do you want to continue? [Y/n] ", "yes-no"],
    ["Overwrite existing file? (y/N)", "yes-no"],
    ["Are you sure you want to continue connecting (yes/no/[fingerprint])?", "question"],
    ["Password: ", "password"],
    ["[sudo] password for alice:", "password"],
    ["Enter passphrase (empty for no passphrase): ", "password"],
    ["(END)", "pager"],
    ["--More--", "pager"],
    ["package name: (myapp) ", null], // npm init prompts end with ") " — a known miss, see eval
    ["What is your name? ", "question"],
    ["Enter value: ", "colon"],
    // Negatives: ordinary output that must NOT look like a prompt.
    ["Compiling foo v0.1.0", null],
    ["done.", null],
    ["fetching https://example.com ...", null],
  ];
  for (const [line, want] of cases) {
    test(`${JSON.stringify(line)} -> ${want}`, () => {
      expect(matchPromptPattern([line])).toBe(want);
    });
  }

  test("uses the last non-empty line", () => {
    expect(matchPromptPattern(["Reading state information...", "Continue? [Y/n] ", ""])).toBe("yes-no");
  });

  test("empty tail matches nothing", () => {
    expect(matchPromptPattern([])).toBeNull();
    expect(matchPromptPattern(["", "  "])).toBeNull();
  });
});

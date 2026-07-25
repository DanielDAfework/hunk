import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentOptionFlagName, SESSION_AGENT_COMMAND_LIST } from "../hunk-session/agentSurface";
import { renderHunkReviewSkill } from "./skillDocument";

const SKILL_PATH = join(import.meta.dir, "..", "..", "skills", "hunk-review", "SKILL.md");

/** Flags the skill documents for non-session commands (`hunk diff`, `hunk markup render`). */
const NON_SESSION_DOCUMENTED_FLAGS = ["--exclude-untracked", "--experimental", "--width"];

/** Normalize checkout line endings so the comparison stays portable on Windows. */
function normalizeNewlines(text: string) {
  return text.replaceAll("\r\n", "\n");
}

describe("hunk-review skill document", () => {
  test("checked-in SKILL.md matches the generated document", () => {
    const checkedIn = normalizeNewlines(readFileSync(SKILL_PATH, "utf8"));
    const rendered = renderHunkReviewSkill();

    if (checkedIn !== rendered) {
      throw new Error(
        "skills/hunk-review/SKILL.md is out of date. Run `bun run generate:skill` and commit the result.",
      );
    }

    expect(checkedIn).toBe(rendered);
  });

  test("only mentions flags that exist on the session command surface", () => {
    const declared = new Set([
      ...SESSION_AGENT_COMMAND_LIST.flatMap((spec) => spec.options.map(agentOptionFlagName)),
      ...NON_SESSION_DOCUMENTED_FLAGS,
    ]);
    const mentioned = renderHunkReviewSkill().match(/--[a-z][a-z-]*/g) ?? [];

    expect(mentioned.length).toBeGreaterThan(0);
    for (const flag of mentioned) {
      expect(declared).toContain(flag);
    }
  });

  test("documents every session command's synopsis", () => {
    const rendered = renderHunkReviewSkill();
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      for (const line of spec.synopsis) {
        expect(rendered).toContain(line);
      }
    }
  });
});

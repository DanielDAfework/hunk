import { describe, expect, test } from "bun:test";
import { resolveSessionTarget } from "@hunk/session-broker-core";
import {
  AGENT_ERROR_DOCS,
  agentErrorQuotePrefix,
  atMostOneFlagMessage,
  COMMENT_APPLY_STDIN_MESSAGE,
  exactlyOneTargetMessage,
  NO_ACTIVE_SESSIONS_MESSAGE,
  noDiffFileMatchesMessage,
  RELOAD_SEPARATOR_MESSAGE,
} from "./agentErrors";
import {
  COMMENT_DIRECTION_FLAGS,
  COMMENT_TARGET_FLAGS,
  NAVIGATE_TARGET_FLAGS,
} from "./agentSurface";

function createTestBrokerSession(sessionId: string) {
  return {
    sessionId,
    cwd: `/tmp/${sessionId}`,
    repoRoot: "/tmp/shared-repo",
    title: `title-${sessionId}`,
    snapshot: { updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

/** Capture the message a callback throws so broker errors can be prefix-checked. */
function thrownMessage(callback: () => unknown) {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected the callback to throw.");
}

describe("agent error messages", () => {
  test("formats exactly-one constraints with an Oxford-comma flag list", () => {
    expect(exactlyOneTargetMessage("navigation target", NAVIGATE_TARGET_FLAGS)).toBe(
      "Specify exactly one navigation target: --hunk <n>, --old-line <n>, or --new-line <n>.",
    );
    expect(exactlyOneTargetMessage("comment target", COMMENT_TARGET_FLAGS)).toBe(
      "Specify exactly one comment target: --old-line <n> or --new-line <n>.",
    );
  });

  test("formats at-most-one constraints as an either/or message", () => {
    expect(atMostOneFlagMessage(COMMENT_DIRECTION_FLAGS)).toBe(
      "Specify either --next-comment or --prev-comment, not both.",
    );
  });

  test("binds every documented quote to a real thrown message", () => {
    const sessions = [createTestBrokerSession("one"), createTestBrokerSession("two")];
    // One real message per AGENT_ERROR_DOCS entry, in the same display order. Broker-owned
    // messages are produced by the broker itself so the doc quotes track its actual wording.
    const realMessages = [
      noDiffFileMatchesMessage("src/App.tsx"),
      NO_ACTIVE_SESSIONS_MESSAGE,
      thrownMessage(() => resolveSessionTarget(sessions, { repoRoot: "/tmp/shared-repo" })),
      thrownMessage(() => resolveSessionTarget(sessions, { sessionPath: "/tmp/missing" })),
      RELOAD_SEPARATOR_MESSAGE,
      COMMENT_APPLY_STDIN_MESSAGE,
      exactlyOneTargetMessage("navigation target", NAVIGATE_TARGET_FLAGS),
      atMostOneFlagMessage(COMMENT_DIRECTION_FLAGS),
    ];

    expect(realMessages).toHaveLength(AGENT_ERROR_DOCS.length);
    for (const [index, doc] of AGENT_ERROR_DOCS.entries()) {
      expect(realMessages[index]!).toStartWith(agentErrorQuotePrefix(doc));
    }
  });
});

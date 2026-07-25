import { describe, expect, test } from "bun:test";
import {
  agentOptionFlagName,
  SESSION_AGENT_COMMAND_LIST,
  SESSION_AGENT_COMMANDS,
  SESSION_COMMENT_COMMAND_LIST,
} from "./agentSurface";

const FLAG_TOKEN_PATTERN = /--[a-z][a-z-]*/g;

describe("session agent command surface", () => {
  test("covers every daemon action with a uniquely named command", () => {
    const names = SESSION_AGENT_COMMAND_LIST.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SESSION_COMMENT_COMMAND_LIST.map((spec) => spec.name)).toEqual([
      "session comment add",
      "session comment apply",
      "session comment list",
      "session comment rm",
      "session comment clear",
    ]);
  });

  test("declares each option flag once per command", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const flagNames = spec.options.map(agentOptionFlagName);
      expect(new Set(flagNames).size).toBe(flagNames.length);
    }
  });

  test("mentions every declared option in the command synopsis", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const synopsis = spec.synopsis.join(" ");
      for (const option of spec.options) {
        expect(synopsis).toContain(agentOptionFlagName(option));
      }
    }
  });

  test("only references declared flags in synopsis and examples", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      const declared = new Set(spec.options.map(agentOptionFlagName));
      const referenced = [...spec.synopsis, ...(spec.examples ?? [])]
        .join(" ")
        .match(FLAG_TOKEN_PATTERN);
      for (const flag of referenced ?? []) {
        expect(declared).toContain(flag);
      }
    }
  });

  test("keeps synopsis lines runnable as `hunk ...` invocations", () => {
    for (const spec of SESSION_AGENT_COMMAND_LIST) {
      for (const line of spec.synopsis) {
        expect(line.startsWith(`hunk ${spec.name}`)).toBe(true);
      }
    }
  });

  test("marks navigation and comment targets with positive-int parsing", () => {
    const navigate = SESSION_AGENT_COMMANDS.navigate;
    const targetFlags = ["--hunk", "--old-line", "--new-line"];
    for (const option of navigate.options) {
      if (targetFlags.includes(agentOptionFlagName(option))) {
        expect(option.parse).toBe("positiveInt");
      }
    }
  });
});

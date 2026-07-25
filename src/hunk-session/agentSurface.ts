import type { SessionDaemonAction } from "../session/protocol";

/**
 * Declarative description of the agent-facing `hunk session` command surface.
 *
 * This module is the single source of truth for what agents can invoke: the Commander commands in
 * `src/core/cli.ts`, the `hunk session --help` usage text, and the generated
 * `skills/hunk-review/SKILL.md` reference sections are all derived from these specs, so the parser
 * and the docs cannot drift apart. Keep it pure data with no runtime dependencies.
 */

/** One agent-facing CLI option on a `hunk session` command. */
export interface AgentCommandOption {
  /** Commander flag definition, e.g. `--repo <path>`. */
  flag: string;
  /** Description shared by `--help` output and generated docs. */
  description: string;
  /** Parse the option value as a 1-based positive integer. */
  parse?: "positiveInt";
  /** Register with Commander as a required option. */
  required?: boolean;
}

/** One positional argument on a `hunk session` command. */
export interface AgentCommandPositional {
  /** Commander argument token, e.g. `[sessionId]` or `[targets...]`. */
  token: string;
  description?: string;
}

/** Declarative spec for one agent-facing `hunk session` command. */
export interface AgentCommandSpec {
  /** Commander command path without the binary name, e.g. `session comment add`. */
  name: string;
  /** One-line description used by Commander help. */
  summary: string;
  positionals: AgentCommandPositional[];
  options: AgentCommandOption[];
  /** Canonical usage lines shared by `hunk session --help` and the generated skill. */
  synopsis: string[];
  /** Copy-paste invocations appended to `--help` output and reused in the generated skill. */
  examples?: string[];
  /** Extra literal help lines (e.g. a stdin payload shape) appended after examples. */
  helpExtra?: string[];
}

/** Selector notation shared by every synopsis line that targets one live session. */
export const SESSION_SELECTOR_SYNOPSIS = "(<session-id> | --repo <path>)";

/** Reload additionally accepts `--session-path` as a selector. */
export const RELOAD_SELECTOR_SYNOPSIS = "(<session-id> | --repo <path> | --session-path <path>)";

/** Absolute navigation targets: callers must pass exactly one. */
export const NAVIGATE_TARGET_FLAGS = ["--hunk <n>", "--old-line <n>", "--new-line <n>"];

/** Comment anchoring targets: callers must pass exactly one. */
export const COMMENT_TARGET_FLAGS = ["--old-line <n>", "--new-line <n>"];

/** Relative comment navigation directions: callers may pass at most one. */
export const COMMENT_DIRECTION_FLAGS = ["--next-comment", "--prev-comment"];

const repoOption: AgentCommandOption = {
  flag: "--repo <path>",
  description: "target the live session whose repo root matches this path",
};

const jsonOption: AgentCommandOption = {
  flag: "--json",
  description: "emit structured JSON",
};

const diffFileOption: AgentCommandOption = {
  flag: "--file <path>",
  description: "diff file path as shown by Hunk",
};

const oldLineOption: AgentCommandOption = {
  flag: "--old-line <n>",
  description: "1-based line number on the old side",
  parse: "positiveInt",
};

const newLineOption: AgentCommandOption = {
  flag: "--new-line <n>",
  description: "1-based line number on the new side",
  parse: "positiveInt",
};

/**
 * Every live-session daemon action, described as one CLI command. `satisfies` keeps this map in
 * lockstep with the daemon protocol: adding a `SessionDaemonAction` without describing its CLI
 * surface here is a compile error, so the generated docs always cover the full surface.
 */
export const SESSION_AGENT_COMMANDS = {
  list: {
    name: "session list",
    summary: "list live Hunk sessions",
    positionals: [],
    options: [jsonOption],
    synopsis: ["hunk session list [--json]"],
  },
  get: {
    name: "session get",
    summary: "show one live Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [repoOption, jsonOption],
    synopsis: [`hunk session get ${SESSION_SELECTOR_SYNOPSIS} [--json]`],
  },
  context: {
    name: "session context",
    summary: "show the selected file and hunk for one live Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [repoOption, jsonOption],
    synopsis: [`hunk session context ${SESSION_SELECTOR_SYNOPSIS} [--json]`],
  },
  review: {
    name: "session review",
    summary: "export the live review model for one Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      {
        flag: "--include-patch",
        description: "include raw unified diff text for each file in review output",
      },
      {
        flag: "--include-notes",
        description: "include live review notes in review output",
      },
      jsonOption,
    ],
    synopsis: [
      `hunk session review ${SESSION_SELECTOR_SYNOPSIS} [--include-patch] [--include-notes] [--json]`,
    ],
  },
  navigate: {
    name: "session navigate",
    summary: "move a live Hunk session to one diff hunk",
    positionals: [{ token: "[sessionId]" }],
    options: [
      diffFileOption,
      repoOption,
      {
        flag: "--hunk <n>",
        description: "1-based hunk number within the file",
        parse: "positiveInt",
      },
      oldLineOption,
      newLineOption,
      { flag: "--next-comment", description: "jump to the next annotated hunk" },
      { flag: "--prev-comment", description: "jump to the previous annotated hunk" },
      jsonOption,
    ],
    synopsis: [
      `hunk session navigate ${SESSION_SELECTOR_SYNOPSIS} --file <path> (--hunk <n> | --old-line <n> | --new-line <n>) [--json]`,
      `hunk session navigate ${SESSION_SELECTOR_SYNOPSIS} (--next-comment | --prev-comment) [--json]`,
    ],
    examples: [
      "hunk session navigate --repo . --file src/App.tsx --hunk 2",
      "hunk session navigate --repo . --file src/App.tsx --new-line 372",
      "hunk session navigate --repo . --file src/App.tsx --old-line 355",
      "hunk session navigate --repo . --next-comment",
      "hunk session navigate --repo . --prev-comment",
    ],
  },
  reload: {
    name: "session reload",
    summary: "replace the contents of one live Hunk session",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      {
        flag: "--session-path <path>",
        description: "target a live session rooted at a different path",
      },
      {
        flag: "--source <path>",
        description: "load the diff from this directory instead of the session's own",
      },
      jsonOption,
    ],
    synopsis: [
      `hunk session reload ${RELOAD_SELECTOR_SYNOPSIS} [--source <path>] [--json] -- diff [ref] [-- <pathspec...>]`,
      `hunk session reload ${RELOAD_SELECTOR_SYNOPSIS} [--source <path>] [--json] -- show [ref] [-- <pathspec...>]`,
    ],
    examples: [
      "hunk session reload --repo . -- diff",
      "hunk session reload --repo . -- diff main...feature -- src/ui",
      "hunk session reload --repo . -- show HEAD~1",
      "hunk session reload --repo . -- show HEAD~1 -- README.md",
      "hunk session reload --repo /path/to/worktree -- diff",
      "hunk session reload --session-path /path/to/live-window --source /path/to/other-checkout -- diff",
    ],
  },
  "comment-add": {
    name: "session comment add",
    summary: "attach one live inline review note",
    positionals: [{ token: "[sessionId]" }],
    options: [
      { ...diffFileOption, required: true },
      { flag: "--summary <text>", description: "short review note", required: true },
      repoOption,
      oldLineOption,
      newLineOption,
      { flag: "--rationale <text>", description: "optional longer explanation" },
      {
        flag: "--markup <stml>",
        description: "experimental STML body (target session must opt in)",
      },
      { flag: "--author <name>", description: "optional author label" },
      { flag: "--focus", description: "add the note and focus the viewport on it" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment add ${SESSION_SELECTOR_SYNOPSIS} --file <path> (--old-line <n> | --new-line <n>) --summary <text> [--rationale <text>] [--author <name>] [--markup <stml>] [--focus] [--json]`,
    ],
    examples: [
      'hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"',
    ],
  },
  "comment-apply": {
    name: "session comment apply",
    summary: "apply many live inline review notes from stdin JSON",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--stdin", description: "read the comment batch from stdin as JSON" },
      { flag: "--focus", description: "apply the batch and focus the first note" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment apply ${SESSION_SELECTOR_SYNOPSIS} --stdin [--focus] [--json]`,
    ],
    examples: [
      `printf '%s\\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' | hunk session comment apply --repo . --stdin`,
    ],
    helpExtra: [
      "Stdin JSON shape:",
      "  {",
      '    "comments": [',
      "      {",
      '        "filePath": "README.md",',
      '        "hunk": 2,',
      '        "summary": "Explain this hunk",',
      '        "rationale": "Optional detail",',
      '        "author": "Pi"',
      "      }",
      "    ]",
      "  }",
    ],
  },
  "comment-list": {
    name: "session comment list",
    summary: "list live inline review notes",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--file <path>", description: "filter comments to one diff file" },
      { flag: "--type <type>", description: "filter to live, all, ai, agent, or user comments" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment list ${SESSION_SELECTOR_SYNOPSIS} [--file <path>] [--type <live|all|ai|agent|user>] [--json]`,
    ],
  },
  "comment-rm": {
    name: "session comment rm",
    summary: "remove one inline review note",
    positionals: [
      {
        token: "[targets...]",
        description: "<session-id> <comment-id>, or <comment-id> with --repo",
      },
    ],
    options: [repoOption, jsonOption],
    synopsis: [`hunk session comment rm ${SESSION_SELECTOR_SYNOPSIS} <comment-id> [--json]`],
  },
  "comment-clear": {
    name: "session comment clear",
    summary: "clear inline review notes",
    positionals: [{ token: "[sessionId]" }],
    options: [
      repoOption,
      { flag: "--file <path>", description: "clear only one diff file's comments" },
      {
        flag: "--include-user",
        description: "also clear human notes created with the TUI `c` action",
      },
      { flag: "--all", description: "clear both live agent comments and human user notes" },
      { flag: "--yes", description: "confirm destructive comment clearing" },
      jsonOption,
    ],
    synopsis: [
      `hunk session comment clear ${SESSION_SELECTOR_SYNOPSIS} [--file <path>] [--include-user|--all] --yes [--json]`,
    ],
  },
} satisfies Record<SessionDaemonAction, AgentCommandSpec>;

/** Specs in display order for help text and generated docs. */
export const SESSION_AGENT_COMMAND_LIST: AgentCommandSpec[] = Object.values(SESSION_AGENT_COMMANDS);

/** Specs for the `hunk session comment` subcommand family, in display order. */
export const SESSION_COMMENT_COMMAND_LIST = SESSION_AGENT_COMMAND_LIST.filter((spec) =>
  spec.name.startsWith("session comment "),
);

/** Extract the flag name (e.g. `--old-line`) from a Commander flag definition. */
export function agentOptionFlagName(option: AgentCommandOption) {
  return option.flag.split(" ")[0]!;
}

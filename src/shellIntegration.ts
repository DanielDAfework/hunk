/**
 * OSC 133 shell integration, injected by owning the shell's startup file.
 *
 * bash: PS0 expands after a command line is read and before it runs → C.
 *       PROMPT_COMMAND runs before each prompt → D;<exit code> then A.
 * zsh:  preexec/precmd hooks emit the same sequences. (Implemented but not
 *       verified in the dev container — no zsh; see FINDINGS.md.)
 *
 * The daemon generates a private rcfile per session so user dotfiles can't
 * clobber the hooks, and sets AGENT_TERM=1 so tooling can detect it's running
 * under an agent terminal.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ShellKind = "bash" | "zsh";

export function detectShellKind(shellPath: string): ShellKind {
  return path.basename(shellPath).includes("zsh") ? "zsh" : "bash";
}

const BASH_RC = `# agent-term generated rcfile — OSC 133 job boundaries
export AGENT_TERM=1
# Keep the prompt minimal and stable; agents never parse it, but humans may attach.
PS1='agent-term$ '
# C: command output starts (PS0 expands post-read, pre-exec).
PS0='\\[\\033]133;C\\007\\]'
# D;<code>: command finished. A: prompt starting.
PROMPT_COMMAND='printf "\\033]133;D;%s\\007" "$?"; printf "\\033]133;A\\007"'
# No fancy line editing needed; keep bracketed paste noise out of the stream.
bind 'set enable-bracketed-paste off' 2>/dev/null || true
`;

const ZSHRC = `# agent-term generated zshrc — OSC 133 job boundaries
export AGENT_TERM=1
PS1='agent-term%% '
precmd() { printf '\\033]133;D;%s\\007' "$?"; printf '\\033]133;A\\007'; }
preexec() { printf '\\033]133;C\\007'; }
`;

export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Write the integration file(s) under `dir` and return how to launch the
 * shell so they take effect.
 */
export function prepareShell(shellPath: string, dir: string): ShellLaunch {
  fs.mkdirSync(dir, { recursive: true });
  const kind = detectShellKind(shellPath);
  if (kind === "zsh") {
    // ZDOTDIR redirects all zsh startup files to our directory.
    fs.writeFileSync(path.join(dir, ".zshrc"), ZSHRC);
    return { file: shellPath, args: ["-i"], env: { ZDOTDIR: dir } };
  }
  const rc = path.join(dir, "bashrc");
  fs.writeFileSync(rc, BASH_RC);
  return { file: shellPath, args: ["--noprofile", "--rcfile", rc, "-i"], env: {} };
}

# Dogfooding agent-term in your own Claude Code setup

The evidence (see FINDINGS.md, A/B rounds 1–3) says: don't replace your
agent's bash tool with a new API — give it the same interface backed by the
supervisor. Two ways to wire that up.

## Option A — hybrid CLI through the Bash tool (recommended, 5 minutes)

1. Start the daemon once (e.g. in a tmux pane, or a user service):

   ```sh
   cd <this repo>
   bun run src/ipcDaemon.ts /tmp/agent-term.sock
   ```

2. Put a tiny wrapper on your PATH, e.g. `~/bin/sh+`:

   ```sh
   #!/bin/sh
   export AGENT_TERM_SOCK=/tmp/agent-term.sock
   export AGENT_TERM_KEY=${AGENT_TERM_KEY:-claude}
   export AGENT_TERM_DISPLAY=sh+   # name used in the printed hints
   exec bun run <this repo>/src/sh.ts "$@"
   ```

3. Tell Claude Code about it in your project's `CLAUDE.md`:

   ```md
   ## terminal
   For dev servers, watch tasks, and anything interactive, prefer:
     sh+ [--timeout <sec>] -- '<bash command>'
   It runs in a persistent shell and prints bracketed status lines:
   follow them (`--reply` answers prompts, `--poll <job>` streams new
   output from long-running jobs, `--grep <job>` searches big output).
   Plain quick commands can keep using the normal Bash tool.
   ```

4. Optionally allowlist it in `.claude/settings.json` so there are no
   permission prompts for `sh+ ...` invocations.

What you should notice in daily use, if the eval generalizes:
- dev servers/watchers: start + confirm binding in one call, `--poll` for
  incremental logs, no orphaned `nohup` processes;
- interactive tools (`npm init`, git credential prompts, pagers) announce
  themselves instead of hanging or dying on EOF;
- per-command exit codes inside one long-lived shell (venvs, `cd`, env
  vars persist);
- when something big scrolls by, `--grep job-N` instead of temp files.

## Option B — MCP server (for clients without a bash tool)

```json
{
  "mcpServers": {
    "agent-term": {
      "command": "bun",
      "args": ["run", "src/daemon.ts"],
      "cwd": "<this repo>"
    }
  }
}
```

This exposes the nine structured tools (session_create/run/wait/
read_output/...). Note the A/B result: for models that are strong shell
users, this surface measured *worse* than exec-style usage — prefer
Option A unless your client can't run CLIs.

## Watching what the agent does

```sh
bun run src/attach.ts <session-id>     # read-only live mirror of the PTY
```

Raw session logs live under `$AGENT_TERM_HOME` (default `~/.agent-term`).

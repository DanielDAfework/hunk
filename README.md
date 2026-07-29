# agent-term

**Give your agent a terminal it can't drown in.** agent-term is a PTY
supervisor daemon exposed as an MCP server: every command becomes an async
job with an exact exit code, output arrives as a ~30-line digest you query
instead of a firehose you paste, and "this program is waiting for input" is
a detected state instead of a hung session. Real PTYs underneath — programs
behave exactly as they do for humans — but agents never touch the raw
stream.

Measured on real workloads: 27–190x fewer tokens than full-output capture on
error-heavy builds and long logs, and a prompt detector at 1.00 precision /
1.00 recall on 12 live cases (sudo-class passwords, git credentials, pagers,
apt confirmations).

See [FINDINGS.md](./FINDINGS.md) for the investigation, eval results, and
answers to the design's open questions.

## Why

Terminal emulators are renderers built for human eyes. Agents use them anyway
because models understand bash deeply, but the fit is bad: progress-bar
redraws pollute captured output, ANSI escapes waste tokens, interactive
prompts hang sessions, output is an unbounded firehose against a finite
context budget, and there is no async job model.

This daemon keeps the PTY (training data stays valid, programs don't change
behavior) and replaces the *interface*: a structured MCP tool surface where
every command is a job, every job's output is normalized and addressable, and
"this thing is waiting for input" is a first-class, detectable state.

## Architecture

```
MCP client (agent)
   │  stdio
┌──▼─────────────────────────────────────────┐
│ daemon (src/daemon.ts)                     │
│  SessionManager ── Session ── bun-pty PTY ─┼── bash/zsh (+ OSC 133 hooks)
│       │              │                     │
│       │              ├─ Osc133Parser: job boundaries + exit codes
│       │              ├─ JobOutput: StreamNormalizer + query modes
│       │              ├─ awaiting-input detector (procfs + termios + patterns)
│       │              └─ raw byte log on disk (human mirror / recovery)
└────────────────────────────────────────────┘
        bun run src/attach.ts <session>   ← read-only human mirror (stub)
```

- **Sessions** are persistent shells on real PTYs (`AGENT_TERM=1` set).
  Multiple concurrent sessions are first-class.
- **Jobs**: `run` returns immediately with a job id. Command boundaries and
  exit codes come from OSC 133 sequences injected via a generated rcfile
  (`PS0`/`PROMPT_COMMAND` in bash, `preexec`/`precmd` in zsh) — no prompt
  regex matching.
- **Output store**: agents get a digest (exit code, duration, sizes,
  estimated tokens, first 10 + last 20 lines) and then query: head / tail /
  slice / grep / full (budget-gated) / delta / screen. Every response reports
  the estimated tokens returned *and* remaining. Normalization strips ANSI,
  collapses progress-bar redraws (final frame + count), flags
  alternate-screen TUI output — and the raw byte stream is always on disk
  for recovery. For full-screen programs, `{mode:"screen"}` renders the live
  viewport through a headless terminal emulator (`@xterm/headless`), exactly
  what a human would see.
- **Awaiting-input**: quiet jobs are probed — is a foreground process blocked
  in `read(2)` on the tty? did termios switch to echo-off/raw? does the
  trailing line look like a prompt? Suspected prompts flip the job to
  `awaiting-input` with the trailing output attached, so the agent can
  `send_input` or escalate. Measured at precision 1.00 / recall 1.00 on the
  12-case eval suite (`test/detector-eval.test.ts`).

## MCP tools (v1)

| tool | purpose |
| --- | --- |
| `session_create(name?, cwd?, shell?)` | new persistent shell session |
| `session_list()` | sessions with job counts |
| `session_kill(session_id)` | kill a session |
| `run(session_id, command)` | start an async job, returns `job_id` immediately |
| `job_status(job_id)` | state + output digest |
| `wait(job_id, timeout_ms, since_line?)` | block until exit/awaiting-input/timeout; optional output delta |
| `read_output(job_id, mode, ...)` | head / tail / slice / grep / full / delta / screen |
| `send_input(session_id, text, end_with_newline?)` | answer prompts |
| `job_kill(job_id, signal?)` | signal the job's foreground process group |

## Usage

```sh
bun install

# run the MCP server (stdio) — e.g. in an MCP client config:
#   { "command": "bun", "args": ["run", "src/daemon.ts"], "cwd": "<this repo>" }
bun run daemon

# human mirror (read-only) of a session's raw stream:
bun run attach s1

# tests (includes live-PTY integration + detector eval):
bun test

# token benchmark, naive capture vs digest+query (writes bench/results.json):
bun run bench
```

Raw logs and generated rcfiles live under `$AGENT_TERM_HOME`
(default `~/.agent-term`).

## Layout

```
src/
  daemon.ts            MCP stdio entry point
  mcp.ts               tool surface (schemas + teaching error messages)
  manager.ts           session registry + global job index
  session.ts           PTY session, job queue, lifecycle, raw log
  markers.ts           streaming OSC 133 parser
  normalize.ts         ANSI strip, CR/cursor-redraw collapse, TUI detection
  screen.ts            headless-xterm viewport rendering for TUI jobs
  store.ts             per-job output store, digest + query modes
  detector.ts          awaiting-input heuristics
  procfs.ts            /proc + termios helpers for the detector
  shellIntegration.ts  generated rcfiles (bash verified; zsh untested)
  attach.ts            human mirror stub
  tokens.ts            token estimation (chars/4)
bench/                 Phase 3 token benchmark
test/                  integration tests + detector eval
```

## Status / limitations

- Prototype. bash is fully exercised; the zsh integration path is written but
  unverified (no zsh in the dev container).
- Linux-specific detector internals (`/proc`, `stty`); the rest is portable.
- In scrollback text, alt-screen content is a frame-boundary approximation;
  use `read_output {mode:"screen"}` for a faithful emulator-rendered
  viewport, or the raw log for bytes.
- `attach` is read-only and poll-based by design (v1 stub).

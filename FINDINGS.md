# FINDINGS

Working notes for the agent-native terminal ("session daemon") prototype.
Phase 1 findings were written before coding, per the brief. Phase 3 results are
appended at the bottom as they land.

## Phase 1 — Investigation

### 1.1 PTY layer under Bun: node-pty is half-broken, bun-pty works

Environment: Bun 1.3.11, Linux x64 (container), bash 5.2.21. No zsh installed
in this container (see 1.2).

**node-pty 1.1.0** (the default choice) was tested first:

- The native addon builds and loads fine under Bun once you run
  `bun pm trust node-pty` (Bun blocks postinstall scripts by default, so the
  node-gyp build silently doesn't happen on plain `bun add` — the resulting
  error, `Failed to load native module: pty.node`, is misleading and worth
  knowing about).
- A second footgun: running a script from *outside* the project directory makes
  Bun resolve `node-pty` from its global cache, which has no built binary.
  Same misleading error.
- With those fixed, **reads work but writes are silently dropped**. A spawned
  `bash -i` paints its prompt (data arrives via `onData`), but `pty.write()`
  never reaches the shell — no echo, no execution, no error. node-pty wraps
  the PTY master fd in a `net.Socket`/`tty.ReadStream`; Bun's implementation
  of that fd-socket path apparently services reads but not writes.
- Workarounds were probed and failed: writing straight to the master fd with
  `fs.writeSync` raises `EBADF` (Bun appears to dup the fd into its event
  loop and invalidate the original), and enumerating `/proc/self/fd` finds
  *no* fd pointing at `/dev/ptmx`, so there is nothing to write to from JS.

**bun-pty 1.x** (Rust core accessed via `bun:ffi`) was tested next and passed
the same probe: full write→execute→read round-trip
(`echo DDD-$((6*7))` → `DDD-42` captured), plus `pid`, `resize`, `kill`,
`onExit`. It avoids Bun's node-net layer entirely, which is exactly where
node-pty broke.

**Decision: bun-pty.** Justification: node-pty's write path is unusable under
this Bun version and the workarounds are dead ends; bun-pty exposes the same
`IPty`-shaped interface (so swapping back to node-pty under Node.js would be a
small change), ships a prebuilt Rust cdylib, and worked first try. Risks
accepted: it's a much smaller project than node-pty, and it exposes no direct
master-fd or slave-path API — we recover the slave tty path via
`/proc/<shell-pid>/fd/0` instead, which we need anyway for termios inspection
(see awaiting-input detection).

There is no Bun-native PTY API in Bun 1.3 (`Bun.spawn` has no `terminal`
option); an FFI package is currently the only "Bun-native" route.

### 1.2 OSC 133 shell integration

Verified in **bash** end-to-end through the real PTY:

- `PS0='\[\033]133;C\007\]'` — bash expands `PS0` after reading a command and
  before executing it, so `C` ("command output starts") fires at exactly the
  right boundary.
- `PROMPT_COMMAND='printf "\033]133;D;%s\007" "$?"; printf "\033]133;A\007"'`
  — emits `D;<exit-code>` ("command finished") then `A` ("prompt starts")
  before every prompt paint.

Observed marker stream for `echo out1; false` then `echo out2`:
`C D;1 A C D;0 A` — correct boundaries and correct exit codes, no prompt-regex
matching anywhere. Two caveats worth recording:

- `PROMPT_COMMAND` also runs for *empty* command lines (user hits enter), so
  the daemon must ignore `D`/`A` markers when no job is active — the job
  lifecycle is driven by "we wrote a command, then saw `C`", not by markers
  alone.
- The daemon owns the rcfile (`bash --norc --rcfile <generated>`), so user
  rc files can't clobber the hooks in v1. A production version would source
  the user's rc first and re-assert the hooks after.

**zsh**: not installed in this container, so the zsh path is implemented
(`precmd`/`preexec` in a generated `ZDOTDIR/.zshrc` emitting the same
sequences) but *not* verified here. `preexec` is actually a better start
marker than bash's `PS0` (it also receives the command text). This is a
documented gap, not an assumption of correctness.

### 1.3 Prior art (one page)

**Warp.** Warp's "blocks" are the closest product-shape ancestor: it uses
shell integration (bracketed markers, same OSC 133 family lineage) to split a
PTY stream into command-scoped blocks with known exit codes, and its agent
features consume blocks rather than raw scrollback. But Warp is a GUI
terminal for humans; blocks are a rendering/UX unit, not an addressable API.
There's no external structured query surface ("give me lines 400–450 of job
7"), no token accounting, and agents can't drive it headlessly as a daemon.

**tmux control mode (`tmux -CC`).** Proves the "real PTYs underneath, machine
protocol on top" architecture is sound — iTerm2 drives whole tmux sessions
through a line-oriented protocol with `%begin`/`%end` guarded replies and
async `%output` notifications. What it does *not* have: any notion of a
command/job (output is per-pane firehose, base64-ish escaped, unbounded), any
output store (scrollback is the store; `capture-pane` is screen-shaped, not
job-shaped), exit codes, or input-wait detection. tmux answers "how do I
multiplex and mirror sessions"; it doesn't answer "how does an agent consume
command output on a budget". The human-mirror plane of this prototype
(`attach`) is deliberately the tmux-shaped part.

**Existing shell/terminal MCP servers.** The common shapes as of early 2026:
(a) one-shot exec servers (run command, return full stdout/stderr when done)
— these hang on interactive prompts and return unbounded output;
(b) tmux-wrapper MCP servers (send-keys + capture-pane) — async and
mirror-able, but screen-scraping: no job identity, no exit codes without
prompt-regex hacks, output reads are "whatever is on screen now";
(c) persistent-shell servers with a timeout+tail contract — closest in
spirit, but typically one shell, no job model, no queryable store, no
awaiting-input state.

**Genuinely not covered by any of the above:** the combination of
(1) job-scoped, exit-code-accurate output capture via shell integration,
(2) an addressable output store with digest-first, token-budgeted reads, and
(3) awaiting-input as a first-class job state. That combination is the
prototype's actual thesis; the pieces exist separately everywhere.

## Phase 3 — Eval

(To be filled in after the build: token-savings table for the five scenarios,
detector precision/recall, and answers to the four open questions.)

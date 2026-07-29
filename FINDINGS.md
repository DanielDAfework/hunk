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

**bun-pty 0.4.x** (Rust core accessed via `bun:ffi`) was tested next and passed
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

### 3.1 Token benchmark: naive capture vs digest+query

Method: each scenario runs for real through the daemon (real PTY, real
commands, real network where needed). Token estimates are chars/4 throughout.
Three baselines per scenario:

- **naive_raw** — the raw PTY stream for the job: what a "run command, return
  the output" MCP server ships (escapes, redraws and all).
- **naive_stripped** — a smarter naive server that strips ANSI but doesn't
  collapse redraws or paginate.
- **digest_flow** — what an agent actually receives here: the `wait()` digest
  JSON plus the JSON of each `read_output` query the scenario's task needs.

| scenario | task | naive_raw | naive_stripped | digest_flow | savings vs raw |
| --- | --- | ---: | ---: | ---: | ---: |
| npm install (cold cache, 143 pkgs) | succeeded? warnings? | 211 | 73 | 197 | **1.1x** |
| pip install (numpy+requests, cold) | succeeded? warnings? | 1,899 | 1,859 | 805 | **2.4x** |
| tsc, 200 type errors | error count + first 3 | 10,805 | 7,303 | 404 | **26.7x** |
| git log --oneline, 10k commits | 15 most recent commits | 121,972 | 121,967 | 643 | **189.7x** |
| dev server (never exits) | did it bind to a port? | 189* | 189* | 311 | 0.6x* |
| find / -name '*.conf' | locate resolv.conf | 3,675 | 3,675 | 642 | **5.7x** |

Raw data: `bench/results.json`; reproduce with `bun run bench`.

**The ≥10x target on scenarios 1–3, investigated as instructed:**

- **tsc and git log clear it easily** (26.7x, 189.7x). Savings scale with
  output size: the digest is a bounded ~30-line window, so the ratio is
  roughly `output_size / constant`.
- **npm install misses it (1.1x), and the reason is a genuine finding:
  npm 10 on a TTY is self-collapsing.** It renders one spinner line via
  `ESC[1G ESC[0K` redraws and a one-line summary — ~900 raw bytes total for a
  143-package cold install. The "progress bars pollute captured output"
  premise is a real problem for pip, cargo, docker, yarn-classic era tools,
  but modern npm already solved its own output hygiene. Normalization still
  pays (raw→normalized is 220→59 tokens, 3.7x, because the spinner frames
  collapse), but there is simply nothing big to save. (This benchmark also
  exposed that our normalizer initially treated only `\r` as a redraw;
  npm's `ESC[1G` column-reset idiom is now handled equivalently.)
- **pip lands at 2.4x** for a different reason worth stating plainly: for
  small-to-medium outputs (~500 normalized tokens), the digest's fixed
  30-line head/tail preview is a large fraction of the whole output, so the
  flow cost approaches the output cost. The digest's value in that regime is
  not savings, it's a **bounded ceiling** — the agent pays ~O(30 lines) no
  matter whether the command printed 500 tokens or 500,000. The naive
  baseline has no ceiling at all.
- **dev server is the degenerate case that proves the model**: naive capture
  of a never-exiting stream has no defined "answer point" at all — a naive
  exec server just hangs. The 0.6x at the 4-second mark is beside the point;
  the stream grows ~39 tokens/s, so a 10-minute naive capture would ship
  ~23,000 tokens (if it ever returned), while the digest answer stays ~311
  and `wait(timeout)` returns with `state: "running"` immediately.

### 3.2 Awaiting-input detector: precision/recall

12-case suite (`test/detector-eval.test.ts`), run against real programs on
real PTYs. Two environment substitutions, both recorded in the test header:
the container runs as root (su/sudo never prompt root), so the sudo case is
`passwd <user>` — the same echo-off-tty-read class; and there is no ssh
client, so the host-key case is the exact OpenSSH prompt text emitted by a
script that blocks on stdin.

| case | result | latency | signal that fired |
| --- | --- | --- | --- |
| passwd password prompt | TP | 1.0s | blocked read(2) on tty; pattern: password |
| git push, credential prompt (local 401) | TP | 0.8s | blocked read (git-remote-http); pattern: colon |
| npm init questionnaire | TP | 1.5s | termios: echo off (readline raw mode) |
| rm -i confirmation | TP | 1.0s | blocked read (rm); pattern: question |
| less on a 5k-line file | TP | 1.0s | blocked read (less) |
| apt-get remove confirmation | TP | 2.5s | blocked read (apt-get); pattern: yes-no |
| python input() | TP | 1.0s | blocked read (python3); pattern: colon |
| ssh host-key prompt (simulated) | TP | 1.0s | blocked read (python3); pattern: question |
| sleep then output | TN | — | — |
| output ending in ":" then silence | TN | — | — |
| silent computation | TN | — | — |
| shell `read` from a pipe (not tty) | TN | — | — |
| **precision 1.00 · recall 1.00** | | | |

The design lesson: the brief's proposed signals (quiet + prompt regexes +
termios) work, but the highest-precision signal wasn't in the brief:
**"is any process in the foreground process group blocked in `read(2)` on a
terminal fd"** (readable from `/proc/<pid>/syscall`). It fired on 7 of 8
positives and cannot fire for compute-quiet negatives. With it in front,
trailing-line regexes were demoted: strong shapes (password / pager / yes-no)
may still decide alone, but weak shapes (trailing `?` / `:`) only *annotate*
— which is exactly what kills the "build output ends with a colon, then
silence" false positive that a pattern-first detector walks into. termios
remains necessary for the readline-raw-mode family (npm init's epoll-based
reader never blocks in read(2); echo-off termios catches it).

### 3.3 Open questions, answered empirically

**1. Does collapsing progress redraws ever destroy information an agent
needed?** Yes — the counterexample is a transient diagnostic drawn *into* the
redrawn line and then overwritten: `\rerror: mirror timed out, retrying` →
`\rdownloading 55%` → `done`. Pure final-frame collapse stores only `done`;
the agent never learns a retry happened. Two mitigations are implemented:
(a) the normalizer preserves overwritten frames matching a diagnostic pattern
(error/warn/fail/timeout/refused/denied), capped at 20 frames so a
`"0 errors"`-style progress bar can't flood the store (both behaviors unit
tested); (b) the raw log always allows byte-level recovery. With those two,
we could not construct a case where needed information is unrecoverable.

**2. Is per-job output the right granularity, or does `&` break it?**
Foreground jobs: per-job is right, and OSC 133 makes the boundaries exact.
Background jobs break clean attribution, in a bounded way: output from a
`cmd &` that outlives its launching job lands in whatever window is open —
the next job's output (misattribution) or between jobs. The daemon's answer
is a session-level **orphan buffer**: data outside any C..D window is
captured there rather than lost (integration-tested with a disowned
background writer). Misattribution *during* a subsequent job remains
possible; the honest fix at the architecture level is "one session per
long-running background concern" — sessions are cheap and first-class, which
is why. A production version could tag jobs that launched background pids
(the shell reports `$!`) and warn on their digests.

**3. What's the right default digest size?** The 10+20 default was right or
irrelevant in 5 of 6 scenarios: wrong only for git-log-10k, where the task
("last 15") needed 15 lines and head has 10 — a 15+30 digest would have
answered it with zero queries for ~90 extra tokens (measured per scenario in
`digest_size_study` in results.json; 15+30 costs +25–90 tokens over 10+20 on
real outputs). Tasks like "how many errors" or "find the warnings" are never
digest-satisfiable — they need `total_matches` from grep regardless of digest
size. So: bump the default to ~15 head lines (cheap, catches "show me the
top/recent N" asks), don't chase digest-only answers beyond that; the fixed
preview is already the dominant cost of the flow for small outputs (see pip).

**4. Should `wait` support incremental deltas?** Yes — implemented and worth
it. `wait(job_id, timeout_ms, since_line)` returns the digest plus only lines
after the cursor, and `read_output {mode:"delta"}` does the same standalone.
On the dev-server stream, three consecutive polls returned 106+58+58 tokens
with no line ever shipped twice (cursors 17→27→37). Without deltas, the
"watch a dev server" loop re-ships an ever-growing tail on every poll; with
them the cost per poll is proportional to *new* output only. The cursor is a
plain line number the agent passes back, which survives daemon statelessness
between calls and is hard to misuse — `last_line` in every response is the
next `since_line`.

### 3.4 Loose ends worth carrying forward

- zsh integration is written but unverified (no zsh in the container).
- For scrollback text, the normalizer's frame-boundary approximation stands;
  for true screens, `read_output {mode:"screen"}` (added post-teardown, see
  3.5) renders the viewport through a headless terminal emulator.
- `attach` is a read-only tail of the raw log; a real mirror plane wants
  follow-mode with terminal size sync.
- Token estimates are chars/4 everywhere; swapping in a real tokenizer only
  changes the constants, not the ratios.

## Post-eval: competitive teardown vs Forge (July 2026)

The Phase 1 survey under-counted the field. The closest competitor is
**Forge** (`forge-terminal-mcp` v0.9.0, MIT, node-pty, ~23 tools): persistent
PTY sessions, ring-buffer incremental reads with per-consumer cursors,
headless-xterm `read_screen`, `wait_for` pattern/exit watching, event push
via MCP logging, sub-agent orchestration (`spawn_claude` with worktrees and
budgets), and a live web dashboard. Also nearby: pilotty (Rust PTY daemon
for driving TUIs, screen snapshots, no MCP/job layer) and a long tail of
exec-style shell servers.

What the teardown established, tool by tool:

- **Forge has no job model.** Its two completion mechanisms are `run_command`
  — blocking, 5-minute cap, "returns all output", i.e. exactly the naive
  baseline this benchmark measures against — and `wait_for` with a **regex
  pattern** (its dev-server templates literally wait for the string
  `"Ready"`), the fragile prompt-matching OSC 133 exists to replace. In a
  persistent Forge terminal there is no way to ask "what was the exit code
  of the command I just ran." The job abstraction (async handle, exact exit
  code, scoped output, digest) remains this prototype's core differentiation
  and it is architectural, not a missing feature.
- **No awaiting-input detection anywhere in the field.** Forge agents must
  notice silence themselves and guess with `read_screen`. The measured
  blocked-read(2)/termios/pattern detector has no competitor.
- **No token accounting in the field.** Forge's ring buffer (1 MB default)
  *drops* wrapped output (`droppedBytes`); this prototype's raw log is
  unbounded and lossless, and every read reports returned/remaining tokens
  with budget-gated full reads.
- **Where Forge is ahead, adopted or noted:** its `@xterm/headless` screen
  rendering was the right call and has been adopted here as
  `read_output {mode:"screen"}` (lazily instantiated when a job enters the
  alternate screen; ~one dependency). Still theirs: event push
  (`subscribe_events` over MCP logging beats polling), the orchestration
  layer, and a real human-mirror dashboard where our `attach` is a stub.
- Integrating the renderer surfaced two latent bugs worth recording:
  bun-pty's `name` option does **not** set `TERM` (node-pty does), so the
  container's `TERM=linux` leaked in and — lacking smcup/rmcup — silently
  disabled the alternate screen for pagers; and job raw-log offsets were
  stamped per-chunk instead of per-parser-event, overshooting `rawStart`.
  Both fixed, both now covered by tests.

Positioning conclusion: Forge built the infrastructure and polish on a
stream-and-screen abstraction; this prototype built the interface semantics
(jobs, exit codes, digests, budgets, awaiting-input) that no one in the field
has. The two are complementary, and the semantics are the durable, portable
part.

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

## Agent-in-the-loop A/B eval — the pre-registered kill criterion FIRED

Protocol: `bench/ab/PROTOCOL.md`, committed before any run. Two arms of real
agents (same frontier model, same task text), each restricted to one tool:
**control** = pi-style truncating exec shim; **term** = the `at` CLI over
this daemon. Success scored by the orchestrator against ground truth; cost
= bytes of tool results entering the model's context, logged symmetrically
per call. One T3 control run was invalidated for bypassing the wrapper
(zero logged calls) and rerun once per protocol; the rerun is what's scored.

| task | arm | success | calls | result tokens | agent wall-clock |
| --- | --- | --- | ---: | ---: | ---: |
| T1 dev-server (never exits) | control | yes | 5 | ~240¹ | 149s |
| | term | yes | 10 | 1,092 | **69s** |
| T2 tsc, 200 errors | control | yes | 2 | **68** | 25s |
| | term | yes | 4 | 491 | 20s |
| T3 /dev/tty-gated prompt | control | yes² | 2 | 300 | 17s |
| | term | yes | 5 | **253** | 18s |
| T4 find/grep (parity task) | control | yes | **1** | **439** | **7s** |
| | term | yes | 14 | 1,408 | 94s |

¹ Two control calls went unlogged because its `pkill -f devserver` matched
and killed its own wrapper process (the command string contains
"devserver") — small outputs, direction of the comparison unaffected.
² Via `printf y | script -qec "python3 cleanup.py" /dev/null` — the agent
synthesized a PTY *inside* the exec shim and blind-fed the confirmation.

**Verdict, per the pre-registered criteria: the control arm matched the
term arm on success across T1–T3 while spending ~608 vs ~1,836 result
tokens — one third. The kill criterion ("control matches success within
20% of tokens") fired decisively. On these tasks, with a frontier model,
the headline value proposition is not supported.**

Why the control arm won, from its transcripts:

- **bash is already a query language.** The control agent never shipped big
  output into context: it composed `| grep -c "error TS"`, `| head -3`,
  `grep -m1 Listening` *inside* the exec call. Phase 3's token benchmark
  implicitly assumed output must transit the tool result before being
  filtered; a capable agent filters server-side, for free. This
  retroactively weakens the practical force of the 17–190x numbers for
  frontier models (they stand for naive/streaming consumption, and for any
  flow where the agent doesn't know what to filter for yet).
- **Missing primitives get synthesized on demand.** No background jobs →
  `nohup ... & echo $!`. No PTY → `script -qec` or Python `pty.spawn`.
  The training-data gravity the original thesis cited works *against* a
  new surface too: the model's bash fluency is so deep that an unfamiliar
  CLI costs more turns than improvising infrastructure with a familiar one
  (T4: 14 ceremony-laden calls vs 1).
- Where the term arm did win: **wall-clock on the never-exiting process**
  (69s vs 149s — `wait` returns on bind; the control arm slept and polled),
  and T3 tokens, marginally.

What survives, stated carefully (post-hoc hypotheses, not tested claims):
supervision ergonomics for long-running processes; closed-loop interactive
dialogs where the needed input depends on reading the prompt (a single y/N
is open-loop scriptable; a password retry or menu choice is not); weaker
or cheaper models without this level of bash improvisation; and the
awaiting-input *detector* as a component (the control arm succeeded at T3
only because it correctly guessed the prompt in advance — nothing told it
a prompt existed). But the honest summary for the headline pitch is: **a
frontier agent with plain bash and a truncating exec tool is a stronger
baseline than this project's premise assumed, and the digest/query surface
as-built did not beat it on its own chosen tasks.**

### Follow-up: the hybrid exec-first arm PASSED all pre-registered criteria

Round 1's autopsy suggested an inverted design: keep the winning interface
(bash in, plain text out, one call) and put the daemon underneath it —
`src/sh.ts` over the same sessions/jobs/normalizer/detector. Structure
appears only as bracketed status lines: real per-command `[exit code: N]`,
`[WAITING FOR INPUT — <reason>]` with a `--reply` instruction (early return
instead of a hang), `[still running as job-N]` with delta-only `--poll`, and
`--grep/--tail job-N` instead of temp files. Criteria were pre-registered in
PROTOCOL.md and committed before the four hybrid agents ran.

| task | control | old term arm | hybrid |
| --- | --- | --- | --- |
| T1 dev-server | ✓ 5 calls · 240 tok · 149s | ✓ 10 · 1,092 · 69s | ✓ 6 · 397 · **46s** |
| T2 tsc errors | ✓ 2 · 68 · 25s | ✓ 4 · 491 · 20s | ✓ 2 · **69** · 30s |
| T3 tty prompt | ✓² 2 · 300 · 17s | ✓ 5 · 253 · 18s | ✓ 4 · 375 · 31s |
| T4 parity | ✓ 1 · 439 · 7s | ✓ 14 · 1,408 · 94s | ✓ **1 · 439** · 18s |

² control's T3 success was open-loop: it *guessed* a prompt existed from
reading cleanup.py and blind-fed `y` through a self-built PTY. The hybrid
agent ran the command plainly, was *told* `[WAITING FOR INPUT — blocked
reading tty; yes-no]`, and answered with `--reply` — the closed-loop shape
that also works when the required input depends on reading the prompt.
(Transcript-verified; one disclosed deviation: a read-only `ls` of the
tool's own bin directory outside the wrapper.)

All five criteria passed: 4/4 success; T4 in 1 call (vs 14 for the old
surface); T2 tokens at 1.01x control (69 vs 68 — bash composition works
through the hybrid, so the digest layer's overhead disappears); T3 solved
by the tool surfacing the prompt; T1 at 46s vs control's 149s. Total
context cost across all four tasks: control 1,047 tokens, old term surface
3,244, hybrid 1,280 — parity with the baseline, plus the structural wins
the baseline lacks (exit codes without sentinels, prompt detection without
guessing, supervised long-runners without nohup/sleep, lossless queryable
history without temp files, no pkill-your-own-wrapper class of footgun).

**Revised conclusion: the daemon's value survives, but only under an
exec-first interface. "A 9-tool replacement for bash" is dead; "bash with a
supervisor underneath" is validated on every axis this eval measures.**

### Round 3 (robustness): the last capability claim dies at frontier tier — and reappears down-model

Pre-registered in PROTOCOL.md before the 12 runs. All ground truth
orchestrator-verified (secrets against gt files, deletions against the
filesystem).

**Q1 — closed-loop gate (random code must be READ from the prompt), frontier
model.** Control 2/2, hybrid 2/2. Both control agents wrote a ~20-line
`pty.fork()` driver on the fly — closed-loop expect(1) improvised from raw
primitives, in 2 calls / ~28s, at *lower* token cost than the hybrid arm
(248 vs 292–475). Per the pre-registered criterion, **the closed-loop
advantage claim is dead for frontier models**. One hybrid rep took 12 calls
because of a real UX bug this exposed: the bracketed hints printed the
CLI's canonical name (`sh --reply ...`) while the agent's wrapper was named
`tool`, sending it down a dead end first (fixed: hints now use
$AGENT_TERM_DISPLAY).

**Q2 — T3 reliability, n=3 per arm (frontier).** 3/3 both arms. The
control's PTY-synthesis workaround (`script -qec`, `pty.spawn`) is
reliable technique, not a lucky roll.

**Q3 — small model (Haiku class), n=1 per cell.** The predicted separation
appears exactly at the closed loop: on the gate, **hybrid succeeded** (9
logged calls — the `[WAITING FOR INPUT]` → `--reply` loop carried it)
while **control genuinely failed the interaction** across 19 calls of
non-working PTY attempts — and then "answered" by finding the ground-truth
file, whose path my fixture leaked inside authgate.py (eval-design flaw,
disclosed; scored as task failure since the challenge itself was never
completed). On T3, both Haiku arms succeeded — the `script -c` y/N trick
is apparently within small-model reach — with hybrid slower (19 calls).

Also from this round's engineering: the new hybrid test suite caught a
poll-cursor bug (first `--poll` re-shipped lines exec had already
returned — duplicate context cost; fixed after the round-3 runs, so it
could only have *inflated* hybrid numbers above, never flattered them).

### Final value assessment after three rounds

For **frontier models**, every capability differentiator tested — output
economy, background supervision, open-loop prompts, closed-loop prompts —
was matched by bash improvisation at equal or lower token cost. What
remains for them is ergonomics and reliability, not capability: no
hand-rolled pty drivers, no nohup/sleep dances, no pkill-your-own-wrapper
footguns, faster wall-clock on supervision (46–69s vs 149s), and prompts
that announce themselves instead of being guessed at. Real, but a
convenience story.

For **smaller models**, the guardrails convert failure into success on
closed-loop interaction (n=1; needs replication). If the product story is
"make cheap models reliable at terminal work," that is where the evidence
points — and it is also the deployment regime (high-volume, cost-sensitive
automation) where a supervisor daemon is most natural to operate.

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

### How coding-agent harnesses handle this today (pi source read)

The benchmark's "naive full capture" baseline is fair for exec-style MCP
servers, but real coding-agent harnesses are smarter, and reading pi's source
(`earendil-works/pi`, `packages/coding-agent/src/core/tools/bash.ts` and
`bash-executor.ts`) shows exactly how much of this problem they already
solve — and which parts they deliberately punt:

- **Output flooding: solved, more crudely.** pi strips ANSI, deletes every
  `\r` outright, tail-truncates to 2,000 lines / 50 KB, and writes the full
  output to a temp file whose path is given to the model — the agent then
  greps the temp file *with more bash calls*. That is a genuinely elegant
  minimal design (bash itself is the query language). But it ships the whole
  tail regardless of need: re-running our scenarios against pi's actual
  policy, tsc-200-errors ships ~7,000 tokens (fits under the cap) vs our
  404, and git-log-10k ships the truncation window (~12,000 tokens) vs our
  643 — the digest+query flow still wins ~17x even against a real harness,
  because tail-truncation is need-blind. And deleting `\r` doesn't collapse
  progress bars, it concatenates every frame into one giant line — pi's
  truncation code has a special `lastLinePartial` case to paper over exactly
  this.
- **Interactivity: punted, explicitly.** pi runs commands through
  `child_process.spawn` with pipes — no PTY at all — so interactive programs
  hit EOF and fail fast instead of hanging. Its bundled `interactive-shell`
  extension says it in a comment: *"This only intercepts user `!` commands,
  not agent bash tool calls. If the agent runs an interactive command, it
  will fail (which is fine)."* Password prompts, `rm -i`, host-key checks:
  fail-or-avoid, never answer.
- **Persistent sessions and long-running processes: punted, explicitly.**
  Each pi bash call is a fresh shell (no cwd/env/venv persistence), and the
  README states the policy in five words: **"No background bash. Use
  tmux."** — i.e., outsource exactly this daemon's job to a human-shaped
  multiplexer the agent must screen-scrape.

### Resiliency hardening mined from tmux's regression suite

tmux's `regress/input-malformed.sh` encodes 25 years of hostile-stream
lessons, and porting its applicable cases immediately exposed three real
bugs in the normalizer's original lookahead-style escape parsing:

1. **No CAN/SUB abort.** `ESC[` + params + `CAN` + `OK` must abort the
   sequence and keep "OK"; the old parser scanned for a final byte and ate
   the "O" as one. (tmux: `csi-param-discard`, `csi-interm-discard`.)
2. **String-sequence payload leak.** DCS/APC/PM/SOS (`ESC P/_/^/X`) were
   treated as 2-char escapes, so a megabyte APC payload — tmux tests exactly
   1.1 MB — would pour into the queryable text as garbage. (tmux:
   `apc-discard`, `malformed-dcs`.)
3. **Giant-OSC leak.** The old parser buffered unterminated escapes with a
   512-byte cap and gave up beyond it, leaking huge OSC payloads. (tmux:
   `osc-discard`.)

The fix is the same shape tmux itself uses: a persistent VT500-style state
machine (text/esc/csi/string/charset) that survives chunk boundaries with
O(1) memory, discards string payloads without buffering, honors CAN/SUB
aborts and ESC-restarts, and caps CSI parameter storage while still
consuming to the final byte. `src/normalize.resilience.test.ts` ports the
tmux cases by name (`tmux:osc-discard` etc.) and adds the property tmux's
incremental parser implies: for a set of adversarial streams, every possible
chunk-split point — plus 40 seeded-random fragment streams — must produce
byte-identical normalized output.

So the harness state of the art already covers the biggest chunk of the
value (bounded output) with tail-truncation + temp file, which shrinks the
headline savings but doesn't erase them (~17x remains on the error-heavy
cases, because digests are need-shaped and truncation isn't). What no
harness covers — and pi documents as out of scope rather than unsolved — is
precisely this prototype's core: real PTYs with job-scoped exit codes,
awaiting-input as a detected, answerable state, and supervised long-running
processes. "Use tmux" is the strongest third-party argument for the PTY
supervisor thesis in this document.

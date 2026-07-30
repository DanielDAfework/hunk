# Agent-in-the-loop A/B protocol (pre-registered)

Committed BEFORE any evaluation run; results in FINDINGS.md must be judged
against exactly these criteria, including negative outcomes.

## Question

Does an agent complete real terminal tasks better (success, context cost,
interaction count) through agent-term's job/digest surface than through a
strong exec-style baseline?

## Arms

Both arms are real agents (same model, same task prompts) restricted to a
single tool command in an isolated arena directory:

- **control** — `bin/tool [--timeout sec] -- '<bash command>'`: pi-style
  baseline read from pi's source: bash -c, combined output, ANSI stripped,
  tail-truncated at 2000 lines / 50 KB, temp-file escape hatch, default 90s
  timeout. This is deliberately the *state of the art harness policy*, not a
  strawman.
- **term** — `bin/tool <subcommand>`: the `at` CLI over the agent-term
  daemon (create/run/wait/status/read/input/kill).

Both wrappers log every call's printed bytes to JSONL (bytes/4 ≈ tokens of
tool results entering the model's context — the symmetric cost measure).

## Tasks and success criteria

- **T1 dev-server**: start `bun run devserver.ts` (never exits), report the
  bound port, leave no server running afterwards. Success = reported port ==
  ground-truth port file AND no devserver process for that arena remains.
- **T2 build errors**: run `tsc -p . --noEmit` in `tsproj` (exactly 200
  errors). Report error-line count and the first three error lines. Success
  = count == 200 AND the three lines match errors.ts lines 1–3.
- **T3 gated confirmation**: run `python3 cleanup.py`, which prompts
  `[y/N]` on /dev/tty (no-tty fallback: refuses and exits 2). Complete the
  cleanup, report the deleted directory names. Success = all three cache
  dirs removed AND answer names them. (Prediction: control cannot succeed
  without a tty; a refusal correctly reported counts as *honest failure*,
  scored unsuccessful but noted.)
- **T4 control task (parity expected)**: `find / -name '*.conf'`, report
  the directory containing resolv.conf. Success = correct directory.
  Included so the eval can show where the baseline is already fine.

## Metrics

Per (task, arm): success (scored by the orchestrator against ground truth,
not agent self-report), tool calls, total tool-result bytes → estimated
tokens, wall-clock from first to last tool call.

## Kill criteria (the falsifiable part)

The value proposition is DEAD if, across T1–T3, the control arm matches the
term arm on success while spending within 20% of its context tokens. It is
WEAK (report as such) if control succeeds everywhere and the token advantage
is under 2x. T4 is excluded from kill scoring (parity expected) but reported.

## Follow-up experiment: hybrid arm (pre-registered addendum)

Motivated by round 1's negative result: the winning interface was bash
itself, so the **hybrid** arm exposes exactly the control shim's interface
(`bin/tool [--timeout sec] -- '<bash command>'`, plain text out) but runs
commands in a persistent PTY session through the daemon. Structure appears
only in bracketed status lines: `[exit code: N]` (real, per command),
`[WAITING FOR INPUT — <reason>]` with a `--reply` instruction (early return
instead of hanging), `[still running as job-N]` with `--poll` (delta-only),
and `--grep/--tail` on truncated output instead of temp files.

Same four tasks, same scoring. Validation criteria (all must hold, judged
against transcripts and logs):

1. Success on all four tasks.
2. T4 (parity): ≤2 tool calls (round 1 term arm needed 14; control 1).
3. T2 result tokens within 1.5x of control's.
4. T3 success where the *tool* surfaces the prompt — the agent's transcript
   must show it simply ran cleanup.py and answered the reported prompt, with
   no self-built PTY (`script`/`pty.spawn`) and no blind pre-piped answer.
5. T1 agent wall-clock under control's 149s.

Anything less is reported as the hybrid design failing too.

## Round 3: robustness (pre-registered addendum)

Three questions left open by rounds 1–2, run as control-vs-hybrid only (the
old term surface is retired):

- **Q1 closed-loop interactivity (T5).** `authgate.py` prints a random
  4-digit code on /dev/tty and requires it typed back (3 attempts) before
  revealing a random secret. Blind feeding cannot succeed; the prompt must
  be read. Neither `expect` nor `pexpect` is installed, so a control-arm
  success requires hand-rolled closed-loop PTY driving. n=2 per arm,
  frontier model. Success = reporting the exact ground-truth secret.
- **Q2 reliability of round-1/2 T3 results.** T3 repeated twice more per
  arm (frontier), for n=3 total per arm across rounds.
- **Q3 cheap-model arm.** T3 and T5, one run per arm, on a small model
  (Haiku class). Hypothesis: the control arm's improvisation ability drops
  with model capability and the hybrid's guardrails matter more.

Honest criteria: if control matches hybrid on T5 success at comparable
cost, the closed-loop advantage claim dies (it is the last capability-side
differentiator this suite can test). Q2/Q3 are measurements, reported
as-is; predictions (hybrid ≥ control everywhere; gap wider on Haiku) are
falsifiable but not kill-grade.

## Threats to validity (accepted, disclosed)

n=1 pair per task (cost); single model; agents may deviate from the
tool-only restriction (logs are checked; non-compliant runs are marked
invalid and rerun once); the treatment CLI was written by the same author as
the daemon (interface bias); tasks chosen to stress the claimed
differentiators (that is the point — T4 exists as the honesty check).

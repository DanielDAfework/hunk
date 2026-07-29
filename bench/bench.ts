/**
 * Phase 3 benchmark: token cost of (a) naive full-output capture vs
 * (b) the digest+query flow, on five realistic scenarios.
 *
 * Accounting is honest about what each side actually ships to the model:
 *  - naive_raw:        estimated tokens of the raw PTY stream for the job
 *                      (what a "run command, return output" MCP server sends,
 *                      ANSI escapes, redraws and all).
 *  - naive_stripped:   tokens of ANSI-stripped-but-uncollapsed text — a
 *                      smarter naive server. Computed by re-normalizing the
 *                      raw with collapse disabled? No: computed as stripped
 *                      bytes of every frame, i.e. normalized lines PLUS all
 *                      collapsed frames reconstructed is impossible post-hoc,
 *                      so we approximate it as raw minus escape overhead —
 *                      see stripAnsiApprox().
 *  - digest_flow:      tokens of the digest JSON the agent gets from wait()
 *                      + the JSON of each follow-up read_output response the
 *                      scenario's task actually requires.
 *
 * Run: bun run bench  (writes bench/results.json, prints a table)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "../src/manager";
import type { Job, Session } from "../src/session";
import { estimateTokens } from "../src/tokens";
import type { OutputQuery } from "../src/types";

const benchRoot = path.join(process.env.TMPDIR ?? "/tmp", `agent-term-bench`);
fs.rmSync(benchRoot, { recursive: true, force: true });
fs.mkdirSync(benchRoot, { recursive: true });
const manager = new SessionManager({ runtimeDir: path.join(benchRoot, "runtime"), quietMs: 1500 });

interface ScenarioResult {
  scenario: string;
  task: string;
  exit_code: number | null;
  raw_bytes: number;
  naive_raw_tokens: number;
  naive_stripped_tokens: number;
  normalized_full_tokens: number;
  digest_tokens: number;
  query_tokens: number;
  digest_flow_tokens: number;
  savings_vs_naive_raw: number;
  savings_vs_naive_stripped: number;
  queries: string[];
  task_answer_preview: string;
  digest_size_study: Record<string, { tokens: number; satisfies_task: boolean }>;
  notes: string[];
}

const results: ScenarioResult[] = [];

/** Rough ANSI-escape overhead removal so "smart naive" isn't strawmanned. */
function stripAnsiApprox(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, "")
    .replace(/\x1b[()#%][0-9A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Read this job's byte range back out of the session raw log. */
function rawOf(session: Session, job: Job): string {
  const buf = fs.readFileSync(session.rawLogPath);
  return buf.subarray(job.output.rawStart, job.output.rawEnd || undefined).toString("latin1");
}

async function runScenario(opts: {
  scenario: string;
  task: string;
  command: string;
  cwd?: string;
  /** Wait budget; jobs still running after this are treated as "live" (dev server). */
  waitMs: number;
  killAfter?: boolean;
  queries: OutputQuery[];
  /** Given digest head/tail arrays, does a digest of this size answer the task alone? */
  digestSatisfies?: (head: string[], tail: string[]) => boolean;
  notes?: string[];
}): Promise<ScenarioResult> {
  console.log(`\n### ${opts.scenario}: ${opts.command}`);
  const session = await manager.createSession({
    name: `bench-${opts.scenario}`,
    shell: "/bin/bash",
    cwd: opts.cwd ?? benchRoot,
  });
  const job = manager.run(session.id, opts.command);
  await session.wait(job, opts.waitMs);

  const digest = session.digest(job);
  const digestTokens = estimateTokens(JSON.stringify(digest));

  let queryTokens = 0;
  const queryDescs: string[] = [];
  let answerPreview = "";
  for (const q of opts.queries) {
    const res = job.output.query(job.id, job.state, q);
    queryTokens += estimateTokens(JSON.stringify(res));
    queryDescs.push(JSON.stringify(q));
    answerPreview += (answerPreview ? " | " : "") + res.text.split("\n").slice(0, 3).join(" / ");
    if (q.mode === "grep") answerPreview += ` [total_matches=${res.total_matches}]`;
  }

  const raw = rawOf(session, job);
  const stripped = stripAnsiApprox(raw);
  const snap = job.output.snapshot();
  const normalizedFull = estimateTokens(snap.lines.join("\n"));

  // Digest-size study for open question 3: what would bigger digests cost,
  // and would they have made the first query unnecessary?
  const study: ScenarioResult["digest_size_study"] = {};
  for (const [h, t] of [
    [10, 20],
    [15, 30],
    [25, 50],
  ] as const) {
    const head = snap.lines.slice(0, h);
    const tail = snap.lines.length > h + t ? snap.lines.slice(-t) : [];
    const d = { ...digest, head, tail };
    study[`${h}+${t}`] = {
      tokens: estimateTokens(JSON.stringify(d)),
      satisfies_task: opts.digestSatisfies ? opts.digestSatisfies(head, tail.length ? tail : head) : false,
    };
  }

  if (opts.killAfter && (job.state === "running" || job.state === "awaiting-input")) {
    session.killJob(job, "SIGTERM");
    await session.wait(job, 5000);
  }
  session.kill();

  const naiveRaw = estimateTokens(raw);
  const naiveStripped = estimateTokens(stripped);
  const flow = digestTokens + queryTokens;
  const r: ScenarioResult = {
    scenario: opts.scenario,
    task: opts.task,
    exit_code: digest.exit_code,
    raw_bytes: raw.length,
    naive_raw_tokens: naiveRaw,
    naive_stripped_tokens: naiveStripped,
    normalized_full_tokens: normalizedFull,
    digest_tokens: digestTokens,
    query_tokens: queryTokens,
    digest_flow_tokens: flow,
    savings_vs_naive_raw: round1(naiveRaw / flow),
    savings_vs_naive_stripped: round1(naiveStripped / flow),
    queries: queryDescs,
    task_answer_preview: answerPreview.slice(0, 300),
    digest_size_study: study,
    notes: [...digest.notes, ...(opts.notes ?? [])],
  };
  results.push(r);
  console.log(
    `  raw=${naiveRaw}tok stripped=${naiveStripped}tok normalized=${normalizedFull}tok | ` +
      `digest=${digestTokens}tok +queries=${queryTokens}tok => flow=${flow}tok | ` +
      `savings ${r.savings_vs_naive_raw}x raw, ${r.savings_vs_naive_stripped}x stripped`,
  );
  return r;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// --------------------------------------------------------------------------
// Fixture prep (plain Bun code, not through the daemon — this is setup).
// --------------------------------------------------------------------------

console.log("preparing fixtures...");

// Scenario 2 fixture: a TS project with ~200 type errors.
const tsDir = path.join(benchRoot, "tsproj");
fs.mkdirSync(tsDir, { recursive: true });
fs.writeFileSync(
  path.join(tsDir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
);
{
  let src = "";
  for (let i = 0; i < 200; i++) src += `const v${i}: number = "not a number ${i}";\n`;
  fs.writeFileSync(path.join(tsDir, "errors.ts"), src);
}

// Scenario 3 fixture: 10k-commit repo via git fast-import.
const gitDir = path.join(benchRoot, "bigrepo");
fs.mkdirSync(gitDir, { recursive: true });
{
  const initProc = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", "-q"], { cwd: gitDir });
  if (initProc.exitCode !== 0) throw new Error("git init failed");
  let stream = "blob\nmark :1\ndata 6\nhello\n\n";
  for (let i = 1; i <= 10_000; i++) {
    const msg = `commit ${i}: adjust module ${i % 97} threshold`;
    stream +=
      `commit refs/heads/main\nmark :${i + 1}\n` +
      `author Bench <bench@example.com> ${1700000000 + i} +0000\n` +
      `committer Bench <bench@example.com> ${1700000000 + i} +0000\n` +
      `data ${Buffer.byteLength(msg)}\n${msg}\n` +
      (i > 1 ? `from :${i}\n` : "") +
      `M 100644 :1 file-${i % 13}.txt\n\n`;
  }
  const fi = Bun.spawnSync(["git", "fast-import", "--quiet"], {
    cwd: gitDir,
    stdin: Buffer.from(stream),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (fi.exitCode !== 0) throw new Error(`fast-import failed: ${fi.stderr.toString()}`);
}

// Scenario 1 fixture: a medium npm project (real registry install through
// whatever proxy the environment provides).
const npmDir = path.join(benchRoot, "npmproj");
fs.mkdirSync(npmDir, { recursive: true });
fs.writeFileSync(
  path.join(npmDir, "package.json"),
  JSON.stringify(
    {
      name: "bench-medium",
      version: "1.0.0",
      dependencies: {
        express: "^4.19.0",
        lodash: "^4.17.0",
        chalk: "^5.3.0",
        webpack: "^5.90.0",
        react: "^18.2.0",
        "react-dom": "^18.2.0",
      },
    },
    null,
    2,
  ),
);

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

// 1. npm install (progress bars, warnings). Task: succeeded? any warnings?
await runScenario({
  scenario: "npm-install",
  task: "did it succeed; list warnings",
  // Cold cache: the container image ships a warm npm cache that reduces a
  // real install to one spinner line, which benchmarks nothing.
  command: "npm install --cache ./cold-npm-cache --no-audit --no-fund --loglevel=notice 2>&1",
  cwd: npmDir,
  waitMs: 240_000,
  queries: [{ mode: "grep", pattern: "[Ww]arn|WARN", context: 0, max_matches: 10 }],
  digestSatisfies: () => false, // warnings can be anywhere in the stream
});

// 1b. pip install — the classic chatty installer with CR-redrawn download
// bars. Included because npm 10 turned out to self-collapse on a TTY (see
// FINDINGS.md); pip represents the tools that don't.
await runScenario({
  scenario: "pip-install",
  task: "did it succeed; list warnings",
  command:
    "python3 -m venv venv && ./venv/bin/pip install --no-cache-dir numpy requests 2>&1",
  cwd: benchRoot,
  waitMs: 240_000,
  queries: [{ mode: "grep", pattern: "[Ww]arn|WARN|[Ee]rror", context: 0, max_matches: 10 }],
  digestSatisfies: () => false,
});

// 2. tsc with ~200 errors. Task: error count + first 3.
await runScenario({
  scenario: "tsc-200-errors",
  task: "how many errors; show first 3",
  command: "tsc -p . --noEmit 2>&1",
  cwd: tsDir,
  waitMs: 120_000,
  queries: [{ mode: "grep", pattern: "error TS", context: 0, max_matches: 3 }],
  // digest head contains the first errors, but the COUNT still needs the grep
  // (total_matches); a bigger digest alone never answers "how many".
  digestSatisfies: () => false,
});

// 3. git log --oneline on 10k commits. Task: the 15 most recent commits.
await runScenario({
  scenario: "git-log-10k",
  task: "show the 15 most recent commits",
  command: "git log --oneline | cat",
  cwd: gitDir,
  waitMs: 120_000,
  queries: [{ mode: "head", lines: 15 }],
  // git log prints newest first: a 15-line digest head answers it outright.
  digestSatisfies: (head) => head.length >= 15,
});

// 4. Long-running dev server. Task: did it bind, from a stream that never exits.
const devResult = await runScenario({
  scenario: "dev-server",
  task: "did it bind to a port (job never exits)",
  command: `bun run ${path.join(import.meta.dir, "devserver.ts")}`,
  waitMs: 4_000, // returns with state=running — that's the point
  killAfter: true,
  queries: [{ mode: "grep", pattern: "Listening on", context: 0, max_matches: 1 }],
  digestSatisfies: (head) => head.some((l) => l.includes("Listening on")),
  notes: ["job intentionally still running at measurement time; killed afterwards"],
});

// 4b. Open question 4: incremental deltas on the same never-ending stream.
{
  const session = await manager.createSession({ name: "bench-delta", shell: "/bin/bash" });
  const job = manager.run(session.id, `bun run ${path.join(import.meta.dir, "devserver.ts")}`);
  await session.wait(job, 2_000);
  const first = job.output.query(job.id, job.state, { mode: "delta", since_line: 0 });
  await Bun.sleep(1_500);
  const second = job.output.query(job.id, job.state, { mode: "delta", since_line: first.last_line! });
  await Bun.sleep(1_500);
  const third = job.output.query(job.id, job.state, { mode: "delta", since_line: second.last_line! });
  console.log(
    `\n### delta-streaming: cursors ${first.last_line} -> ${second.last_line} -> ${third.last_line}; ` +
      `tokens per poll: ${first.returned_estimated_tokens}, ${second.returned_estimated_tokens}, ${third.returned_estimated_tokens}`,
  );
  (devResult.notes ??= []).push(
    `delta streaming: 3 polls returned ${first.returned_estimated_tokens}+${second.returned_estimated_tokens}+${third.returned_estimated_tokens} tokens, ` +
      `no line ever shipped twice (cursors ${first.last_line}->${second.last_line}->${third.last_line})`,
  );
  // The real dev-server story is growth over time: naive capture scales with
  // wall-clock, the digest doesn't. Project both at 10 minutes of runtime.
  const tokensPerSec = second.returned_estimated_tokens / 1.5;
  (devResult.notes ??= []).push(
    `stream grows ~${Math.round(tokensPerSec)} tokens/s: naive capture of a 10-minute run ` +
      `would ship ~${Math.round(tokensPerSec * 600)} tokens (and never terminates); the digest stays ~${devResult.digest_flow_tokens}`,
  );
  session.killJob(job, "SIGTERM");
  await session.wait(job, 5_000);
  session.kill();
}

// 5. find / — huge output, agent needs a grep.
await runScenario({
  scenario: "find-conf",
  task: "locate resolv.conf among all *.conf files",
  command: "find / -name '*.conf' 2>/dev/null",
  waitMs: 240_000,
  queries: [{ mode: "grep", pattern: "resolv\\.conf", context: 0, max_matches: 10 }],
  digestSatisfies: () => false,
});

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

manager.shutdown();

console.log("\n=== token savings summary ===");
console.log(
  "scenario".padEnd(16) +
    "naive_raw".padStart(10) +
    "stripped".padStart(10) +
    "digest+q".padStart(10) +
    "savings".padStart(12),
);
for (const r of results) {
  console.log(
    r.scenario.padEnd(16) +
      String(r.naive_raw_tokens).padStart(10) +
      String(r.naive_stripped_tokens).padStart(10) +
      String(r.digest_flow_tokens).padStart(10) +
      `${r.savings_vs_naive_raw}x`.padStart(12),
  );
}

const outPath = path.join(import.meta.dir, "results.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nwrote ${outPath}`);
process.exit(0);

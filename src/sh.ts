/**
 * `sh` — the hybrid exec-first surface, designed from the A/B eval's lesson:
 * the winning interface is bash itself, so this looks exactly like a plain
 * exec tool (bash command in, plain text out, one call) while running on the
 * daemon's PTY/job machinery. The structure only surfaces when it matters:
 *
 *   sh -- '<bash command>'          run in the persistent PTY shell; prints
 *                                   output + [exit code: N]. If the command
 *                                   goes quiet at an interactive prompt, it
 *                                   returns EARLY with [waiting for input]
 *                                   instead of hanging. If it is still
 *                                   running at --timeout (default 30s), it
 *                                   returns with a job id to poll — no
 *                                   nohup/sleep gymnastics needed.
 *   sh --reply '<text>'            answer the pending prompt, keep waiting
 *   sh --poll <job>                 print only NEW output since last poll
 *   sh --kill <job> [--signal SIG]  stop a running job
 *   sh --grep <job> --pattern <re>  search a finished/large job's output
 *   sh --tail <job> [--lines N]     last N lines of a job's output
 *
 * cwd and env persist across calls (it is one real shell). Output over
 * 2000 lines / 50 KB is tail-truncated with a note naming the job id so the
 * rest stays queryable — no temp files.
 *
 * Socket: $AGENT_TERM_SOCK. Session key: $AGENT_TERM_KEY (default "hybrid").
 * Initial cwd for the auto-created session: $AGENT_TERM_CWD.
 * $AB_LOG: symmetric per-call byte logging for the A/B eval.
 */

import * as fs from "node:fs";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

function out(text: string, exitCode = 0): never {
  console.log(text);
  if (process.env.AB_LOG) {
    fs.appendFileSync(
      process.env.AB_LOG,
      JSON.stringify({ ts: Date.now(), arm: "hybrid", bytes: text.length }) + "\n",
    );
  }
  process.exit(exitCode);
}

interface ExecViewResult {
  job_id: string;
  state: string;
  exit_code: number | null;
  duration_ms: number | null;
  lines: string[];
  notes: string[];
  awaiting_reason: string | null;
}

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const sockPath = process.env.AGENT_TERM_SOCK ?? "/tmp/agent-term.sock";
  const reqLine = JSON.stringify({ id: 1, method, params }) + "\n";
  const response = await new Promise<string>((resolve, reject) => {
    let buf = "";
    Bun.connect({
      unix: sockPath,
      socket: {
        open(socket) {
          socket.write(reqLine);
        },
        data(_s, data) {
          buf += data.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl !== -1) resolve(buf.slice(0, nl));
        },
        error(_s, e) {
          reject(e);
        },
        connectError(_s, e) {
          reject(e);
        },
      },
    });
  });
  const parsed = JSON.parse(response);
  if (!parsed.ok) out(`ERROR: ${parsed.error}`, 1);
  return parsed.result;
}

/** Render an exec/reply/poll result as plain, bash-tool-shaped text. */
function render(r: ExecViewResult, opts: { deltaOnly?: boolean } = {}): string {
  let lines = r.lines;
  let truncNote = "";
  const totalBytes = lines.join("\n").length;
  if (lines.length > MAX_LINES || totalBytes > MAX_BYTES) {
    let tail = lines.slice(-MAX_LINES);
    while (tail.join("\n").length > MAX_BYTES && tail.length > 1) {
      tail = tail.slice(Math.ceil(tail.length / 4));
    }
    truncNote = `\n[showing last ${tail.length} of ${lines.length} lines — query the rest: sh --grep ${r.job_id} --pattern '<re>'  or  sh --tail ${r.job_id} --lines N]`;
    lines = tail;
  }
  let body = lines.join("\n");
  for (const n of r.notes) body += `\n${n}`;
  body += truncNote;

  if (r.state === "exited" || r.state === "killed") {
    body += `\n[exit code: ${r.exit_code}${r.state === "killed" ? " (killed)" : ""}]`;
  } else if (r.state === "awaiting-input") {
    body +=
      `\n[WAITING FOR INPUT — ${r.awaiting_reason}]` +
      `\n[answer it with: sh --reply '<text>'   (or sh --kill ${r.job_id} to abort)]`;
  } else {
    body +=
      `\n[still running as ${r.job_id}${opts.deltaOnly ? " (new output only)" : ""} — ` +
      `new output: sh --poll ${r.job_id} ; stop: sh --kill ${r.job_id}]`;
  }
  return body.trimStart();
}

const argv = process.argv.slice(2);
const key = process.env.AGENT_TERM_KEY ?? "hybrid";

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

if (argv.includes("--reply")) {
  const text = flag("reply") ?? "";
  const r = await rpc("reply", {
    key,
    text,
    end_with_newline: !argv.includes("--no-newline"),
    timeout_ms: num(flag("timeout")) ?? 30_000,
  });
  out(render(r));
} else if (flag("poll")) {
  const r = await rpc("poll", { job: flag("poll"), timeout_ms: num(flag("timeout")) ?? 2_000 });
  out(render(r, { deltaOnly: true }));
} else if (flag("kill")) {
  await rpc("job_kill", { job: flag("kill"), signal: flag("signal") });
  const r = await rpc("poll", { job: flag("kill"), timeout_ms: 3_000 });
  out(render(r));
} else if (flag("grep")) {
  const q = await rpc("read", {
    job: flag("grep"),
    mode: "grep",
    pattern: flag("pattern"),
    context: num(flag("context")),
    max_matches: num(flag("max-matches")),
  });
  out(`${q.text}\n[${q.total_matches} total matches]`);
} else if (flag("tail")) {
  const q = await rpc("read", { job: flag("tail"), mode: "tail", lines: num(flag("lines")) ?? 30 });
  out(q.text);
} else {
  const dd = argv.indexOf("--");
  const timeout = num(flag("timeout"));
  const command = (dd === -1 ? argv.filter((a) => !a.startsWith("--")) : argv.slice(dd + 1)).join(" ");
  if (!command) out("usage: sh [--timeout sec] -- '<bash command>'  (see header for --reply/--poll/--kill/--grep/--tail)", 2);
  const r = await rpc("exec", {
    key,
    cwd: process.env.AGENT_TERM_CWD,
    command,
    timeout_ms: (timeout ?? 30) * 1000,
  });
  out(render(r));
}

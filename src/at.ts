/**
 * `at` — thin CLI over the IPC daemon, designed to be driven by an agent's
 * bash tool. Prints one compact JSON object to stdout per invocation.
 *
 *   at create [--name n] [--cwd dir]
 *   at run <session> -- <command...>
 *   at wait <job> [--timeout ms] [--since-line n]
 *   at status <job>
 *   at read <job> --mode head|tail|slice|grep|full|delta|screen [--lines n]
 *       [--start n] [--end n] [--pattern re] [--context n] [--max-matches n]
 *       [--confirm-tokens n] [--since-line n]
 *   at input <session> <text...> [--no-newline]
 *   at kill <job> [--signal SIG]
 *   at sessions
 *
 * Socket: $AGENT_TERM_SOCK (default /tmp/agent-term.sock).
 * If $AB_LOG is set, appends one JSONL line per call (method + response
 * bytes) — used by the A/B eval to measure context cost symmetrically.
 */

import * as fs from "node:fs";

function fail(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

/** Split argv into positionals and --flags (flag value = next token unless boolean). */
function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string | boolean> } {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

const num = (v: string | boolean | undefined) => (v === undefined ? undefined : Number(v));

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) fail("usage: at <create|run|wait|status|read|input|kill|sessions> ...");
const { pos, flags } = parseArgs(rest);

let method: string;
let params: Record<string, unknown>;
switch (cmd) {
  case "create":
    method = "session_create";
    params = { name: flags.name, cwd: flags.cwd, shell: flags.shell };
    break;
  case "run": {
    const session = pos[0];
    const command = pos.slice(1).join(" ");
    if (!session || !command) fail("usage: at run <session> -- <command...>");
    method = "run";
    params = { session, command };
    break;
  }
  case "wait":
    if (!pos[0]) fail("usage: at wait <job> [--timeout ms] [--since-line n]");
    method = "wait";
    params = { job: pos[0], timeout_ms: num(flags.timeout) ?? 15_000, since_line: num(flags["since-line"]) };
    break;
  case "status":
    if (!pos[0]) fail("usage: at status <job>");
    method = "status";
    params = { job: pos[0] };
    break;
  case "read":
    if (!pos[0] || typeof flags.mode !== "string") {
      fail('usage: at read <job> --mode tail --lines 30 | --mode grep --pattern "err" | --mode screen ...');
    }
    method = "read";
    params = {
      job: pos[0],
      mode: flags.mode,
      lines: num(flags.lines),
      start: num(flags.start),
      end: num(flags.end),
      pattern: typeof flags.pattern === "string" ? flags.pattern : undefined,
      context: num(flags.context),
      max_matches: num(flags["max-matches"]),
      confirm_tokens: num(flags["confirm-tokens"]),
      since_line: num(flags["since-line"]),
    };
    break;
  case "input": {
    const session = pos[0];
    const text = pos.slice(1).join(" ");
    if (!session) fail("usage: at input <session> <text...> [--no-newline]");
    method = "input";
    params = { session, text, end_with_newline: flags["no-newline"] !== true };
    break;
  }
  case "kill":
    if (!pos[0]) fail("usage: at kill <job> [--signal SIG]");
    method = "job_kill";
    params = { job: pos[0], signal: flags.signal };
    break;
  case "sessions":
    method = "session_list";
    params = {};
    break;
  default:
    fail(`unknown subcommand "${cmd}". Valid: create, run, wait, status, read, input, kill, sessions.`);
}

const sockPath = process.env.AGENT_TERM_SOCK ?? "/tmp/agent-term.sock";
const reqLine = JSON.stringify({ id: 1, method, params }) + "\n";

let response: string;
try {
  response = await new Promise<string>((resolve, reject) => {
    let buf = "";
    Bun.connect({
      unix: sockPath,
      socket: {
        open(socket) {
          socket.write(reqLine);
        },
        data(_socket, data) {
          buf += data.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl !== -1) resolve(buf.slice(0, nl));
        },
        error(_socket, err) {
          reject(err);
        },
        connectError(_socket, err) {
          reject(err);
        },
      },
    });
  });
} catch (e) {
  fail(
    `cannot reach daemon at ${sockPath}: ${e instanceof Error ? e.message : e}. ` +
      `Start it with: bun run src/ipcDaemon.ts`,
  );
}

// A/B instrumentation: response bytes ≈ context cost of this call's result.
if (process.env.AB_LOG) {
  fs.appendFileSync(
    process.env.AB_LOG,
    JSON.stringify({ ts: Date.now(), arm: "agent-term", method, bytes: response.length }) + "\n",
  );
}

const parsed = JSON.parse(response);
if (parsed.ok) {
  console.log(JSON.stringify(parsed.result));
  // The open socket would keep the Bun event loop alive; exit explicitly.
  process.exit(0);
} else {
  console.log(JSON.stringify({ ok: false, error: parsed.error }));
  process.exit(1);
}

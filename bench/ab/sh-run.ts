/**
 * Control-arm shim for the A/B eval: the strong "state of the art harness"
 * baseline, modeled directly on pi's bash tool policy (read from source):
 *
 *   - runs the command via bash -c with combined stdout+stderr
 *   - ANSI stripped, \r removed
 *   - tail-truncated to 2000 lines / 50 KB, whichever first
 *   - on truncation, the full output is saved to a temp file whose path is
 *     printed, so the agent can grep it with further commands
 *   - optional --timeout <seconds> (default 90); on timeout the process
 *     tree is killed and partial output returned
 *
 * This is deliberately NOT a strawman: it is what a well-built coding agent
 * ships today. If $AB_LOG is set, appends one JSONL line per call (bytes
 * printed ≈ context cost), symmetric with the `at` CLI's logging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const argv = process.argv.slice(2);
let timeoutSec = 90;
const tIdx = argv.indexOf("--timeout");
if (tIdx !== -1) {
  timeoutSec = Number(argv[tIdx + 1]) || 90;
  argv.splice(tIdx, 2);
}
const dd = argv.indexOf("--");
const command = (dd === -1 ? argv : argv.slice(dd + 1)).join(" ");
if (!command) {
  console.log("usage: sh-run [--timeout sec] -- <command...>");
  process.exit(2);
}

const proc = Bun.spawn(["bash", "-c", command], {
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try {
    proc.kill("SIGKILL");
  } catch {}
}, timeoutSec * 1000);

const [out, err] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
const exitCode = await proc.exited;
clearTimeout(timer);

// pi-style sanitization: strip ANSI, drop \r.
const clean = (out + err)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, "")
  .replace(/\r/g, "");

let body = clean;
let note = "";
const lines = clean.split("\n");
const totalBytes = Buffer.byteLength(clean);
if (lines.length > MAX_LINES || totalBytes > MAX_BYTES) {
  const tmp = path.join(os.tmpdir(), `sh-run-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`);
  fs.writeFileSync(tmp, clean);
  let tail = lines.slice(-MAX_LINES);
  let joined = tail.join("\n");
  while (Buffer.byteLength(joined) > MAX_BYTES && tail.length > 1) {
    tail = tail.slice(Math.ceil(tail.length / 4));
    joined = tail.join("\n");
  }
  if (Buffer.byteLength(joined) > MAX_BYTES) joined = joined.slice(-MAX_BYTES);
  body = joined;
  note = `\n\n[Output truncated: showing last ${tail.length} of ${lines.length} lines. Full output: ${tmp}]`;
}

const printed = `${body}${note}\n[exit code: ${timedOut ? `killed after ${timeoutSec}s timeout` : exitCode}]`;
console.log(printed);

if (process.env.AB_LOG) {
  fs.appendFileSync(
    process.env.AB_LOG,
    JSON.stringify({ ts: Date.now(), arm: "control", command: command.slice(0, 120), bytes: printed.length }) + "\n",
  );
}
process.exit(0);

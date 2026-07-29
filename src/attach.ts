/**
 * Human mirror plane — v1 stub.
 *
 * Tails a session's raw byte stream to the current (real) terminal, so a
 * human can watch what the agent's shell is doing. Read-only: no input is
 * forwarded. Full bidirectional attach is out of scope for v1.
 *
 * Usage:
 *   bun run src/attach.ts <path-to-stream.raw>
 *   bun run src/attach.ts <session-id>          # resolved under $AGENT_TERM_HOME
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun run src/attach.ts <session-id | path/to/stream.raw>");
  process.exit(2);
}

const runtimeDir = process.env.AGENT_TERM_HOME ?? path.join(os.homedir(), ".agent-term");
const rawPath = fs.existsSync(arg) ? arg : path.join(runtimeDir, "sessions", arg, "stream.raw");
if (!fs.existsSync(rawPath)) {
  console.error(`no raw stream at ${rawPath}`);
  process.exit(1);
}

console.error(`[attach] mirroring ${rawPath} (read-only, ^C to detach)\n`);

let offset = 0;
const fd = fs.openSync(rawPath, "r");
const buf = Buffer.alloc(64 * 1024);

/** Replay existing content, then poll for appended bytes. */
function drain(): void {
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    if (n <= 0) break;
    offset += n;
    process.stdout.write(buf.subarray(0, n));
  }
}

drain();
setInterval(drain, 150);

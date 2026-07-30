/**
 * A/B eval arena generator. Creates one isolated arena per (task, arm):
 *
 *   /tmp/ab-arena/t<N>-<arm>/
 *     bin/tool     — the ONLY command the agent may run: control arm wraps
 *                    sh-run.ts (pi-style truncating exec), treatment arm
 *                    wraps the `at` CLI (agent-term daemon client)
 *     ...fixtures  — task-specific files (devserver, tsproj, cleanup.py)
 *
 * Logs: /tmp/ab-arena/logs/t<N>-<arm>.jsonl (one line per tool call, bytes
 * printed = context cost). Ground truth: /tmp/ab-arena/gt/.
 *
 * Run: bun run bench/ab/setup.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/tmp/ab-arena";
const REPO = path.resolve(import.meta.dir, "../..");
const SOCK = "/tmp/ab-at.sock";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of ["logs", "gt"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const DEVSERVER = `// dev-server fixture: binds an OS-assigned port, logs forever, never exits.
const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
console.log("devserver v1.0.0");
console.log("loading config...");
console.log("compiling 87 modules...");
console.log(\`Listening on http://localhost:\${server.port}\`);
// Ground truth for the eval scorer (agents are not told about this):
if (process.env.AB_GT) {
  await Bun.write(process.env.AB_GT, String(server.port));
}
let i = 0;
setInterval(() => {
  i += 1;
  console.log(\`GET /api/poll 200 \${(i % 7) + 2}ms\`);
}, 200);
`;

const CLEANUP_PY = `import os, shutil, sys

base = os.path.dirname(os.path.abspath(__file__))
targets = [d for d in ("cache/alpha", "cache/beta", "cache/gamma")
           if os.path.isdir(os.path.join(base, d))]
if not targets:
    print("nothing to clean")
    sys.exit(0)
try:
    tty_in = open("/dev/tty")
    tty_out = open("/dev/tty", "w")
except OSError:
    print("ERROR: cannot prompt: no controlling terminal; refusing to delete", file=sys.stderr)
    sys.exit(2)
tty_out.write(f"Delete {len(targets)} stale cache directories? [y/N] ")
tty_out.flush()
ans = tty_in.readline().strip().lower()
if ans in ("y", "yes"):
    for t in targets:
        shutil.rmtree(os.path.join(base, t))
        print("deleted:", t)
    print("cleanup complete")
else:
    print("aborted")
    sys.exit(1)
`;

function tsprojInto(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
  );
  let src = "";
  for (let i = 0; i < 200; i++) src += `const v${i}: number = "not a number ${i}";\n`;
  fs.writeFileSync(path.join(dir, "errors.ts"), src);
}

function writeTool(arenaDir: string, id: string, arm: "control" | "term"): void {
  const bin = path.join(arenaDir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(ROOT, "logs", `${id}-${arm}.jsonl`);
  const gt = path.join(ROOT, "gt", `${id}-${arm}-port.txt`);
  const body =
    arm === "control"
      ? `#!/bin/sh
export AB_LOG=${log}
export AB_GT=${gt}
exec bun run ${REPO}/bench/ab/sh-run.ts "$@"
`
      : `#!/bin/sh
export AB_LOG=${log}
export AB_GT=${gt}
export AGENT_TERM_SOCK=${SOCK}
exec bun run ${REPO}/src/at.ts "$@"
`;
  fs.writeFileSync(path.join(bin, "tool"), body, { mode: 0o755 });
}

const TASKS = ["t1", "t2", "t3", "t4"] as const;
for (const id of TASKS) {
  for (const arm of ["control", "term"] as const) {
    const dir = path.join(ROOT, `${id}-${arm}`);
    fs.mkdirSync(dir, { recursive: true });
    writeTool(dir, id, arm);
    if (id === "t1") fs.writeFileSync(path.join(dir, "devserver.ts"), DEVSERVER);
    if (id === "t2") tsprojInto(path.join(dir, "tsproj"));
    if (id === "t3") {
      fs.writeFileSync(path.join(dir, "cleanup.py"), CLEANUP_PY);
      for (const c of ["alpha", "beta", "gamma"]) {
        const d = path.join(dir, "cache", c);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "stale.dat"), "x".repeat(64));
      }
    }
    // t4 needs no fixtures (searches the real filesystem).
  }
}

console.log(`arena ready at ${ROOT} (8 instances). Daemon socket expected at ${SOCK}.`);

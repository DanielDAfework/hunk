/**
 * Round-3 arena generator (robustness round). Creates isolated instances for:
 *   - T5 closed-loop gate: t5-{control,hybrid}-r{1,2}  (+ haiku: t5h-...)
 *   - T3 repetitions:      t3-{control,hybrid}-r{2,3}  (+ haiku: t3h-...-r1)
 *
 * T5's authgate.py prints a RANDOM verification code on /dev/tty and demands
 * it typed back (3 attempts) before revealing a random secret — blind
 * feeding cannot work; the prompt must be read. Ground truth (the secret)
 * is written to a baked-in path the agents are not told about.
 *
 * Run: bun run bench/ab/setup-round3.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/tmp/ab-arena3";
const REPO = path.resolve(import.meta.dir, "../..");
const SOCK = "/tmp/ab-at.sock";

fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of ["logs", "gt"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const AUTHGATE = (gtPath: string) => `import secrets, sys

GT = ${JSON.stringify(gtPath)}
try:
    tty_in = open("/dev/tty")
    tty_out = open("/dev/tty", "w")
except OSError:
    print("ERROR: interactive terminal required", file=sys.stderr)
    sys.exit(2)
code = str(secrets.randbelow(9000) + 1000)
secret = secrets.token_hex(4)
with open(GT, "w") as f:
    f.write(secret)
for attempt in range(3):
    tty_out.write(f"Type this verification code to continue: {code}\\n> ")
    tty_out.flush()
    if tty_in.readline().strip() == code:
        print(f"ACCESS GRANTED secret={secret}")
        sys.exit(0)
    tty_out.write("Incorrect.\\n")
    tty_out.flush()
print("LOCKED OUT")
sys.exit(1)
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

function writeTool(arenaDir: string, instance: string, arm: "control" | "hybrid"): void {
  const bin = path.join(arenaDir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(ROOT, "logs", `${instance}.jsonl`);
  const body =
    arm === "control"
      ? `#!/bin/sh
export AB_LOG=${log}
exec bun run ${REPO}/bench/ab/sh-run.ts "$@"
`
      : `#!/bin/sh
export AB_LOG=${log}
export AGENT_TERM_SOCK=${SOCK}
export AGENT_TERM_KEY=${instance}
export AGENT_TERM_CWD=${arenaDir}
export AGENT_TERM_DISPLAY=${path.join(bin, "tool")}
exec bun run ${REPO}/src/sh.ts "$@"
`;
  fs.writeFileSync(path.join(bin, "tool"), body, { mode: 0o755 });
}

function makeT5(instance: string, arm: "control" | "hybrid"): void {
  const dir = path.join(ROOT, instance);
  fs.mkdirSync(dir, { recursive: true });
  writeTool(dir, instance, arm);
  fs.writeFileSync(path.join(dir, "authgate.py"), AUTHGATE(path.join(ROOT, "gt", `${instance}-secret.txt`)));
}

function makeT3(instance: string, arm: "control" | "hybrid"): void {
  const dir = path.join(ROOT, instance);
  fs.mkdirSync(dir, { recursive: true });
  writeTool(dir, instance, arm);
  fs.writeFileSync(path.join(dir, "cleanup.py"), CLEANUP_PY);
  for (const c of ["alpha", "beta", "gamma"]) {
    const d = path.join(dir, "cache", c);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "stale.dat"), "x".repeat(64));
  }
}

const instances: string[] = [];
for (const arm of ["control", "hybrid"] as const) {
  for (const r of [1, 2]) {
    makeT5(`t5-${arm}-r${r}`, arm);
    instances.push(`t5-${arm}-r${r}`);
  }
  for (const r of [2, 3]) {
    makeT3(`t3-${arm}-r${r}`, arm);
    instances.push(`t3-${arm}-r${r}`);
  }
  // haiku (cheap model) instances, one per task per arm
  makeT5(`t5h-${arm}-r1`, arm);
  makeT3(`t3h-${arm}-r1`, arm);
  instances.push(`t5h-${arm}-r1`, `t3h-${arm}-r1`);
}

console.log(`round-3 arena ready at ${ROOT}: ${instances.length} instances`);
console.log(instances.join(" "));

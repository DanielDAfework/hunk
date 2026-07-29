/**
 * Awaiting-input detector evaluation against real interactive programs.
 *
 * 8 positive cases (programs genuinely blocked on user input) and 4 negative
 * cases (quiet-but-working programs that must NOT be flagged). The afterAll
 * hook prints the precision/recall table that FINDINGS.md reports.
 *
 * Environment substitutions (dev container has no sshd/ssh and runs as root,
 * so sudo never prompts):
 *  - "sudo password"  -> `su <user>` password prompt (same class: echo-off
 *    read on /dev/tty by a setuid-style tool).
 *  - "ssh host key"   -> simulated: a script printing the exact OpenSSH
 *    host-key prompt and blocking on stdin.
 * Both substitutions are recorded in FINDINGS.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "../src/manager";
import type { Job, Session } from "../src/session";

const runtimeDir = path.join(process.env.TMPDIR ?? "/tmp", `agent-term-eval-${process.pid}`);
const workDir = path.join(runtimeDir, "work");
const manager = new SessionManager({ runtimeDir, quietMs: 600 });

interface CaseResult {
  name: string;
  kind: "positive" | "negative";
  flagged: boolean;
  reason?: string;
  ms?: number;
}
const results: CaseResult[] = [];

let authServer: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  fs.mkdirSync(workDir, { recursive: true });
  // Local HTTP server that always demands basic auth — triggers git's
  // interactive credential prompt without touching the network.
  authServer = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("auth required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="eval"' },
      }),
  });
});

afterAll(() => {
  authServer?.stop(true);
  manager.shutdown();

  const positives = results.filter((r) => r.kind === "positive");
  const negatives = results.filter((r) => r.kind === "negative");
  const tp = positives.filter((r) => r.flagged).length;
  const fn = positives.length - tp;
  const fp = negatives.filter((r) => r.flagged).length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = positives.length === 0 ? 1 : tp / positives.length;

  console.log("\n=== awaiting-input detector eval ===");
  for (const r of results) {
    const mark = r.kind === "positive" ? (r.flagged ? "TP" : "FN") : r.flagged ? "FP" : "TN";
    console.log(
      `  [${mark}] ${r.name}${r.flagged ? ` (${r.ms}ms; ${r.reason})` : ""}`,
    );
  }
  console.log(
    `  precision=${precision.toFixed(2)} (${tp}/${tp + fp} flagged were real), ` +
      `recall=${recall.toFixed(2)} (${tp}/${positives.length} real prompts caught), fn=${fn}`,
  );
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

/** Run a command; resolve when the job is flagged awaiting-input or deadline passes. */
async function observe(
  name: string,
  kind: "positive" | "negative",
  command: string,
  opts: { deadlineMs?: number; setup?: (s: Session) => Promise<void> } = {},
): Promise<CaseResult> {
  const s = await manager.createSession({ name: `eval-${name}`, shell: "/bin/bash", cwd: workDir });
  try {
    if (opts.setup) await opts.setup(s);
    const t0 = Date.now();
    const job: Job = manager.run(s.id, command);
    const deadline = t0 + (opts.deadlineMs ?? 10_000);
    let flagged = false;
    let reason: string | undefined;
    while (Date.now() < deadline) {
      if (job.state === "awaiting-input") {
        flagged = true;
        reason = job.awaitingReason;
        break;
      }
      // Negatives: once the job exits cleanly without ever being flagged, done.
      if (job.state === "exited" || job.state === "killed") break;
      await Bun.sleep(100);
    }
    const r: CaseResult = { name, kind, flagged, reason, ms: Date.now() - t0 };
    results.push(r);
    return r;
  } finally {
    s.kill();
  }
}

/** Helper: run a setup command inside the session and wait for it. */
function setupCmd(cmd: string) {
  return async (s: Session) => {
    const j = s.run(cmd);
    await s.wait(j, 15_000);
    if (j.exitCode !== 0) {
      throw new Error(`setup failed (${cmd}): exit ${j.exitCode}\n${j.output.snapshot().lines.join("\n")}`);
    }
  };
}

describe("positives: real interactive prompts must be flagged", () => {
  test("password prompt via passwd (sudo-class substitute — root is never asked by su/sudo)", async () => {
    const r = await observe("passwd-password", "positive", "passwd eval-user", {
      setup: setupCmd("id -u eval-user >/dev/null 2>&1 || useradd -m eval-user"),
    });
    expect(r.flagged).toBe(true);
    expect(r.reason).toMatch(/echo off|blocked reading tty|password/);
  }, 30_000);

  test("git push credential prompt (local 401 server)", async () => {
    const port = authServer!.port;
    const r = await observe(
      "git-credential",
      "positive",
      `cd gitcase && env -u http_proxy -u HTTP_PROXY -u GIT_ASKPASS -u SSH_ASKPASS GIT_TERMINAL_PROMPT=1 git push origin main`,
      {
        setup: setupCmd(
          [
            "rm -rf gitcase && mkdir gitcase",
            "cd gitcase && git -c init.defaultBranch=main init -q",
            "git config user.email e@x && git config user.name e",
            "echo hi > f && git add f && git commit -qm c",
            `git remote add origin http://127.0.0.1:${port}/repo.git`,
            "cd ..",
          ].join(" && "),
        ),
      },
    );
    expect(r.flagged).toBe(true);
  }, 30_000);

  test("npm init interactive questionnaire", async () => {
    const r = await observe("npm-init", "positive", "cd npmcase && npm init", {
      setup: setupCmd("rm -rf npmcase && mkdir npmcase"),
      deadlineMs: 20_000,
    });
    expect(r.flagged).toBe(true);
  }, 40_000);

  test("rm -i confirmation", async () => {
    const r = await observe("rm-i", "positive", "touch victim.txt && rm -i victim.txt");
    expect(r.flagged).toBe(true);
  }, 30_000);

  test("less pager on a long file", async () => {
    const r = await observe("less", "positive", "seq 1 5000 > big.txt && less big.txt");
    expect(r.flagged).toBe(true);
  }, 30_000);

  test("apt-get remove confirmation", async () => {
    // Removal prompts before doing anything; the session is killed right
    // after detection so nothing is actually removed.
    const r = await observe("apt-confirm", "positive", "apt-get remove less", {
      deadlineMs: 20_000,
    });
    expect(r.flagged).toBe(true);
    expect(r.reason).toMatch(/yes-no|blocked/);
  }, 40_000);

  test("python input() call", async () => {
    const r = await observe(
      "python-input",
      "positive",
      `python3 -c 'x = input("Your choice: "); print("got", x)'`,
    );
    expect(r.flagged).toBe(true);
    expect(r.reason).toContain("blocked reading tty");
  }, 30_000);

  test("ssh host-key prompt (simulated — no ssh client in container)", async () => {
    // Exact OpenSSH prompt shape, minus apostrophes (bash single-quote nesting).
    const prompt =
      "The authenticity of host example.com (93.184.216.34) cannot be established.\\n" +
      "ED25519 key fingerprint is SHA256:abcdef.\\n" +
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ";
    const r = await observe(
      "ssh-hostkey-sim",
      "positive",
      `python3 -c 'import sys; sys.stdout.write("${prompt}"); sys.stdout.flush(); sys.stdin.readline()'`,
    );
    expect(r.flagged).toBe(true);
  }, 30_000);
});

describe("negatives: quiet-but-working jobs must NOT be flagged", () => {
  test("plain sleep then output", async () => {
    const r = await observe("sleep-then-echo", "negative", "sleep 2.5; echo done", {
      deadlineMs: 8000,
    });
    expect(r.flagged).toBe(false);
  }, 30_000);

  test("trailing-colon output then silence (the colon trap)", async () => {
    const r = await observe(
      "colon-trap",
      "negative",
      "echo 'linking objects:'; sleep 2.5; echo done",
      { deadlineMs: 8000 },
    );
    expect(r.flagged).toBe(false);
  }, 30_000);

  test("silent computation", async () => {
    const r = await observe(
      "silent-compute",
      "negative",
      `python3 -c 'import time; time.sleep(2.5); print("computed 42")'`,
      { deadlineMs: 8000 },
    );
    expect(r.flagged).toBe(false);
  }, 30_000);

  test("shell read from a pipe (not a tty)", async () => {
    const r = await observe(
      "pipe-read",
      "negative",
      "printf 'a\\nb\\n' | while read x; do sleep 1.2; echo got-$x; done",
      { deadlineMs: 8000 },
    );
    expect(r.flagged).toBe(false);
  }, 30_000);
});

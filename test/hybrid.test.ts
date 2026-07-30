/**
 * Integration tests for the hybrid exec-first surface (the round-2/3
 * validated design): handleIpc's exec/reply/poll against a real manager
 * with real PTY sessions, no socket needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "../src/manager";
import { handleIpc } from "../src/ipcDaemon";

const runtimeDir = path.join(process.env.TMPDIR ?? "/tmp", `agent-term-hybrid-test-${process.pid}`);
const manager = new SessionManager({ runtimeDir, quietMs: 600 });

afterAll(() => {
  manager.shutdown();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

const call = (method: string, params: Record<string, unknown>) =>
  handleIpc(manager, { id: 1, method, params });

describe("hybrid exec surface", () => {
  test("exec: one round-trip returns output, real exit code, duration", async () => {
    const r = (await call("exec", { key: "h1", cwd: "/tmp", command: "echo one; false; echo two" })) as any;
    expect(r.state).toBe("exited");
    expect(r.exit_code).toBe(0); // last command's status, like any shell line
    expect(r.lines).toEqual(["one", "two"]);
    expect(typeof r.duration_ms).toBe("number");
  });

  test("exec: nonzero exit codes come from the shell, not sentinels", async () => {
    const r = (await call("exec", { key: "h1", command: "bash -c 'exit 42'" })) as any;
    expect(r.exit_code).toBe(42);
  });

  test("exec: cwd and env persist across calls (persistent session)", async () => {
    await call("exec", { key: "h1", command: "cd /etc && export HYBRID_MARK=yes" });
    const r = (await call("exec", { key: "h1", command: "pwd; echo mark=$HYBRID_MARK" })) as any;
    expect(r.lines).toEqual(["/etc", "mark=yes"]);
  });

  test("exec: interactive prompt returns early as awaiting-input with a reason", async () => {
    const r = (await call("exec", {
      key: "h2",
      cwd: "/tmp",
      command: "read -p 'proceed? [y/N] ' a; echo answer=$a",
      timeout_ms: 8000,
    })) as any;
    expect(r.state).toBe("awaiting-input");
    expect(r.awaiting_reason).toMatch(/blocked reading tty|yes-no/);
    // reply resumes the same job and completes it
    const done = (await call("reply", { key: "h2", text: "y", timeout_ms: 8000 })) as any;
    expect(done.state).toBe("exited");
    expect(done.lines.at(-1)).toBe("answer=y");
  });

  test("exec: still-running jobs return with a pollable id; poll is delta-only", async () => {
    const r = (await call("exec", {
      key: "h3",
      cwd: "/tmp",
      command: "for i in 1 2 3 4 5 6; do echo beat-$i; sleep 0.5; done",
      timeout_ms: 1200,
    })) as any;
    expect(r.state).toBe("running");
    const seen = r.lines.length;
    expect(seen).toBeGreaterThan(0);
    const p1 = (await call("poll", { job: r.job_id, timeout_ms: 1200 })) as any;
    // Delta must start after what exec already returned — no duplicates.
    expect(p1.lines[0]).toBe(`beat-${seen + 1}`);
    const p2 = (await call("poll", { job: r.job_id, timeout_ms: 4000 })) as any;
    expect(p2.state).toBe("exited");
    expect([...r.lines, ...p1.lines, ...p2.lines]).toEqual(
      ["beat-1", "beat-2", "beat-3", "beat-4", "beat-5", "beat-6"],
    );
  });

  test("reply with no active job teaches instead of hanging", async () => {
    await expect(call("reply", { key: "h1", text: "y" })).rejects.toThrow(/no active job/);
  });

  test("job_kill on a hybrid job flips it to killed", async () => {
    const r = (await call("exec", { key: "h4", cwd: "/tmp", command: "sleep 30", timeout_ms: 500 })) as any;
    expect(r.state).toBe("running");
    await call("job_kill", { job: r.job_id });
    const p = (await call("poll", { job: r.job_id, timeout_ms: 5000 })) as any;
    expect(p.state).toBe("killed");
  });
});

/**
 * Integration tests against a real bash on a real PTY. Each test file gets
 * its own runtime dir so raw logs don't collide.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "../src/manager";

const runtimeDir = path.join(
  process.env.TMPDIR ?? "/tmp",
  `agent-term-test-${process.pid}`,
);
const manager = new SessionManager({ runtimeDir, quietMs: 700 });

afterAll(() => {
  manager.shutdown();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

describe("session + job lifecycle", () => {
  test("runs a command and captures exit code, duration, output", async () => {
    const s = await manager.createSession({ name: "basic", shell: "/bin/bash" });
    const job = manager.run(s.id, "echo alpha; echo beta; exit_code_test=1; false; true");
    expect(job.state).toBe("queued");
    await s.wait(job, 5000);
    const d = s.digest(job);
    expect(d.state).toBe("exited");
    expect(d.exit_code).toBe(0);
    expect(d.head).toEqual(["alpha", "beta"]);
    expect(d.duration_ms).not.toBeNull();
  });

  test("nonzero exit codes are reported exactly", async () => {
    const s = await manager.createSession({ name: "codes", shell: "/bin/bash" });
    const job = manager.run(s.id, "bash -c 'exit 42'");
    await s.wait(job, 5000);
    expect(job.exitCode).toBe(42);
  });

  test("AGENT_TERM=1 is visible to programs", async () => {
    const s = await manager.createSession({ name: "envcheck", shell: "/bin/bash" });
    const job = manager.run(s.id, "echo AT=$AGENT_TERM");
    await s.wait(job, 5000);
    expect(s.digest(job).head).toEqual(["AT=1"]);
  });

  test("jobs queue FIFO within a session and both complete", async () => {
    const s = await manager.createSession({ name: "fifo", shell: "/bin/bash" });
    const j1 = manager.run(s.id, "sleep 0.3; echo first-done");
    const j2 = manager.run(s.id, "echo second-done");
    expect(j2.state).toBe("queued");
    await s.wait(j2, 8000);
    expect(s.digest(j1).head).toEqual(["first-done"]);
    expect(s.digest(j2).head).toEqual(["second-done"]);
    // j1 must have finished before j2 started.
    expect(j1.endedAt!).toBeLessThanOrEqual(j2.startedAt!);
  });

  test("multiple concurrent sessions run in parallel", async () => {
    const a = await manager.createSession({ name: "par-a", shell: "/bin/bash" });
    const b = await manager.createSession({ name: "par-b", shell: "/bin/bash" });
    const t0 = Date.now();
    const ja = manager.run(a.id, "sleep 0.5; echo A");
    const jb = manager.run(b.id, "sleep 0.5; echo B");
    await Promise.all([a.wait(ja, 8000), b.wait(jb, 8000)]);
    // Serial would be >= 1s; parallel should be well under.
    expect(Date.now() - t0).toBeLessThan(950);
    expect(a.digest(ja).head).toEqual(["A"]);
    expect(b.digest(jb).head).toEqual(["B"]);
  });

  test("awaiting-input: read builtin is detected and answerable", async () => {
    const s = await manager.createSession({ name: "prompt", shell: "/bin/bash" });
    const job = manager.run(s.id, "printf 'proceed? [y/N] '; read ans; echo answer=$ans");
    await s.wait(job, 6000);
    expect(job.state).toBe("awaiting-input");
    expect(job.awaitingReason).toContain("yes-no");
    const d = s.digest(job);
    expect(d.awaiting_tail!.join("\n")).toContain("proceed?");
    s.sendInput("y", true);
    await s.wait(job, 6000);
    expect(job.state).toBe("exited");
    expect(s.digest(job).head.at(-1)).toBe("answer=y");
  });

  test("job_kill terminates a foreground process", async () => {
    const s = await manager.createSession({ name: "killer", shell: "/bin/bash" });
    const job = manager.run(s.id, "sleep 60");
    await Bun.sleep(500);
    s.killJob(job, "SIGTERM");
    await s.wait(job, 6000);
    expect(job.state).toBe("killed");
  });

  test("killing a queued job dequeues it without running", async () => {
    const s = await manager.createSession({ name: "dequeue", shell: "/bin/bash" });
    const j1 = manager.run(s.id, "sleep 0.5");
    const j2 = manager.run(s.id, "echo never");
    s.killJob(j2, "SIGTERM");
    expect(j2.state).toBe("killed");
    await s.wait(j1, 6000);
    expect(j1.state).toBe("exited");
    expect(s.digest(j2).line_count).toBe(0);
  });

  test("raw log on disk preserves escapes and markers (lossless recovery)", async () => {
    const s = await manager.createSession({ name: "rawlog", shell: "/bin/bash" });
    const job = manager.run(s.id, "printf '\\033[31mred\\033[0m\\n'");
    await s.wait(job, 5000);
    // Normalized view is clean...
    expect(s.digest(job).head).toEqual(["red"]);
    // ...but the raw log still has the color escape and the OSC 133 markers.
    const raw = fs.readFileSync(s.rawLogPath, "latin1");
    expect(raw).toContain("\x1b[31mred");
    expect(raw).toContain("\x1b]133;D;0");
  });

  test("progress bars are collapsed with a note", async () => {
    const s = await manager.createSession({ name: "progress", shell: "/bin/bash" });
    const job = manager.run(
      s.id,
      `for i in $(seq 1 300); do printf '\\rdownloading %d%%' $((i/3)); done; echo`,
    );
    await s.wait(job, 10000);
    const d = s.digest(job);
    expect(d.line_count).toBe(1);
    expect(d.head[0]).toBe("downloading 100%");
    expect(d.notes.join(" ")).toContain("collapsed");
  });

  test("TUI job: screen mode renders what a human sees in less", async () => {
    const s = await manager.createSession({ name: "tui-screen", shell: "/bin/bash" });
    const setup = manager.run(s.id, "seq 1 2000 | sed 's/^/row /' > screen-big.txt");
    await s.wait(setup, 5000);
    const job = manager.run(s.id, "less screen-big.txt");
    await s.wait(job, 6000); // flips to awaiting-input (pager reading keys)
    expect(job.state).toBe("awaiting-input");
    const screen = await job.output.queryScreen(job.id, job.state);
    // The rendered viewport shows the top of the file, positionally.
    expect(screen.text.split("\n")[0]).toBe("row 1");
    expect(screen.text).toContain("row 20");
    // Quit the pager; job exits normally.
    s.sendInput("q", false);
    await s.wait(job, 6000);
    expect(job.state).toBe("exited");
    expect(s.digest(job).tui_mode).toBe(true);
  });

  test("session_kill marks active jobs and refuses further runs", async () => {
    const s = await manager.createSession({ name: "doomed", shell: "/bin/bash" });
    const job = manager.run(s.id, "sleep 30");
    await Bun.sleep(300);
    manager.killSession(s.id);
    expect(s.alive).toBe(false);
    expect(job.state).toBe("killed");
    expect(() => manager.run(s.id, "echo nope")).toThrow(/dead|no session/);
  });

  test("duplicate live session names are rejected with guidance", async () => {
    await manager.createSession({ name: "uniq", shell: "/bin/bash" });
    expect(manager.createSession({ name: "uniq" })).rejects.toThrow(/already exists/);
  });

  test("orphan output between jobs is captured, not lost", async () => {
    const s = await manager.createSession({ name: "orphan", shell: "/bin/bash" });
    // Disowned background process that prints AFTER the job exits.
    const job = manager.run(s.id, "( { sleep 0.4; echo late-bg-output; } & disown ) 2>/dev/null");
    await s.wait(job, 5000);
    expect(job.state).toBe("exited");
    await Bun.sleep(900);
    const orphan = s.orphanOutput.snapshot().lines.join("\n");
    expect(orphan).toContain("late-bg-output");
  });
});

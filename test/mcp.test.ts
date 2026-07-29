/**
 * MCP surface test: drives the real server through an in-memory transport
 * pair, exactly as an MCP client would.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionManager } from "../src/manager";
import { buildServer } from "../src/mcp";

const runtimeDir = path.join(process.env.TMPDIR ?? "/tmp", `agent-term-mcp-test-${process.pid}`);
const manager = new SessionManager({ runtimeDir, quietMs: 700 });
const server = buildServer(manager);
const client = new Client({ name: "test-client", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

afterAll(async () => {
  await client.close();
  manager.shutdown();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<{ payload: any; isError: boolean; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = res.content[0]?.text ?? "";
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* error messages are plain text */
  }
  return { payload, isError: res.isError === true, text };
}

describe("MCP tool surface", () => {
  test("lists the nine v1 tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "job_kill",
      "job_status",
      "read_output",
      "run",
      "send_input",
      "session_create",
      "session_kill",
      "session_list",
      "wait",
    ]);
  });

  test("full run/wait/read cycle through the wire", async () => {
    const created = await call("session_create", { name: "wire", shell: "/bin/bash" });
    expect(created.isError).toBe(false);
    const sid = created.payload.session_id as string;

    const run = await call("run", { session_id: sid, command: "seq 1 50" });
    expect(run.isError).toBe(false);
    const jid = run.payload.job_id as string;
    expect(run.payload.state).toBe("queued");

    const waited = await call("wait", { job_id: jid, timeout_ms: 8000 });
    expect(waited.payload.state).toBe("exited");
    expect(waited.payload.exit_code).toBe(0);
    expect(waited.payload.line_count).toBe(50);
    expect(waited.payload.head).toHaveLength(10);
    expect(waited.payload.tail).toHaveLength(20);

    const grep = await call("read_output", { job_id: jid, mode: "grep", pattern: "^25$", context: 1 });
    expect(grep.payload.total_matches).toBe(1);
    expect(grep.payload.text).toBe("24:24\n25:25\n26:26");
    expect(grep.payload.remaining_estimated_tokens).toBeGreaterThan(0);

    const list = await call("session_list", {});
    const entry = list.payload.sessions.find((s: any) => s.session_id === sid);
    expect(entry.alive).toBe(true);
    expect(entry.job_ids).toContain(jid);
  });

  test("full read over budget returns a teaching error", async () => {
    const created = await call("session_create", { name: "budget", shell: "/bin/bash" });
    const sid = created.payload.session_id as string;
    const run = await call("run", { session_id: sid, command: "seq 1 2000" });
    await call("wait", { job_id: run.payload.job_id, timeout_ms: 8000 });
    const full = await call("read_output", {
      job_id: run.payload.job_id,
      mode: "full",
      confirm_tokens: 10,
    });
    expect(full.isError).toBe(true);
    expect(full.text).toContain("confirm_tokens");
    expect(full.text).toMatch(/grep|tail|slice/);
  });

  test("missing query params teach the correct shape", async () => {
    const created = await call("session_create", { name: "shape", shell: "/bin/bash" });
    const sid = created.payload.session_id as string;
    const run = await call("run", { session_id: sid, command: "echo x" });
    await call("wait", { job_id: run.payload.job_id, timeout_ms: 8000 });
    const bad = await call("read_output", { job_id: run.payload.job_id, mode: "grep" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('mode "grep" requires "pattern"');
  });

  test("unknown ids produce actionable errors", async () => {
    const r = await call("job_status", { job_id: "job-does-not-exist" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("session_list");
    const s = await call("run", { session_id: "nope", command: "true" });
    expect(s.isError).toBe(true);
    expect(s.text).toContain("session_create");
  });

  test("send_input answers a prompt end to end", async () => {
    const created = await call("session_create", { name: "answer", shell: "/bin/bash" });
    const sid = created.payload.session_id as string;
    const run = await call("run", { session_id: sid, command: "read -p 'name: ' n; echo hi-$n" });
    const waited = await call("wait", { job_id: run.payload.job_id, timeout_ms: 8000 });
    expect(waited.payload.state).toBe("awaiting-input");
    await call("send_input", { session_id: sid, text: "world" });
    const done = await call("wait", { job_id: run.payload.job_id, timeout_ms: 8000 });
    expect(done.payload.state).toBe("exited");
    expect(done.payload.head.join("\n")).toContain("hi-world");
  });

  test("wait with since_line streams deltas", async () => {
    const created = await call("session_create", { name: "deltas", shell: "/bin/bash" });
    const sid = created.payload.session_id as string;
    const run = await call("run", {
      session_id: sid,
      command: "echo one; sleep 0.4; echo two; sleep 0.4; echo three",
    });
    const jid = run.payload.job_id;
    const first = await call("wait", { job_id: jid, timeout_ms: 200, since_line: 0 });
    const cursor = first.payload.last_line as number;
    const second = await call("wait", { job_id: jid, timeout_ms: 8000, since_line: cursor });
    expect(second.payload.state).toBe("exited");
    const newLines = (second.payload.new_lines as string).split("\n").filter(Boolean);
    // Everything after the first snapshot, nothing repeated from before it.
    expect(newLines).toEqual(["one", "two", "three"].slice(cursor));
  });
});

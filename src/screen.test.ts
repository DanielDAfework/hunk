import { describe, expect, test } from "bun:test";
import { JobOutput } from "./store";
import { QueryError } from "./store";
import { ScreenRenderer } from "./screen";

describe("ScreenRenderer", () => {
  test("renders cursor-addressed TUI drawing faithfully", async () => {
    const r = new ScreenRenderer(40, 10);
    // Full-screen program: clear, draw a header at row 1 and a status at row 10.
    r.write("\x1b[?1049h\x1b[2J\x1b[1;1HFile: notes.txt\x1b[10;1H-- 42% --");
    await r.flush();
    const lines = r.renderLines();
    expect(lines[0]).toBe("File: notes.txt");
    expect(lines[9]).toBe("-- 42% --");
    // Middle rows are blank screen, preserved positionally.
    expect(lines[4]).toBe("");
    r.dispose();
  });

  test("later repaints replace earlier content (a real emulator, not a log)", async () => {
    const r = new ScreenRenderer(20, 4);
    r.write("\x1b[2J\x1b[1;1Hframe one");
    r.write("\x1b[2J\x1b[1;1Hframe two");
    await r.flush();
    expect(r.renderLines()).toEqual(["frame two"]);
    r.dispose();
  });
});

describe("JobOutput screen mode", () => {
  test("non-TUI jobs get a teaching error", async () => {
    const o = new JobOutput(80, 24);
    o.feed("plain output\n");
    expect(o.hasScreen).toBe(false);
    await expect(o.queryScreen("job-x", "exited")).rejects.toThrow(QueryError);
    await expect(o.queryScreen("job-x", "exited")).rejects.toThrow(/tail, slice, or grep/);
  });

  test("alt-screen output activates the renderer and renders the viewport", async () => {
    const o = new JobOutput(30, 5);
    o.feed("before tui\n");
    o.feed("\x1b[?1049h\x1b[2J\x1b[1;1Hpicker: choose an option\x1b[2;1H> alpha");
    expect(o.hasScreen).toBe(true);
    const res = await o.queryScreen("job-y", "running");
    expect(res.mode).toBe("screen");
    expect(res.text.split("\n")).toEqual(["picker: choose an option", "> alpha"]);
    expect(res.returned_estimated_tokens).toBeGreaterThan(0);
    expect(res.notes.join(" ")).toContain("viewport");
  });
});

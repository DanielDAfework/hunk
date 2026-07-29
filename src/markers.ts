/**
 * Streaming parser for OSC 133 shell-integration markers.
 *
 * The daemon's job lifecycle is driven by these three markers, injected via
 * the generated rcfile (see shellIntegration.ts):
 *   ESC ] 133 ; C BEL          — command execution starts (output follows)
 *   ESC ] 133 ; D ; <code> BEL — command finished with exit code
 *   ESC ] 133 ; A BEL          — shell is painting a fresh prompt
 *
 * Markers can be split across PTY read chunks, so the parser keeps a small
 * pending tail whenever a chunk ends in what could be a partial marker.
 * Everything that is not an OSC 133 marker passes through as data untouched
 * (other escape sequences are the normalizer's problem, not ours).
 */

export type Marker =
  | { type: "A" }
  | { type: "B" }
  | { type: "C" }
  | { type: "D"; exitCode: number | null };

export type ParseEvent =
  | { kind: "data"; data: string }
  | { kind: "marker"; marker: Marker };

const MARKER_RE = /\x1b\]133;([ABCD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/;

/** Longest a marker can reasonably be; beyond this a pending tail is flushed as data. */
const MAX_PENDING = 64;

/** True if `s` could be the beginning of an OSC 133 marker (ends mid-sequence). */
export function isPossibleMarkerPrefix(s: string): boolean {
  const full = "\x1b]133;";
  if (s.length < full.length) return full.startsWith(s);
  if (!s.startsWith(full)) return false;
  // Started a marker: it's still a prefix as long as no terminator appeared.
  // (ESC inside could be the start of the ST terminator "ESC \".)
  return !s.includes("\x07") && !/\x1b\\/.test(s.slice(1));
}

export class Osc133Parser {
  private pending = "";

  /** Parse a chunk; returns interleaved data segments and markers, in order. */
  feed(chunk: string): ParseEvent[] {
    let buf = this.pending + chunk;
    this.pending = "";
    const events: ParseEvent[] = [];

    for (;;) {
      const m = MARKER_RE.exec(buf);
      if (!m) break;
      if (m.index > 0) events.push({ kind: "data", data: buf.slice(0, m.index) });
      const letter = m[1] as "A" | "B" | "C" | "D";
      if (letter === "D") {
        const arg = m[2];
        const code = arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : null;
        events.push({ kind: "marker", marker: { type: "D", exitCode: code } });
      } else {
        events.push({ kind: "marker", marker: { type: letter } });
      }
      buf = buf.slice(m.index + m[0].length);
    }

    // Hold back a trailing partial marker; flush everything else as data.
    const escIdx = buf.lastIndexOf("\x1b");
    if (escIdx !== -1) {
      const tail = buf.slice(escIdx);
      if (tail.length <= MAX_PENDING && isPossibleMarkerPrefix(tail)) {
        if (escIdx > 0) events.push({ kind: "data", data: buf.slice(0, escIdx) });
        this.pending = tail;
        return events;
      }
    }
    if (buf.length > 0) events.push({ kind: "data", data: buf });
    return events;
  }

  /** Flush any held partial marker as plain data (call at stream end). */
  flush(): ParseEvent[] {
    if (this.pending.length === 0) return [];
    const out: ParseEvent[] = [{ kind: "data", data: this.pending }];
    this.pending = "";
    return out;
  }
}

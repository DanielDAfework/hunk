import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { RegisteredFileView } from "../../extensions/types";
import {
  fileViewHunkCount,
  createFileViewInput,
  createFileViewInputSnapshot,
  type FileViewInputSnapshot,
} from "./host";
import {
  validateFileViewLayout,
  validateFileViewSourceRanges,
  type ValidatedFileViewLayout,
} from "./layout";
import { registeredFileViewKey } from "./state";

/** Bound asynchronous third-party layout work so raw diff never waits indefinitely. */
export const FILE_VIEW_LAYOUT_TIMEOUT_MS = 1_500;
/** Keep extension preparation parallel but bounded across a large changeset. */
export const FILE_VIEW_LAYOUT_CONCURRENCY = 4;
/** Coalesce rapid width changes without ever painting geometry measured for a stale width. */
export const FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS = 50;
/** Retain only a bounded set of prepared trees across file, view, and resize churn. */
export const FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES = 64;
/** Bound warning dedupe metadata retained across input generations for this hook lifetime. */
export const FILE_VIEW_LAYOUT_ISSUE_MAX_ENTRIES = 256;

const EMPTY_RESOLVED_FILE_VIEW_LAYOUTS: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();

export interface ResolvedFileViewLayout extends ValidatedFileViewLayout {
  key: string;
  extensionId: string;
  viewId: string;
  /** Stable identity for this concrete registration object. */
  registrationIdentity: number;
  /** Changes whenever the host accepts a newly prepared layout. */
  layoutGeneration: number;
}

interface CacheEntry {
  file: DiffFile;
  registered: RegisteredFileView;
  resolved: ResolvedFileViewLayout | null;
}

interface ResolvedEntry {
  file: DiffFile;
  key: string;
  registered: RegisteredFileView;
  width: number;
  resolved: ResolvedFileViewLayout;
}

/** Record a dedupe key while evicting the oldest retained key at the fixed limit. */
function recordBoundedIssue(keys: Set<string>, key: string) {
  if (keys.has(key)) return false;
  if (keys.size >= FILE_VIEW_LAYOUT_ISSUE_MAX_ENTRIES) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  keys.add(key);
  return true;
}

/** Remove superseded widths for one registration before reading or preparing its current width. */
function selectCacheWidthVariant(
  entries: Map<string, CacheEntry>,
  cacheKey: string,
  file: DiffFile,
  registered: RegisteredFileView,
) {
  for (const [key, entry] of entries) {
    if (key !== cacheKey && entry.file.id === file.id && entry.registered === registered) {
      entries.delete(key);
    }
  }
  const cached = entries.get(cacheKey);
  if (cached) {
    // Map insertion order doubles as a small LRU so hot entries survive changeset churn.
    entries.delete(cacheKey);
    entries.set(cacheKey, cached);
  }
  return cached;
}

/** Insert one successful or declined result and evict the oldest retained tree when full. */
function cacheLayoutResult(entries: Map<string, CacheEntry>, key: string, entry: CacheEntry) {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

/** Create one layout-owned signal linked to the containing effect. */
function createLayoutController(parentSignal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }
  return {
    controller,
    detach: () => parentSignal.removeEventListener("abort", abort),
  };
}

/**
 * Run one extension layout with a child cancellation lifetime.
 *
 * The child is aborted on timeout, parent supersession, and successful or failed completion.
 * Promise.race detaches the host from extensions that resolve after their budget has expired.
 */
export async function runFileViewLayoutRequest(
  registered: RegisteredFileView,
  file: DiffFile,
  width: number,
  parentSignal: AbortSignal,
  timeoutMs = FILE_VIEW_LAYOUT_TIMEOUT_MS,
  snapshot?: FileViewInputSnapshot,
): Promise<ValidatedFileViewLayout | null> {
  const { controller, detach } = createLayoutController(parentSignal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("layout timed out"));
        reject(new Error("layout timed out"));
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("layout aborted"));
        return;
      }
      controller.signal.addEventListener("abort", () => reject(new Error("layout aborted")), {
        once: true,
      });
    });
    const input = createFileViewInput(file, width, controller.signal, snapshot);
    const candidate = await Promise.race([
      Promise.resolve().then(() => registered.view.layout(input)),
      deadline,
      cancelled,
    ]);
    if (controller.signal.aborted || parentSignal.aborted) {
      throw new Error("layout aborted");
    }
    if (candidate === null) {
      return null;
    }
    const checked = validateFileViewLayout(candidate, fileViewHunkCount(file), width);
    if (!checked.valid) {
      throw new Error(`invalid layout: ${checked.issue}`);
    }
    const requiredSides = new Set(
      checked.value.layout.rows.flatMap((row) =>
        (row.sourceRanges ?? []).map((sourceRange) => sourceRange.side),
      ),
    );
    const documents = Object.fromEntries(
      await Promise.all(
        [...requiredSides].map(async (side) => [side, await input.readDocument(side)] as const),
      ),
    );
    if (controller.signal.aborted || parentSignal.aborted) {
      throw new Error("layout aborted");
    }
    const bindingIssue = validateFileViewSourceRanges(checked.value.layout, documents);
    if (bindingIssue) {
      throw new Error(`invalid layout: ${bindingIssue}`);
    }
    return checked.value;
  } finally {
    if (timeout) clearTimeout(timeout);
    detach();
    controller.abort();
  }
}

/**
 * Run selected file-view layouts outside render and retain only validated results.
 *
 * Raw diff remains visible while preparation is pending or declines the file. A
 * cancellation never reaches an extension as an error toast: resizes, reloads,
 * and changing the selected view are normal control flow.
 */
export function useFileViewLayouts({
  files,
  selections,
  views,
  width,
  onIssue,
}: {
  files: readonly DiffFile[];
  selections: Readonly<Record<string, string>>;
  views: readonly RegisteredFileView[];
  width: number;
  onIssue: (message: string) => void;
}) {
  const cache = useRef(new Map<string, CacheEntry>());
  const registrationIdentities = useRef(new WeakMap<RegisteredFileView, number>());
  const nextRegistrationIdentity = useRef(1);
  const nextLayoutGeneration = useRef(1);
  const previousWidth = useRef<number | undefined>(undefined);
  const reportedIssues = useRef(new Set<string>());
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedEntry>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    const next = new Map<string, ResolvedEntry>();
    const widthChanged = previousWidth.current !== undefined && previousWidth.current !== width;
    previousWidth.current = width;
    let active = true;
    let cursor = 0;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const byKey = new Map(views.map((view) => [registeredFileViewKey(view), view]));

    const registrationIdentityFor = (registered: RegisteredFileView) => {
      let identity = registrationIdentities.current.get(registered);
      if (identity === undefined) {
        identity = nextRegistrationIdentity.current++;
        registrationIdentities.current.set(registered, identity);
      }
      return identity;
    };

    const reportOnce = (registered: RegisteredFileView, key: string, message: string) => {
      const identity = registrationIdentityFor(registered);
      if (recordBoundedIssue(reportedIssues.current, `${identity}:${key}`)) onIssue(message);
    };

    const prepareFile = async (file: DiffFile) => {
      const key = selections[file.id];
      if (!key) return;
      const registered = byKey.get(key);
      if (!registered) return;

      const cacheKey = `${file.id}:${key}:${width}`;
      const cached = selectCacheWidthVariant(cache.current, cacheKey, file, registered);
      // A valid registration-aware cache hit bypasses even matches(), whose extension code may be
      // expensive or stateful. A reload replaces the registration object and invalidates it.
      if (cached?.file === file && cached.registered === registered) {
        if (cached.resolved) {
          next.set(file.id, { file, key, registered, width, resolved: cached.resolved });
        }
        return;
      }

      const snapshot = createFileViewInputSnapshot(file);
      try {
        if (!registered.view.matches(snapshot.file)) return;
      } catch {
        reportOnce(
          registered,
          `${file.id}:${key}:matches`,
          `Extension ${registered.extensionId} file view "${registered.view.id}" failed matching ${file.path} • using raw diff`,
        );
        return;
      }

      try {
        const validated = await runFileViewLayoutRequest(
          registered,
          file,
          width,
          controller.signal,
          FILE_VIEW_LAYOUT_TIMEOUT_MS,
          snapshot,
        );
        if (controller.signal.aborted || !active) return;
        if (validated === null) {
          cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: null });
          return;
        }
        const registrationIdentity = registrationIdentityFor(registered);
        const prepared: ResolvedFileViewLayout = {
          ...validated,
          key,
          extensionId: registered.extensionId,
          viewId: registered.view.id,
          registrationIdentity,
          layoutGeneration: nextLayoutGeneration.current++,
        };
        cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: prepared });
        next.set(file.id, { file, key, registered, width, resolved: prepared });
      } catch (error) {
        if (controller.signal.aborted || !active) return;
        const detail = error instanceof Error ? error.message : String(error);
        const invalid = detail.startsWith("invalid layout: ");
        reportOnce(
          registered,
          `${file.id}:${key}:${invalid ? detail : "layout"}`,
          invalid
            ? `Extension ${registered.extensionId} file view "${registered.view.id}" returned an ${detail} • using raw diff`
            : `Extension ${registered.extensionId} file view "${registered.view.id}" failed laying out ${file.path} • using raw diff`,
        );
        cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: null });
      }
    };

    const worker = async () => {
      while (active) {
        const index = cursor++;
        const file = files[index];
        if (!file) return;
        await prepareFile(file);
      }
    };

    const prepare = () => {
      void Promise.all(
        Array.from({ length: Math.min(FILE_VIEW_LAYOUT_CONCURRENCY, files.length) }, worker),
      ).then(() => {
        if (active) setResolved(next);
      });
    };

    if (widthChanged) {
      startTimer = setTimeout(prepare, FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS);
    } else {
      prepare();
    }

    return () => {
      active = false;
      if (startTimer) clearTimeout(startTimer);
      controller.abort();
    };
  }, [files, onIssue, selections, views, width]);

  return useMemo(() => {
    const current = new Map<string, ResolvedFileViewLayout>();
    const byKey = new Map(views.map((view) => [registeredFileViewKey(view), view]));
    for (const file of files) {
      const key = selections[file.id];
      const entry = resolved.get(file.id);
      if (
        key &&
        entry?.file === file &&
        entry.key === key &&
        entry.registered === byKey.get(key) &&
        entry.width === width
      ) {
        current.set(file.id, entry.resolved);
      }
    }
    // Effects clean up after render. Exact per-file filtering synchronously declines stale geometry
    // while preserving unaffected files across filtering and another file's selection change.
    return current.size > 0 ? current : EMPTY_RESOLVED_FILE_VIEW_LAYOUTS;
  }, [files, resolved, selections, views, width]);
}

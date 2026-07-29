import { useEffect, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { RegisteredFileView } from "../../extensions/types";
import { fileViewHunkCount, createFileViewInput } from "./host";
import { validateFileViewLayout, type ValidatedFileViewLayout } from "./layout";
import { registeredFileViewKey } from "./state";

/** Bound asynchronous third-party layout work so raw diff never waits indefinitely. */
export const FILE_VIEW_LAYOUT_TIMEOUT_MS = 1_500;
/** Keep extension preparation parallel but bounded across a large changeset. */
export const FILE_VIEW_LAYOUT_CONCURRENCY = 4;
/** Retain only a bounded set of prepared trees across file, view, and resize churn. */
export const FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES = 64;
/** Bound warning dedupe metadata within one active input generation. */
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

interface ResolvedState {
  files?: readonly DiffFile[];
  selections?: Readonly<Record<string, string>>;
  views?: readonly RegisteredFileView[];
  width?: number;
  layouts: ReadonlyMap<string, ResolvedFileViewLayout>;
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
    const input = createFileViewInput(file, width, controller.signal);
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
  const [resolved, setResolved] = useState<ResolvedState>({
    layouts: EMPTY_RESOLVED_FILE_VIEW_LAYOUTS,
  });

  useEffect(() => {
    const controller = new AbortController();
    const next = new Map<string, ResolvedFileViewLayout>();
    let active = true;
    let cursor = 0;
    const byKey = new Map(views.map((view) => [registeredFileViewKey(view), view]));
    const reportedIssues = new Set<string>();

    const reportOnce = (key: string, message: string) => {
      if (recordBoundedIssue(reportedIssues, key)) onIssue(message);
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
        if (cached.resolved) next.set(file.id, cached.resolved);
        return;
      }

      try {
        if (!registered.view.matches(createFileViewInput(file, width, controller.signal).file)) {
          return;
        }
      } catch {
        reportOnce(
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
        );
        if (controller.signal.aborted || !active) return;
        if (validated === null) {
          cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: null });
          return;
        }
        let registrationIdentity = registrationIdentities.current.get(registered);
        if (registrationIdentity === undefined) {
          registrationIdentity = nextRegistrationIdentity.current++;
          registrationIdentities.current.set(registered, registrationIdentity);
        }
        const prepared: ResolvedFileViewLayout = {
          ...validated,
          key,
          extensionId: registered.extensionId,
          viewId: registered.view.id,
          registrationIdentity,
          layoutGeneration: nextLayoutGeneration.current++,
        };
        cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: prepared });
        next.set(file.id, prepared);
      } catch (error) {
        if (controller.signal.aborted || !active) return;
        const detail = error instanceof Error ? error.message : String(error);
        const invalid = detail.startsWith("invalid layout: ");
        reportOnce(
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

    void Promise.all(
      Array.from({ length: Math.min(FILE_VIEW_LAYOUT_CONCURRENCY, files.length) }, worker),
    ).then(() => {
      if (active) setResolved({ files, selections, views, width, layouts: next });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [files, onIssue, selections, views, width]);

  // Effects clean up after render. Decline the previous generation synchronously so its painters
  // cannot register or paint once with new files, selections, registrations, or width.
  if (
    resolved.files !== files ||
    resolved.selections !== selections ||
    resolved.views !== views ||
    resolved.width !== width
  ) {
    return EMPTY_RESOLVED_FILE_VIEW_LAYOUTS;
  }
  return resolved.layouts;
}

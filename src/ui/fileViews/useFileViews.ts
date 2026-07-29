import { useEffect, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { ExtensionFileViewLayout } from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import { fileViewHunkCount, createFileViewInput } from "./host";
import { validateFileViewLayout } from "./layout";
import { registeredFileViewKey } from "./state";

/** Bound asynchronous third-party layout work so raw diff never waits indefinitely. */
export const FILE_VIEW_LAYOUT_TIMEOUT_MS = 1_500;

export interface ResolvedFileViewLayout {
  key: string;
  layout: ExtensionFileViewLayout;
}

interface CacheEntry {
  file: DiffFile;
  key: string;
  width: number;
  layout: ExtensionFileViewLayout | null;
}

/** Race one third-party layout against the host resource budget without leaking a timer. */
function layoutWithTimeout<T>(layout: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("layout timed out")), FILE_VIEW_LAYOUT_TIMEOUT_MS);
  });
  return Promise.race([layout, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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
  const reportedIssues = useRef(new Set<string>());
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedFileViewLayout>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    const next = new Map<string, ResolvedFileViewLayout>();
    let active = true;
    const byKey = new Map(views.map((view) => [registeredFileViewKey(view), view]));

    const reportOnce = (key: string, message: string) => {
      if (!reportedIssues.current.has(key)) {
        reportedIssues.current.add(key);
        onIssue(message);
      }
    };

    const prepare = async () => {
      for (const file of files) {
        const key = selections[file.id];
        if (!key) {
          continue;
        }
        const registered = byKey.get(key);
        if (!registered) {
          continue;
        }
        const input = createFileViewInput(file, width, controller.signal);
        try {
          if (!registered.view.matches(input.file)) {
            continue;
          }
        } catch {
          reportOnce(
            `${file.id}:${key}:matches`,
            `Extension ${registered.extensionId} file view "${registered.view.id}" failed matching ${file.path} • using raw diff`,
          );
          continue;
        }

        const cacheKey = `${file.id}:${key}:${width}`;
        const cached = cache.current.get(cacheKey);
        if (cached?.file === file) {
          if (cached.layout) {
            next.set(file.id, { key, layout: cached.layout });
          }
          continue;
        }

        try {
          const candidate = await layoutWithTimeout(Promise.resolve(registered.view.layout(input)));
          if (controller.signal.aborted || !active) {
            return;
          }
          if (candidate === null) {
            cache.current.set(cacheKey, { file, key, width, layout: null });
            continue;
          }
          const checked = validateFileViewLayout(candidate, fileViewHunkCount(file), width);
          if (!checked.valid) {
            reportOnce(
              `${file.id}:${key}:invalid:${checked.issue}`,
              `Extension ${registered.extensionId} file view "${registered.view.id}" returned an invalid layout (${checked.issue}) • using raw diff`,
            );
            cache.current.set(cacheKey, { file, key, width, layout: null });
            continue;
          }
          cache.current.set(cacheKey, {
            file,
            key,
            width,
            layout: checked.value.layout,
          });
          next.set(file.id, { key, layout: checked.value.layout });
        } catch {
          if (controller.signal.aborted || !active) {
            return;
          }
          reportOnce(
            `${file.id}:${key}:layout`,
            `Extension ${registered.extensionId} file view "${registered.view.id}" failed laying out ${file.path} • using raw diff`,
          );
          cache.current.set(cacheKey, { file, key, width, layout: null });
        }
      }
      if (active) {
        setResolved(next);
      }
    };

    void prepare();
    return () => {
      active = false;
      controller.abort();
    };
  }, [files, onIssue, selections, views, width]);

  return resolved;
}

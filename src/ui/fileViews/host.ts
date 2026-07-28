import type { DiffFile } from "../../core/types";
import type {
  ExtensionFileChangeRange,
  ExtensionFileDocuments,
  ExtensionFileSide,
  ExtensionFileViewInput,
} from "../../extension-api/types";
import { readMetadataHunkSummaries, toReadOnlyFileViews } from "../../extensions/events";

/** Abort one caller's wait without cancelling the host's shared source read. */
function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException("The file-view request was aborted.", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("The file-view request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Build public changed-line ranges from the parsed hunk structure, without leaking Pierre types. */
export function fileViewChanges(file: DiffFile): readonly ExtensionFileChangeRange[] {
  const changes: ExtensionFileChangeRange[] = [];
  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const chunk of hunk.hunkContent) {
      if (chunk.type === "context") {
        if (chunk.lines > 0) {
          changes.push({
            hunkIndex,
            side: "old",
            range: [oldLine, oldLine + chunk.lines - 1],
            kind: "context",
          });
          changes.push({
            hunkIndex,
            side: "new",
            range: [newLine, newLine + chunk.lines - 1],
            kind: "context",
          });
        }
        oldLine += chunk.lines;
        newLine += chunk.lines;
        continue;
      }
      if (chunk.deletions > 0) {
        changes.push({
          hunkIndex,
          side: "old",
          range: [oldLine, oldLine + chunk.deletions - 1],
          kind: "removed",
        });
      }
      if (chunk.additions > 0) {
        changes.push({
          hunkIndex,
          side: "new",
          range: [newLine, newLine + chunk.additions - 1],
          kind: "added",
        });
      }
      oldLine += chunk.deletions;
      newLine += chunk.additions;
    }
  }
  return Object.freeze(changes.map((change) => Object.freeze(change)));
}

/** Build lazy document reads that expose no source-fetcher implementation details. */
export function createFileViewDocuments(file: DiffFile): ExtensionFileDocuments {
  const reads = new Map<
    ExtensionFileSide,
    Promise<{ availability: "exact"; text: string } | null>
  >();
  return Object.freeze({
    read(side: ExtensionFileSide, signal?: AbortSignal) {
      let read = reads.get(side);
      if (!read) {
        read = file.sourceFetcher
          ? file.sourceFetcher
              .getFullText(side)
              .then((text) =>
                text === null ? null : Object.freeze({ availability: "exact" as const, text }),
              )
              .catch(() => null)
          : Promise.resolve(null);
        reads.set(side, read);
      }
      return waitWithSignal(read, signal);
    },
  });
}

/** Build the frozen, public input handed to one file-view layout function. */
export function createFileViewInput(file: DiffFile): ExtensionFileViewInput {
  const view = toReadOnlyFileViews([file])[0]!;
  return Object.freeze({
    file: view,
    documents: createFileViewDocuments(file),
    changes: fileViewChanges(file),
  });
}

/** Read the hunk count through the public conversion boundary. */
export function fileViewHunkCount(file: DiffFile) {
  return readMetadataHunkSummaries(file.metadata).length;
}

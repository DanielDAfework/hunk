import { HUNK_VENDOR_EXTENSION_ID } from "../../../extensionIds";
import { runExtensionFactory } from "../../../runExtension";
import {
  createEmptyExtensionRegistry,
  type ExtensionLoadIssue,
  type RegisteredCommand,
  type RegisteredFileView,
} from "../../../types";
import { markdownFileViewExtension } from "./markdown";

/**
 * Load bundled review-stream file views separately from VCS adapters.
 *
 * This mirrors the built-in sidebar boundary: renderer-aware bundled UI must
 * not leak into VCS adapter resolution, but still dogfoods the public API.
 */
interface BundledFileViewExtension {
  views: readonly RegisteredFileView[];
  commands: readonly RegisteredCommand[];
}

let bundledFileViewExtension: BundledFileViewExtension | undefined;

/** Load the bundled renderer through the same registry as a user extension. */
export function getBundledFileViewExtension(): BundledFileViewExtension {
  if (bundledFileViewExtension) {
    return bundledFileViewExtension;
  }
  const registry = createEmptyExtensionRegistry();
  const issues: ExtensionLoadIssue[] = [];
  runExtensionFactory({
    metadata: {
      id: HUNK_VENDOR_EXTENSION_ID,
      sourcePath: "hunk:bundled/file-views/markdown",
      origin: "bundled",
    },
    registry,
    issues,
    factory: markdownFileViewExtension,
  });
  bundledFileViewExtension = {
    views: registry.fileViews,
    commands: registry.commands,
  };
  return bundledFileViewExtension;
}

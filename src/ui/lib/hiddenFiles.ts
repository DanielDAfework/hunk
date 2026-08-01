import { createContext, useContext } from "react";

/**
 * Collapsed-file state shared with the built-in sidebar.
 *
 * This deliberately sits outside `ExtensionSidebarViewProps`. Hiding is an
 * app-level review affordance rather than a published extension capability, so
 * the contract in `extension-api/types.ts` stays as it is and third-party
 * sidebars keep rendering unchanged against the default below.
 */
export interface HiddenFilesState {
  /** Ids of files whose diff body is collapsed in the review stream. */
  hiddenFileIds: ReadonlySet<string>;
  /** Collapse or restore one file. */
  toggleFileHidden: ((fileId: string) => void) | undefined;
}

const EMPTY_HIDDEN_FILE_IDS: ReadonlySet<string> = new Set<string>();

/** Default leaves rows non-hideable, so consumers outside the app still render. */
export const HiddenFilesContext = createContext<HiddenFilesState>({
  hiddenFileIds: EMPTY_HIDDEN_FILE_IDS,
  toggleFileHidden: undefined,
});

/** Read the collapsed-file state for the current review. */
export function useHiddenFiles(): HiddenFilesState {
  return useContext(HiddenFilesContext);
}

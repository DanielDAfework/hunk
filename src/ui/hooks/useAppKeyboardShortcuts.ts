import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef } from "react";
import type { MenuId } from "../components/chrome/menu";
import { dispatchAppCommand, type AppCommand } from "../lib/appCommands";
import type { ExtensionDialogRequest } from "../lib/extensionDialogs";
import { isEscapeKey, isSaveDraftNoteKey } from "../lib/keyboard";
import { routeKeyOwnership, type KeyOwner } from "../lib/keyRouting";

type FocusArea = "files" | "filter" | "note";

export interface UseAppKeyboardShortcutsOptions {
  activeMenuId: MenuId | null;
  activateCurrentMenuItem: () => void;
  closeAgentSkill: () => void;
  closeHelp: () => void;
  closeMenu: () => void;
  acceptThemeSelector: () => void;
  cancelDraftNote: () => void;
  closeThemeSelector: () => void;
  closeExtensionTrustPrompt: () => void;
  /**
   * Every app-level shortcut, built-in and extension-contributed, in dispatch
   * order. Modal navigation stays in this hook; commands own the rest.
   */
  commands: readonly AppCommand[];
  denyRepoExtensions: () => void;
  /** The extension dialog currently on screen, or `null` when none is. */
  extensionDialog: ExtensionDialogRequest | null;
  acceptExtensionDialog: () => void;
  cancelExtensionDialog: () => void;
  moveExtensionDialogSelection: (delta: number) => void;
  extensionTrustPromptOpen: boolean;
  trustRepoExtensions: () => void;
  focusArea: FocusArea;
  moveMenuItem: (delta: number) => void;
  moveThemeSelector: (delta: number) => void;
  openMenu: (menuId: MenuId) => void;
  saveConfigPromptOpen: boolean;
  saveViewPreferencesAndQuit: () => void;
  discardViewPreferencesAndQuit: () => void;
  neverAskToSaveViewPreferencesAndQuit: () => void;
  closeSaveConfigPrompt: () => void;
  saveDraftNote: () => void;
  showAgentSkill: boolean;
  showHelp: boolean;
  switchMenu: (delta: number) => void;
  toggleFocusArea: () => void;
  themeSelectorOpen: boolean;
}

/**
 * Register the app's scoped keyboard handling while keeping mode precedence
 * explicit.
 *
 * Modal surfaces (the trust prompt, save-config prompt, dialogs, the theme
 * selector, open menus, focused text inputs) answer first, in a fixed order —
 * their keys are the structure of the widget that owns them. Everything that
 * falls through lands in the command table, where built-in shortcuts and
 * extension commands share one dispatch path.
 *
 * Every handler answers the question "who owns this key?" with a
 * {@link KeyOwner}, and `routeKeyOwnership` enforces the consumption policy
 * centrally: `"mine"` is consumed so the focused renderable never double-acts
 * on it, `"focused"` ends the chain while leaving the key for the focused
 * text input, `"notMine"` keeps asking. See `../lib/keyRouting.ts` for the
 * full contract, including why a boolean cannot express it.
 */
export function useAppKeyboardShortcuts({
  activeMenuId,
  activateCurrentMenuItem,
  closeAgentSkill,
  closeHelp,
  closeMenu,
  acceptThemeSelector,
  cancelDraftNote,
  closeThemeSelector,
  closeExtensionTrustPrompt,
  commands,
  denyRepoExtensions,
  extensionDialog,
  acceptExtensionDialog,
  cancelExtensionDialog,
  moveExtensionDialogSelection,
  extensionTrustPromptOpen,
  trustRepoExtensions,
  focusArea,
  moveMenuItem,
  moveThemeSelector,
  openMenu,
  saveConfigPromptOpen,
  saveViewPreferencesAndQuit,
  discardViewPreferencesAndQuit,
  neverAskToSaveViewPreferencesAndQuit,
  closeSaveConfigPrompt,
  saveDraftNote,
  showAgentSkill,
  showHelp,
  switchMenu,
  toggleFocusArea,
  themeSelectorOpen,
}: UseAppKeyboardShortcutsOptions) {
  const activeMenuIdRef = useRef(activeMenuId);
  const commandsRef = useRef(commands);
  const focusAreaRef = useRef(focusArea);
  const showAgentSkillRef = useRef(showAgentSkill);
  const showHelpRef = useRef(showHelp);
  const saveConfigPromptOpenRef = useRef(saveConfigPromptOpen);
  const themeSelectorOpenRef = useRef(themeSelectorOpen);
  const extensionTrustPromptOpenRef = useRef(extensionTrustPromptOpen);
  const extensionDialogRef = useRef(extensionDialog);
  // These three close over live dialog state (the highlighted option, the typed
  // text), so they are read through refs rather than captured once.
  const acceptExtensionDialogRef = useRef(acceptExtensionDialog);
  const cancelExtensionDialogRef = useRef(cancelExtensionDialog);
  const moveExtensionDialogSelectionRef = useRef(moveExtensionDialogSelection);

  activeMenuIdRef.current = activeMenuId;
  commandsRef.current = commands;
  focusAreaRef.current = focusArea;
  showAgentSkillRef.current = showAgentSkill;
  showHelpRef.current = showHelp;
  saveConfigPromptOpenRef.current = saveConfigPromptOpen;
  themeSelectorOpenRef.current = themeSelectorOpen;
  extensionTrustPromptOpenRef.current = extensionTrustPromptOpen;
  extensionDialogRef.current = extensionDialog;
  acceptExtensionDialogRef.current = acceptExtensionDialog;
  cancelExtensionDialogRef.current = cancelExtensionDialog;
  moveExtensionDialogSelectionRef.current = moveExtensionDialogSelection;

  /**
   * Stop a key dead: the focused renderable never sees it, and neither do
   * sibling global listeners (job control's Ctrl-C/Ctrl-Z handlers).
   *
   * `preventDefault()` alone would stop the renderable; adding
   * `stopPropagation()` matches what the modal prompts have always done, and
   * a key a handler owned outright has no other legitimate audience.
   */
  const consumeKey = (key: KeyEvent) => {
    key.preventDefault();
    key.stopPropagation();
  };

  /** F10 toggles the menu bar, except while a note draft outranks it. */
  const handleMenuToggleShortcut = (key: KeyEvent): KeyOwner => {
    if (key.name !== "f10") {
      return "notMine";
    }

    // The note composer owns the whole keyboard except its own escape
    // hatches; popping the menu bar over an in-progress draft would route the
    // next keystrokes away from the user's text. Swallow rather than forward:
    // the textarea has no use for F10 as text.
    if (focusAreaRef.current === "note") {
      return "mine";
    }

    if (activeMenuIdRef.current) {
      closeMenu();
    } else {
      openMenu("file");
    }

    return "mine";
  };

  /** Escape closes the topmost open overlay (agent skill, then help). */
  const handleDialogShortcut = (key: KeyEvent): KeyOwner => {
    if (!isEscapeKey(key)) {
      return "notMine";
    }

    if (showAgentSkillRef.current) {
      closeAgentSkill();
      return "mine";
    }

    if (showHelpRef.current) {
      closeHelp();
      return "mine";
    }

    return "notMine";
  };

  /**
   * Own every key while the save-config prompt is up.
   *
   * A modal question is on screen; keys it does not recognize are swallowed
   * rather than allowed to quietly act on the review behind it.
   */
  const handleSaveConfigPromptShortcut = (key: KeyEvent): KeyOwner => {
    if (!saveConfigPromptOpenRef.current) {
      return "notMine";
    }

    if (key.name === "return" || key.name === "enter" || key.name === "s" || key.sequence === "s") {
      saveViewPreferencesAndQuit();
      return "mine";
    }

    // "q" again quits and discards, so a double-tap of the quit key always exits.
    if (key.name === "q" || key.sequence === "q") {
      discardViewPreferencesAndQuit();
      return "mine";
    }

    if (key.name === "n" || key.sequence === "n") {
      neverAskToSaveViewPreferencesAndQuit();
      return "mine";
    }

    if (isEscapeKey(key)) {
      closeSaveConfigPrompt();
      return "mine";
    }

    return "mine";
  };

  /**
   * Own every key while the repo-extension trust prompt is up.
   *
   * The prompt is a security decision, so no key may fall through to review
   * navigation and leave it ambiguous which choice the user just made. Escape
   * is deliberately the same as "not now": dismiss, persist nothing.
   */
  const handleExtensionTrustPromptShortcut = (key: KeyEvent): KeyOwner => {
    if (!extensionTrustPromptOpenRef.current) {
      return "notMine";
    }

    if (key.name === "return" || key.name === "enter" || key.name === "t" || key.sequence === "t") {
      trustRepoExtensions();
      return "mine";
    }

    if (key.name === "n" || key.sequence === "n") {
      denyRepoExtensions();
      return "mine";
    }

    if (isEscapeKey(key)) {
      closeExtensionTrustPrompt();
      return "mine";
    }

    return "mine";
  };

  /**
   * Own every key while an extension dialog is up.
   *
   * Modal in the same sense the trust prompt is: a question is on screen and no
   * key may quietly do something else with the review behind it. It sits below
   * Hunk's own app-critical prompts — those are about the session itself, and an
   * extension may not outrank them — and above menus, help, and the command
   * table.
   *
   * The input kind is the one non-modal-shaped answer: keys it does not act on
   * are the text the user is typing into the dialog's focused field, so they
   * are the focused widget's, not swallowed.
   */
  const handleExtensionDialogShortcut = (key: KeyEvent): KeyOwner => {
    const dialog = extensionDialogRef.current;
    if (!dialog) {
      return "notMine";
    }

    if (isEscapeKey(key)) {
      cancelExtensionDialogRef.current();
      return "mine";
    }

    if (key.name === "return" || key.name === "enter") {
      acceptExtensionDialogRef.current();
      return "mine";
    }

    if (dialog.kind === "select") {
      if (key.name === "up") {
        moveExtensionDialogSelectionRef.current(-1);
        return "mine";
      }

      if (key.name === "down" || key.name === "tab") {
        moveExtensionDialogSelectionRef.current(key.shift ? -1 : 1);
        return "mine";
      }
    }

    if (dialog.kind === "confirm") {
      if (key.name === "y" || key.sequence === "y") {
        acceptExtensionDialogRef.current();
        return "mine";
      }

      if (key.name === "n" || key.sequence === "n") {
        cancelExtensionDialogRef.current();
        return "mine";
      }
    }

    return dialog.kind === "input" ? "focused" : "mine";
  };

  /** Own every key while the theme selector is up; it is a modal surface. */
  const handleThemeSelectorShortcut = (key: KeyEvent): KeyOwner => {
    if (!themeSelectorOpenRef.current) {
      return "notMine";
    }

    if (isEscapeKey(key)) {
      closeThemeSelector();
      return "mine";
    }

    if (key.name === "up") {
      moveThemeSelector(-1);
      return "mine";
    }

    if (key.name === "down") {
      moveThemeSelector(1);
      return "mine";
    }

    if (key.name === "tab") {
      moveThemeSelector(key.shift ? -1 : 1);
      return "mine";
    }

    if (key.name === "return" || key.name === "enter") {
      acceptThemeSelector();
      return "mine";
    }

    // Swallow everything else: an unrecognized key must not scroll or edit the
    // review behind the selector.
    return "mine";
  };

  /**
   * Navigate an open dropdown menu.
   *
   * Deliberately not fully modal: the final `"notMine"` is load-bearing. Menu
   * items advertise single-key accelerators (`q`, `r`, `/`…), and those keys
   * must keep falling through to the command table, which consumes on match
   * and closes the menu via `closesMenu`.
   */
  const handleMenuShortcut = (key: KeyEvent): KeyOwner => {
    if (!activeMenuIdRef.current) {
      return "notMine";
    }

    if (isEscapeKey(key)) {
      closeMenu();
      return "mine";
    }

    if (key.name === "left") {
      switchMenu(-1);
      return "mine";
    }

    if (key.name === "right" || key.name === "tab") {
      switchMenu(1);
      return "mine";
    }

    if (key.name === "up") {
      moveMenuItem(-1);
      return "mine";
    }

    if (key.name === "down") {
      moveMenuItem(1);
      return "mine";
    }

    if (key.name === "return" || key.name === "enter") {
      activateCurrentMenuItem();
      return "mine";
    }

    return "notMine";
  };

  /**
   * Route keys around the focused text inputs (the file filter and the inline
   * note draft).
   *
   * Both inputs receive their characters through OpenTUI's renderable path,
   * which consuming would cut off — so plain typing is `"focused"`, and only
   * the inputs' explicit escape hatches (Tab out of the filter, Escape/Ctrl-S
   * on a draft) are acted on here and owned as `"mine"`.
   */
  const handleFocusedInputShortcut = (key: KeyEvent): KeyOwner => {
    if (focusAreaRef.current === "filter") {
      // Deliberately no modifier check: Shift+Tab toggles focus exactly like
      // Tab, in both its CSI-u and legacy backtab encodings.
      if (key.name === "tab") {
        toggleFocusArea();
        return "mine";
      }

      // Everything else is the filter's text (its own Escape handling lives on
      // the input, which clears first and closes second).
      return "focused";
    }

    if (focusAreaRef.current !== "note") {
      return "notMine";
    }

    if (isEscapeKey(key)) {
      cancelDraftNote();
      return "mine";
    }

    if (isSaveDraftNoteKey(key)) {
      saveDraftNote();
      return "mine";
    }

    // Everything else is the note draft's text, including keys that double as
    // command bindings.
    return "focused";
  };

  useKeyboard((key: KeyEvent) => {
    // Precedence is the array order: app-critical prompts, extension dialogs,
    // then menus and overlays, then focused text inputs, and finally the
    // command table below.
    const owned = routeKeyOwnership(
      [
        handleExtensionTrustPromptShortcut,
        handleSaveConfigPromptShortcut,
        handleExtensionDialogShortcut,
        handleMenuToggleShortcut,
        handleDialogShortcut,
        handleThemeSelectorShortcut,
        handleMenuShortcut,
        handleFocusedInputShortcut,
      ],
      key,
      consumeKey,
    );
    if (owned) {
      return;
    }

    // Dispatch consumes on match (preventDefault inside the loop), so a key
    // that runs a command never doubles as a scroll-box or input key.
    const matched = dispatchAppCommand(commandsRef.current, key);
    if (matched?.closesMenu) {
      closeMenu();
    }
  });
}

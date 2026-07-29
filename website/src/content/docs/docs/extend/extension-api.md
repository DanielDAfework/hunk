---
title: Extension API
description: Register themes, languages, transforms, commands, dialogs, and events through the extension API object.
---

The extension factory receives one API object. Registration calls are only valid while the factory is running; Hunk seals the object afterwards so a deferred callback cannot mutate the registry mid-session. This page indexes the whole object; the two largest registration calls are documented in depth on their own pages and summarized in place below.

## `hunk.apiVersion`

The API generation this Hunk speaks (currently `1`). Branch on it if you want one file to support several Hunk versions.

## `hunk.registerTheme(theme)`

Contribute one selectable theme. The object is the same shape as a `[themes.<id>]` config table:

```ts
hunk.registerTheme({
  id: "midnight-review",
  label: "Midnight Review",
  base: "catppuccin-mocha",
  accent: "#7fd1ff",
  syntaxScopes: { "keyword.operator": "#7fd1ff" },
});
```

Theme ids must be lowercase words separated by `-` or `_` and cannot reuse a built-in id. Config-defined themes always win over extension themes for the same id; the loser is reported as a startup notice. Extension themes appear in the selector after config themes, in load order.

## `hunk.registerFileLanguage(extension, language)`

Map a file extension to a syntax-highlighting language. The extension may be written with or without a leading dot and is lowercased.

```ts
hunk.registerFileLanguage(".zig", "zig");
hunk.registerFileLanguage("bzl", "python");
```

Later registrations win over earlier ones. Hunk's own `.mts` and `.cts` mappings cannot be overridden; attempts are skipped with a notice.

## `hunk.registerVcsAdapter(adapter)`

Contribute an additional version-control backend — the same call Hunk's own bundled Git, Jujutsu, and Sapling backends make. An adapter declares `detect`, its `operations` (`working-tree-diff`, `revision-show`, `stash-show`), and optionally detection priority, watch support, exact file sources, extra files, and rich user-fixable failures.

Full contract: [VCS adapters](/docs/extend/vcs-adapters/).

## `hunk.registerSidebarView(view)`

Contribute a sidebar view — your own React component, rendered inside Hunk's OpenTUI tree beside (or in place of) the built-in file navigation. Views receive live review props, guarded navigation actions, the user's resolved keybindings, and a scrollbox ref contract for selection-following and windowing.

Full contract: [Custom sidebars](/docs/extend/custom-sidebars/).

## `hunk.transformChangeset(fn)`

Rewrite the loaded changeset before it reaches the review UI. Transforms run in registration order, each seeing the previous one's output, on first load and on every reload.

```ts
hunk.transformChangeset((changeset) => ({
  ...changeset,
  files: changeset.files.filter((file) => !file.path.endsWith(".lock")),
}));
```

The function may be async. Filtering and reordering `files` is fully supported — the sidebar and the review stream both follow whatever you return.

Each file carries an opaque `metadata` field: it is the parsed diff the renderer draws from, so pass it through untouched (spreading a file preserves it). What you return is validated before it is reviewed. A transform that throws, or returns something the review UI could not draw — not a changeset with a `files` array, a file missing `metadata.hunks` or `stats`, two files sharing an `id` — is skipped: the previous changeset carries forward and you get a warning naming your extension and the problem.

You never need to reach into `metadata` to know what a file's hunks are: the read-only views Hunk hands outward (event payloads, sidebar props, a command's selection) carry a `hunks` list of public summaries — `index`, the `@@` header, and the inclusive old/new line spans, in render order. Like `changeType`, it is derived from the metadata at that boundary, so a transform neither receives nor produces it, and a stale value spread through a transform is replaced with what the metadata actually parses to.

## `hunk.registerCommand(command, handler)`

Register a named command, optionally bound to a key. Commands are not a sidebar one-off: they are the same mechanism Hunk's own shortcuts dispatch through — one table, one loop, built-ins first.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "hello", title: "Say hello", key: "ctrl+g" }, (ctx) => {
    ctx.notify("hello from a command");
  });
}
```

Key chords are `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` joined with `+` around a base key — a character (`"y"`, `"["`), an uppercase letter for its shifted form (`"G"`), or a named key (`"f2"`, `"pageup"`, `"left"`). `shift` applies to letters and named keys only: for a shifted symbol or digit, bind the character the shift produces (`"!"`, not `"shift+1"`), since terminals report the character rather than the combination. An unparsable chord fails the registration; a chord already owned by a built-in shortcut — or by an earlier-loaded extension — leaves that chord unbound, with a warning toast naming both sides. Omit `key` to register a command with no binding.

`key` also takes a list, binding the command to every chord in it:

```ts
hunk.registerCommand({ id: "hello", title: "Say hello", key: ["ctrl+g", "f9"] }, (ctx) => {
  ctx.notify("hello from a command");
});
```

Chords are refused one at a time: if `ctrl+g` were already taken, the command would still answer to `f9`.

Whatever an extension declares is a _default_. Users remap commands by id in the `[keybindings]` table of their own config, extension commands included — yours is named `"<extensionId>.<commandId>"`, while Hunk's own are `"hunk.app.quit"` and friends. See [`docs/keybindings.md`](https://github.com/modem-dev/hunk/blob/main/docs/keybindings.md) for the rules; the practical consequence is that a chord you declare may not be the chord your command ends up on.

Every registered command is also listed in the menu bar's **Extensions** menu, under its `title`, showing whichever key it currently answers to. The menu appears only when something registered a command, entries are grouped by extension in load order, and running one from the menu is the same dispatch the key would have done — so a command with no `key`, or one whose chord was refused, is still reachable with the mouse.

The handler fires when the key is pressed outside modal UI — dialogs, menus, and focused text inputs own their keys first, and pager mode does not dispatch extension commands. It receives the standard context plus `ctx.sidebars`, the controls for opening sidebar views:

- `ctx.sidebars.open(viewId)` / `close(viewId)` / `toggle(viewId)` — a bare id names your own extension's view, `"files"` names the built-in file navigation, and `"<extensionId>:<viewId>"` addresses any registered view. Opening a view also reveals the sidebar area when the user has hidden it with `s`, so the open is never silent.
- `ctx.sidebars.isOpen(viewId)` reports current state.

`ctx.selection` is where the review was pointing when the command fired — the same selection a sidebar component sees in its props, so a command never has to track `selection_changed` itself to know what the user is looking at:

```ts
hunk.registerCommand(
  { id: "show-selection", title: "Show the selected file", key: "ctrl+y" },
  (ctx) => {
    const { file, hunkIndex } = ctx.selection;
    if (!file) {
      ctx.notify("No file selected");
      return;
    }

    ctx.notify(hunkIndex === null ? file.path : `${file.path} — hunk ${hunkIndex + 1}`);
  },
);
```

`selection.file` is a frozen read-only view, identical to the entries in a sidebar's `files` prop. Hunk keeps the selection inside the visible files, so it is `null` only when nothing is visible at all — a filter that matches no files. `selection.hunkIndex` is that file's selected hunk, and `null` whenever `file` is — or when the file has no hunks to select. The values are captured when the command fires: a handler that awaits still sees the selection it was run from, not wherever the user navigated to meanwhile.

`ctx.navigation` moves the review stream: `selectFile(fileId)` and `selectHunk(fileId, hunkIndex)`, the same guarded navigation a sidebar's `actions` carry, routed through the same review controller — the stream scrolls, selection updates, and `selection_changed` fires exactly as if the user had clicked a sidebar row. Unlike `selection` it is live, not a snapshot: a call acts on the review as it is at that moment, so a handler that awaits a dialog and then navigates still works. A file id the stream cannot currently show is refused with a warning rather than corrupting the selection, and a hunk index is clamped into the file's real range.

A handler may be async; a failure (sync or rejected) becomes a warning naming your extension.

### Asking the user

`ctx.dialogs` puts a question on screen and waits for the answer. Three shapes, all promise-returning:

- `confirm({ title, body?, confirmLabel?, cancelLabel? })` → `true` or `false`
- `select({ title, options })` → the chosen string, or `null`
- `input({ title, placeholder?, initial? })` → the typed string, or `null`

```ts
hunk.registerCommand(
  { id: "reformat", title: "Reformat the selected file", key: "ctrl+r" },
  async (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      return;
    }

    const proceed = await ctx.dialogs.confirm({
      title: `Reformat ${file.path}?`,
      body: "The file is rewritten in place.",
      confirmLabel: "reformat",
    });

    ctx.notify(proceed ? `Reformatting ${file.path}` : "Left it alone");
  },
);
```

`select` is the natural fit for acting on part of the selection — here, asking which hunk of the selected file to jump to, then navigating there:

```ts
hunk.registerCommand({ id: "pick-hunk", title: "Pick a hunk", key: "ctrl+k" }, async (ctx) => {
  const file = ctx.selection.file;
  const hunks = file?.hunks ?? [];
  if (!file || hunks.length === 0) {
    ctx.notify("Nothing to pick from", "warning");
    return;
  }

  const labels = hunks.map((hunk) => hunk.header || `hunk ${hunk.index + 1}`);
  const picked = await ctx.dialogs.select({ title: "Which hunk?", options: labels });

  // `navigation` is live, so the jump is valid even after awaiting the dialog.
  if (picked !== null) {
    ctx.navigation.selectHunk(file.id, labels.indexOf(picked));
  }
});
```

Hunk draws the dialog, not you: your text fills the title, body, and choices, and the frame carries an `ext <your-id>` attribution line — the same marker `notify` toasts use — so a prompt can never present itself as Hunk asking.

One dialog is on screen at a time. Concurrent requests queue in call order, across extensions too, so a second question waits its turn instead of replacing the first. While a dialog is up it owns the keyboard: Escape cancels (`false`, or `null`), Enter accepts — the confirm action, the highlighted option, or the typed text — and review shortcuts stay suppressed underneath. Confirm dialogs also answer to `y`/`n`, select dialogs to `↑`/`↓`, and every dialog's actions and rows are clickable.

Two things resolve a dialog without the user: the session moving on, and bad arguments. A session reload — the refresh key, a watch-triggered reload, an agent command — cancels open and queued dialogs, since the review they asked about is being replaced; a dialog pending at shutdown resolves its cancel value the same way, and a request made after that point cancels immediately. A blank `title`, or a `select` with no options, is a bug in the extension rather than an answer from the user, so the promise **rejects**; like any other handler failure, that surfaces as a warning naming your extension.

## `hunk.on(event, handler)`

Subscribe to a lifecycle or UI event. Handlers may be async; Hunk never blocks the UI waiting for one. Alongside `cwd` and `notify`, every handler receives `ctx.sidebars`, the same open/close/toggle controls command handlers receive. That means a `changeset_loaded` handler can reveal its extension's sidebar when it finds something worth showing — no keypress required.

| Event                  | Payload                 | When                                                     |
| ---------------------- | ----------------------- | -------------------------------------------------------- |
| `startup`              | `{ cwd }`               | once, after the app mounts with its first changeset      |
| `changeset_loaded`     | `{ changeset }`         | first load and every reload                              |
| `selection_changed`    | `{ fileId, hunkIndex }` | when the review selection settles (debounced ~150ms)     |
| `file_viewed`          | `{ file, hunkIndex }`   | when selection settles on a file or a reload replaces it |
| `filter_changed`       | `{ filter }`            | whenever the file-filter query changes                   |
| `theme_changed`        | `{ themeId }`           | when the user commits a new theme                        |
| `layout_changed`       | `{ mode, layout }`      | mode or responsive split/stack layout changes            |
| `watch_reload_pending` | `{}`                    | watcher observed a change before its reload check        |
| `note_created`         | `{ note }`              | a user saves an inline review note                       |
| `note_edited`          | `{ note }`              | an in-progress inline note's body changes                |
| `session_reload`       | `{ changeset, reason }` | on every session reload                                  |
| `shutdown`             | `{}`                    | on exit, best-effort within a short timeout              |

`selection_changed` is trailing-debounced on purpose: holding `[`/`]` retargets the selection many times a second, and handlers only care where the user landed. `fileId` and `hunkIndex` are `null` when nothing is selected.

`session_reload`'s `reason` is `"watch"` (the watcher saw the source change), `"daemon"` (an agent command through the session broker), or `"manual"` (the refresh key, or the reload after granting extension trust).

`note_created` and `note_edited` cover notes authored in Hunk's own UI, in this session. Review notes are session-local state, so there is no backlog to replay on startup — but comments added through agent session commands do not emit these events, and a `session_reload` may remap or drop notes without one either. A list accumulated from these events is therefore "notes the user saved here this session", not a complete review record; present it as such.

`shutdown` handlers get a short window (250ms) to finish before Hunk exits anyway, so treat it as best-effort flushing rather than guaranteed cleanup.

## `hunk.events`

`hunk.events` is a small bus shared by every loaded extension. Use it to coordinate extensions without coupling them through a command or global state. Names are open-ended, so namespace them with your extension id. Listeners get the same `ctx.sidebars` controls as lifecycle handlers; delivery is fire-and-forget and one listener's failure is reported without stopping the others. Events an extension emits while factories are loading are queued until every extension has had a chance to subscribe.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.events.on<{ fileCount: number }>("summary:ready", (payload, ctx) => {
    if (payload.fileCount > 100) ctx.sidebars.open("summary");
  });

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    hunk.events.emit("summary:ready", { fileCount: changeset.files.length });
    ctx.sidebars.open("summary");
  });
}
```

Bus payloads are shallow-frozen copies when they are objects. Keep nested data immutable if multiple extensions will read it.

## `hunk.config`

Your extension's own `[extension.<id>]` config table, as a plain object. Hunk does not interpret the keys — unknown keys pass straight through — and repo config overrides user config key by key.

**Treat these values as untrusted.** Tables merge by extension id with no notion of where the extension was installed from, so a repository under review can set or override configuration for an extension you installed globally. That is deliberate — repo-level tuning of a shared extension is a normal team workflow, and Hunk shows a startup notice listing the extension ids a repo configures — but it means `hunk.config` must never be trusted for exec-adjacent decisions such as binary paths, shell commands, or module loading. Validate those against something the user controls.

```toml
# ~/.config/hunk/config.toml
[extension.collapse-generated]
patterns = ["*.lock", "dist/**"]
```

```ts
const patterns = (hunk.config.patterns as string[] | undefined) ?? ["*.lock"];
```

## `ctx.notify(message, type?)`

Every handler and transform receives a context object with `cwd` and `notify`. Event and bus handlers additionally receive `sidebars` and `events.emit`; command handlers receive `sidebars`, `selection`, `navigation`, and `dialogs`. `notify` shows a single unobtrusive line at the bottom of the app that clears itself after a few seconds; queued messages appear in turn. `type` is `"info"` (default), `"warning"`, or `"error"`, which selects the color. Notifications raised before the UI has mounted are buffered and flushed once it does, so a `startup` handler can notify safely.

## `hunk.log(message)`

Record a diagnostic line. Logs are collected per extension rather than written to the terminal, because the TUI owns the screen.

## Not contributable yet

Menu entries, standalone keybindings (a chord contributed without a command — commands registered through `registerCommand` **are** already user-remappable via `[keybindings]`), custom note renderers, session commands, and CLI subcommands are not contributable yet. Commands and their default key bindings landed with `registerCommand` — the named-command registry the rest build on; see [`docs/extension-system-exploration.md`](https://github.com/modem-dev/hunk/blob/main/docs/extension-system-exploration.md) for the design and phasing.

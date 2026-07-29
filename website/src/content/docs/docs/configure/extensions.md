---
title: Extensions
description: Load plain TypeScript extensions that contribute themes, VCS backends, changeset transforms, sidebars, and commands.
---

The extension API is experimental and may change in breaking ways between minor releases while it stabilizes; breaking changes are called out in release notes.

## Where extensions load from

Hunk loads plain TypeScript extensions from:

- `~/.config/hunk/extensions/` — your personal extensions
- a repository's `.hunk/extensions/` — only after you explicitly trust that repository
- `--extension <path>` — an entry file or directory, repeatable, for development

`--no-extensions` turns user extensions off for one run. Hunk's bundled backends (Git, Jujutsu, and Sapling) are themselves extensions and stay loaded either way.

Repository-declared extension code never runs without a trust prompt, and a failing extension is isolated rather than taking the review down.

## What an extension can do

An extension exports one default function receiving the API object. It can contribute themes and file-extension → language mappings, add a VCS backend, rewrite the changeset before review, replace the file-navigation sidebar with its own React component, register commands, react to lifecycle events, and show transient messages:

```ts
// ~/.config/hunk/extensions/collapse-lockfiles.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.transformChangeset((changeset, ctx) => {
    const files = changeset.files.filter((file) => !file.path.endsWith(".lock"));
    ctx.notify(`Collapsed ${changeset.files.length - files.length} lockfiles`);
    return { ...changeset, files };
  });
}
```

## Configure extensions

`[extensions]` controls loading, and each extension reads its own settings from an `[extension.<id>]` table that Hunk passes through untouched:

```toml
[extensions]
enabled = true
paths = ["~/dev/my-extension"]

[extension.my-extension]
verbose = true
```

Repository tables merge over user tables key by key, and Hunk names every extension whose settings a repository overrides. See the [config reference](/docs/reference/config/) for the exact keys.

## Full authoring guide

The complete API documentation — VCS adapter contracts, sidebar scrollbox rules, command registration, events, and a worked example — lives in [`docs/extensions.md`](https://github.com/modem-dev/hunk/blob/main/docs/extensions.md) in the repository, with the module-level architecture in [`docs/extension-architecture.md`](https://github.com/modem-dev/hunk/blob/main/docs/extension-architecture.md).

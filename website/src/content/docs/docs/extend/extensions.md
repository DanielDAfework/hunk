---
title: Extensions
description: Load plain TypeScript extensions, understand discovery and trust, and configure them.
---

A Hunk extension entry is one TypeScript (or JavaScript) file that default-exports a function. Hunk imports it at startup and hands it an API object. An entry may stand alone or be declared by a folder's optional `package.json` manifest; no build step is required.

```ts
// ~/.config/hunk/extensions/hello.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.on("startup", (_event, ctx) => {
    ctx.notify("Hello from my extension");
  });
}
```

**The extension API is experimental.** Everything documented here works today, but the `hunkdiff/extension` surface may change in breaking ways between minor releases while it stabilizes against real third-party extensions. Breaking changes are called out in release notes, and `hunk.apiVersion` identifies the surface an extension was written against.

What an extension can register is covered by the companion pages: the [extension API](/docs/extend/extension-api/) (themes, languages, changeset transforms, commands, events, dialogs), [VCS adapters](/docs/extend/vcs-adapters/), and [custom sidebars](/docs/extend/custom-sidebars/).

## Where Hunk looks for extensions

Discovery runs group by group, alphabetically by resolved path within each group — a folder extension's entries sort together, at the folder's own path. The first occurrence of a resolved path wins, so a path you pass explicitly keeps its origin even if the same file is also discovered somewhere else.

| Group | Source                                               | Trust                 |
| ----- | ---------------------------------------------------- | --------------------- |
| 1     | `--extension <path>` (repeatable)                    | runs immediately      |
| 2     | `[extensions] paths` in your user config             | runs immediately      |
| 3     | `~/.config/hunk/extensions/`                         | runs immediately      |
| 4     | `.hunk/extensions/` in the repo under review         | **prompts for trust** |
| 4     | `[extensions] paths` in the repo `.hunk/config.toml` | **prompts for trust** |

The two repo-local sources share a group number because they are one group: both are repo-controlled, so they share a trust decision and their paths are sorted together rather than one source being loaded ahead of the other.

A directory source matches `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mjs` directly inside it, plus one level of folder extensions, so a folder extension can keep helper modules beside its entry file.

### Folder extensions

A folder is an extension if it declares its entry files in a `package.json`, or failing that if it has an `index.{ts,tsx,js,jsx,mjs}` (in that preference order, so a folder shipping both a source and a built entry resolves the same everywhere). The manifest field is `hunk`:

```text
~/.config/hunk/extensions/my-ext/
  package.json          # {"hunk": {"extensions": ["./src/index.ts"]}}
  node_modules/         # bun install / npm install, right here
  src/
    index.ts            # the declared entry
    helper.ts
```

The manifest wins over the `index.*` fallback, and its paths resolve against the folder. It may list more than one entry, in which case each entry loads as its own extension in the order the manifest gives. Each one is identified by its file stem; when stems collide, later entries receive a numeric suffix while avoiding ids already claimed by other entries in the manifest.

Because the manifest is a real `package.json`, a folder extension may depend on npm packages: declare them, install them into the folder's own `node_modules`, and imports resolve from the entry file the way they do in any other package.

Pointing `--extension` or `[extensions] paths` straight at a directory works either way: a directory that is itself a folder extension loads as that one extension, so its helper modules stay helpers. A directory that is not is treated as a directory _of_ extensions and scanned with the patterns above.

### Extension ids

An extension's **id** is its file stem, or its folder name for `<name>/index.ts`. A manifest that declares a single entry also keeps the folder's name, whatever the entry file is called. The id is what `[extension.<id>]` config tables key off, so moving a single-file extension into a folder of the same name — or later giving that folder a manifest — keeps its config working.

The id is also the namespace your extension owns: its commands are `<id>.<commandId>` and its sidebar views `<id>:<viewId>`. So the id has to be spelled like a name — starting with a letter or digit, then letters, digits, `-`, or `_`. A dot or a colon would make those composed ids ambiguous, and `hunk`, `git`, `jj`, and `sl` are reserved for what Hunk ships. An extension whose id breaks a rule is skipped with a startup notice naming the file; rename it and it loads. If two discovery sources offer the same id, the first in source order loads and the other is skipped the same way, since one id cannot own two config tables.

### Explicit intent

`--no-extensions` disables user extensions for one run — nothing on disk is read, let alone executed. Use it when triaging a bug.

`--extension` is explicit user intent: the file loads immediately, with no trust prompt, even when the path points inside the repository under review. Never pass a path you have not read — including one copy-pasted from a repository's own README.

## Bundled extensions

Every VCS backend Hunk ships — **Git, Jujutsu, and Sapling** — is an extension, and so is the **built-in file-navigation sidebar**. They are compiled into the binary and register through the same `hunk.registerVcsAdapter` and `hunk.registerSidebarView` these pages document. There is no core-registered backend left, no private sidebar, and no private path into the review pipeline.

Git in particular is the reason: it is the backend that exercises every integration point there is — exact file sources, skipped-too-large placeholders, untracked files, watch plans, rich failures — so running it through the published API is what keeps that API honest. Anything Git can do, your adapter can do, because Git does it the same way you would.

Bundled extensions differ from yours in three ways, all of them consequences of being Hunk's own code:

- They are **statically imported**, so they load synchronously, before config resolution picks the session's VCS.
- They are **implicitly trusted**: no discovery, no trust prompt, and no `[extension.<id>]` config table.
- They stay loaded under `--no-extensions` and `[extensions] enabled = false`. Those switches exist to triage extensions _you_ installed; losing VCS support from a debugging flag would break every workflow there is.

Failure isolation still applies to them. The ids `git`, `jj`, and `sl` are reserved as a result, and so is `hunk`, the id the bundled sidebar and every built-in command are named under.

## Trust

Extensions run with your user permissions, exactly like a shell dotfile. That is fine for extensions you installed yourself, and not fine for extensions that came with a repository you are about to review — pointing a diff tool at unfamiliar code is a normal thing to do, and it must never execute that code.

So repo-local sources are gated. The first time Hunk finds extensions in a repository's `.hunk/extensions` (or repo-config `paths`), it skips them and asks:

```text
Run this repository's extensions?

  This repository contains extensions in .hunk/extensions.
  Extensions run with your user permissions.

  enter/t trust · esc not now · n never
```

- **Trust** records the decision and reloads the session so the repo's extensions take effect immediately.
- **Not now** (also `Esc`) dismisses without recording anything; you will be asked again next time.
- **Never** records a denial so Hunk stops offering.

Decisions are stored per repository root in `~/.config/hunk/state.json`. The prompt is a normal dialog over the review stream, not a gate in front of it: you can dismiss it and keep reviewing.

Trust is keyed by the repo root's **path**, not by the repository's identity — the same model VS Code workspace trust uses. If you delete a trusted checkout and a different repository later occupies that path, it inherits the decision. Clear the entry from `state.json` if that matters for a path you reuse.

## Failure isolation

A broken extension should not break review. An extension that fails to import, has no default export, or throws from its factory is skipped, its partial registrations are rolled back, and it becomes a startup notice in the footer. A handler or transform that throws later is reported as a warning naming the extension, and everything else keeps running. Event handlers receive frozen copies of the changeset, so accidental mutation throws inside the handler instead of corrupting the review.

This is crash containment, not a sandbox. Per-file `metadata` inside event payloads is shared with the renderer for performance and is not frozen, and an extension runs with your full user permissions — it can do anything your shell can. The containment protects you from bugs, not from code you should not have loaded in the first place.

## CLI flags and config

```bash
hunk diff --extension ./path/to/entry.ts   # load one entry file (repeatable)
hunk diff --extension ./my-ext             # a folder extension: loads ./my-ext/index.ts
hunk diff --no-extensions                  # disable user extensions for this run
```

```toml
# ~/.config/hunk/config.toml or .hunk/config.toml
[extensions]
enabled = true                      # false disables loading for this layer
paths = ["~/dev/hunk-ext/index.ts"] # extra entry files or directories

[extension.my-extension]            # opaque payload handed to that extension
some_key = "some value"
```

`[extensions] enabled` layers like every other option: a repo `.hunk/config.toml` overrides your user config. `--no-extensions` is a hard off switch that no config layer can re-enable. Both govern **user** extensions only — Hunk's bundled Git, Jujutsu, and Sapling backends load either way. `[extensions] paths` from a repo config is trust-gated the same way `.hunk/extensions` is, because it is repo-controlled either way.

`[extension.<id>]` tables are handed to the matching extension uninterpreted, repo config merging over user config key by key; see [`hunk.config`](/docs/extend/extension-api/#hunkconfig) for the trust caveats that come with that.

## A complete example

Collapse lockfiles and generated output out of every review, and say how many files were hidden.

```ts
// ~/.config/hunk/extensions/collapse-generated.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Match one path against a `*`-only glob, anchored at both ends. */
function matchesPattern(path: string, pattern: string) {
  const source = pattern
    .split("*")
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

export default function (hunk: HunkExtensionAPI) {
  const patterns = (hunk.config.patterns as string[] | undefined) ?? [
    "*.lock",
    "*-lock.json",
    "dist/*",
  ];

  hunk.transformChangeset((changeset, ctx) => {
    const kept = changeset.files.filter(
      (file) => !patterns.some((pattern) => matchesPattern(file.path, pattern)),
    );

    const hidden = changeset.files.length - kept.length;
    if (hidden > 0) {
      ctx.notify(`Collapsed ${hidden} generated ${hidden === 1 ? "file" : "files"}`);
    }

    return { ...changeset, files: kept };
  });
}
```

Configure it without touching the code:

```toml
# .hunk/config.toml
[extension.collapse-generated]
patterns = ["*.lock", "bun.lockb", "generated/*"]
```

Try it against the working tree without installing it:

```bash
hunk diff --extension ./collapse-generated.ts
```

Continue with the [extension API](/docs/extend/extension-api/) for everything the API object offers.

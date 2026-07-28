---
"hunkdiff": minor
---

Extension command handlers receive the current review selection as `ctx.selection` — the selected file as a frozen read-only view plus its selected hunk index, captured when the command fires. A command that acts on what the user is looking at (copy this path, open this hunk elsewhere) no longer has to shadow-track the `selection_changed` event to know where the review is.

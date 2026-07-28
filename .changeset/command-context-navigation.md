---
"hunkdiff": minor
---

Extension command handlers can now navigate the review stream: `ctx.navigation.selectFile(fileId)` and `ctx.navigation.selectHunk(fileId, hunkIndex)` carry the same guarded navigation a custom sidebar's `actions` do — validated against the currently visible files, hunk indexes clamped, failures reported as warnings — routed through the same review controller, so a "jump to the next flagged hunk" command no longer needs a mounted sidebar to move the selection. Unlike `ctx.selection`, which stays a snapshot from when the key fired, `navigation` is live: a handler that awaits a dialog and then navigates acts on the review as it is now.

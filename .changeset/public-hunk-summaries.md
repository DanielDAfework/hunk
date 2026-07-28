---
"hunkdiff": minor
---

The extension API now exposes public hunk summaries: every read-only file view Hunk hands outward (event payloads, sidebar props, a command's selection) carries a `hunks` list of `ExtensionDiffHunk` records — `index`, the `@@` header, and inclusive old/new line spans, in render order. The index is the same one `selectedHunkIndex` reports and `actions.selectHunk` accepts, so hunk checklists, per-hunk progress views, and agent-annotation navigators no longer need to cast into the opaque `metadata`. The summaries derive through the same helper the agent session surface reports hunks with, so the two external views of a review cannot drift apart.

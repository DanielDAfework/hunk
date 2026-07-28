---
"hunkdiff": minor
---

Extension command handlers can ask the user a question through `ctx.dialogs`: `confirm` for a yes/no prompt, `select` for a list of choices, and `input` for a line of text, each returning a promise that resolves the answer (or a cancel value on Escape). Hunk draws the modal itself and labels it with the extension that raised it, one dialog shows at a time with concurrent requests queued in call order, and a dialog still pending when the review goes away resolves as cancelled instead of leaving a handler waiting.

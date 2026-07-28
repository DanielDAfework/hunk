---
"hunkdiff": patch
---

Extension discovery now recognizes `.tsx` and `.jsx` entry files everywhere `.ts` entries are found — standalone files in an extensions directory and `index.tsx`/`index.jsx` folder fallbacks — matching what the runtime loader already supported. A TSX sidebar extension no longer needs a `package.json` manifest just to name its entry file. The authoring guide also gains a recipe for feeding lifecycle-event state into sidebar components, documents the pane width/height contract, qualifies exactly which notes the `note_created`/`note_edited` events report, and fixes the "not contributable yet" list to say standalone keybindings rather than contradicting the remappable-command docs.

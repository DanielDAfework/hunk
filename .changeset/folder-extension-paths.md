---
"hunkdiff": patch
---

Pointing `--extension` or `[extensions] paths` at a directory that contains an `index.ts`/`index.js`/`index.mjs` now loads it as a single folder extension instead of scanning every file inside it as separate extensions.

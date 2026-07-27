---
"hunkdiff": patch
---

Folder extensions can now declare their entry points through a `package.json` `"hunk": { "extensions": [...] }` manifest, which takes precedence over the `index.*` fallback and lets an extension ship several entries and its own npm dependencies.

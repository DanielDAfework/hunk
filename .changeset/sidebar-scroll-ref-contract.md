---
"hunkdiff": patch
---

The extension authoring guide now documents the supported scrollbox ref contract for custom sidebars: hold a React ref to your `<scrollbox>`, give rows stable `id` props, and use `scrollChildIntoView` to follow the selection, with `scrollTop`/`viewport.height` and the scrollbar/viewport change events for pane geometry — the exact surface the built-in sidebar runs on, now committed as the supported way to scroll, follow, and window a third-party sidebar instead of being described as an unsupported gap.

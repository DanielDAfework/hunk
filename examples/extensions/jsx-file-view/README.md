# JSX file-view POC extension

An opt-in proof of concept for fixed-height React/OpenTUI rows in alternate file presentations. It appears only for files with at least two parsed hunks and creates two custom rows per hunk, with stable row IDs and explicit hunk bounds.

Run it from this checkout against a multi-hunk working-tree change:

```bash
bun run src/main.tsx -- diff --extension ./examples/extensions/jsx-file-view
```

Choose **Extensions → Toggle JSX hunk cards (POC)**. The row component uses a React state hook and OpenTUI `box`/`text` elements. Clicking a card toggles its local detail when mouse delivery is available. Each component is a closure over the hunk summary; Hunk passes it only bounded paint props. The `spans` on every row are the host-rendered fallback.

This example is deliberately opt-in and experimental. See [`docs/file-view-jsx-poc.md`](../../../docs/file-view-jsx-poc.md) for constraints.

# Fixed-height JSX file-view rows (POC)

This worktree experiments with one constrained escape hatch in the symbolic file-view contract. A validated row may pair a fixed integer `height` with a React function `component`. Hunk mounts that component as a real React/OpenTUI element while keeping the normal review-stream layout declarative and host-owned. Like all Hunk extensions, this is a cooperative trusted-code contract rather than a sandbox.

## Contract

- Layout still happens before paint and supplies stable row IDs plus one inclusive row range for every parsed hunk.
- Every custom row must retain symbolic `spans`. They are rendered if the component fails, and symbolic-only layouts continue through the existing renderer unchanged.
- A component row must declare both `component` and `height`. The component must be a function, one row is limited to 256 terminal lines, and all component rows in a layout are limited to 100,000 lines. Existing row/span/text limits still apply. An invalid layout falls back to raw diff.
- Hunk passes only `width`, fixed `height`, `selected`, and zero-based `rowIndex`. A per-row closure can capture arbitrary parsed or semantic data without adding an opaque payload to the host contract.
- Hunk mounts the component inside a fixed `height`/`minHeight`/`maxHeight`, `flexShrink: 0`, overflow-hidden wrapper. No post-mount measurement feeds back into geometry. Stable IDs, hunk bounds, selection, scrolling, and row windowing remain host-owned.

## Deliberate limits

- **Windowing unmounts state.** A component outside the host row window is unmounted. Hook state is local paint state, not durable review state.
- **Component resizing is ignored.** Content that asks for a different size is clipped to the declared row height. There is no resize callback or measurement pass.
- **Focus and mouse are not guaranteed.** Custom rows may receive OpenTUI events when normal routing permits, but this POC makes no focus, keyboard, or mouse-delivery contract. Cooperative components leave primary review navigation host-owned.
- **Inline notes force raw diff.** Existing availability policy still disables alternate file views whenever host-owned inline note placement needs raw rows.
- **Error containment is row-local only.** Synchronous render/lifecycle errors caught by React's row boundary replace that component with its symbolic spans. Event-handler and asynchronous errors are outside React error-boundary containment. There is no extension-facing error callback in this POC.
- **Clipping is not a security boundary.** Ordinary descendants cannot expand their host row, but the host-served OpenTUI module still exposes global capabilities such as portals, renderer access, and keyboard hooks. A malicious or careless extension can escape normal row composition just as other trusted TypeScript extensions can affect their process. The POC proves geometry preservation for cooperative components, not enforceable containment of arbitrary code.
- Cooperative custom rows cannot replace the file section, control outer flex layout, request post-mount geometry changes, or bypass the host's raw fallback and resource validation through normal descendant rendering.

See `examples/extensions/jsx-file-view/` for an opt-in hook-using, multi-hunk example.

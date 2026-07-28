---
"hunkdiff": patch
---

Fix Nix flake evaluation on Nixpkgs 26.11, which dropped `x86_64-darwin`. Hunk's flake no longer declares that system, and it now pins bun2nix's `systems` input to the same list so building the `aarch64-darwin` package never forces an Intel macOS Nixpkgs. The system list is exposed as a `systems` flake input for consumers that need to override it.

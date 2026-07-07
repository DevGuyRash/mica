# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- In-vault runtime verification: load Mica in the live vault and exercise all three modes, inline editing, snapshot/diff/revert, migration, and the file-bridge. Everything under `crates/` and `src/` builds, typechecks, lints, and passes `cargo test` + `pnpm smoke`, but has not yet been driven inside a running Obsidian.

## Remaining polish (by area)

- **Migration**: currently does structural tabs→mica conversion + snapshots v1. Still to do: import each `[!bug]-` / `[!todo]-` archived callout as a _prior_ version, plus a dry-run + rollback command.
- **Live Preview editing**: upgrade the textarea inline editor to `EmbeddableMarkdownEditor` (markdown rendering while editing) inside a persistent atomic widget (vs today's reveal-on-overlap).
- **Perf**: incremental block-level reparse so typing inside a block triggers 0 WASM scans (today: one scan per document change, cached across cursor moves). Then the zero-copy typed-array boundary (today: `serde-wasm-bindgen` structured clone).
- **Settings UI**: autosave/debounce, snapshot cadence, sidecar visibility, default diff granularity/edit mode, theming presets.
- **Tests/CI**: a TS test runner + GitHub Actions (build wasm, cargo test, tsc, eslint, smoke).

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch`, not `amend`.

## Risks to watch

- `EmbeddableMarkdownEditor` is a semi-internal Obsidian API — isolate behind an adapter with the current plain-textarea fallback.
- Live Preview widget interactivity vs Obsidian revealing source when upgrading from reveal-on-overlap to `atomicRanges`.

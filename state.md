# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- M2 — three-mode rendering + corruption-proof editing: reading-view code-block processor, Live Preview CM6 atomic widget hosting `EmbeddableMarkdownEditor`, transaction-based `EditBridge`, shared `LayoutEngine`. Exit: the append-bug regression test (grow content past old bounds → clean replace).

## Next

- M3 — identity (`mica-id` frontmatter) + visible sidecar CAS + `ledger.jsonl` + change-gated snapshot-on-save + revert/edit-in-place.

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch`, not `amend`.

## Risks to watch

- `EmbeddableMarkdownEditor` is a semi-internal Obsidian API — isolate behind an adapter with a plain-CM6 fallback (M2).
- Live Preview widget staying interactive under `atomicRanges` without Obsidian revealing source (M2).
- WASM boundary currently uses `serde-wasm-bindgen` (structured clone), not yet the zero-copy typed-array path — deferred perf optimization (M8).

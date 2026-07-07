# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- M3 — identity (`mica-id` frontmatter) + visible sidecar CAS + `ledger.jsonl` + change-gated snapshot-on-save + revert/edit-in-place.

## Next

- M4 — diff engine (`similar` → wasm): char/word/line + inline emphasis + patches; N-way vs swappable base; the 5 diff UI modes.

## Deferred (revisit at the noted milestone)

- M5 upgrades Live Preview from the current reveal-on-overlap widget to a persistent atomic widget with true inline per-tab editing (`EmbeddableMarkdownEditor`). The corruption-proof `block_content_edit` is already in the core, unused by the UI until then.
- In-Obsidian runtime verification of the M2 renderer/widget is pending (built + typechecked + bundled; not yet loaded in a live vault here).

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch`, not `amend`.

## Risks to watch

- `EmbeddableMarkdownEditor` is a semi-internal Obsidian API — isolate behind an adapter with a plain-CM6 fallback (M5).
- Live Preview widget staying interactive under `atomicRanges` without Obsidian revealing source (M5).
- WASM boundary currently uses `serde-wasm-bindgen` (structured clone), not yet the zero-copy typed-array path — deferred perf optimization (M8).

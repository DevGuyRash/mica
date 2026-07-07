# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- M1 — pushdown fence scanner + SoA CST + serializer with a byte-exact round-trip on the real 701 KB note; wire `WasmBridge` to instantiate the inlined binary and expose `scan`/`parse_block`. Verify `new_id()` (uuid v7) works at runtime on wasm, not just at compile time.

## Next

- M2 — three-mode rendering + corruption-proof editing (CM6 atomic widget + `EmbeddableMarkdownEditor` + transaction-based `EditBridge`).

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch`, not `amend`.

## Risks to watch

- `EmbeddableMarkdownEditor` is a semi-internal Obsidian API — isolate behind an adapter with a plain-CM6 fallback (M2).
- Live Preview widget staying interactive under `atomicRanges` without Obsidian revealing source (M2).
- WASM build: confirm `uuid` v7 + `blake3` compile clean on `wasm32-unknown-unknown` (getrandom `js`).

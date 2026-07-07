# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- M7 — scriptable API (`window.mica`) + command palette + inbox/outbox file-bridge for agents.

## Next

- M8 — migration (tabs→mica + archive-as-history), perf hardening, polish. Then in-vault runtime verification.

## Deferred (revisit at the noted milestone)

- Inline per-tab editing now works via a plain textarea inside the reveal-on-overlap widget (corruption-proof). A richer inline editor (`EmbeddableMarkdownEditor`, markdown rendering while editing) and a persistent atomic widget remain a polish upgrade.
- In-Obsidian runtime verification of the M2 renderer/widget is pending (built + typechecked + bundled; not yet loaded in a live vault here).

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch`, not `amend`.

## Risks to watch

- `EmbeddableMarkdownEditor` is a semi-internal Obsidian API — isolate behind an adapter with a plain-CM6 fallback (M5).
- Live Preview widget staying interactive under `atomicRanges` without Obsidian revealing source (M5).
- WASM boundary currently uses `serde-wasm-bindgen` (structured clone), not yet the zero-copy typed-array path — deferred perf optimization (M8).

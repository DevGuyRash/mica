# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- Daily-driver validation in the real vault (v0.1.0): enable Mica, run **Migrate tabs → Mica (dry run, whole vault)**, review the console report, migrate one real prompt note, and live with tabs/chip/diff for a few sessions. Everything automated is green (54 Rust tests, Node smoke, strict gate, 8 e2e specs in a real Obsidian); lived-in feel is the remaining unknown.

## Remaining scope

- **Live Preview editor**: upgrade the textarea to `EmbeddableMarkdownEditor` (semi-internal API — adapter + keep the textarea fallback); optional `atomicRanges` persistent widget.
- **Versioning UX**: lineage view (parent chains exist in the ledger; no UI walks them yet); live gutter diff vs head while typing (the chip's dirty dot covers the signal today).
- **Reconciliation**: duplicate-note-anchor and merge-divergence conflict cases (orphan/duplicate-block cases + startup reconcile ship today).
- **Storage polish**: derived `state.json` cache and `.graveyard/` for detached histories; register `.mica/` objects in Obsidian's Excluded files (manual setting today).
- **Perf (deferred by measurement)**: incremental block-level reparse and the zero-copy typed-array boundary — current full-doc scan is ~0.7 ms on the real 711 KB note, cached across cursor moves.
- **Distribution**: community-plugin submission checklist (repo URL in manifest, release artifacts) when ready to publish.

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch` (parent recorded); no in-place amend.

## Risks to watch

- Obsidian Sync racing a `ledger.jsonl` append mid-write is reasoned-safe (append-only + order-independent fold) but not reproduced under real Sync.
- `EmbeddableMarkdownEditor` is semi-internal and has broken before (Obsidian 1.5.8) — adapter + fallback required when adopted.
- The official Obsidian CLI test tier (`just e2e-cli`) is unexercised until the local app ships/activates the CLI.

# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- Daily-driver validation in the real vault (v0.1.0): enable Mica, run **Migrate tabs → Mica (dry run, whole vault)**, review the console report, migrate one real prompt note, and live with the inline editor / structure affordances / smart auto-save for a few sessions. The automated gate (Rust tests, Node smoke, strict typecheck+lint, e2e in a real Obsidian) is green; lived-in feel is the remaining unknown.

## Remaining scope

- **Storage efficiency (COW without a delta chain)**: zstd-compress sidecar objects — hash stays over the _plaintext_ so identity/dedup are unchanged (~3–5× on markdown, zero brittleness); the easy first win. Later, only if measurement shows large heavily-versioned blocks: content-defined chunking (rolling-hash boundaries) so a version becomes a manifest of chunk hashes with real intra-version dedup, GC-by-reachability into `.graveyard/`. Keep immutable content-addressing + append-only ledger — do NOT adopt a predecessor-referencing delta chain (breaks Sync-safety, brittle if a link is lost).
- **Live Preview editor**: the inline region editor is a plain `<textarea>`; optional upgrade to `EmbeddableMarkdownEditor` (semi-internal API — adapter + keep the textarea fallback) for live markdown affordances while editing a region.
- **Deferred editing niceties**: dragging whole nested groups (a tabs group into a cell, or out to the root) — tab/cell reorder and same-kind cross-group moves ship today, but group-level drag does not; inserting prose _between_ two nested containers (today a ghost region only appears when a container has no prose at all); a contextual insert inside grid cells.
- **Versioning UX**: lineage view (parent chains exist in the ledger; no UI walks them yet); live gutter diff vs head while typing (the chip's dirty dot covers the signal today).
- **Reconciliation**: duplicate-note-anchor and merge-divergence conflict cases (orphan/duplicate-block cases + startup reconcile ship today).
- **Storage polish**: derived `state.json` cache and `.graveyard/` for detached histories; register `.mica/` objects in Obsidian's Excluded files (manual setting today).
- **Perf (deferred by measurement)**: incremental block-level reparse and the zero-copy typed-array boundary — the current full-doc scan is cached across cursor moves and fast on the real 711 KB note.
- **Distribution**: community-plugin submission checklist (repo URL in manifest, release artifacts) when ready to publish.

## Confirmed defaults (revisit only if needed)

- Authoring syntax: friendly closer-free `tab:` delimiters (primary); `:::` colon-fence directives for grids and nesting. Migration emits the `tab:` form.
- Editing model: inline click-to-edit content **regions** (a region edits only its prose, never structural directives); structure is manipulated directly (hover ×/rename on tabs, + to insert a tab/cell where you're focused, a grid column stepper, contextual "+ Tabs / + Grid"). New structures are created empty.
- Auto-snapshot: smart — gated on a **content signature** (trimmed, order-independent leaf text), so adding empty tabs/cells, reordering, and renaming never mint a version; only real prose changes do. Per-session green/red toggle + interval live in each block's footer; default interval 5 s; master switch `autoSnapshotEnabled`.
- Block ids are auto-stamped on edit (setting `autoAddIds`, default on).
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch` (parent recorded); no in-place amend.
- Appearance is **one-accent-driven**: `--mica-accent` retints chrome/borders/chip via `color-mix`; themes are `body.mica-theme-*` classes that only set that accent, density/tab-style are `data-` attrs, per-item settings write inline CSS vars that win over the preset. Add a theme = add a class + a `MICA_THEMES` entry; do not spread per-element colors.

## Risks to watch

- Obsidian Sync racing a `ledger.jsonl` append mid-write is reasoned-safe (append-only + order-independent fold) but not reproduced under real Sync.
- `EmbeddableMarkdownEditor` is semi-internal and has broken before (Obsidian 1.5.8) — adapter + fallback required when adopted.
- The virtualized reading view renders nothing under headless Xvfb; reading-mode e2e coverage therefore drives the code-block processor via `MarkdownRenderer.render` rather than the live preview. The official Obsidian CLI test tier (`just e2e-cli`) is likewise unexercised until the local app ships/activates the CLI.
- `color-mix` on always-visible chrome hangs CDP screenshot capture under Xvfb (software compositing) — so appearance is validated by **computed styles** (the 20-ui theming canary), not pixels. Any future visual-diff tier needs a real GPU/display; use `preview.html` for human eyeballing meanwhile.

# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- User-side validation in the real vault: enable Mica, run the dry-run migration on one real prompt note, exercise tabs/versioning/diff day-to-day. The full automated stack is green (51 Rust tests, Node smoke, typecheck/lint, 7 e2e specs in a downloaded real Obsidian), but daily-driver feel is unproven.

## Remaining scope (by area, post-audit)

- **Migration**: import `[!bug]-` / `[!todo]-` archived callouts as _prior_ versions (today: structural convert + whole-note backup object + v1 snapshot); bulk vault-wide migration with a report; `migrate.*` verbs on the API.
- **Versioning UX**: edit-a-previous-version-in-place (branch default / amend explicit), lineage view, live gutter diff vs last snapshot, per-block version chip.
- **Diff**: N-up (≤3 columns vs base) view and a patch _view_ mode (engine + swap-base + copy-patch exist).
- **Live Preview**: upgrade the textarea to `EmbeddableMarkdownEditor` (semi-internal API — keep the textarea fallback); optional `atomicRanges` for a persistent widget.
- **Reconciliation**: duplicate-note-anchor and merge-divergence cases (orphan-sidecar / orphan-block / duplicate-block ship today); reconcile pass on load.
- **Storage polish**: sidecar `manifest.json` + derived `state.json` + `.graveyard/`; register `.mica/` objects in Obsidian's Excluded files to keep search/graph clean.
- **Settings UI**: snapshot debounce, default diff granularity/mode, sidecar location, theming presets (CSS vars exist).
- **Perf (deferred by measurement)**: full-doc scan is ~0.7 ms on the real 711 KB note, cached across cursor moves; incremental reparse + zero-copy typed-array boundary remain future wins, not current pain.
- **CI**: GitHub Actions running the four tiers (cargo, smoke, gate, wdio e2e under xvfb).

## Confirmed defaults (revisit only if needed)

- Authoring syntax: colon-fence directives inside a ` ```mica ` fence.
- `mica-id` is a separate frontmatter field from the existing `uuid`.
- Edit-a-previous-version defaults to `branch`, not `amend`.

## Risks to watch

- Obsidian Sync racing a `ledger.jsonl` append mid-write is reasoned-safe (append-only + order-independent fold) but not reproduced under real Sync.
- `EmbeddableMarkdownEditor` is semi-internal and has broken before (Obsidian 1.5.8) — adapter + fallback required when adopted.
- The official Obsidian CLI test tier (`just e2e-cli`) is unexercised until the local app ships/activates the CLI.

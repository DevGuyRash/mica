# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- **Daily-driver validation of the v0.2 rebuild** in the real vault: live with the
  quick editor / lightbox / pointer DnD (now incl. per-callout region drags) /
  versions timeline / block header for a few sessions. The automated gate
  (179 Rust tests incl. CLI end-to-end, Node smoke, strict typecheck+lint+clippy,
  40 e2e tests incl. DnD stress + feature suites in a real Obsidian) is green;
  lived-in feel is the remaining unknown.
- **Callout-split signature churn (one-time)**: the parser now gives callouts
  their own leaf, so the content signature of blocks containing callouts changes
  once — expect a single spurious auto-snapshot per such block on first edit.
- **Commits are unsigned** (1Password SSH signer was unavailable to the autonomous
  session). Re-sign with: `git rebase --exec 'git commit --amend --no-edit -S' 65a1e9e`.
- **Obsidian CLI socket fragility**: any `obsidian <cmd>` invocation while the app
  is booting spawns a second instance that unlinks `$XDG_RUNTIME_DIR/<obsidian-ipc-endpoint>`;
  a stale file also blocks the next bind (EADDRINUSE). Recovery that works:
  `rm -f` the socket file, SIGTERM the electron main pid, relaunch detached
  (`setsid /usr/bin/obsidian`), wait ≥15 s with NO obsidian invocations, then use.
  `obsidian eval` cannot await promises and console.log does not come back — chain
  `.then(r => app.vault.adapter.write("out.json", …))` and read the file instead.

- **e2e pointer-timing flakiness**: two dnd-stress tests (below-sibling
  indicator probe, spring-loading) each failed once across three otherwise
  green full runs — pointer-event timing under Xvfb. If it recurs, bump the
  30ms settle waits or gate the indicator probe behind a waitUntil.

## Remaining scope

- **Mobile pass**: the new chrome degrades via CSS but has had no dedicated
  touch/small-screen tuning (drag handles, hover-revealed affordances need
  touch equivalents beyond long-press-free pointerdown).
- **Fold persistence**: folds are session-state (per-block UI store). If users
  want folds to survive restarts, persist keys into fence attrs or data.json.
- **Cell-level collapse**: deliberately skipped (a folded cell buys nothing in
  a shared grid row) — section/group folds only.
- **Versions modal**: n-up compare view exists in diffView but has no UI entry
  point; consider a "compare many" affordance if timeline use demands it.
- **Bundle diet (deferred decisions)**: ~188 KB of main.js is the
  lang-markdown → lang-html → lezer JS/CSS chain (code-block highlighting in
  the editors) — dropping nested-language highlighting would tree-shake most
  of it; `wasm-opt = ["-Oz"]` in mica-core Cargo.toml buys another ~0.9%.
- **engine.ts `debouncers` map**: one entry per file path ever modified,
  cleared only on settings change — small, but prune on file rename/delete
  when touching that area next.
- **Navigator drag**: the block navigator lists/jumps; dragging rows to reorder
  from the tree is designed but not wired.
- **Storage efficiency (COW without a delta chain)**: zstd-compress sidecar
  objects — hash stays over the plaintext; later, content-defined chunking only
  if measurement demands. Keep immutable content-addressing + append-only ledger.
- **Reconciliation**: duplicate-note-anchor and merge-divergence conflict cases
  (orphan/duplicate + startup reconcile + CLI repair/doctor ship today).
- **Storage polish**: derived `state.json` cache and `.graveyard/`; register
  `.mica/` objects in Obsidian's Excluded files automatically.
- **Perf (deferred by measurement)**: incremental block-level reparse; zero-copy
  typed-array boundary. Full-doc scan is cached and fast on the real 711 KB note.
- **Distribution**: community-plugin submission checklist; consider packaging the
  CLI (cargo-dist / AUR) when the plugin ships.
- **CLI `watch` + Obsidian both running**: both write the same sidecar safely
  (append-only, content-addressed) but double-snapshot timing hasn't been
  observed under a real editing session; watch is intended for Obsidian-closed use.

## Confirmed defaults (revisit only if needed)

- Authoring syntax: friendly closer-free `tab:` (primary); `:::` directives for
  grids/nesting. Moves conform node form automatically (friendly⇄directive).
- Editing model: click = quick CM6 editor; Ctrl/Cmd+click or Expand = lightbox;
  explicit save only (button / Ctrl+Enter); Esc double-tap discards; drafts live
  on the plugin keyed by block id. Blur NEVER commits.
- Destructive ops: pre-image + Undo toast, no confirm dialogs.
- Auto-snapshot: content-signature gated (in the Rust core, shared with the CLI);
  per-session toggle + interval in the version chip's context menu; default 5 s.
- Per-block appearance: fence-header attrs (`accent density tabstyle radius name`)
  written via `set_block_attr`; block-local CSS vars/data-attrs at render.
- One reducer: `mica-core::ops` serves the plugin (WASM `apply_op`) and the CLI.
  TS never mutates the CST directly.
- Ledger event set: add-version / set-head / label. Labels are edited via `label`
  events (never rewriting history). Old plugins skip unknown event lines safely
  (JSONL lines that fail to parse are ignored on read).

## Risks to watch

- Obsidian Sync racing a `ledger.jsonl` append mid-write is reasoned-safe
  (append-only + order-independent fold) but not reproduced under real Sync.
- The bundled `@codemirror/lang-markdown` must keep importing Obsidian's
  externalized `@codemirror/*`/`@lezer/*` instances (tag identity for
  highlighting). Pin bumps of those packages deserve a live-Obsidian check.
- The fixture theme's `slide-down` entrance animation never advances under the
  sandbox compositor, pinning `.view-content` a full pane-height off-screen — the
  `sandbox-motion` snippet disables that one animation; static hostile rules stay.
  Only hit-testing (elementFromPoint) ever noticed; keep the snippet enabled.
- The virtualized reading view renders nothing under headless Xvfb; reading-mode
  e2e drives the code-block processor directly. Appearance is validated by
  computed styles (color-mix hangs CDP screenshots under Xvfb) — use
  `preview.html` for human eyeballing.
- `typescript` is pinned ~5.9 (TS 7 breaks typescript-eslint); revisit when
  typescript-eslint supports it.

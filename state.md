# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- **Daily-driver validation of the v0.2 rebuild** in the real vault: live with the
  quick editor / lightbox / pointer DnD / versions timeline / block header for a
  few sessions. The automated gate (155 Rust tests incl. 14 CLI end-to-end, Node
  smoke, strict typecheck+lint+clippy, 24 e2e tests in a real Obsidian) is green;
  lived-in feel is the remaining unknown.
- **Commits are unsigned** (1Password SSH signer was unavailable to the autonomous
  session). Re-sign with: `git rebase --exec 'git commit --amend --no-edit -S' 65a1e9e`.
- **Obsidian CLI socket fragility**: any `obsidian <cmd>` invocation while the app
  is booting spawns a second instance that unlinks `$XDG_RUNTIME_DIR/<obsidian-ipc-endpoint>`;
  a stale file also blocks the next bind (EADDRINUSE). If `obsidian eval` reports
  "Unable to connect", remove the stale socket file and toggle Settings → Command
  line interface off/on (or restart the app once, without probing during boot).

## Remaining scope

- **Mobile pass**: the new chrome degrades via CSS but has had no dedicated
  touch/small-screen tuning (drag handles, hover-revealed affordances need
  touch equivalents beyond long-press-free pointerdown).
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
- The virtualized reading view renders nothing under headless Xvfb; reading-mode
  e2e drives the code-block processor directly. Appearance is validated by
  computed styles (color-mix hangs CDP screenshots under Xvfb) — use
  `preview.html` for human eyeballing.
- `typescript` is pinned ~5.9 (TS 7 breaks typescript-eslint); revisit when
  typescript-eslint supports it.

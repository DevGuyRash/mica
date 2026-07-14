# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- **Daily-driver validation of the v0.2 rebuild** in the real vault: live with
  the editors / pointer DnD / folds / versions timeline for a few sessions.
  The automated gate (182 Rust tests, Node smoke, strict
  typecheck+lint+clippy+fmt, 47 e2e in a real Obsidian) is green; lived-in
  feel is the remaining unknown.
- **Commits are unsigned** (1Password SSH signer needs interactive approval).
  Re-sign with: `git rebase --exec 'git commit --amend --no-edit -S' 65a1e9e`.
- **One-time signature churn**: blocks containing callouts get a single
  spurious auto-snapshot on first edit (the parser now splits callouts into
  their own leaves, which changed those blocks' content signatures once).

## Risks to watch

- Obsidian Sync racing a `ledger.jsonl` append mid-write is reasoned-safe
  (append-only + order-independent fold) but not reproduced under real Sync —
  one two-device test belongs on the release checklist (`RELEASING.md`).
- The bundled `@codemirror/lang-markdown` must keep importing Obsidian's
  externalized `@codemirror/*`/`@lezer/*` instances (tag identity for
  highlighting). Pin bumps of those packages deserve a live-Obsidian check.
- The fixture theme's `slide-down` entrance animation never advances under the
  sandbox compositor — the `sandbox-motion` snippet disables that one
  animation; keep it enabled (only elementFromPoint ever noticed).
- The virtualized reading view renders nothing under headless Xvfb;
  reading-mode e2e drives the code-block processor directly. Appearance is
  validated by computed styles — use `preview.html` for human eyeballing.
- `typescript` is pinned ~5.9 (TS 7 breaks typescript-eslint); revisit when
  typescript-eslint supports it.
- CLI `watch` + Obsidian running concurrently: double-snapshots are harmless
  (ledger dedups by content hash) but untested under a real editing session;
  watch is intended for Obsidian-closed use.

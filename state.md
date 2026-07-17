# Mica — State

Active, in-flight work only. Finished work lives in the docs or the code, not here.

## Now

- **Daily-driver validation of the v0.2 rebuild** in the real vault: live with
  the editors / pointer DnD / folds / versions timeline / grid boundary strips
  for a few sessions. The automated gate (Rust + Node smoke + strict
  typecheck/lint/clippy/fmt + full e2e in a real Obsidian) is green; lived-in
  feel is the remaining unknown.
- **Commits are unsigned** (1Password SSH signer needs interactive approval).
  Re-sign with: `git rebase --exec 'git commit --amend --no-edit -S' 65a1e9e`.
- **One-time signature churn**: blocks containing callouts or multi-paragraph
  prose get a single spurious auto-snapshot on first edit (the parser now
  splits callouts AND paragraphs into their own leaves; each split changed
  those blocks' content signatures once). Signatures are paragraph-normalized
  now, so further leaf-granularity changes cannot churn them again.

- **Deferred decision**: a keyboard path for the editor toolbar (tools are
  tabindex −1 by design; pickers are mouse-only). Everything else keyboard-
  reachable; decide whether toolbar hotkeys/tab-stops are worth it post-ship.
- **One-reducer exception to close**: `forkBlock` (src/identity/reconcile.ts)
  rewrites a duplicate block's `id=` by direct text replacement — the Rust
  edit surface rejects id changes, so TS had no guarded path. Add a fresh-scan
  `rewriteBlockId(oldId, occurrence, newId)` at the WASM boundary, then swap
  the splice. Same theme: blockShell's raw-source editor + Undo use
  `replaceAll` without an `expected` guard.

## Risks to watch

- The content signature joins sorted paragraph texts with a single space, so
  "a b" in one paragraph and "a" + "b" as two paragraphs collide (a join/split
  edit with identical words can miss one auto-snapshot). Pre-existing, rare,
  and only skips a snapshot — a fix means re-framing the digest (length-
  prefixed entries) and a full signature churn; defer until one is needed.
- Obsidian Sync racing a `ledger.jsonl` append mid-write is reasoned-safe
  (append-only + order-independent fold) but not reproduced under real Sync —
  one two-device test belongs on the release checklist (`RELEASING.md`).
- The bundled `@codemirror/lang-markdown` must keep importing Obsidian's
  externalized `@codemirror/*`/`@lezer/*` instances (tag identity for
  highlighting). Pin bumps of those packages deserve a live-Obsidian check.
- The fixture theme's `slide-down` entrance animation never advances under the
  sandbox compositor — the `sandbox-motion` snippet disables that one
  animation; keep it enabled (only elementFromPoint ever noticed).
- The "revealed raw source tints" e2e is load-sensitive: under heavy parallel
  CPU load the xvfb window loses focus (`document.hasFocus()` false) and
  Obsidian's own preview widget won't yield — diagnosed via the test's DIAG
  capture, not a product bug. Run the suite on a quiet machine.
- The virtualized reading view renders nothing under headless Xvfb;
  reading-mode e2e drives the code-block processor directly. Appearance is
  validated by computed styles — use `preview.html` for human eyeballing.
- `typescript` is pinned ~5.9 (TS 7 breaks typescript-eslint); revisit when
  typescript-eslint supports it.
- CLI `watch` + Obsidian running concurrently: double-snapshots are harmless
  (ledger dedups by content hash) but untested under a real editing session;
  watch is intended for Obsidian-closed use.

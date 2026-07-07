# Mica — Architecture

> Living document. How Mica is built. Pairs with `PRD.md` (what/why) and `DESIGN.md` (UX & syntax).

## Shape

Two halves over one shared **Rust → WASM** core. TypeScript owns everything the Obsidian API requires (plugin shell, CodeMirror 6, DOM, Vault I/O, API); Rust owns the CPU-bound cores (fence scanner + CST, diff, hashing, id minting).

```text
mica-core (Rust -> WASM)          TypeScript shell (Obsidian plugin)
  fence scanner + CST               WasmBridge (typed-array boundary)
  serializer + fence normalizer     Reading renderer (code-block processor)
  diff (similar)                    Live Preview widget (CM6 ViewPlugin/StateField)
  BLAKE3 hashing                    EditBridge (transaction-based edits)
  UUIDv7                            storage/sidecar, version engine, reconcile
                                    diff UI, scriptable API + file-bridge, migration
```

## Core principle: derive state, never cache it

Every correctness guarantee comes from one discipline repeated at three layers:

- **Editing.** Block boundaries live only in a CodeMirror `RangeSet` that is remapped through _every_ transaction. No line number is ever stored. Edits are `{from,to,insert}` change specs derived live — never a cached-coordinate overwrite. (That overwrite is exactly what corrupts `obsidian-tabs`.)
- **Versioning.** Current state is a fold over an append-only `ledger.jsonl`; version objects are immutable and content-addressed. Revert flips a pointer; nothing is rewritten.
- **Identity.** The note↔history link is derived by matching content-carried UUIDs, not paths — so it self-heals across renames and moves.

## Rust → WASM core

- A **pushdown line scanner** (a stack of `CodeFence{char,len}` / `ColonFence{len}` contexts) delimits blocks and layout directives in one O(bytes) pass — replacing backtick-counting. CommonMark rule: a fence of N chars closes only on ≥ N of the same char; nesting requires the outer fence strictly longer than every inner one, which the serializer guarantees on write.
- The parse result is a **Structure-of-Arrays CST**: flat parallel vectors (kind / parent / children / spans / subtree-hash) that are cache-friendly and cheap to ship to JS. Leaf content is opaque byte spans; Mica never parses markdown inline syntax.
- **Boundary.** Hot paths (`scan`, `parse_block`) exchange raw pointers + typed-array views over `wasm.memory.buffer` (zero-copy; strings decoded lazily). Low-frequency ops use `serde-wasm-bindgen`. WASM crossings are O(structural events), not O(keystrokes). The `.wasm` is inlined into `main.js` as a `Uint8Array` (esbuild `binary` loader) and instantiated once.

## Rendering (three modes)

- **Reading view.** `registerMarkdownCodeBlockProcessor("mica", …)` builds read-only interactive DOM; nested content renders by recursion via `MarkdownRenderer.render` under a `MarkdownRenderChild`.
- **Live Preview.** A `StateField` holds the block `RangeSet` and provides it to `EditorView.atomicRanges` (the cursor skips the block, so Obsidian never reveals raw source). A `ViewPlugin` builds `Decoration.replace({widget, block:true})` over `view.visibleRanges` only (virtualized), gated by `editorLivePreviewField`, at `Prec.highest`. `WidgetType.eq(id,hash)` reuses DOM. The widget hosts an `EmbeddableMarkdownEditor` (behind an adapter, since it is semi-internal).
- **Source mode.** Widgets off; raw fence text; byte-exact round-trip.

## Editing (corruption-proof)

A keystroke inside a tab emits a child delta → Mica reads the block's live range from the `StateField` (plus a boundary-verify that re-scans on mismatch) → dispatches `{changes}` to the parent view with a `micaInternal` annotation (no feedback loop). Positions are mapped by CodeMirror; corruption is impossible by construction.

## Storage & versioning

- Current version stays inline (portable plain markdown). History lives in a **visible, co-located** `<Note>.mica/` sidecar: content-addressed objects (`objects/b3-….mica.md`), an append-only `ledger.jsonl` (authoritative), a derived `state.json` cache, a `manifest.json`, and a `.graveyard/`.
- Visible (not hidden) because hidden dot-folders emit no Vault events — which would break self-healing — and visible files ride Obsidian Sync / obsidian-git and stay human-readable.
- Snapshot-on-save is change-gated by a BLAKE3 hash (no snapshot storms). Append-only + content-addressed ⇒ Sync/git see only additions ⇒ no history merge conflicts.

## Diff

The Rust `similar` crate provides char/word/line granularity, intra-line emphasis, grouped hunks, and unified patches. N-way compare = N pairwise diffs against a user-selectable base. The engine returns hunks/spans/patches; the TS side renders inline / side-by-side / N-up / swap-base / patch.

## Scriptable API

`window.mica` exposes UUID-addressed verbs (`block.*`, `version.*`, `migrate.*`, `repair`, `reconcile`), mirrored by palette commands and a file-bridge: an agent drops `{verb,args}` JSON in an inbox folder; `vault.on('create')` executes it and writes an outbox result — working on desktop, mobile, and over Sync with no server. An optional desktop loopback adds a real `mica` CLI.

## Build & distribution

pnpm + esbuild (bundle `src/main.ts` → `main.js`, CommonJS, externalizing `obsidian` / `electron` / `@codemirror/*`) + `wasm-pack` for the core. The dev repo lives at `~/repos/mica` and is symlinked into the vault's plugin folder for hot-reload testing; the vault repo is never polluted.

## Load-bearing files

`crates/mica-core/src/lib.rs`, `src/cm/micaViewPlugin.ts`, `src/cm/micaBlockWidget.ts`, `src/render/*`, `src/storage/sidecar.ts`, `src/version/engine.ts`, `src/identity/reconcile.ts`, `src/api/mica.ts`, `src/migrate/tabs.ts`.

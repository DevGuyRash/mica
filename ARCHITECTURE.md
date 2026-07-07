# Mica — Architecture

> Living document. How Mica is built. Pairs with `PRD.md` (what/why) and `DESIGN.md` (UX & syntax).

## Shape

Two halves over one shared **Rust → WASM** core. TypeScript owns everything the Obsidian API requires (plugin shell, CodeMirror 6, DOM, Vault I/O, API); Rust owns the CPU-bound cores (fence scanner + CST, diff, hashing, id minting).

```text
mica-core (Rust -> WASM)          TypeScript shell (Obsidian plugin)
  fence scanner + CST               WasmBridge (serde boundary)
  serializer + fence normalizer     Reading renderer (code-block processor)
  diff (similar)                    Live Preview widget (CM6 StateField)
  BLAKE3 hashing · UUIDv7           version engine + sidecar storage
  block edits · migration           reconcile, diff UI, window.mica + file-bridge
```

## Core principle: derive state, never cache it

Every correctness guarantee comes from one discipline repeated at three layers:

- **Editing.** Block boundaries are recomputed from a live scan at every decision point — render and write alike. No line number or node path is ever trusted after the document may have changed. Edits are `{from,to,insert}` change specs derived at dispatch time — never a cached-coordinate overwrite. (That overwrite is exactly what corrupts `obsidian-tabs`.)
- **Versioning.** Current state is a fold over an append-only `ledger.jsonl`; version objects are immutable and content-addressed. Revert flips a pointer; nothing is rewritten.
- **Identity.** The note↔history link is derived by matching content-carried UUIDs, not paths — so it self-heals across renames and moves.

## Rust → WASM core

- A **context-tracking line scanner** (`None` / inside-a-foreign-fence / inside-a-mica-block) delimits blocks in one O(bytes) pass — replacing backtick-counting. Per CommonMark, everything inside any fence is literal until that fence's closer, so a ` ```mica ` example _quoted_ inside a longer documentation fence is never treated as a real block. The serializer guarantees the outer fence is strictly longer than every inner one on write. Colon-fence directives (`:::tabs` / `:::tab` / `:::grid` / `:::cell`) are parsed _inside_ a block by a recursive descent that treats inner code fences as opaque.
- The parse result is a **CST of containers and opaque leaves**; every node stores its exact source strings, so `serialize(parse(x)) == x` byte-for-byte for unedited trees. Leaf content is never re-flowed; Mica parses structure, not markdown inline syntax.
- **Boundary.** All calls cross via `serde-wasm-bindgen` (structured clone) today; a zero-copy typed-array path is a planned optimization. A full-document scan of the real 711 KB note measures ~0.7 ms. Offsets crossing to CodeMirror are converted to UTF-16 in a single forward pass. The `.wasm` is inlined into `main.js` as a `Uint8Array` (esbuild `binary` loader) and instantiated once.

## Rendering (three modes)

- **Reading view.** `registerMarkdownCodeBlockProcessor("mica", …)` builds read-only interactive DOM; nested content renders by recursion via `MarkdownRenderer.render` under a `MarkdownRenderChild`.
- **Live Preview.** A `StateField<DecorationSet>` builds `Decoration.replace({widget, block:true})` for every closed block and provides it via `EditorView.decorations.from(field)`. This MUST be a StateField: CodeMirror rejects block-level/line-break-spanning decorations from view plugins at runtime ("Block decorations may not be specified via plugins") — a constraint verified the hard way in a live Obsidian. Reveal-on-overlap: a block whose range intersects the selection renders as raw source. Gated by `editorLivePreviewField`; ranges end at the closing fence line's end (never past its newline); `WidgetType.eq(id, content)` reuses DOM; the scan is cached per document text so cursor-only transactions skip WASM.
- **Source mode.** Widgets off; raw fence text; byte-exact round-trip.

## Editing (corruption-proof)

The Live Preview widget hosts a plain-textarea editor per tab (an `EmbeddableMarkdownEditor` upgrade is planned). Save re-scans the **live** document for the block by id, re-parses it, verifies the target tab's identity (name + title) — refusing to write if the block changed underneath the editor — swaps that tab's children in the CST, re-serializes, and dispatches a `{from,to,insert}` change whose bounds were recomputed at that instant. No cached offset or node path is ever trusted at write time.

## Storage & versioning

- Current version stays inline (portable plain markdown). History lives in a **visible, co-located** `<Note>.mica/` sidecar: content-addressed objects (`objects/b3-….mica.md`), an append-only `ledger.jsonl` (authoritative; folded in `(ts, eid)` order so Sync/git line-unions converge — `add-version` events may carry a `parent` hash for branch lineage), and a `manifest.json` summary (note anchor, path hint, block names) refreshed on snapshot. A derived `state.json` cache and `.graveyard/` remain planned (see `state.md`).
- Visible (not hidden) because hidden dot-folders emit no Vault events — which would break self-healing — and visible files ride Obsidian Sync / obsidian-git and stay human-readable.
- Snapshot-on-save is change-gated by a BLAKE3 hash (no snapshot storms). Append-only + content-addressed ⇒ Sync/git see only additions ⇒ no history merge conflicts.

## Diff

The Rust `similar` crate provides char/word/line granularity, intra-line emphasis, grouped hunks, and unified patches. N-way compare = N pairwise diffs against a user-selectable base. The engine returns hunks/spans/patches; the TS side renders inline / side-by-side / N-up / swap-base / patch.

## Scriptable API

`window.mica` exposes UUID-addressed verbs (`block.list/read/update`, `versions.list/snapshot/revert/diff/patch/edit`, `migrate.scan/run`, `prepare`, `repair`), mirrored by palette commands and a file-bridge: an agent drops `{verb,args}` JSON in `mica-bridge/inbox/`; the watcher (registered on `onLayoutReady` so old instructions never replay at vault load) executes it, **consumes the inbox file**, and writes `mica-bridge/outbox/<same-name>.json` — desktop, mobile, and over Sync with no server. Destructive verbs snapshot before writing. A desktop loopback CLI remains planned; the official Obsidian CLI tier (`tests/e2e-cli/run.sh`) covers shell-driven contract checks meanwhile.

## Build & distribution

pnpm + esbuild (bundle `src/main.ts` → `main.js`, CommonJS, externalizing `obsidian` / `electron` / `@codemirror/*`) + `wasm-pack` for the core. The dev repo lives at `~/repos/mica` and is symlinked into the vault's plugin folder for hot-reload testing; the vault repo is never polluted.

## Load-bearing files

Rust: `crates/mica-core/src/{scanner,parser,edit,versions,diff,reconcile,migrate}.rs` (+ `lib.rs` wasm exports). TS: `src/cm/micaLivePreview.ts`, `src/render/{layoutEngine,readingRenderer}.ts`, `src/storage/sidecar.ts`, `src/version/engine.ts`, `src/identity/{identity,reconcile}.ts`, `src/api/mica.ts`, `src/main.ts` (commands incl. migration).

## Testing tiers

1. `cargo test` — 51 unit/regression tests on the pure core (incl. the obsidian-tabs append-bug cases).
2. `pnpm smoke` — the WASM boundary end-to-end in Node (ids, hashing, scan/parse/serialize, migrate+edit+diff).
3. `just e2e` — wdio-obsidian-service: 7 contract + rendering specs inside a real downloaded Obsidian under Xvfb (this tier caught the CM6 block-decoration crash nothing offline could).
4. `just e2e-cli` — contract checks via the official Obsidian CLI against the running app; skips with instructions when the CLI isn't activated.

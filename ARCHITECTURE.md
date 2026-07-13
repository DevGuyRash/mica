# Mica — Architecture

> Living document. How Mica is built. Pairs with `PRD.md` (what/why) and `DESIGN.md` (UX & syntax).

## Shape

One pure Rust core, two hosts. The core owns everything exact: the fence
grammar, the CST, **every structural edit (the op reducer)**, the snapshot
change-gate, hashing, diffing, migration. It compiles to WASM for the Obsidian
plugin and natively for the standalone `mica` CLI — so a script and a click can
never disagree.

```text
crates/mica-core (pure Rust)         hosts
  fence scanner + CST                 TypeScript plugin (src/)
  serializer + fence normalizer         WasmBridge (serde boundary)
  ops reducer (apply_op)                block shell (header/tabs/grids/regions)
  snapshot gate (content signature)     CM6 editors (quick + lightbox) + toolbar
  ledger fold (+labels)                 pointer DnD engine
  diff (similar) · BLAKE3 · UUIDv7      versions timeline · settings · window.mica
  block edits · header attrs            file-bridge
  migration                           mica CLI (crates/mica-cli, native)
                                        vault discovery · sidecar I/O (byte-
                                        compatible) · watch daemon · doctor
```

## Core principle: derive state, never cache it

Every correctness guarantee comes from one discipline repeated at three layers:

- **Editing.** Block boundaries are recomputed from a live scan at every decision point — render and write alike. No line number or node path is ever trusted after the document may have changed. Edits are `{from,to,insert}` change specs derived at dispatch time — never a cached-coordinate overwrite. (That overwrite is exactly what corrupts `obsidian-tabs`.)
- **Versioning.** Current state is a fold over an append-only `ledger.jsonl`; version objects are immutable and content-addressed. Revert flips a pointer; nothing is rewritten.
- **Identity.** The note↔history link is derived by matching content-carried UUIDs, not paths — so it self-heals across renames and moves.

## Rust → WASM core

- A **context-tracking line scanner** (`None` / inside-a-foreign-fence / inside-a-mica-block) delimits blocks in one O(bytes) pass — replacing backtick-counting. Per CommonMark, everything inside any fence is literal until that fence's closer, so a ` ```mica ` example _quoted_ inside a longer documentation fence is never treated as a real block. The serializer guarantees the outer fence is strictly longer than every inner one on write. Inside a block, tabs use the friendly closer-free `tab:` delimiter (each `tab:` line auto-closes at the next one); colon-fence directives (`:::tabs` / `:::tab` / `:::grid` / `:::cell`) provide grids and explicit nesting. Both are parsed by one recursive descent that treats inner code fences as opaque and stores exact source strings, so every shape round-trips byte-for-byte.
- The parse result is a **CST of containers and opaque leaves**; every node stores its exact source strings, so `serialize(parse(x)) == x` byte-for-byte for unedited trees. Leaf content is never re-flowed; Mica parses structure, not markdown inline syntax.
- **Boundary.** All calls cross via `serde-wasm-bindgen` (structured clone) today; a zero-copy typed-array path is a planned optimization. A full-document scan of the real 711 KB note measures ~0.7 ms. Offsets crossing to CodeMirror are converted to UTF-16 in a single forward pass. The `.wasm` is inlined into `main.js` as a `Uint8Array` (esbuild `binary` loader) and instantiated once.

## Rendering (three modes)

- **Reading view.** `registerMarkdownCodeBlockProcessor("mica", …)` builds read-only interactive DOM; nested content renders by recursion via `MarkdownRenderer.render` under a `MarkdownRenderChild`.
- **Live Preview.** A `StateField<DecorationSet>` builds `Decoration.replace({widget, block:true})` for every closed block and provides it via `EditorView.decorations.from(field)`. This MUST be a StateField: CodeMirror rejects block-level/line-break-spanning decorations from view plugins at runtime ("Block decorations may not be specified via plugins") — a constraint verified the hard way in a live Obsidian. Reveal-on-overlap: a block whose range intersects the selection renders as raw source. Gated by `editorLivePreviewField`; ranges end at the closing fence line's end (never past its newline); `WidgetType.eq(id, content)` reuses DOM; the scan is cached per document text so cursor-only transactions skip WASM.
- **Source mode.** Widgets off; raw fence text; byte-exact round-trip.

## Editing (corruption-proof)

Every gesture becomes a `StructOp` applied by the **shared Rust reducer**
(`ops.rs::apply_op_impl`) — insertTab, renameTab, saveRegion, moveNode (tabs,
cells, and whole groups, with subtree-cycle rejection and automatic
friendly⇄directive form conformance so a move can never reparse into a
different structure), moveRegion (leaf runs — prose sections, callouts, code
blocks — relocated between group containers with same-parent re-indexing),
insertLeaf, duplicateNode, setTabAttr, setCols. The parser gives callouts
their own leaf (like code fences), so each is an independently draggable,
editable section. The host
re-scans the **live** document, applies the op to a fresh parse, and dispatches
one `{from,to,insert}` change whose bounds were recomputed at that instant.
`saveRegion` carries the region's expected text and is refused if the block
changed underneath the editor. No cached offset or node path is ever trusted
at write time.

The editors are CodeMirror 6 (`src/ui/mdEditor.ts`) — a compact quick editor
in place and a full lightbox — with an explicit save lifecycle: Save /
Ctrl+Enter commit, Esc double-taps to discard when dirty, and blur does
NOTHING. In-progress drafts live on the plugin keyed by block id, so widget
rebuilds and reading⇄editing flips reopen the editor with nothing lost.
Destructive ops capture a pre-image and offer an Undo toast instead of a
confirm dialog. Block ids are auto-stamped on the debounced save path
(setting-gated).

## Storage & versioning

- Current version stays inline (portable plain markdown). History lives in a **visible, co-located** `<Note>.mica/` sidecar: content-addressed objects (`objects/b3-….mica.md`), an append-only `ledger.jsonl` (authoritative; folded in `(ts, eid)` order so Sync/git line-unions converge — `add-version` events may carry a `parent` hash for branch lineage), and a `manifest.json` summary (note anchor, path hint, block names) refreshed on snapshot. A derived `state.json` cache and `.graveyard/` remain planned (see `state.md`).
- Visible (not hidden) because hidden dot-folders emit no Vault events — which would break self-healing — and visible files ride Obsidian Sync / obsidian-git and stay human-readable.
- Snapshot-on-save is change-gated by a BLAKE3 hash (no snapshot storms). Append-only + content-addressed ⇒ Sync/git see only additions ⇒ no history merge conflicts.

## Diff

The Rust `similar` crate provides char/word/line granularity, intra-line emphasis, grouped hunks, and unified patches. N-way compare = N pairwise diffs against a user-selectable base. The engine returns hunks/spans/patches; the TS side renders inline / side-by-side / N-up / swap-base / patch.

## The standalone CLI

`crates/mica-cli` is a native binary over the same core: vault discovery (walk
up to `.obsidian`), sidecar I/O byte-compatible with the plugin (same paths,
same tab-indented manifest, same append-only ledger), the same snapshot gate,
and the same reducer for structural edits. Commands: ls/cat/set, tab/cell/
grid/mv, versions/show/diff/restore/label, snapshot, watch (a polling
auto-snapshot daemon for when Obsidian is closed), migrate, prepare, repair,
doctor. `--json` everywhere for scripting. Exit codes: 1 I/O, 2 bad args,
3 not found, 4 corrupt state.

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

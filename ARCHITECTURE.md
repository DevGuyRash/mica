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

- A **context-tracking line scanner** (`None` / inside-a-foreign-fence / inside-a-mica-block) delimits blocks in one O(bytes) pass — replacing backtick-counting. Per CommonMark, everything inside any fence is literal until that fence's closer, so a ` ```mica ` example _quoted_ inside a longer documentation fence is never treated as a real block. Every guarded block-content write scans replacement closers and atomically grows the original opener and closer when necessary; a nested editor can therefore introduce a longer fence without terminating its Mica block. Inside a block, tabs use the friendly closer-free `tab:` delimiter (each `tab:` line auto-closes at the next one); colon-fence directives (`:::tabs` / `:::tab` / `:::grid` / `:::cell` / reversible `:::section`) provide grids, explicit nesting, and logical section grouping. Saving several paragraph leaves through one prose editor promotes that replacement into one `section`; existing wrappers are reused rather than nested, and their opener/closer grow atomically above payload colon runs. Both forms are parsed by one recursive descent that treats inner code fences as opaque and stores exact source strings, so every untouched shape round-trips byte-for-byte.
- The parse result is a **CST of containers and opaque leaves**; every node stores its exact source strings, so `serialize(parse(x)) == x` byte-for-byte for unedited trees. Leaf content is never re-flowed; Mica parses structure, not markdown inline syntax.
- **Boundary.** Structured data crosses through `serde-wasm-bindgen`. Common edit paths use coarse text APIs (`apply_op_text`, `apply_ops_text`, and exact-range block/header edits), so the CST stays in Rust instead of being cloned into JavaScript and back. A full-document scan of the real 711 KB note measures ~0.7 ms. Offsets crossing to CodeMirror are converted to UTF-16 in a single forward pass. The `.wasm` is inlined into `main.js` as a `Uint8Array` (esbuild `binary` loader) and instantiated once.

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
combineRegions/uncombineSection (exact-preimage, Markdown-only grouping through
a reversible `:::section` wrapper), insertLeaf, duplicateNode, setTabAttr,
setCols. The parser gives callouts and fenced code their own leaves, so each is
an independently draggable, editable section. The host
re-scans the **live** document, applies the op to a fresh parse, and dispatches
one `{from,to,insert}` change whose bounds were recomputed at that instant.
`saveRegion` carries the region's expected text and is refused if the block
changed underneath the editor. No cached offset or node path is ever trusted
at write time.

Dependent gestures can use an all-or-nothing reducer batch: operations run on
one candidate CST, normalize once, and either all commit or the original bytes
are returned unchanged. By-id writers reject duplicate ids; identity repair is
the deliberate exception that identifies one exact UTF-16 occurrence and asks
Rust to rewrite only that header. Cross-block moves require stable ids, derive
both exact pre-images from one live document, and dispatch both replacements in
one ordered CodeMirror transaction.

The editors are CodeMirror 6 (`src/ui/mdEditor.ts`) — a compact Markdown quick
editor and one reusable full lightbox — with reconfigurable Markdown/code
language compartments and an explicit save lifecycle: Save / Ctrl+Enter
commit, Esc double-taps to discard when dirty, and blur does NOTHING. Structured
callout and code adapters edit metadata plus a fence-free/quote-free body, then
rebuild standard Markdown. Unknown code languages fall back to plain text;
known languages load asynchronously with a request guard so a stale parser
cannot replace a newer selection. A single Lezer projection discovers nested
callouts and quoted code in O(bytes + syntax nodes); source ranges remain the
authority, and nested controls attach only when rendered DOM cardinality is
unambiguous. In-progress drafts live on the plugin keyed by block id, so widget
rebuilds and reading⇄editing flips reopen the editor with nothing lost.
Destructive ops capture the immediate pre-image and offer an Undo toast instead
of a confirm dialog. Undo and raw-source saves carry an exact expected value;
conflicts preserve the newer document and remain visible to the user. Block ids
are auto-stamped on a debounced maintenance path (setting-gated), independently
of automatic content snapshots. Built-in commands and `createBlockSource` stamp
UUIDv7 identities before insertion.

## Storage & versioning

- Current version stays inline (portable plain markdown). History lives in a **visible, co-located** `<Note>.mica/` sidecar: verified content-addressed objects (`objects/b3-….mica.md`, or `.mica.gz` above 4 KiB when the host WebView supports compression; older WebViews retain larger objects as `.mica.md`), an append-only `ledger.jsonl` (authoritative; folded in `(ts, eid)` order so Sync/git line-unions converge — `add-version` events may carry a `parent` hash for branch lineage), and a `manifest.json` summary (note anchor, path hint, current explicit block names). Note renames serialize with snapshots, move only into an absent destination, and surface collisions without merging; the manifest also refreshes on metadata-only maintenance without timestamp-only rewrites. UUIDs alone anchor lineage. Note paths and block names are current non-versioned metadata, so the content ledger intentionally cannot reconstruct historical renames. Hosts recompute the plaintext hash on every object read/write, reject malformed identities and oversized/decompression-bomb objects, and share the same 128 MiB limit. Repair moves fully orphaned sidecars into the root `.mica-graveyard/`; a derived `state.json` cache remains planned (see `state.md`).
- Legacy migrations additionally retain `<Note>.mica/migration.json`, a shared
  plugin/CLI transaction record with schema
  `{format,status,note,original,migrated,events}`. `original` and `migrated`
  name verified whole-note objects; stable event ids make a `pending` record
  resumable after an ambiguous append, and `complete` preserves a durable
  recovery reference instead of turning successful migration evidence into an
  unreachable object.
- Visible (not hidden) because hidden dot-folders emit no Vault events — which would break self-healing — and visible files ride Obsidian Sync / obsidian-git and stay human-readable.
- Snapshot-on-save is change-gated by a domain-separated, length-framed full BLAKE3 content signature (no structural snapshot storms or leaf-boundary collisions). Per-note plugin work is serialized; exact-content preconditions and guarded rollback protect the note when a sidecar append fails. The CLI stages replacements beside their target, syncs them, atomically publishes them, and verifies the result. Append-only + content-addressed means Sync/git normally see additions rather than object rewrites.

## Diff

The Rust `similar` crate provides char/word/line granularity, intra-line emphasis, grouped hunks, and unified patches. N-way compare = N pairwise diffs against a user-selectable base. The engine returns hunks/spans/patches; the TS side renders inline / side-by-side / N-up / swap-base / patch. The synchronous plugin path enforces combined-size, line-count, long-line, and granularity-specific budgets before preprocessing or diffing; larger comparisons are directed to the interruptible CLI. The timeline materializes at most 100 rows at once, and explicit base search replaces an unbounded menu.

## Clipboard projection

Every rendered structural unit exposes the same CST-backed copy path in Reading view and Live Preview. A pure TypeScript projection walks the selected exact CST once: raw mode serializes its stored source segments; portable mode removes only recognized Mica container lines, drops whitespace-only boundary scaffolding, and preserves one blank-line semantic boundary between nonempty children. Optional outer wrapping synthesizes a backtick fence longer than every inner run and deliberately omits source fence attributes so pasted blocks cannot duplicate identity. The projection is O(bytes) time and O(bytes) output space and never scrapes rendered DOM text.

## Section interaction

Stored content kind is source-derived (`markdown`, `callout`, or fenced `code`);
rendered/source is a separate view/edit axis and is never persisted as a
four-way mode enum. Explicit conversions use standard Markdown syntax and name
metadata loss in the Undo notice. Compatible plain-Markdown regions expose a
typed light-DOM combine contract. The pointer engine captures same-block
candidates once, checks cached rectangles in O(visible compatible sections) per
move with no candidate-list allocation, and promotes a central target only
after a stationary dwell. Themes own the complete ready outline, tint, glow,
plus, and motion through `--mica-combine-*` properties. The Rust reducer repeats
compatibility and both exact-preimage checks before it creates or extends one
logical wrapper; callouts and code are conservatively excluded.

## The standalone CLI

`crates/mica-cli` is a native binary over the same core: vault discovery (walk
up to `.obsidian`), sidecar I/O byte-compatible with the plugin (same paths,
same tab-indented manifest, same append-only ledger), the same snapshot gate,
and the same reducer for structural edits. Note, object, and manifest replacements
are guarded, atomic, and post-write verified; vault walks do not follow symlinks
outside the vault. Commands: ls/cat/set, tab/cell/
grid/mv, versions/show/diff/restore/label, snapshot, watch (a polling
auto-snapshot daemon for when Obsidian is closed), migrate, prepare, repair,
doctor. `--json` everywhere for scripting. Exit codes: 1 I/O, 2 bad args,
3 not found, 4 corrupt state.

## Scriptable API

`window.mica` exposes UUID-addressed verbs (`block.list/read/update`, `versions.list/snapshot/revert/diff/patch/edit`, `migrate.scan/run`, `prepare`, `repair`) plus `createBlockSource({name?, body})`, the canonical template constructor. It returns a complete UUIDv7-addressed block, validates the optional explicit name through the core header writer, and sizes the outer fence above body backticks; `block.source` mirrors it in the file bridge. The other APIs are mirrored by palette commands and that bridge: an agent drops `{verb,args}` JSON in `mica-bridge/inbox/`; the watcher (registered on `onLayoutReady` so old instructions never replay at vault load) executes it, **trashes the consumed inbox file**, and writes `mica-bridge/outbox/<same-name>.json` — desktop, mobile, and over Sync with no server. Mutating verbs run through the per-file transaction queue, reject duplicate identities, and surface failures to callers. A desktop loopback transport into a running Obsidian instance remains planned; the official Obsidian CLI tier (`tests/e2e-cli/run.sh`) covers shell-driven contract checks meanwhile.

## Build & distribution

pnpm + esbuild (bundle `src/main.ts` → `main.js`, CommonJS, externalizing `obsidian` / `electron` / `@codemirror/*`) + `wasm-pack` for the core. Node, pnpm, Rust, wasm-pack, and release metadata are pinned or checked in CI; dependency advisories and release artifacts are release gates. The dev repo lives at `~/repos/mica` and is symlinked into the vault's plugin folder for hot-reload testing; the vault repo is never polluted.

## Load-bearing files

Rust: `crates/mica-core/src/{scanner,parser,edit,versions,diff,reconcile,migrate}.rs` (+ `lib.rs` wasm exports). TS: `src/cm/micaLivePreview.ts`, `src/render/{layoutEngine,readingRenderer}.ts`, `src/storage/sidecar.ts`, `src/version/engine.ts`, `src/identity/{identity,reconcile}.ts`, `src/api/mica.ts`, `src/main.ts` (commands incl. migration).

## Testing tiers

1. `cargo test --workspace` — core, CLI, integration, adversarial-depth/scaling, and documentation tests.
2. `pnpm smoke` — the WASM boundary end-to-end in Node (ids, hashing, guarded/exact edits, atomic batches, duplicate repair, migrate+edit+diff).
3. `pnpm e2e` — eight contract + rendering specs inside a real downloaded Obsidian under Xvfb. Scheduled profiles repeat the suite at the minimum supported app version and under mobile emulation.
4. `just e2e-cli` — contract checks via the official Obsidian CLI against the running app; skips with instructions when the CLI isn't activated.

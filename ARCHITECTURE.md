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
                                        vault discovery · central-store I/O (byte-
                                        compatible) · watch daemon · doctor
```

## Core principle: derive state, never cache it

Every correctness guarantee comes from one discipline repeated at three layers:

- **Editing.** Block boundaries are recomputed from a live scan at every decision point — render and write alike. No line number or node path is ever trusted after the document may have changed. Edits are `{from,to,insert}` change specs derived at dispatch time — never a cached-coordinate overwrite. (That overwrite is exactly what corrupts `obsidian-tabs`.)
- **Versioning.** Current state is a fold over an append-only `ledger.jsonl`; version objects are immutable and content-addressed, while logical checkpoint IDs distinguish separate history points that share identical bytes. Restore appends a forward checkpoint; reset and visibility changes append state events. Nothing is rewritten.
- **Identity.** The note↔history link is derived by matching content-carried UUIDs, not paths — so it self-heals across renames and moves.

## Rust → WASM core

- A **context-tracking line scanner** (`None` / inside-a-foreign-fence / inside-a-mica-block) delimits blocks in one O(bytes) pass — replacing backtick-counting. Per CommonMark, everything inside any fence is literal until that fence's closer, so a ` ```mica ` example _quoted_ inside a longer documentation fence is never treated as a real block. Every guarded block-content write scans replacement closers and atomically grows the original opener and closer when necessary; a nested editor can therefore introduce a longer fence without terminating its Mica block. Inside a block, tabs use the friendly closer-free `tab:` delimiter (each `tab:` line auto-closes at the next one); colon-fence directives (`:::tabs` / `:::tab` / `:::grid` / `:::cell` / reversible `:::section`) provide grids, explicit nesting, and logical section grouping. Saving several paragraph leaves through one prose editor promotes that replacement into one `section`; existing wrappers are reused rather than nested, and their opener/closer grow atomically above payload colon runs. Both forms are parsed by one recursive descent that treats inner code fences as opaque and stores exact source strings, so every untouched shape round-trips byte-for-byte.
- The parse result is a **CST of containers and opaque leaves**; every node stores its exact source strings, so `serialize(parse(x)) == x` byte-for-byte for unedited trees. Leaf content is never re-flowed; Mica parses structure, not markdown inline syntax.
- **Boundary.** Structured data crosses through `serde-wasm-bindgen`. Common edit paths use coarse text APIs (`apply_op_text`, `apply_ops_text`, and exact-range block/header edits), so the CST stays in Rust instead of being cloned into JavaScript and back. A full-document scan of the real 711 KB note measures ~0.7 ms. Offsets crossing to CodeMirror are converted to UTF-16 in a single forward pass. The `.wasm` is inlined into `main.js` as a `Uint8Array` (esbuild `binary` loader) and instantiated once.

## Rendering (three modes)

- **Reading view.** `registerMarkdownCodeBlockProcessor("mica", …)` builds read-only interactive DOM; nested content renders by recursion via `MarkdownRenderer.render` under a `MarkdownRenderChild`.
- **Live Preview.** A `StateField<DecorationSet>` builds `Decoration.replace({widget, block:true})` for every closed block and provides it via `EditorView.decorations.from(field)`. This MUST be a StateField: CodeMirror rejects block-level/line-break-spanning decorations from view plugins at runtime ("Block decorations may not be specified via plugins") — a constraint verified the hard way in a live Obsidian. Reveal-on-overlap: a block whose range intersects the selection renders as raw source. Widget replacement is gated by `editorLivePreviewField`; ranges end at the closing fence line's end (never past its newline); `WidgetType.eq(id, content)` reuses DOM; the scan is cached per document text so cursor-only transactions skip WASM.
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
language compartments, global live view-preference compartments, and an
explicit save lifecycle: Save / Ctrl+Enter commit, Esc closes search before it
double-taps to discard when dirty, and blur does NOTHING. All editor surfaces
share a shadow-root gutter whose foreground, divider, active line, spacing, and
font size inherit documented `--mica-gutter-*` theme tokens. Incremental Lezer
highlighting styles markers and semantic Markdown without removing source or
changing heading line geometry; empty/unknown code stays plain, while `md` and
`markdown` deliberately opt into the Markdown projection. Full lightboxes own
one Blob worker for exact find ranges, Global/first-match scope, and ECMAScript replacement semantics. The worker also returns replacement projections for viewport-bounded Original/Changes/Result decorations; previews never mutate the editor document.
Generations discard stale replies, a 500 ms watchdog terminates pathological
regex, typed arrays retain O(matches) offsets, and CodeMirror creates
decorations only for visible matches. One shared `Intl.Segmenter`-backed service
computes Unicode words/graphemes/meaningful lines in O(text) on a debounced,
selection-aware path; exact UTF-16, UTF-8, and line-ending details are computed
only when their popover opens, so typing does not allocate a UTF-8 copy. Structured
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

Open editors also own a bounded, session-only block history keyed by stable
block id. Mica transactions record exact outer-block pre/post images; compound
cross-block operations remain one entry, while consecutive raw-source typing
groups for 750 ms. Undo/Redo re-scan the live document and replace only exact
expected block images, so unrelated note edits are never rolled back. The
controller retains at most 100 entries/8 MiB per editor and is deliberately
separate from the durable version ledger.

## Storage & versioning

- Current version stays inline (portable plain markdown). History lives in one **visible vault-relative folder**, defaulting to `mica-data/`. The portable vault-root `mica.json` selects that folder for both hosts; the selected folder's `root.json` identifies storage format 1 and the store UUID. The shared `objects/` pool contains verified full-BLAKE3-addressed immutable objects (plain Markdown through 4 KiB; gzip above it in every host). Independent note records under `notes/<safe-note-key>/` hold an append-only `ledger.jsonl` authoritative under `(ts, eid)` ordering, a `manifest.json` summary, and operation journals. A safe key is a domain-separated full hash of the original stable note identity; arbitrary identity text never becomes a path component. Note-scoped `object-aliases.json` resolves retained legacy short hashes against verified full objects without changing ledger or journal bytes. Legacy `add-version` rows retain hash lineage and append-only `replace-version` normalization. New `checkpoint` rows use a stable logical version ID plus content hash, parent version ID, optional restore source, and cause. `move-head`, `version-label`, and `version-visibility` target logical IDs, so identical content hashes remain distinct checkpoints and hidden versions retain their original lineage. The folded model keeps both the raw ledger HEAD and the effective visible HEAD: dirty checks and new checkpoint parentage use raw HEAD, while timeline display and explicit visible-Head comparison use effective HEAD. Effective visible parents and HEAD splice over hidden ancestors without changing live bytes or falsely dirtying a working copy that still matches a hidden raw HEAD. Conflicting IDs, absent/cross-block targets, inconsistent legacy replacements, or ambiguous hash references fail closed. Original events and objects remain immutable and readable. Note renames serialize with snapshots and refresh only the current path hint; history directories never follow note paths. Duplicate live note identities block writable bindings. The manifest refreshes on metadata-only maintenance without timestamp-only rewrites. UUIDs alone anchor block lineage. Note paths and block names are current non-versioned metadata, so the content ledger intentionally cannot reconstruct historical renames. Hosts recompute the plaintext hash on every object read/write, reject malformed identities and oversized/decompression-bomb objects, and share the same 128 MiB limit. Repair enumerates central note records by manifest identity and retains orphaned history for recovery. No shared-object deletion or garbage collection is part of this format change; a derived `state.json` cache remains planned (see `state.md`).
- Storage routing is owned by `mica.json`, with schema
  `{format:1,folder,storeId,previousFolder,initializing}`. `folder` is a
  validated visible vault-relative path. Missing nullable fields become null;
  missing `initializing` becomes false. A null `storeId` is valid only for an
  uninitialized active route with no existing store directory. First setup
  records a chosen UUID with `initializing:true` before creating directories,
  writes that exact UUID to the marker, then clears the flag through an exact
  locator guard. Only this recorded intent permits interrupted setup to
  resume with an absent or empty directory, or a marker with that UUID;
  unknown children remain a conflict. Non-null `previousFolder` records a
  pending move and requires the existing UUID and `initializing:false`.
  An unmarked preexisting directory, even an empty one, is not initialization
  intent. A custom route also rejects any competing reserved `mica-data` entry;
  relocation permits that entry only when it is the recorded source or target.
  Ordinary operations fail closed while initialization or a move is pending.
  Plugin preferences hold the requested location; `--store-dir` must agree with the
  active locator. Neither can select a competing store. **Apply after restart**
  validates and saves the request, then startup performs the move before the
  identity index, engine, bridge, or renderers start. CLI/watch writers must be
  stopped first. A guarded pending locator precedes the whole-folder move;
  verifying the destination UUID precedes activation. Objects, ledgers, aliases,
  manifests, and journals retain their bytes. Interrupted moves resume only
  when the recorded source/destination state identifies one matching store;
  conflicting copies remain untouched. Below, `<store>` denotes the selected
  folder.
- The plugin retains validated locator and marker file generations and checks
  their visible Vault identity, path, mtime and size after asynchronous I/O and
  inside publication callbacks. Plugin and CLI marker reads share a 4096-byte
  limit. An engine retains its startup root. Each live-note publication/rollback
  guard pins the selected `TFile` and path when captured; a route replacement or
  later file rename/replacement invalidates that guard. Owned initialization
  advances only its own verified generations; other pending intent remains
  blocked. Startup folder
  moves pin their source and destination markers at each publication boundary.
  Vault metadata cannot reveal every external write, and no adapter operation
  atomically compares the locator, marker and another file together.
- Legacy migrations additionally retain `<store>/notes/<note-key>/migration.json`, a shared
  plugin/CLI transaction record with schema
  `{format,status,note,original,migrated,events}`. `original` and `migrated`
  name verified whole-note objects; stable event ids make a `pending` record
  resumable after an ambiguous append, and `complete` preserves a durable
  recovery reference instead of turning successful migration evidence into an
  unreachable object.
- Logical-section history normalization retains a separate
  `<store>/notes/<note-key>/section-normalization.json` transaction record with exact
  pre/post whole-note hashes and stable `replace-version` events. The command
  writes and verifies immutable objects first, publishes a pending journal,
  compare-and-swaps the note, appends only missing events, verifies the folded
  result, and then marks the journal complete. It never repurposes the legacy
  migration record or refreshes the manifest.
- Prompt-collection consolidation retains
  `<store>/notes/<note-key>/tab-consolidation.json`. It replaces the selected live prompt
  collection with one fresh unnamed block, maps source blocks to tabs, and
  composes each source legacy version or identity-bearing checkpoint into a
  whole-target checkpoint while preserving source timestamps, labels,
  visibility, logical parents, objects, and ledger events. Top-level callouts
  and fenced code remain native leaves; only
  contiguous ordinary Markdown runs receive reversible `:::section` wrappers.
  Exact note and manifest generations make interrupted publication resumable.
  Completed-journal inspection validates the immutable original/result objects,
  recorded manifest and first ledger prefix containing its exact events. Later
  note edits, HEAD moves, metadata refreshes and identical event replays do not
  change that historical boundary. Retained path hints remain contained relative
  metadata independently of later storage-folder moves. Pending publication
  still requires the exact current note and manifest generations before
  completing a transaction.
- Native journal publishers share the existing append-only ledger lock with
  appenders and revalidate their retained route after acquiring it. New pending
  transactions claim the exact bytes observed during planning or absence.
  Completion requires a matching logical payload and fresh read-only checks of
  its source, events, objects and operation-specific result under the lock;
  same-state replays preserve existing bytes. A new claim still publishes pending
  when a completed predecessor has the same payload. Identical intervening byte
  cycles are not distinguished. Writers that bypass the lock and portable
  compare-to-rename races remain outside that cooperative guarantee.
- The managed root is visible because hidden dot-folders do not participate in the normal Vault event model and Obsidian Sync excludes them. Sync must include other file types for JSON/JSONL/gzip state. The selected folder and reserved default `mica-data` namespace are excluded from live-note scans, rendering mutations, snapshots, migration and watch, so object files never produce history of history. Git is an optional transport/backup tool and never selects the root.
- Snapshot-on-save is change-gated by a domain-separated, length-framed full BLAKE3 content signature (no structural snapshot storms or leaf-boundary collisions). Per-note plugin work is serialized; exact-content preconditions and guarded rollback protect the note when a ledger append fails. The CLI stages replacements beside their target, syncs them, atomically publishes them, and verifies the result. Append-only + content-addressed means Sync/git normally see additions rather than object rewrites.
- Explicit snapshots return the block ids whose `checkpoint`/`move-head` pairs
  reached the ledger. A block status control targets only its own id; the
  command-palette action remains note-wide. Manifest refreshes and identity
  maintenance never count as saved versions. Revert-to-HEAD force-snapshots the
  exact working body first, then restores the prior verified head, making the
  discarded body recoverable. Restore-as-checkpoint creates a distinct forward
  checkpoint even when its object hash appeared earlier; Reset HEAD appends a
  logical head move to the selected checkpoint. Timeline removal and restoration
  append visibility events and never delete objects.

## Diff

The Rust `similar` crate provides char/word/line granularity, intra-line emphasis, grouped hunks, and unified patches. N-way compare = N pairwise diffs against a user-selectable base. The engine returns hunks/spans/patches; the TS side renders inline / side-by-side / N-up / swap-base / patch. The synchronous plugin path enforces combined-size, line-count, long-line, and granularity-specific budgets before preprocessing or diffing; larger comparisons are directed to the interruptible CLI. The timeline materializes at most 100 rows at once, and explicit base search replaces an unbounded menu.

Focused history inspection reuses the ordinary block renderer with an
inspection presentation contract that suppresses edit/copy/fold/drag chrome and
external navigation while leaving tab activation available. Auto comparison
resolves working copy → head, stored version → recorded parent, and root →
empty baseline; ordinary plugin and CLI snapshots persist the previous logical
HEAD as `parentVersionId`. Explicit Head never substitutes another version.

Each loaded version gets a linear `ScopeIndex`: exact source ranges,
kind/family/path/ancestry, parent and sibling context, normalized metadata,
structural shape, a polynomial rolling range hash backed by two `Uint32Array`
prefix tables, and neighbor fingerprints. Indexing is O(source units + CST
nodes). Adjacent parent→child transitions use indexed, capped candidate edges,
reciprocal one-to-one validation, and exact-byte verification. Unique exact
content, mapped parents, stable labels, structural shape, neighboring anchors,
and linear resemblance sketches can support a mapping. Candidate resemblance is
45% ordered token-trigram Dice, 25% token-frequency Dice, and 30% normalized
line-anchor Dice (short content falls back to token frequency); numeric
position, resemblance alone, or one weak neighbor cannot establish identity.
Adjacent section windows are indexed once
for split/combine recognition rather than rescanned per section. Unmatched
scopes become Added/Removed only when no plausible edge remains; duplicate or
empty ambiguities stay Needs matching.

Arbitrary comparisons route lazily through recorded parents and the nearest
common ancestor. At most two adjacent objects need loading for each streamed
transition; the 12-object/index/transition LRUs remain bounded, and traversal
stops at the first unsafe or unavailable edge. Interactive indexing is capped at
2 Mi UTF-16 code units; larger snapshots stay available to whole-block diff/CLI
paths. Ambiguous candidate materialization is capped at 64, with rendered
snapshot selection as the complete fallback. Manual pairings are scoped to one
modal, version pair, and selected locator. The inspection selection model keeps
up to eight scopes in source order, eliminates parent/descendant overlaps, and
builds one independently resolved, lazily rendered comparison row per scope. No
inner scope ids or historical rewrites are involved.

One comparison plan answers what the history window is comparing: a base, the
targets derived from the timeline selection, and an optional element scope.
Element focus and several-version comparison compose — each focused element owns
a row spanning every target. A picked version never becomes a column of itself;
it is reported as the base instead. Grid layouts cap at four columns and name
what they dropped, while stacked patches are uncapped. Rendering and copying
both walk the plan's ordered cells, so the clipboard cannot describe a different
comparison than the surface. Element names come from location, type, and
position among same-kind siblings, never from content: a leaf's label is its
first source line, which is neither stable nor able to tell siblings apart.

Very tall blocks register with one controller per actual scroll container. A
single status cluster is reparented between header, middle dock, and footer,
preventing duplicate Save/History controls. Reading view uses a zero-height
sticky host. Live Preview moves the same middle cluster into a stationary
CodeMirror-owned overlay, outside community-theme clipping and virtualized
widget geometry. Registration waits until a detached `WidgetType.toDOM` result
enters Obsidian’s live DOM, then binds explicitly to `.cm-scroller`. Managers
share scroll/resize observation, use a bounded timer fallback when animation
frames are throttled, and remove themselves with the render component.

The dock clipboard consumes the existing `ScopeIndex` rather than adding
another structural parser. One transient controller records automatic, focused,
or pinned intent. Automatic reading targeting samples a stable band after
scroll idle; the outermost tab or grid boundary owns that context, so parallel
cells are never guessed. Focus and Source-mode caret/selection may select a
deeper exact scope. Pinned locators reconcile conservatively through the same
scope resolver used by history, and copy reparses the current working source
immediately before projecting it. A stale or ambiguous locator fails closed;
there is no ancestor fallback. Mini-editor drafts are applied as one guarded
working-copy overlay before indexing and copying.

When a CodeMirror primary selection is inside a long raw fence in full Source
mode or exposed Live Preview source, a single per-editor companion dock listens
to the actual scroll DOM as well as CodeMirror viewport updates and uses the
same bounded scheduling fallback. It reads the current editor buffer as a
`WorkingCopyProvider`. Read-only history can inspect that buffer immediately.
Before Restore, branch-edit, or explicit Save mutates version state, the provider
flushes through `MarkdownView.save()` and verifies both the editor generation
and vault bytes; a concurrent edit cancels the mutation rather than operating on
stale source.

Dock action order, target mode, and floating surface are settings-backed. The
rendered and raw-source presenters share action IDs, scope labels, clipboard
projection, and pin state even though CodeMirror requires its own DOM host.
Theme/frosted/accent/custom treatments resolve through documented
`--mica-long-dock-*` variables and apply only while controls float.

## Clipboard projection

Every rendered structural unit exposes the same CST-backed copy path in Reading view and Live Preview. A pure TypeScript projection walks the selected exact CST once and retains source-aware authored/generated segments: syntax mode serializes stored Mica container lines; portable mode emits authored leaves with exact indentation, tabs, blank runs, trailing bytes, and line endings. Optional outer wrapping synthesizes a backtick fence longer than every inner run and deliberately omits source fence attributes so pasted blocks cannot duplicate identity. Content-scope numbering prefixes only authored physical lines while leaving generated directives/fences untouched; output-scope numbering runs after serialization and covers every line. Number width is computed once, blank authored lines count, and numbering remains continuous across semantic fragments. The projection is O(bytes) time and O(bytes) output space and never scrapes rendered DOM text.

## UI actions and settings

`ActionSpec` is the one typed definition used by responsive direct controls,
entity ellipsis menus, context menus, and keyboard-reachable paths. One shared
`ResizeObserver` fans width changes into local O(actions) packers; cached control
measurements are invalidated by theme, density, and toolbar changes. Direct
actions promote by bounded priority and retain source order, while drag and
editor line numbers stay pinned. Rendered entities construct only their local
action list, mount no document-wide listener, and dispose native menus/timers
with their render child. Optional hover-open has a short delay and leave grace,
checks fine-pointer capability at use time, and never replaces click/keyboard
behavior. Tabs keep activation/add/overflow direct.

Semantic section actions pass through one preference filter before either
responsive controls or context menus are built. Persisted
`hiddenSectionActions` stores grouped omissions (for example every contextual
`convert-*` action maps to `convert`) rather than a whitelist, so new action
types remain visible after upgrades. The filter is scoped to `sectionActions`;
drag and block/tab/grid/cell/editor commands never enter it.

`SETTING_LIFECYCLES` exhaustively maps every persisted setting to immediate
runtime application, open-widget rerender, live toolbar repaint, click-time
read, next-open, or next-startup behavior. The map is type-checked against
`MicaSettings`, so a new preference cannot compile without a declared lifecycle.
Mounted toolbars subscribe to immutable configuration replacement and repaint
their controls without replacing CodeMirror documents or undo history.
Legacy duplicate custom-button ids are normalized deterministically once on
load; existing buttons without a surface remain Markdown-only, while current
configuration rejects empty names/templates and falls back safely for invalid
icons.

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

`crates/mica-cli` is a native binary over the same core: explicit `--vault DIR`
accepts an existing plain directory; automatic discovery recognizes the portable
`mica.json` locator, an Obsidian configuration marker, or the default
`mica-data/root.json`. `--store-dir FOLDER` is vault-relative and must agree with
an existing locator. Pending or inconsistent routing fails closed rather than
initializing another store. Shared Rust path and source-backed identity rules
select central storage independently of Git. Host
I/O is byte-compatible with the plugin (same paths,
same tab-indented manifest, same append-only ledger), the same snapshot gate,
and the same reducer for structural edits. Note, object, and manifest replacements
are guarded, atomic, and post-write verified; vault walks do not follow symlinks
outside the vault. Commands: ls/cat/set, tab/cell/
grid/mv, versions/show/diff/restore/reset-head/remove-versions/restore-versions/label, snapshot, watch (a polling
auto-snapshot daemon for when Obsidian is closed), migrate,
normalize-sections, consolidate-tabs, prepare, repair, doctor.
`normalize-sections` accepts a
note or directory; `--history` applies the same one-section wrapper to stored
versions through append-only replacement events, and `--dry-run` performs the
full validation without writes. `--json` everywhere for scripting. Exit codes: 1 I/O, 2 bad args,
3 not found, 4 corrupt state.
`consolidate-tabs` accepts the same note-or-directory scope and uses
`--history` to retain each source block's history in the fresh tabbed target.
Single-block notes keep their UUID and use append-only replacements when only
semantic leaf boundaries need correction.

`replace-version` and the identity-bearing checkpoint event family are
coordinated ledger-format upgrades. Readers fail closed on an unknown typed
event, but pre-upgrade binaries cannot interpret a future event they do not
know about. Every plugin and CLI instance on every device that can touch the
vault must therefore be upgraded before the first structural history
normalization or identity-bearing checkpoint operation.

## Scriptable API

`window.mica` exposes UUID-addressed verbs (`block.list/read/update`, `versions.list/removed/snapshot/revert/restore-checkpoint/reset-head/set-visible/diff/patch/edit/label`, `migrate.scan/run`, `prepare`, `repair`) plus `createBlockSource({name?, body})`, the canonical template constructor. It returns a complete UUIDv7-addressed block, validates the optional explicit name through the core header writer, and sizes the outer fence above body backticks; `block.source` mirrors it in the file bridge. Revert, branch edit, and label selectors resolve a stable checkpoint ID first; a full content hash remains a compatibility selector only when it identifies one checkpoint. The other APIs are mirrored by palette commands and that bridge: an agent drops `{verb,args}` JSON in `<store>/bridge/inbox/` (default `mica-data/bridge/inbox/`); the watcher (registered on `onLayoutReady` so old instructions never replay at vault load) admits it only after validating the file generation and selected inbox, replaces the exact executed inbox bytes with a consumed marker (preserving any newer content), and writes `<store>/bridge/outbox/<same-name>.json` — desktop, mobile, and over Sync with no server. The bridge names visibility changes `versions.set-visible`; `versions.visibility` remains an alias for existing callers. Post-registration create and modify events are serialized through a bounded inbox queue, so reusing a filename works without replaying consumed generations. The consumed marker retains the exact serialized response if later outbox publication fails; it stays non-executable. Operation execution and consumption are not one atomic transaction. Mutating verbs run through the per-file transaction queue, reject duplicate identities, and surface failures to callers. A desktop loopback transport into a running Obsidian instance remains planned; the official Obsidian CLI tier (`tests/e2e-cli/run.sh`) covers shell-driven contract checks meanwhile.

## Build & distribution

pnpm + esbuild (bundle `src/main.ts` → `main.js`, CommonJS, externalizing `obsidian` / `electron` / `@codemirror/*`) + `wasm-pack` for the core. Node, pnpm, Rust, wasm-pack, and release metadata are pinned or checked in CI; dependency advisories and release artifacts are release gates. The dev repo lives at `~/repos/mica` and is symlinked into the vault's plugin folder for hot-reload testing; the vault repo is never polluted.

## Load-bearing files

Rust: `crates/mica-core/src/{scanner,parser,edit,versions,diff,reconcile,migrate,store}.rs` (+ `lib.rs` wasm exports). TS: `src/cm/micaLivePreview.ts`, `src/render/{layoutEngine,readingRenderer}.ts`, `src/storage/sidecar.ts`, `src/version/engine.ts`, `src/identity/{identity,reconcile}.ts`, `src/api/mica.ts`, `src/main.ts` (commands incl. migration).

## Testing tiers

1. `cargo test --workspace` — core, CLI, integration, adversarial-depth/scaling, and documentation tests.
2. `pnpm smoke` — the WASM boundary end-to-end in Node (ids, hashing, guarded/exact edits, atomic batches, duplicate repair, migrate+edit+diff).
3. `pnpm e2e` — nine contract + rendering specs inside a real downloaded Obsidian under Xvfb, including worker timeout/recovery, theme-token gutters, action input modes, scoped toolbar repainting, and ambiguity-safe focused history. Scheduled profiles repeat the suite at the minimum supported app version and under mobile emulation.
4. `just e2e-cli` — contract checks via the official Obsidian CLI against the running app; skips with instructions when the CLI isn't activated.

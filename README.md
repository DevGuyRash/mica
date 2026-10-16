# Mica

**Versioned, structured content blocks for Obsidian — with a real command line.** Fast nested tabs and grids, first-class per-block version history, Meld-class diffing, a full markdown editor with toolbar, and a standalone `mica` CLI that drives your vault with Obsidian closed — all in plain, portable Markdown. Mica is a modern replacement for the `obsidian-tabs` plugin, built around guarded source transformations and recoverable version history.

- **Tabs & grids** that nest deeply (up to 128 structural levels), without stacking backticks.
- **Real Markdown and code editors.** Click prose to edit Markdown in place, or expand callouts and fenced code into structured lightboxes. Code blocks expose their optional language/info string and use matching syntax highlighting. Nothing commits merely because an editor loses focus, and unsaved conflicts remain visible to the user.
- **Block-level versioning.** Give a block an id and Mica snapshots semantic content changes into one vault-root history store you can inspect, diff, label, and restore — from the app or the shell.
- **Drag anything.** Tabs, cells, and whole groups move by pointer with live insertion indicators, spring-loaded tabs, and keyboard alternatives.
- **Two engines, one brain.** The Obsidian plugin and the `mica` CLI share the same Rust core, so a script at 2 a.m. and a click at noon behave identically.

---

## Install

### The plugin

For manual installation, use the published [Mica release assets](https://github.com/DevGuyRash/mica/releases):

1. Copy `manifest.json`, `main.js`, and `styles.css` into `<your vault>/.obsidian/plugins/mica/`.
   _(Or, if you're developing it, symlink the repo there — see [Development](#development).)_
2. In Obsidian: **Settings → Community plugins → Reload**, then enable **Mica**.

### The CLI (optional, recommended)

```sh
cargo build --release -p mica-cli     # → target/release/mica
# put it on your PATH, then from anywhere inside a vault:
mica ls "My Note"
```

The CLI operates on vault files directly — Obsidian does not need to be running — and writes the exact same central storage format the plugin reads; Git is optional.

---

## Quick start

**1. Make a block.** Run **`Mica: Insert Mica block`** from the command palette (or paste this) — a `tab:` line starts each tab, and you never close anything:

````markdown
```mica
tab: Overview
This is the **first** tab. Regular Markdown works: lists, links, code, callouts.

> [!tip] Callouts render normally inside tabs.

tab: Details
The second tab. Click the tab bar to switch (or arrow keys when focused).
```
````

Already have markdown you want inside a block? Select it and run **`Mica: Wrap selection in a Mica block`**.

**2. Edit it.** In **Live Preview**, click prose to open the **quick source editor** — marker-preserving Markdown styling, a formatting ribbon (bold, italic, lists, callout picker, code blocks, …), and Save/Cancel that never move out from under your pointer. Clicking a callout or fenced code section opens its structured lightbox; code gets an optional language/info field and language-aware highlighting. The section-type menu switches standard Markdown among prose, callout, and fenced-code representations, while **Rendered Markdown** and **Source** remain views of that content rather than extra file formats. Open the section's ⋮ menu (or **Ctrl/Cmd+click** the text) for the **full-screen source lightbox** with line numbers, preview/whitespace controls, Unicode-aware selection/total statistics, and off-thread find/replace. Search exposes Global, Match case, Multiline, Dot matches newline, and runtime-supported advanced ECMAScript flags. Global-off intentionally limits the result set to the first match; Replace all is available only with Global on. The Original / Changes / Result control previews replacements without editing the document, using the same deletion/addition language as version diffs. A timeout terminates pathological patterns instead of freezing the app. `Ctrl+Enter` saves; `Esc` closes search first and asks before discarding real changes. Clicking away does nothing by default; explicit save/cancel-on-click-away modes are available in settings.

**3. Restructure it.** Add a tab with **`+`**, rename with a double-click, right-click a tab for icons/duplicate/delete, and **drag** tabs, cells, sections, or whole groups wherever they should live — insertion lines show exactly where things land, and hovering a tab mid-drag springs it open so you can drop inside. Hold compatible Markdown over another section for a moment and the line becomes a full target outline with a large **+**; dropping combines them into one reversible section. The ordinary section menu provides previous/next combine actions for keyboard and touch use. Deletions, conversions, combines, and uncombines offer conflict-guarded **Undo** instead of nagging with confirms. Hover between any two sections for a quiet **+** that inserts prose, a callout, a code block, or a whole new group right there.

**4. It versions itself.** A moment after you edit, Mica stamps the block with an id and starts keeping history. The footer's **`v3 ●`** chip means three visible checkpoints and unsaved changes; click it for the **timeline** — labels, relative times, forward restores, deliberate HEAD resets, recoverable timeline removal, branch-edit, and readable diffs. Right-click the chip for auto-save controls.

In manual mode, **Save version** saves only that block and tells you when there
were no changes. While editing, contextual Undo/Redo controls affect only the
current Mica block—not unrelated Markdown elsewhere in the note. When the
working block differs from HEAD, **Revert to HEAD** first preserves the working
copy as a recoverable version and then restores HEAD exactly.

> **Already using `obsidian-tabs`?** Run **`Mica: Migrate tabs → Mica (dry run, whole vault)`**, review, then convert — your manual "archived" callouts become real, labeled version history. Or from the shell: `mica migrate --dry-run`. A retained `mica-data/notes/<note-key>/migration.json` records the transaction status, exact original/migrated object hashes, and replayable ledger events so the plugin or CLI can resume an interrupted migration without guessing.

---

## Writing blocks

Make tabs the easy way: inside a ` ```mica ` block, a `tab: Title` line starts each tab, running until the next `tab:`. **You never close anything.**

The extras:

- **Block header attrs** (managed for you, editable by hand): ` ```mica id=… name="…" accent=#7c5cff density=compact tabstyle=pill radius=8 ` — `id` anchors history; the rest are per-block appearance, set from the block's ⋮ menu.
- **Per-tab icons**: `tab: Deploy {icon=rocket}` shows a Lucide icon in the chip (set via right-click → _Set icon…_).
- **Callouts** — any Obsidian callout works, rendered natively.
- **Code blocks** — ordinary backtick or tilde fences, with an optional language/info string; rendered by Obsidian and editable as language + body, including when quoted inside a callout.
- **Grids** — `:::grid {cols=3}` … `:::` containing `:::cell` … `:::` cells.
- **Combined sections** — `:::section` … `:::` is the reversible wrapper Mica creates when compatible Markdown sections are combined. It changes layout grouping, not the Markdown inside, and **Uncombine** removes only the wrapper. Saving several paragraphs from one text editor also uses one logical wrapper, so blank lines stay inside that section instead of silently creating draggable siblings. Mica grows the colon fence above closer-like `:::` lines in the payload.
- **Nesting** — the flat `tab:` form can't nest, so nested groups use the explicit `:::tabs` / `:::tab Title` form. You'll rarely type it: the insert menus and drag-and-drop build (and convert) nesting for you, correctly, every time.

Everything is ordinary Markdown, and Mica sizes fences for you — you never count backticks.

### The three view modes

- **Reading view** — rendered, read-only: switch tabs, browse history, use the navigator. The active tab is **shared** with editing mode.
- **Live Preview** — rendered and editable: the full direct-manipulation experience. A pencil glyph in the block header tells you it's editable (a book means read-only).
- **Source mode** — plain Markdown, byte-exact round-trips, nothing hidden.

### The block header and action menus

Hover a block (or pin it via settings) for its header: the current **name** and one **⋮ menu** containing collapse, whole-block source editing, appearance, copy, navigator, version history, and save-version actions. An unnamed block displays its note title without writing a `name=` attribute; additional unnamed blocks display ` · 2`, ` · 3`, and so on. Those suffixes are presentation only—stable ids remain authoritative. Sections, tabs, tab groups, grids, cells, nested callouts/code, and folded rows follow the same rule: the drag grip stays direct where useful and secondary actions live in one consistent menu. Menus default to click; optional delayed hover is disabled automatically on touch/coarse pointers, while click, Enter, Space, context menus, and folded-row activation remain available. The **Section actions** settings composer can hide copy, editing, conversion, combine, fold, or delete commands from semantic sections without changing editor, block, tab, grid, or cell controls; drag always remains available.

Copy actions exist on blocks, tab groups, individual tabs, grids, cells, text/code sections, callouts, nested callouts, nested code, combined sections, and folded sections in both Reading view and Live Preview. By default they copy portable Markdown content with Mica layout wrappers removed. Four independent preferences can retain selected Mica layout syntax, add a fresh identity-free outer `mica` fence, add aligned line numbers, and choose whether numbers cover authored content only or every generated output line. Projection preserves authored indentation, tabs, blank runs, trailing bytes, and LF/CRLF style; generated wrappers use a safe fence and never copy source ids or appearance attributes.

---

## Versioning

- **Smart auto-snapshots.** A short while after a block's _content_ changes, it's snapshotted. Structure-only churn — adding empty tabs, reordering, renaming — never mints a version. Toggle auto/manual and the idle interval from the version chip's right-click menu.
- **Pre-image safety.** Content-changing CLI/API mutations first ensure the current semantic content is represented in history. Structure-only layout changes intentionally do not mint versions; destructive editor controls instead offer exact-source, conflict-guarded Undo.
> **Storage format change in 0.3.0:** the plugin and CLI use the central store together. Old note-local `.mica` directories are not imported automatically, and old clients must not write after cutover. Back up existing data and complete a verified offline transfer before enabling this version on an existing setup. The product has no automatic layout migration or dual-write mode. Shared objects are retained; this change adds no garbage collection.

- **Where it lives.** One visible vault-root `mica-data/` store holds shared immutable objects under `objects/` and independent note histories under `notes/<note-key>/`. Each note record has an append-only `ledger.jsonl`, a human-readable `manifest.json`, and any existing operation journals. Safe note keys derive from the stable `mica-id`; current note paths are metadata, so renames do not move history. Objects use full plaintext BLAKE3 addresses and are stored once across notes: Markdown through 4 KiB, gzip above it in every supported host. Note-scoped `object-aliases.json` records retain any legacy short-hash references without rewriting ledger or journal bytes. Git is optional. When using Obsidian Sync, enable **Sync all other types** so JSON, JSONL and gzip state travels with the Markdown files; dot-prefixed stores are excluded by Sync. [Official Sync settings](https://obsidian.md/help/sync/settings)
- **Checkpoint identity.** Each checkpoint has a stable version ID separate from its content hash, so restoring identical bytes can still create a distinct point in history. Parents, HEAD, labels, and visibility use that ID. Visible `vN` numbers are presentation labels and may change when checkpoints are removed from or restored to the timeline; automation should use a version ID or an unambiguous hash.
- **Coordinated upgrade.** Identity-bearing checkpoints, HEAD moves, labels, and visibility are new typed ledger events. Older readers fail closed instead of guessing. Upgrade the Mica plugin and CLI on every device that touches the vault before creating or managing these checkpoints.
- **Append-only structural normalization.** `replace-version` events can point an existing `add-version` event at a structure-only replacement object without rewriting the original event or object. Labels, timestamps, origins, lineage, version order, and version count stay attached to the original addition. This ledger event requires a Mica build that understands it: upgrade the plugin and CLI on every device before normalizing history or editing normalized stored history.
- **Identity and rename contract.** Stable note and block identities own history. A note rename refreshes its manifest path hint through the same serialized queue; its history directory and shared objects stay in place. Duplicate note identities block writes until repaired, preventing copied notes from mixing ledgers. Explicit block-name changes update current metadata without creating a `vN` row. History does not reconstruct historical note names. Moving or exporting a note with history must include its note record and referenced shared objects; copying the Markdown alone carries its current content.

### The timeline

Click the version chip: versions are shown in fixed 100-row pages with label, relative age, optional exact local timestamp, head marker, and preview — plus the dirty **working copy** when you have unsaved changes. Comparison starts in **Auto**: a working copy compares with the current head, a stored version with its recorded parent, a branch with the version it actually branched from, and v1 with an empty “Before v1” baseline. Head and pinned versions remain explicit overrides. The searchable picker finds exact `v123` ordinals, labels, hash prefixes, and dates without loading every object or rendering an unbounded menu.

**Diff** keeps the inline / split / patch, line / word / char, whitespace, syntax-filtering, and copied-patch workflow. **Inspect** replaces only the large diff pane with a read-only rendering of the selected snapshot: navigate its tabs, select one element or up to eight disjoint elements, then compare every selected block/tab/grid/cell/logical section/callout/code scope against the same base. Ctrl/Cmd-click toggles, Shift selects a compatible sibling range, selected scopes receive numbered markers, and multi-element results stay separate in lazy collapsible rows so disjoint source is never presented as one file. **Copy comparisons** produces a headed Markdown report with one independent patch per element. Whole-block comparison across several versions remains a separate advanced, four-version workflow.

Cross-version matching walks actual parent lineage and accepts reciprocal one-to-one mappings supported by exact content, mapped parents, stable labels, structural shape, neighbors, or bounded content resemblance—never numeric position or resemblance alone. Ordered token trigrams, token frequencies, and line anchors improve candidate ranking without turning similarity into identity. It reports changes, conversions, adjacent splits/combines, additions, removals, and unresolved ambiguity. Missing or ambiguous counterparts require an explicit pairing or disposition; indistinguishable empty or duplicated elements are intentionally never guessed. Ambiguities show rendered, keyboard-navigable candidate cards with evidence, neighboring context, and expandable bounded previews. Long lineage walks stream through adjacent snapshots without retaining the entire history. The authoritative whole-block timeline always remains visible. Interactive scope inspection is capped at 2 Mi UTF-16 code units per snapshot; larger comparisons stay available through whole-block diff and the interruptible CLI instead of blocking Obsidian's UI.

Per checkpoint, **Restore as new checkpoint** first preserves a dirty working copy, restores the selected bytes, and records a new child of the previous HEAD so history keeps moving forward. **Reset HEAD here** is the deliberate branching operation: it restores the selected bytes and moves HEAD to that existing checkpoint. **Remove from timeline** appends a visibility event without deleting ledger lines or objects; descendants compare against their nearest retained ancestor, hidden gaps remain visible as counts, and the Removed versions view restores original lineage. Removing the visible current checkpoint leaves live content and the raw ledger HEAD alone, moves only the effective visible HEAD to the nearest retained ancestor, and does not falsely mark unchanged content dirty. The next real edit remains parented to the hidden raw checkpoint, while its visible lineage is spliced cleanly in the timeline.

Blocks taller than both 800 px and 1.25× their nearest scrollport keep navigation and status reachable without a permanently sticky toolbar. The default contextual cluster travels from the header to a compact middle dock and then to the footer, so Save and History never appear twice. Its copy control names the exact scope it will copy: keyboard focus and Source-mode selection win, active tabs and top-level grids form stable automatic boundaries, and a reading band changes target only after scrolling settles. The adjacent scope picker can pin any structural descendant, resume automatic targeting, or copy the whole block once; stale scopes fail instead of silently copying an ancestor. Mini-editor drafts and the full in-memory Source buffer participate in the projection.

The same setting controls a CodeMirror companion dock in full Source mode and for raw fences exposed in Live Preview. It stays associated with the long block containing the primary selection while scrolling, without moving the caret or recreating its controls. History reads the exact in-memory buffer, and mutations first save and verify that generation before touching the ledger. ID-less blocks retain jumps but explain why History is unavailable. Settings can reduce either dock to jump-only controls or turn them off, choose contextual/block/manual copy targeting, compose the dock actions, and select theme, frosted, accent, or contrast-checked custom floating surfaces. Nested scroll panes, touch targets, safe-area insets, reduced motion, and theme-overridable dock variables are respected.

---

## The `mica` CLI

Everything above, from the shell, with Obsidian closed. Sidecars are byte-compatible — mix and match freely.

````sh
mica ls "My Note" --tree              # blocks, tabs, versions — with addressable paths
mica cat "My Note" --tab Overview     # print one tab's body
mica set "My Note" -b demo -f new.md  # replace content (pre-image + result versioned)
mica tab add "My Note" --title Notes  # structural edits: tab/cell/grid/mv
mica versions "My Note"               # the timeline, in your terminal
mica diff "My Note"                   # working copy vs head, colored
mica restore "My Note" v3             # restore bytes as a new forward checkpoint
mica reset-head "My Note" v3          # restore and deliberately branch from v3
mica remove-versions "My Note" v2 v3  # recoverably hide checkpoints
mica restore-versions "My Note" <id>  # return removed checkpoints to the timeline
mica label "My Note" v3 "Golden"      # name a version
mica snapshot "My Note"               # change-gated snapshot now
mica watch                            # daemon: auto-snapshot the vault while Obsidian is closed
mica migrate --dry-run                # legacy ```tabs conversion report
mica normalize-sections Prompts --history --dry-run  # validate one-editor normalization
mica consolidate-tabs Prompts --history --dry-run    # plan one-block tab consolidation
mica repair                           # repair identities; retain and report orphaned history
mica doctor                           # central-store health (missing objects, bad ledger lines)
````

After reviewing the dry-run JSON, repeat `normalize-sections` without `--dry-run` while Obsidian is closed. The command accepts one note or a directory, wraps each selected body in exactly one logical `:::section`, and uses append-only replacements for stored history. It preserves original objects and ledger lines and can resume an interrupted note transaction from `section-normalization.json`.

`consolidate-tabs` is the recoverable follow-up for prompt collections that were imported as several independent blocks. It creates one unnamed target block with one tab per logical prompt, preserves source history as full target snapshots, and promotes top-level callouts and fenced code to native sections. Single-block notes retain their UUID while receiving the same semantic section correction. The command preserves all source objects/events and resumes from `tab-consolidation.json`.

Global flags: `--vault DIR` accepts any existing plain directory; otherwise Mica walks up to a valid `mica-data/root.json` marker or `.obsidian`. Git does not select the root. The name `mica-data` is reserved for managed state: select its containing root rather than that folder or a descendant. Use `--json` on every read command for scripting. Blocks are addressed by id, `name`, or 1-based index. Interactive version selectors accept visible `vN`, labels, stable version IDs, or unambiguous hash prefixes; durable scripts should use the version ID.

## Scripting & AI agents

The plugin's core block-editing and versioning surface is also programmatic.

**From the console or a scripting plugin:**

```js
const source = window.mica.createBlockSource({
	name: "Prompt", // optional; omit it to inherit the note title in the UI
	body: "tab: Prompt\n\nWrite here.\n",
});
await window.mica.blockList("My Note.md");
await window.mica.blockUpdate("My Note.md", "<id>", "new body"); // guarded update
await window.mica.blockApply("My Note.md", "<id>", { op: "insertTab", path: [0], at: 2 });
await window.mica.blockSetAttr("My Note.md", "<id>", "accent", "#7c5cff");
await window.mica.versionsList("My Note.md", "<id>");
await window.mica.versionsRestoreCheckpoint("My Note.md", "<id>", "<version-id>");
await window.mica.versionsResetHead("My Note.md", "<id>", "<version-id>");
await window.mica.versionsSetVisible("My Note.md", "<id>", ["<version-id>"], false);
await window.mica.versionsLabel("My Note.md", "<id>", "<version-id>", "Golden");
await window.mica.versionsDiff("My Note.md", base, other, "word");
```

`createBlockSource` is the canonical template path: it returns a complete Mica fence with a UUIDv7, validates an optional user-authored name, and sizes the outer backtick fence above every run in the body. Names containing double quotes, backticks, line breaks, or control characters are rejected with a clear error rather than silently changed. Template code should not reconstruct the header grammar itself.

`versionsRevert`, `versionsEdit`, and `versionsLabel` take a stable version ID. For compatibility, each also accepts a full content hash when that hash identifies exactly one checkpoint; duplicate-hash histories require the version ID.

**From any process, via the file-bridge** — drop `{ "verb": "block.apply", "args": ["My Note.md", "<id>", "{\"op\":\"insertTab\",\"path\":[0],\"at\":2}"] }` into `mica-data/bridge/inbox/`; the result appears in `mica-data/bridge/outbox/`. Verbs: `block.source` (body, optional name), `block.list/read/update/apply/attr`, `versions.list/removed/snapshot/revert/restore-checkpoint/reset-head/set-visible/diff/patch/edit/label`, `migrate.scan/run`, `prepare`, `repair`. `versions.set-visible` takes the note, block ID, `"true"` or `"false"`, then one or more version IDs; `versions.visibility` remains a compatibility alias. Destructive verbs snapshot first.

---

## Commands

| Command                                   | Does                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| **Insert Mica block (tabs) here**         | Drop a fresh block at the cursor.                    |
| **Wrap selection in a Mica block**        | Fence the selected markdown (fences auto-sized).     |
| **Collapse / expand all Mica blocks**     | One-keystroke overview of long notes.                |
| **Prepare note for Mica (add ids)**       | Stamp blocks + frontmatter so versioning works.      |
| **Snapshot versions now**                 | Force a snapshot of the active note.                 |
| **Compare block versions**                | Open the timeline for the note's first block.        |
| **Repair history (reconcile)**            | Re-home histories whose notes moved; report orphans. |
| **Migrate tabs → Mica**                   | Dry-run or convert; active note or whole vault.      |
| **Run instruction (JSON from clipboard)** | Execute an API instruction manually.                 |

## Settings

Grouped by intent — **Versioning**, **Comparing**, **Appearance**, **Copying**, **Editors**, **Migration**:

- **Appearance** — a **theme gallery** (Match Obsidian, Slate, Ocean, Forest, Sunset, Grape, Rose, Carbon, Cyber, Solar) with live previews; accent override; density; corner radius; tab style (connected / underline / pill); **block header** visibility (hover / always / never); animations; version chip; tab spacing; editor sizing. Any single block can override accent/density/tab style/radius from its ⋮ menu.
- **Copying** — independently retain `tab:` / `:::` layout syntax, wrap copies in an outer Mica block, add aligned line numbers, and number authored content or complete output. Generated outer fences are sized around nested code blocks and never duplicate a block id.
- **Editors** — global live line numbers, whitespace visualization, marker-preserving Markdown styling, autosize/max height, save/click-away behavior, and a configurable formatting ribbon. Custom buttons validate their name/template/icon, avoid id collisions, update already-open toolbars, and can target Markdown, code, or both. Entity actions promote only while they fit; tabs stay compact with hover/focus dots plus right-click, and the hover dots can be disabled without removing keyboard/context-menu access.
- **Comparing** — choose diff defaults and optionally append exact local timestamps to relative version ages.
- **Icon packs** — Obsidian's built-in Lucide icons are always available and need no network. Extra packs (Bootstrap Icons, Tabler, Simple Icons, Iconoir, Twemoji) are **off by default and never bundled**; enabling one downloads it from [jsDelivr](https://www.jsdelivr.com/) (falling back to [unpkg](https://unpkg.com/) for npm-hosted packs) the first time an icon is needed, from a version-pinned URL. Downloaded SVG is rebuilt through an allowlist rather than inserted as markup. Each pack's licence is shown beside its toggle, and packs requiring credit (Twemoji, CC-BY 4.0) surface that attribution in settings. Disabling a pack releases everything it loaded.
- **Long blocks** — choose the contextual traveling cluster, jump-only navigation, or no extra controls; select contextual, whole-block, or manual clipboard targeting; compose the dock actions; and choose theme, frosted, accent, or custom floating colors.
- **Actions** — direct copy/edit/fold controls appear on hover while they fit and progressively collapse into one vertical-ellipsis menu as a block, section, tab, grid, cell, or editor narrows. Drag and editor line numbers stay direct. Rendered entities can instead keep every secondary action in the ellipsis; menus open by click or delayed hover, while touch remains click-only. A two-pane section-action composer hides or restores contextual section commands live; its hidden-list storage means newly introduced commands remain visible by default.
- Everything resolves to CSS custom properties (`--mica-accent`, `--mica-radius`, `--mica-gutter-*`, `--mica-inspector-*`, …), so [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) or your theme can go further. `preview.html` previews themes without launching Obsidian.

### Network use

Mica works entirely offline. The only outbound requests it can make are icon-pack
downloads, and only for packs you explicitly enable — see **Icon packs** above.
No telemetry, no analytics, no self-update.

## How it works (in one breath)

A pure **Rust core** (one crate) does the exact, fiddly parts — fence grammar, the CST, **every structural edit**, content-signature gating, hashing, diffing — and compiles twice: to WebAssembly inside the plugin, and natively inside the `mica` binary. The TypeScript shell and the CLI are thin hosts around the same reducer, and both obey one rule: _derive state from the live document; never trust a cached offset._ That's why editing a rendered tab can't corrupt your note the way `obsidian-tabs` did. See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`PRD.md`](PRD.md), and [`DESIGN.md`](DESIGN.md).

## Development

```sh
just bootstrap   # pnpm install + wasm32 target
just build       # wasm-pack + bundled main.js
just cli         # target/release/mica
just link        # symlink into your vault for live testing
just check       # format-check, typecheck, lint, Rust tests (workspace)
pnpm smoke       # WASM boundary test in Node (no Obsidian needed)
just e2e         # contract + UI suite in a REAL sandboxed Obsidian (Xvfb)
```

The reproducible toolchain is Node 22.12 or newer, pnpm 11.3.0, Rust 1.97.1,
`wasm-pack` 0.15.0, the `wasm32-unknown-unknown` target, and `just`. The pnpm and
Rust versions are recorded in `package.json` and `rust-toolchain.toml`; CI pins
the same `wasm-pack` version.

The checked-in CI and Compatibility workflow definitions describe the normal
verification suites and tag artifact uploads when hosted Actions is enabled;
they do not publish GitHub Releases. [RELEASING.md](RELEASING.md) gives the local
release procedure, version/lockfile synchronization, minimum/mobile checks and
download verification. Real mobile devices and two-device Obsidian Sync remain
manual release gates because desktop automation cannot reproduce those runtime
and concurrency boundaries.

Ordinary source pushes do not distribute a plugin update. Publish a new matching
GitHub Release with the three runtime assets for each version. The initial
Community directory submission is needed only once. Users install updates with
**Community plugins → Check for updates → Update** or **Update all**; installed
community plugins do not update automatically.

## License

[MIT](LICENSE)

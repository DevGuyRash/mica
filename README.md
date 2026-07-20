# Mica

**Versioned, structured content blocks for Obsidian — with a real command line.** Fast nested tabs and grids, first-class per-block version history, Meld-class diffing, a full markdown editor with toolbar, and a standalone `mica` CLI that drives your vault with Obsidian closed — all in plain, portable Markdown. Mica is a modern replacement for the `obsidian-tabs` plugin, built around guarded source transformations and recoverable version history.

- **Tabs & grids** that nest deeply (up to 128 structural levels), without stacking backticks.
- **A real editor.** Click any text to edit in place with a CodeMirror markdown editor and toolbar; expand to a full-screen lightbox with live preview. Nothing commits merely because the editor loses focus, and unsaved conflicts remain visible to the user.
- **Block-level versioning.** Give a block an id and Mica snapshots semantic content changes into a sidecar folder you can read, diff, label, and restore — from the app or the shell.
- **Drag anything.** Tabs, cells, and whole groups move by pointer with live insertion indicators, spring-loaded tabs, and keyboard alternatives.
- **Two engines, one brain.** The Obsidian plugin and the `mica` CLI share the same Rust core, so a script at 2 a.m. and a click at noon behave identically.

---

## Install

### The plugin

Mica isn't in the community-plugin store yet, so install it manually:

1. Copy `manifest.json`, `main.js`, and `styles.css` into `<your vault>/.obsidian/plugins/mica/`.
   _(Or, if you're developing it, symlink the repo there — see [Development](#development).)_
2. In Obsidian: **Settings → Community plugins → Reload**, then enable **Mica**.

### The CLI (optional, recommended)

```sh
cargo build --release -p mica-cli     # → target/release/mica
# put it on your PATH, then from anywhere inside a vault:
mica ls "My Note"
```

The CLI operates on vault files directly — Obsidian does not need to be running — and writes the exact same sidecar format the plugin reads.

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

**2. Edit it.** In **Live Preview**, click any text to open the **quick editor** — real markdown highlighting, a toolbar (bold, italic, lists, callout picker, code blocks, …), and Save/Cancel that never move out from under your pointer. Press the expand button (or **Ctrl/Cmd+click** the text) for the **full-screen lightbox** with a live preview pane. `Ctrl+Enter` saves; `Esc` asks before discarding real changes. Clicking away does nothing by default; explicit save/cancel-on-click-away modes are available in settings.

**3. Restructure it.** Add a tab with **`+`**, rename with a double-click, right-click a tab for icons/duplicate/delete, and **drag** tabs, cells, or whole groups wherever they should live — insertion lines show exactly where things land, and hovering a tab mid-drag springs it open so you can drop inside. Deletions offer **Undo** instead of nagging with confirms. Hover between any two sections for a quiet **+** that inserts prose, a callout, a code block, or a whole new group right there.

**4. It versions itself.** A moment after you edit, Mica stamps the block with an id and starts keeping history. The footer's **`v3 ●`** chip means three versions and unsaved changes; click it for the **timeline** — labels, relative times, one-click restore, branch-edit, and readable diffs. Right-click the chip for auto-save controls.

> **Already using `obsidian-tabs`?** Run **`Mica: Migrate tabs → Mica (dry run, whole vault)`**, review, then convert — your manual "archived" callouts become real, labeled version history. Or from the shell: `mica migrate --dry-run`. A retained `<Note>.mica/migration.json` records the transaction status, exact original/migrated object hashes, and replayable ledger events so the plugin or CLI can resume an interrupted migration without guessing.

---

## Writing blocks

Make tabs the easy way: inside a ` ```mica ` block, a `tab: Title` line starts each tab, running until the next `tab:`. **You never close anything.**

The extras:

- **Block header attrs** (managed for you, editable by hand): ` ```mica id=… name="…" accent=#7c5cff density=compact tabstyle=pill radius=8 ` — `id` anchors history; the rest are per-block appearance, set from the block's ⋮ menu.
- **Per-tab icons**: `tab: Deploy {icon=rocket}` shows a Lucide icon in the chip (set via right-click → _Set icon…_).
- **Callouts** — any Obsidian callout works, rendered natively.
- **Grids** — `:::grid {cols=3}` … `:::` containing `:::cell` … `:::` cells.
- **Nesting** — the flat `tab:` form can't nest, so nested groups use the explicit `:::tabs` / `:::tab Title` form. You'll rarely type it: the insert menus and drag-and-drop build (and convert) nesting for you, correctly, every time.

Everything is ordinary Markdown, and Mica sizes fences for you — you never count backticks.

### The three view modes

- **Reading view** — rendered, read-only: switch tabs, browse history, use the navigator. The active tab is **shared** with editing mode.
- **Live Preview** — rendered and editable: the full direct-manipulation experience. A pencil glyph in the block header tells you it's editable (a book means read-only).
- **Source mode** — plain Markdown, byte-exact round-trips, nothing hidden.

### The block header

Hover a block (or pin it via settings) for its header: **name** (click to rename), the **navigator** (a tree of every tab/grid/cell with word counts — click to jump), a one-click **Copy** control, and the **⋮ menu** (edit whole block in the lightbox, per-block appearance, version history, save version now). The chevron collapses the block to one line.

Clipboard buttons also live on tab groups, individual tabs, grids, cells, text/code sections, callouts, nested callouts, and folded sections in both Reading view and Live Preview. By default they copy portable Markdown content with Mica layout wrappers removed. Two independent settings can preserve the selected layout syntax and/or wrap the result in a fresh identity-free `mica` code fence.

---

## Versioning

- **Smart auto-snapshots.** A short while after a block's _content_ changes, it's snapshotted. Structure-only churn — adding empty tabs, reordering, renaming — never mints a version. Toggle auto/manual and the idle interval from the version chip's right-click menu.
- **Pre-image safety.** Content-changing CLI/API mutations first ensure the current semantic content is represented in history. Structure-only layout changes intentionally do not mint versions; destructive editor controls instead offer exact-source, conflict-guarded Undo.
- **Where it lives.** Next to `My Note.md`, a visible `My Note.mica/` folder holds verified content-addressed version objects (plain Markdown through 4 KiB; larger objects use gzip when the host WebView supports it and otherwise remain plain Markdown), an append-only `ledger.jsonl`, and a human-readable `manifest.json`. Migrated notes also retain `migration.json`, the shared plugin/CLI transaction record. It all rides Obsidian Sync and git.

### The timeline

Click the version chip: versions are shown in fixed 100-row pages with label, age, head marker, and preview — plus the dirty **working copy** when you have unsaved changes. Find an older base directly by version number, label, or hash. Select any two points to diff (inline / split / patch, line / word / char, layout syntax dimmed); oversized interactive comparisons point to the interruptible CLI instead of blocking Obsidian's UI. Per version: **Restore** (current state is snapshotted first), **Branch-edit** (opens the lightbox; saving creates a new version that records its parent), **Label**, **Copy**.

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
mica restore "My Note" v3             # roll back (snapshots current state first)
mica label "My Note" v3 "Golden"      # name a version
mica snapshot "My Note"               # change-gated snapshot now
mica watch                            # daemon: auto-snapshot the vault while Obsidian is closed
mica migrate --dry-run                # legacy ```tabs conversion report
mica repair                           # re-home sidecars after renames; report orphans
mica doctor                           # sidecar health (missing objects, bad ledger lines)
````

Global flags: `--vault DIR` (else it walks up to `.obsidian`), `--json` on every read command for scripting. Blocks are addressed by id, `name`, or 1-based index; versions by `vN`, label, or hash prefix.

## Scripting & AI agents

The plugin's core block-editing and versioning surface is also programmatic.

**From the console or a scripting plugin:**

```js
await window.mica.blockList("My Note.md");
await window.mica.blockUpdate("My Note.md", "<id>", "new body"); // guarded update
await window.mica.blockApply("My Note.md", "<id>", { op: "insertTab", path: [0], at: 2 });
await window.mica.blockSetAttr("My Note.md", "<id>", "accent", "#7c5cff");
await window.mica.versionsList("My Note.md", "<id>");
await window.mica.versionsLabel("My Note.md", "<id>", "<hash>", "Golden");
await window.mica.versionsDiff("My Note.md", base, other, "word");
```

**From any process, via the file-bridge** — drop `{ "verb": "block.apply", "args": ["My Note.md", "<id>", "{\"op\":\"insertTab\",\"path\":[0],\"at\":2}"] }` into `mica-bridge/inbox/`; the result appears in `mica-bridge/outbox/`. Verbs: `block.list/read/update/apply/attr`, `versions.list/snapshot/revert/diff/patch/edit/label`, `migrate.scan/run`, `prepare`, `repair`. Destructive verbs snapshot first.

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
- **Copying** — optionally retain `tab:` / `:::` layout syntax, wrap copies in an outer Mica block, or enable both. Generated outer fences are sized around nested code blocks and never duplicate a block id.
- Everything resolves to CSS custom properties (`--mica-accent`, `--mica-radius`, …), so [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) or your theme can go further. `preview.html` previews themes without launching Obsidian.

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

CI runs the normal format, type, lint, Rust, build, smoke, release-contract, and
real-Obsidian suites for pull requests, pushes to `main`, and release tags. A
scheduled/manual compatibility workflow also runs the full suite against the
declared minimum Obsidian app and under desktop mobile emulation, plus a
non-blocking moving-latest desktop canary. Real mobile devices and two-device
Obsidian Sync remain manual release gates because desktop automation cannot
reproduce those runtime and concurrency boundaries.

## License

[MIT](LICENSE)

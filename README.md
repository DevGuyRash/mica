# Mica

**Versioned, structured content blocks for Obsidian.** Fast nested tabs and grids, first-class per-block version history, and Meld-class diffing — all in plain, portable Markdown. Mica is a modern replacement for the `obsidian-tabs` plugin, built so the old "auto-save corrupts my note" bug is impossible by construction.

- **Tabs & grids** that nest as deep as you like, without stacking backticks.
- **Every block is versioned.** Edit freely; Mica snapshots changes into a sidecar folder you can read, diff, and revert.
- **Meld-style diffing** — inline / side-by-side / 3-up, char / word / line, swap base, copy patch, branch-edit any old version.
- **Three ways to work:** read-only, edit-the-rendered-view, or raw Markdown — your choice, per note.
- **Drivable by API** so scripts and AI agents can create, edit, diff, and version blocks headlessly.

---

## Install

Mica isn't in the community-plugin store yet, so install it manually:

1. Copy `manifest.json`, `main.js`, and `styles.css` into a new folder `<your vault>/.obsidian/plugins/mica/`.
   _(Or, if you're developing it, symlink the repo there — see [Development](#development).)_
2. In Obsidian: **Settings → Community plugins → Reload**, then enable **Mica**.
3. You'll see `Mica: loaded` in the developer console (Ctrl/Cmd-Shift-I). That's it.

---

## Quick start

**1. Make a block.** Create a note and paste this — a `tab:` line starts each tab, and you never close anything:

````markdown
```mica
tab: Overview
This is the **first** tab. Regular Markdown works: lists, links, code, callouts.

> [!tip] Callouts render normally inside tabs.

tab: Details
The second tab. Click the tab bar to switch (or arrow keys when focused).
```
````

Switch to **Reading view** or **Live Preview** and you'll see a tabbed block.

**2. Edit it.** In **Live Preview**, click any text in the block to edit just that piece in place — the editor shows clean Markdown, never the tab/grid plumbing. Add a tab with the **`+`** in the tab bar, drop a whole group with the quiet **`+ Tabs` / `+ Grid`** buttons where you're working, hover a tab for **×** (delete) or double-click it to rename. Nothing you do can corrupt the note.

**3. It versions itself.** A moment after you edit, Mica stamps the block with an id and starts keeping history — no command needed. The block's footer shows an **Auto** pill and a **`v2 ●`** chip; click the chip to compare and restore versions.

> **Already using `obsidian-tabs`?** Skip straight to [Migrating](#migrating-from-obsidian-tabs) — one command converts a note (or your whole vault) and turns your manual "archived" callouts into real version history.

---

## Writing blocks

Make tabs the easy way: inside a ` ```mica ` block, a `tab: Title` line starts each tab, running until the next `tab:`. **You never close anything.**

````markdown
```mica
tab: Kernel
The Kernel tab — any Markdown works.

tab: Frame Gate
The Frame Gate tab.
```
````

That's the whole syntax for tabs. The extras:

- **Block header** (optional): ` ```mica id=… name="…" `. The `id` (added automatically) lets versioning and the API follow a block across renames; `name` is a label.
- **Callouts** — any Obsidian callout (`> [!note]`, `> [!tip]`, `> [!warning]`, …) works, rendered natively.
- **Grids / menus** — a `:::grid {cols=3}` … `:::` block containing `:::cell` … `:::` cells.
- **Nesting** (a tab group _inside_ a tab) — the `tab:` shorthand is flat, so for nesting use the explicit form there: `:::tabs` … `:::` with `:::tab Title` … `:::` inside (add colons to go deeper — `::::tabs` wraps `:::tab`). You'll rarely type this by hand: migration generates it, and the **`+ Tabs` / `+ Grid`** affordances build nesting for you.

Everything is ordinary Markdown, and Mica sizes the outer ` ```mica ` fence for you — so you never count backticks.

### The three view modes

Mica works in all of Obsidian's modes, and you choose per note:

- **Reading view** — fully rendered, read-only tabs/grids; switch tabs, open history.
- **Live Preview** — rendered, editable tabs/grids. Click any text to edit just that region in place (clean Markdown, no `:::` plumbing); add, rename, and delete tabs and cells with the inline **+**, **×**, and rename affordances.
- **Source mode** — plain Markdown. Everything round-trips byte-for-byte; nothing is hidden or rewritten behind your back.

---

## Versioning

Mica keeps each block's history automatically — it stamps the block with an id the first time you edit it (or run **Prepare note for Mica** to do it now; turn this off in settings if you prefer manual ids).

- **Smart auto-snapshots.** A short while after you change a block's _content_, it's snapshotted. Pure structure changes — adding an empty tab or cell, reordering, renaming — never create a version, and unchanged content is never re-stored, so history stays clean.
- **Auto ↔ Manual.** Each block's footer has a green/red pill (with an editable interval) to toggle auto-snapshotting per session; in **Manual** mode a **Save version** button snapshots on demand.
- **Where it lives.** Next to `My Note.md`, Mica creates a visible `My Note.mica/` folder holding your version objects (plain Markdown files), an append-only `ledger.jsonl`, and a `manifest.json`. It's human-readable, and it rides Obsidian Sync / Git like any other file.
- **The version chip.** In the footer sits a `v<count>` chip. A dot (`v3 ●`) means the block has unsaved _content_ changes vs. its last snapshot. Click the chip to open **Compare**.

### Compare & restore

The compare window (chip, or **`Mica: Compare block versions`**) lets you:

- Pick a **Base** and a **Compare** version (and an optional third for 3-up).
- Choose **granularity** (line / word / char) and **mode** (inline / side-by-side / patch).
- **Swap base** ↔ compare, or **Copy patch** (a unified diff) to the clipboard.
- **Edit compare as new version** — opens an old version for editing; saving creates a _new_ version that records which one it branched from. History is never rewritten.

To roll a block back, open compare, pick the version, and branch-edit it (or use the API `versions.revert`). Your current content is always snapshotted first, so nothing is ever lost.

---

## Migrating from `obsidian-tabs`

If you have notes using ` `````tabs ` blocks, Mica converts them.

1. **Preview first.** Run **`Mica: Migrate tabs → Mica (dry run, whole vault)`**. Nothing is written — a report of what _would_ convert prints to the console (Ctrl/Cmd-Shift-I).
2. **Convert.** Happy with the preview? Run **`Mica: Migrate tabs → Mica (active note)`** for one note, or **`… (whole vault)`** for all of them.

What migration guarantees:

- **Lossless.** The entire original note is backed up as a content-addressed object _before_ anything is written, tab bodies are copied verbatim (blank lines and dividers included), and notes containing Templater tokens (`<%`) are skipped untouched.
- **Your archives become real history.** Version-style callouts inside tabs — e.g. `> [!success]- Review Kernel (V1.0)` or `> [!bug]- Frame Gate (V0.3)` — are imported as **labeled versions** you can diff and restore. By default Mica recognizes **every built-in Obsidian callout type**; narrow or broaden this in **Settings → Version callout types** (leave it empty to import _any_ callout type, including custom ones).

---

## Commands

Open the command palette (Ctrl/Cmd-P) and type "Mica":

| Command                                   | Does                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| **Prepare note for Mica (add ids)**       | Stamps blocks + frontmatter so versioning works.     |
| **Snapshot versions now**                 | Force a snapshot of the active note.                 |
| **Compare block versions**                | Open the diff window for the note's first block.     |
| **Repair history (reconcile)**            | Re-home histories whose notes moved; report orphans. |
| **Migrate tabs → Mica**                   | Dry-run or convert; active note or whole vault.      |
| **Run instruction (JSON from clipboard)** | Execute an API instruction manually.                 |

---

## Settings

**Settings → Mica:**

- **Auto-snapshot versions** + **interval** — master switch and idle time (500–10000 ms) for smart auto-snapshotting; also toggled per session from each block's footer pill.
- **Default diff granularity / mode** — what the compare window opens with.
- **Show version chip on blocks** — toggle the per-block chip.
- **Layout & editing** — cap tab/cell height with a scrollbar, and control whether the inline editor grows with content and its max height.
- **Reconcile history on startup** — scan for orphaned/moved histories when the vault opens.
- **Version callout types (migration)** — which callout types import as history (default: all built-in types; empty = any).

Everything visual is themeable via CSS custom properties on `body` (see `styles.css`; e.g. `--mica-diff-add`, `--mica-editor-max-height`) — the [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) plugin or your theme can override them.

---

## Scripting & AI agents

Mica's whole feature set is reachable from code — nothing is UI-only.

**From the console or a scripting plugin** (`js-engine`, `customjs`, Templater):

```js
await window.mica.blockList("My Note.md"); // [{ id, name }]
await window.mica.blockUpdate("My Note.md", "<id>", "new body"); // corruption-proof
await window.mica.versionsList("My Note.md", "<id>"); // [{ hash, ts, label }]
await window.mica.versionsDiff("My Note.md", baseHash, otherHash, "word");
await window.mica.migrateScan(); // dry-run report
```

**From an AI agent (or any process), via the file-bridge** — no server, works on desktop, mobile, and over Sync. Drop an instruction file into `mica-bridge/inbox/`:

```json
{ "verb": "versions.diff", "args": ["My Note.md", "<baseHash>", "<otherHash>", "line"] }
```

Mica runs it, **deletes the instruction** (so it can't replay), and writes the result to `mica-bridge/outbox/<same-name>.json`:

```json
{ "ok": true, "result": { "hunks": [ … ], "similarity": 0.82 }, "error": null }
```

Verbs: `block.list/read/update`, `versions.list/snapshot/revert/diff/patch/edit`, `migrate.scan/run`, `prepare`, `repair`. Destructive verbs snapshot before writing, so an agent can never destroy the only copy of a block.

---

## How it works (in one breath)

A small, pure **Rust core** (compiled to WebAssembly) does the exact, fiddly parts — locating blocks by a real fence grammar, computing edits, hashing, diffing — and a **TypeScript / CodeMirror 6** shell wires it into Obsidian. One rule everywhere: _derive state from the live document, never trust a cached offset._ That's why editing a rendered tab can't corrupt your note the way `obsidian-tabs` did. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full picture, [`PRD.md`](PRD.md) for the vision, and [`DESIGN.md`](DESIGN.md) for UX & syntax.

---

## Development

```sh
just bootstrap   # pnpm install + add the wasm32 target
just build       # wasm-pack + bundled main.js
just link        # symlink into your vault for live testing
just dev         # watch-rebuild main.js
just check       # typecheck, lint, format-check, Rust tests
pnpm smoke       # WASM boundary test in Node (no Obsidian needed)
just e2e         # full contract + rendering suite in a REAL sandboxed Obsidian (Xvfb)
just e2e-cli     # contract checks via the official Obsidian CLI (skips if not activated)
```

Requirements: Node + pnpm, the Rust toolchain with `wasm-pack` and the `wasm32-unknown-unknown` target, and `just`. CI runs all tiers on every push.

## License

MIT

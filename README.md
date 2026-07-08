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

**1. Make a block.** Create a note and paste this:

````markdown
```mica
:::tabs
:::tab Overview
This is the **first** tab — regular Markdown works here: lists, links, code, and callouts.

> [!tip] Callouts render normally inside tabs.
:::
:::tab Details
Second tab. Switch between tabs by clicking the tab bar (or arrow-keys when focused).
:::
:::
```
````

Switch to **Reading view** or **Live Preview** and you'll see a tabbed block.

**2. Turn on versioning.** Run the command **`Mica: Prepare note for Mica (add ids)`** (Ctrl/Cmd-P → type "Mica"). This stamps each block with a stable id and adds a `mica-id` to the note's frontmatter. Now every save snapshots your blocks.

**3. Edit and compare.** In Live Preview, click **✎ Edit** on a tab to edit it in place. After a couple of edits, click the **`v2 ●`** chip under the block → the compare window opens with your history.

> **Already using `obsidian-tabs`?** Skip straight to [Migrating](#migrating-from-obsidian-tabs) — one command converts a note (or your whole vault) and turns your manual "archived" callouts into real version history.

---

## Writing blocks

A Mica block is a fenced code block tagged `mica`:

````markdown
```mica id=0192abcd name="Review Instruments"
… structure goes here …
```
````

- `id=` — a stable UUID (added for you by **Prepare note for Mica**). Versioning and the API address blocks by this id; it survives renames and moves.
- `name=` — an optional human label (quote it if it has spaces).

Inside the block, structure uses **colon-fence directives**, so nesting adds colons — never more backticks:

| Directive                  | What it does                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `:::tabs` … `:::`          | A tab group.                                                   |
| `:::tab Title` … `:::`     | One tab (the title shows on the tab bar).                      |
| `:::grid {cols=3}` … `:::` | A responsive grid / menu.                                      |
| `:::cell` … `:::`          | One grid cell.                                                 |
| `> [!note] …`              | Any Obsidian callout — rendered natively, no special handling. |

Everything between the directives is ordinary Markdown. **Nest freely** — a grid of tabs, tabs inside a tab, callouts anywhere. To go deeper, use more colons on the outer container (`::::tabs` wraps `:::tab`), exactly like Obsidian's own fence rules. Mica sizes the outer ` ```mica ` fence for you, so you never count backticks again.

### The three view modes

Mica works in all of Obsidian's modes, and you choose per note:

- **Reading view** — fully rendered, read-only tabs/grids; switch tabs, open history.
- **Live Preview** — rendered tabs you can **edit in place** (the ✎ button). Click _into_ a block to drop to raw source; click away and it re-renders.
- **Source mode** — plain Markdown. Everything round-trips byte-for-byte; nothing is hidden or rewritten behind your back.

---

## Versioning

Once a block has an id, Mica keeps its history automatically.

- **Auto-snapshots.** A short while after you stop typing, each changed block is snapshotted. Unchanged blocks are never re-stored, so history stays clean.
- **Where it lives.** Next to `My Note.md`, Mica creates a visible `My Note.mica/` folder holding your version objects (plain Markdown files), an append-only `ledger.jsonl`, and a `manifest.json`. It's human-readable, and it rides Obsidian Sync / Git like any other file.
- **The version chip.** Under each rendered block sits a `v<count>` chip. A dot (`v3 ●`) means the block has unsaved changes vs. its last snapshot. Click the chip to open **Compare**.

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

- **Snapshot debounce** — idle time before an auto-snapshot (500–10000 ms).
- **Default diff granularity / mode** — what the compare window opens with.
- **Show version chip on blocks** — toggle the per-block chip.
- **Reconcile history on startup** — scan for orphaned/moved histories when the vault opens.
- **Version callout types (migration)** — which callout types import as history (default: all built-in types; empty = any).

Everything visual is themeable via CSS custom properties on `.mica` (see `styles.css`) — the [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) plugin or your theme can override them.

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

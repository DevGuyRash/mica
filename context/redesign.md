# Mica v0.2 — Ground-up UX revamp blueprint

> Working doc for the v0.2 rebuild. Durable outcomes graduate to PRD/DESIGN/ARCHITECTURE
> when shipped. Findings below come from a live computer-use walkthrough (2026-07-12)
> plus a full code read.

## Walkthrough findings (what "clunky" concretely means)

| #   | Finding                                                                           | Root cause                              |
| --- | --------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Active tab illegible under real themes                                            | state = subtle bg change only           |
| 2   | Editing = bare `<textarea>`; no toolbar/highlight/preview                         | plain textarea editor                   |
| 3   | First click often doesn't open editor ("two-click tango")                         | click/selection/reveal races            |
| 4   | Blur silently commits (stuck-key garbage got written); Manual mode = no pre-image | commit-on-blur + no pre-snapshot        |
| 5   | Editor opens off-screen; Save/Cancel move as textarea grows                       | bottom action bar + no scroll-into-view |
| 6   | Versions are anonymous ("v14"/"v15", no time/label/preview)                       | dropdown-only compare modal             |
| 7   | Diff renders lines glued ("a:::"); `:::` plumbing leaks                           | diffView bug + no directive filtering   |
| 8   | Branch-edit modal = another bare textarea with raw plumbing                       | same                                    |
| 9   | No editability indicator; reading vs LP look identical                            | no mode affordance                      |
| 10  | Caret inside block ⇒ whole block flips to raw source                              | reveal-on-overlap on any selection      |
| 11  | Grid cells nearly invisible; grid controls always-on noise                        | weak borders, static action bars        |
| 12  | Can't insert prose between containers; ghost only when empty                      | renderNodes limitation                  |
| 13  | Reading/LP don't share active tab; mode flip resets state                         | reading renderer has no ui state        |
| 14  | Footer heavy on every block (Auto pill + Save + chip)                             | always-on footer                        |
| 15  | Tab overflow scrolls with no "see all"; + hidden at end                           | nav overflow design                     |

Also: DnD is HTML5-drag, tab↔tab / cell↔cell only, no group drag, no keyboard path,
no auto-scroll, weak ghost. (Rewrite mandated by user regardless.)

## Design decisions (v0.2)

### 1. One editor component, three doors

`MicaEditor` = CodeMirror 6 (bundled `@codemirror/lang-markdown` + `@lezer/markdown`;
shares Obsidian's externalized `@codemirror/state|view|language`) + markdown toolbar

- optional live preview pane (MarkdownRenderer).

* **Quick edit** (click a region): compact CM6 inline editor, mini toolbar, action bar
  pinned on TOP (no moving targets), Expand button → lightbox.
* **Lightbox** (Expand, Ctrl/Cmd+click a region, header menu, branch-edit): near-full-screen
  modal — full toolbar, editor ⇄ preview (toggle side-by-side), word count, Save / Cancel,
  Ctrl+Enter saves, Esc = double-tap-to-discard when dirty.
* Toolbar verbs: bold, italic, strikethrough, highlight, inline code, H1–H3, link,
  wikilink, bullet/numbered/task list, blockquote, **callout picker** (ALL Obsidian types
    - fold ±, + Admonition custom types read at runtime, searchable, with icons),
      **codeblock w/ language picker**, table, hr. All are selection-aware toggles.
* Nesting-correct by construction: callout-in-callout adds `>` depth; codeblock fence
  length auto-grows to exceed inner fences (core already sizes the outer mica fence).

### 2. Editing lifecycle (bulletproof)

- NO commit-on-blur. Save = button / Ctrl+Enter only. Esc cancels (double-tap when dirty).
- Drafts live on `plugin.micaUi` keyed by block id: widget rebuilds / mode flips reopen
  the editor with the draft intact.
- Pre-image guarantee: before an inline commit on a block whose head ≠ current content,
  snapshot first (closes the Manual-mode data-loss hole; API `block.update` already does this).
- Editors scroll themselves into view on open.

### 3. Block chrome (`blockShell`)

- **Header** (hover-revealed by default; setting: hover/always/never): name (click-rename →
  fence `name="…"`), navigator (tree popover: jump/reorder), overflow menu
  (Edit source, Block appearance, Copy/Export, History, Save version, Collapse).
- **Footer** quiet: right-aligned version chip + dirty dot only. Auto/Manual + interval move
  into the chip's menu. Save-version button only in manual mode. Global + per-block hide.
- **Tabs**: active = accent fill + underline bar (legible on any theme), hover ×, double-click
  rename (also via context menu), + after last tab, overflow → edge fades + "⌄" all-tabs
  menu (searchable). Optional per-tab icon `tab: Title {icon=rocket}`.
- **Grid**: real cell borders, hover cell toolbar (grip/edit/×), ghost "+ cell" tile at end,
  grid toolbar (cols chip popover, gap) on hover top-right.
- **Insert-between**: slim hover + line between ANY siblings (root, tab body, cell):
  Tabs / Grid / Callout / Code / Prose.
- **Mode affordance**: editable blocks show a pencil glyph in header; reading shows book.
  `data-mica-mode` attr for CSS.
- Reading & LP share `micaUi` by block id → active tab survives mode flips. Reading gets
  same shell minus editing verbs.

### 4. DnD v2 (pointer-based, one engine)

- pointerdown (+5px threshold) on: tab chip, cell grip, group grip (new) → ghost clone
  follows pointer; insertion LINES between siblings; spring-loaded tabs (hover 400ms
  activates); "into" highlight for empty containers; auto-scroll near viewport edges;
  Esc cancels. All drops = one `moveNode` op (groups included).
- Keyboard: Alt+←/→ (tabs) & Alt+↑/↓ (cells) reorder; documented in README.
- No HTML5 drag events anywhere.

### 5. Versions panel (replaces DiffModal)

- Left timeline: label (editable), relative time, origin badge (auto/manual/migrated/branch),
  first-line preview, branch parent glyph; "Working copy" pseudo-entry when dirty; head pinned.
- Right: diff surface — Base picker (previous / head / pick), inline / side-by-side / patch,
  granularity; layout-syntax lines rendered dimmed (toggle).
- Per-version actions: Restore, Branch-edit (lightbox), Label, Copy content, Copy patch.
- Fix diffView line-joining bug. Keyboard: ↑/↓ select, Enter actions.

### 6. Customization v2

- Keep one-accent CSS-var architecture. Add per-block fence attrs
  (`accent= density= tabstyle= radius=`) applied as inline vars on the widget; GUI via
  header → Block appearance.
- Settings: theme gallery cards w/ live mini-preview, new themes (Carbon, Cyber, Solar),
  all knobs emit CSS vars documented in styles.css header; "Copy CSS snippet".
- Per-tab icons (lucide) via title attrs; icon picker in tab context menu.

### 7. Safety

- Destructive ops (delete tab/cell/group) → Undo toast (10s) instead of window.confirm;
  undo = inverse dispatch (CM undo also works).
- All writes remain live-rescan `{from,to,insert}` — unchanged invariant.

### 8. Standalone CLI (`mica`), shared core

- Workspace: `crates/mica-core` (+ new `ops.rs` ported reducer w/ factories + tests,
  `snapshot.rs` pure snapshot decisions) and NEW `crates/mica-cli` (clap, native).
- One reducer: TS `cst/ops.ts` becomes a thin wrapper over core `apply_op` (wasm export).
- CLI verbs (vault-file direct, no Obsidian): `ls`, `cat`, `set`, `tab add/rm/rename/mv`,
  `cell add/rm/mv`, `grid cols`, `versions list/show/diff/patch/restore/label`,
  `snapshot`, `watch` (daemon: auto-snapshot while Obsidian closed), `migrate scan/run`,
  `repair`, `prepare`, `doctor`. `--json` for scripting; sidecar format byte-compatible
  with the plugin. Vault root autodiscovery (walk up to `.obsidian`).

### 9. Beyond-the-ask features (shipping in v0.2)

- Block navigator popover (tree of tabs/grids/cells; click = jump; drag = reorder).
- Commands: "Insert Mica block", "Wrap selection in Mica block", "Add tab to current block",
  "Open block in lightbox", "Toggle block collapse".
- Per-tab word counts in navigator; block word count in header tooltip.
- Copy/duplicate tab; "Move tab to its own block"; export block/tab to clipboard.
- Collapsible blocks (state in micaUi; optional `collapsed` fence attr).
- Spring-loaded tabs during drag (drop into another tab's body).

## Non-goals for v0.2

- WYSIWYG rich-text editing (markdown stays visible in editors).
- Mobile-specific layouts (CSS keeps degrading gracefully; dedicated pass later).
- zstd sidecar compression & chunking (unchanged plan, still deferred).

## Verification gate (all must pass before "done")

cargo tests (incl. new ops/snapshot/CLI), pnpm smoke, typecheck+lint, wdio e2e,
CLI integration script vs a fixture vault, live Obsidian walkthrough of: create → edit
(quick + lightbox + toolbar + callout/codeblock incl. nested) → drag tab/cell/group →
versions timeline (restore/branch/label) → per-block appearance → reading-mode parity.

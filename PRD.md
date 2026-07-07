# Mica — Product Requirements (PRD)

> Living document. The vision and full feature set — what we build toward. Pairs with `ARCHITECTURE.md` (how) and `DESIGN.md` (UX & syntax).

## 1. Problem

Users author rich, deeply structured notes (prompt engineering, playbooks, specs) with the `obsidian-tabs` plugin and hit three walls:

1. **Corruption.** The tab editor's periodic autosave appends/duplicates content instead of replacing it, because it feeds a stale cached line offset into a range replace. Deeply nested code fences make it worse.
2. **Manual, drift-prone versioning.** A version is hand-synced across frontmatter, a callout title, and the content body; old versions are copied by hand into "Archived" tab sections.
3. **Monolithic notes.** All versions and variants accumulate in one file — the largest real note is 701 KB / 13,385 lines — degrading search, editing, and navigation.

## 2. Vision

**Mica is a versioned, structured content-block system for Obsidian.** Tabs and grids are _views_ over addressable, versioned **blocks**. Content stays markdown-native and portable; history is real, diffable, and externalized; the corruption class of bug is structurally impossible; and the whole system is drivable by API for humans and AI agents alike.

Design values, in priority order: **correctness → speed → intuitive UX → deep customizability → portability.**

## 3. Users & modes

Mica serves three ways of working, matching Obsidian's own view modes:

- WHEN a note is in **Reading view** THEN Mica SHALL render fully-interactive, read-only tabs/grids (switch tabs, view versions and diffs).
- WHEN a note is in **Live Preview** THEN Mica SHALL render tabs/grids as inline-editable widgets with GUI affordances.
- WHEN a note is in **Source mode** THEN Mica SHALL show raw, hand-editable markdown and round-trip it losslessly.

Non-coders can live entirely in Reading/Live Preview; power users and agents can drive everything via markdown or API.

## 4. Feature set

### 4.1 Blocks, tabs, grids

- A `mica` block is a fenced code block carrying a stable UUID.
- Layout primitives — tab groups, grids/menus, cells, callouts — nest arbitrarily via colon-fence directives, without increasing backtick depth.
- Mica auto-computes fence lengths so nesting never corrupts and users never count backticks.

### 4.2 Versioning (first-class)

- Every change to a block snapshots the prior content as an immutable, content-addressed object in a co-located sidecar.
- Cycle between versions; revert; edit a previous version in place (branch by default, amend on request); view lineage.
- Auto version-bump for template-derived blocks.

### 4.3 Diffing (Meld-class)

- Char-, word-, and line-level diffs with intra-line emphasis.
- Compare up to three versions at once against a swappable base.
- Modes: inline, side-by-side, N-up, swap-base, patch (unified diff).

### 4.4 Identity & self-healing

- Identity is content-carried (block UUID in the fence; note `mica-id` in frontmatter), so history survives rename/move — even outside Obsidian.
- Reconciliation heals orphans, duplicates, and merge divergence without ever rewriting immutable history.

### 4.5 Scriptable API

- The full feature set is reachable through `window.mica`, the command palette, and a file-bridge (inbox/outbox JSON) so AI agents and scripts can drive it headlessly on desktop, mobile, and over Sync. An optional desktop loopback exposes a true `mica` shell CLI.

### 4.6 Migration

- One command converts existing `tabs` files to Mica and imports their manual archives as real version history, with dry-run and rollback.

### 4.7 Customization

- Everything visual is themeable via CSS custom properties; behavior is configurable via settings; syntax and API are stable contracts.

## 5. Non-goals (for now)

- Not a general Git replacement; history is per-block, in-vault, markdown-native.
- Not a real-time collaborative editor.
- Not a markdown-inline parser — Obsidian renders markdown; Mica parses _structure_.

## 6. Success criteria

- The corruption bug is impossible by construction (a regression test proves it).
- A 13k-line note edits and scrolls at 60 fps; typing triggers zero WASM calls.
- The 46 real tabs files migrate losslessly with archives imported as history.
- Every palette action is reachable headlessly by UUID through the API.

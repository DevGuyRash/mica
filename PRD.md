# Mica — Product Requirements (PRD)

> Forward-looking product document — what Mica builds toward, not a claim that
> every item ships in the current release. Current behavior is documented in
> `README.md` and `ARCHITECTURE.md`; planned or not-yet-verified items are marked
> explicitly below.

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
- Layout primitives — tab groups, grids/menus, cells, callouts — nest through 128 structural levels via colon-fence directives, without increasing backtick depth. Deeper input remains byte-exact but is treated as opaque content.
- Mica auto-computes fence lengths so nesting never corrupts and users never count backticks.
- WHEN a user inserts a grid THEN Mica SHALL create an empty two-column grid and SHALL present an explicit first-cell affordance without opening an editor.
- WHEN a user copies a block, group, tab, grid, cell, section, callout, nested callout, or folded unit THEN Mica SHALL preserve standard Markdown content and SHALL remove Mica layout wrappers by default.
- WHEN “Include Mica layout syntax” is enabled THEN Mica SHALL preserve the selected unit's exact recognized `tab:` and `:::` wrappers.
- WHEN “Wrap copies in an outer Mica block” is enabled THEN Mica SHALL use an identity-free fence longer than any inner backtick run and SHALL NOT copy the source block id.
- WHEN Mica removes structural wrappers THEN Mica SHALL preserve nonblank authored whitespace and source line endings and SHALL retain one semantic blank-line boundary between adjacent nonempty structural children.

### 4.2 Versioning (first-class)

- Semantic content changes snapshot the prior content as an immutable, content-addressed object in a co-located sidecar; structure-only layout changes intentionally do not create versions.
- Cycle between versions; revert; edit a previous version as a branch; view lineage. **Planned:** explicit amend-in-place.
- **Planned:** auto version-bump for template-derived blocks.

### 4.3 Diffing (Meld-class)

- Char-, word-, and line-level diffs with intra-line emphasis.
- Compare up to four versions at once against a swappable base.
- Modes: inline, side-by-side, N-up, swap-base, patch (unified diff).

### 4.4 Identity & self-healing

- Identity is content-carried (block UUID in the fence; note `mica-id` in frontmatter), so history survives rename/move — even outside Obsidian.
- Reconciliation heals orphans, duplicates, and merge divergence without ever rewriting immutable history.

### 4.5 Scriptable API

- Core block editing, versioning, migration, preparation, and repair are reachable through `window.mica` and a file bridge (inbox/outbox JSON). The standalone `mica` CLI provides the native shell surface. Physical-mobile and two-device Sync behavior remain release-time manual verification gates.

### 4.6 Migration

- One command converts existing `tabs` files to Mica and imports their manual archives as real version history, with dry-run and rollback.

### 4.7 Customization

- Everything visual is themeable via CSS custom properties; behavior is configurable via settings; syntax and API are stable contracts.

## 5. Non-goals (for now)

- Not a general Git replacement; history is per-block, in-vault, markdown-native.
- Not a real-time collaborative editor.
- Not a markdown-inline parser — Obsidian renders markdown; Mica parses _structure_.

## 6. Acceptance status

- **Implemented and regression-tested:** live edits use guarded, freshly scanned ranges instead of cached document offsets.
- **Partially verified:** cursor-only transactions skip WASM. A sustained 60 fps claim for the 13k-line note still needs a recorded performance run on release hardware.
- **Not verified from this repository:** the external 46-file legacy corpus migrates losslessly. The checked-in migration fixtures and synthetic regressions are the current automated evidence.
- **Implemented for the documented core API:** UUID-addressed block/version verbs, migration, preparation, and repair. UI preferences and presentation-only actions are not claimed as headless API surface.

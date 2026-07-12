# Mica — Design (UX & Syntax)

> Living document. How Mica looks, feels, and reads. Pairs with `PRD.md` and `ARCHITECTURE.md`.

## Principles

- **Affordances first.** Every interactive element looks interactive; state (active tab, dirty, version) is always visible.
- **Three doors, one room.** Reading, Live Preview, and Source are views of the same block; nothing is lost switching between them.
- **Never surprise the file.** What Mica writes is diff-clean, style-preserving, and byte-stable when nothing changed.
- **Customizable to the pixel.** Visuals via CSS custom properties; behavior via settings; syntax and API are stable contracts.

## Syntax

A Mica block is a fenced code block tagged `mica` with a header attribute list:

<pre>
```mica id=&lt;uuidv7&gt; name="…"
</pre>

**Tabs use the friendly, closer-free `tab:` delimiter** — a `tab: Title` line at column 0 starts each tab, running until the next `tab:` (no closing fence). This is the primary syntax and matches the obsidian-tabs feel. For everything else (and for nesting), **colon-fence directives** are available:

- `tab: Title` — the everyday way to write a tab. No closer.
- `:::grid {cols=3 gap=8}` … `:::` — a grid/menu of `:::cell` … `:::`.
- `:::tabs` … `:::` with `:::tab Title` … `:::` — the explicit form, used to NEST a tab group inside a tab (the flat `tab:` delimiter can't express nesting). Deeper nesting uses more colons (`::::tabs` wraps `:::tab`).
- Callouts use Obsidian's native `> [!type]` syntax, unchanged, inside any body.

Rules (testable):

- WHEN Mica serializes a block THEN the outer ` ```mica ` fence length SHALL be strictly greater than every inner code fence it contains.
- WHEN a block is parsed and re-serialized with no intervening edit THEN the output SHALL equal the input byte-for-byte (both `tab:` and `:::` forms).
- The version marker SHALL NOT live in the block body or title; the block `id` plus the sidecar ledger are the source of truth.

### Before / after

`obsidian-tabs` (backtick-nested, version hand-synced in the title):

<pre>
`````tabs
tab: Kernel
> [!success]- Review Kernel (V1.0)
> ````md
> …
> ````
`````
</pre>

Mica (same friendly `tab:` syntax; version tracked in history, not the title):

<pre>
```mica id=0192f4a1-…-7c name="Review Instruments"
tab: Kernel
> [!success] Review Kernel

…
```
</pre>

## Tab & grid UX

- Tab bar: keyboard-navigable (arrows, Home/End; Alt+arrows REORDER), ARIA roles,
  active state legible on any theme (accent underline + fill), optional per-tab
  Lucide icons, an all-tabs menu when the strip overflows.
- Grids: responsive columns from `{cols}`; visible cell borders; hover tools
  (grip / delete); a ghost "+" tile adds the next cell; the cols chip edits count.
- Direct manipulation: pointer drag for tabs, cells, and whole groups with live
  insertion indicators, spring-loaded tabs, auto-scroll, Esc cancel. Insert-between
  zones put prose/callouts/code/groups anywhere. Deletes offer Undo, never confirms.
- Every block has a hover header: name, navigator tree (jump anywhere), ⋮ menu,
  collapse. A pencil/book glyph says whether THIS view can edit.

## Editing UX

- One CodeMirror 6 markdown editor everywhere: the in-place quick editor (pinned
  action bar on top, mini toolbar) and the full-screen lightbox (full toolbar,
  live preview pane, word count).
- The toolbar's callout picker lists every Obsidian type AND the Admonition
  plugin's custom types, with fold modes and an optional title; the code-block
  picker sizes fences to out-nest their content.
- Save is explicit (button / Ctrl+Enter). Esc double-taps to discard when dirty.
  Blur never commits. Drafts survive rebuilds and mode flips.

## Versioning UX

- A per-block version affordance (chip/dropdown) shows the current label and count; cycling is keyboard-friendly.
- "Edit previous version" opens the chosen version in place; saving branches by default (a clear toggle offers amend).
- A live gutter indicator marks lines changed since the last snapshot (git-gutter style).

## Diff UX

- A diff surface compares up to three versions against a highlighted **base** the user can swap.
- Modes: inline (single column, ± with intra-line emphasis), side-by-side (2-up), N-up (≤ 3 columns), patch (copyable unified diff).
- Granularity toggle: line / word / char. Non-color status cues (icons/underlines) for accessibility.

## Customization surface

- Ten themes in a live-preview gallery; one accent drives everything; CSS custom
  properties under `.mica` for anything finer (Style Settings compatible).
- Per-block overrides (accent / density / tab style / radius / name) live as
  fence-header attrs, edited from the block's ⋮ menu — they travel with the note.
- Settings: snapshot debounce, diff defaults, version chip, block-header mode
  (hover/always/never), density, radius, tab style, animations, editor sizing.

## Accessibility

- Full keyboard operation for tabs, versions, and diffs; ARIA roles throughout; never color-only status; respects reduced-motion.

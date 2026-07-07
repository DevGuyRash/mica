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

Structure inside a block uses **colon-fence directives** (Pandoc/MyST-style), so nesting adds colons, not backticks:

- `:::tabs` … `:::` — a tab group. Each tab is `:::tab &lt;Title&gt;` … `:::`.
- `:::grid {cols=3 gap=8}` … `:::` — a grid/menu of `:::cell` … `:::`.
- Callouts use Obsidian's native `> [!type]` syntax, unchanged, inside any body.
- Deeper nesting uses more colons (`::::tabs` wraps `:::tab`), exactly like the CommonMark fence rule.

Rules (testable):

- WHEN Mica serializes a block THEN the outer ` ```mica ` fence length SHALL be strictly greater than every inner code fence it contains.
- WHEN a block is parsed and re-serialized with no intervening edit THEN the output SHALL equal the input byte-for-byte.
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

Mica (colon-nested, version tracked in history):

<pre>
```mica id=0192f4a1-…-7c name="Review Instruments"
:::tabs
:::tab Kernel
> [!success] Review Kernel

…
:::
:::
```
</pre>

## Tab & grid UX

- Tab bar: keyboard-navigable (arrow keys, Home/End), ARIA `tablist`/`tab`/`tabpanel`, active state via `--mica-tab-*` vars.
- Grids: responsive columns from `{cols}`, collapsing gracefully on narrow panes.
- Live Preview: click a tab to switch; edit its body inline; a subtle dirty indicator shows uncommitted changes vs the current version.

## Versioning UX

- A per-block version affordance (chip/dropdown) shows the current label and count; cycling is keyboard-friendly.
- "Edit previous version" opens the chosen version in place; saving branches by default (a clear toggle offers amend).
- A live gutter indicator marks lines changed since the last snapshot (git-gutter style).

## Diff UX

- A diff surface compares up to three versions against a highlighted **base** the user can swap.
- Modes: inline (single column, ± with intra-line emphasis), side-by-side (2-up), N-up (≤ 3 columns), patch (copyable unified diff).
- Granularity toggle: line / word / char. Non-color status cues (icons/underlines) for accessibility.

## Customization surface

- CSS custom properties under `.mica` (see `styles.css`) — override in a theme or the Style Settings plugin.
- Settings (M3+): autosave/debounce, snapshot cadence, sidecar visibility, default diff granularity, default edit mode (branch/amend), theming presets.

## Accessibility

- Full keyboard operation for tabs, versions, and diffs; ARIA roles throughout; never color-only status; respects reduced-motion.

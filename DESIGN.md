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
- Settings (shipped): snapshot debounce, default diff granularity, default diff mode (inline / side-by-side / patch), version-chip visibility, reconcile-on-startup. Future: sidecar location, theming presets.

## Accessibility

- Full keyboard operation for tabs, versions, and diffs; ARIA roles throughout; never color-only status; respects reduced-motion.

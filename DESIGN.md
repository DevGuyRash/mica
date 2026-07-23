# Mica — Design (UX & Syntax)

> Forward-looking design document. Current behavior is described directly;
> unshipped proposals are marked **Planned**. Pairs with `PRD.md` and
> `ARCHITECTURE.md`.

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
- `:::tabs` … `:::` with `:::tab Title` … `:::` — the explicit form, used to NEST a tab group inside a tab (the flat `tab:` delimiter can't express nesting). Deeper nesting uses more colons (`::::tabs` wraps `:::tab`), through the 128-level structural safety limit.
- `:::section` … `:::` — a reversible logical wrapper created when compatible Markdown sections are combined or when one prose editor save contains multiple paragraph-level leaves. It preserves the enclosed paragraph/source boundaries; uncombine removes the wrapper without rewriting the children. Its colon run is strictly longer than any closer-like colon-only line in its payload.
- Callouts use Obsidian's native `> [!type]` syntax, unchanged, inside any body.
- Code sections use standard backtick or tilde fences with an optional language/info string, unchanged.

Rules (testable):

- WHEN Mica serializes a block THEN the outer ` ```mica ` fence length SHALL be strictly greater than every inner code fence it contains.
- WHEN Mica promotes a multi-paragraph prose edit into one logical section THEN it SHALL size the `section` fence strictly above every closer-like colon run in the payload and SHALL NOT nest another `section` wrapper around an existing one.
- WHEN a block is parsed and re-serialized with no intervening edit THEN the output SHALL equal the input byte-for-byte (both `tab:` and `:::` forms).
- The version marker SHALL NOT live in the block body or title; the block `id` plus the sidecar ledger are the source of truth.
- WHEN `name=` is absent THEN the UI SHALL derive the note-basename label and unnamed ordinal for presentation only; it SHALL NOT persist or resolve that fallback as block identity.

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
  (copy / grip / delete); a newly inserted grid starts empty with one ghost "+"
  tile in its first slot; choosing a content type creates the first cell; the
  cols chip edits count.
- Direct manipulation: pointer drag for tabs, cells, sections, and whole groups
  with live insertion indicators, spring-loaded tabs, auto-scroll, Esc cancel.
  A stationary central dwell over a compatible Markdown section transforms the
  insertion line into a themeable full-target border/tint/glow with a large `+`;
  drop combines target-first. Section menus expose previous/next compatible
  actions as the keyboard/touch path. Insert-between zones put
  prose/callouts/code/groups anywhere. Deletes and structural transforms offer
  conflict-guarded Undo, never confirms.
- Every block has a hover header: name, navigator tree (jump anywhere), ⋮ menu,
  copy, collapse. A pencil/book glyph says whether THIS view can edit. Copy also
  appears in the existing hover/touch tools for groups, tabs, cells, sections,
  callouts, nested callouts, nested code, combined sections, and folded units in
  Reading and Live Preview.

## Editing UX

- One reconfigurable CodeMirror 6 editor everywhere: the in-place Markdown
  source editor (pinned action bar on top, mini toolbar) and the shared
  full-screen lightbox (live preview pane, word/character count). Structured
  callout and code-block variants reuse that lightbox; code exposes an optional
  language/info field, language-aware colors, and a fence-free body.
- The toolbar's callout picker lists every Obsidian type AND the Admonition
  plugin's custom types, with fold modes and an optional title; the code-block
  picker sizes fences to out-nest their content.
- Content kind and editor view are separate: Markdown/callout/code is derived
  from standard source syntax, while rendered/source is a transient view axis.
  The section menu performs explicit, undoable conversions and names metadata
  that is removed. Rendered Markdown itself has no editor state.
- Fenced code quoted inside a callout receives the same copy/drag/delete/expand
  tools when its source range maps one-to-one to Obsidian's native render;
  ambiguous processor output intentionally falls back to the parent editor.
- Save is explicit (button / Ctrl+Enter). Esc double-taps to discard when dirty.
  Blur never commits. Drafts survive rebuilds and mode flips.

## Versioning UX

- A per-block version affordance (chip/dropdown) shows the current label and count; cycling is keyboard-friendly.
- "Edit previous version" opens the chosen version in place and saving creates a branch. **Planned:** an explicit amend toggle.
- **Planned:** a live gutter indicator for lines changed since the last snapshot.

## Diff UX

- A diff surface compares up to four versions against a highlighted **base** the user can swap.
- Modes: inline (single column, ± with intra-line emphasis), side-by-side (2-up), N-up (≤ 4 columns), patch (copyable unified diff).
- Granularity toggle: line / word / char. Non-color status cues (icons/underlines) for accessibility.

## Customization surface

- Ten themes in a live-preview gallery; one accent drives everything; CSS custom
  properties under `.mica` for anything finer (Style Settings compatible).
- Per-block overrides (accent / density / tab style / radius / name) live as
  fence-header attrs, edited from the block's ⋮ menu — they travel with the note.
- Settings: snapshot debounce, diff defaults, version chip, block-header mode
  (hover/always/never), responsive or menu-only rendered actions, density,
  radius, tab style, animations, copy syntax / outer-container modes, editor sizing.
- Section-combine feedback is theme-owned through `--mica-combine-*` custom
  properties (ring, fill, glow, plus, timing), with a static reduced-motion
  presentation.

## Accessibility

- Tab, navigator, version, diff, responsive entity, and editor-toolbar controls have keyboard paths and labelled controls; status is not color-only and reduced-motion is respected.

# AGENTS.md — foundational engineering rules for Mica

WHEN beginning nontrivial work THEN you SHALL read `ARCHITECTURE.md` for the
current system design, `RELEASING.md` for release procedures when relevant,
and `state.md` for unresolved work and active risks. This file contains only
durable decision rules. It is not an incident log, changelog, selector catalog,
or place for version-specific workarounds.

WHEN a lesson applies only to one completed bug or environment THEN you SHALL
put it in a regression test, the relevant code comment, or nowhere. WHEN a
lesson changes how future work should be designed or verified THEN you SHALL
distill the invariant here.

## Verification is risk-scaled

Fast feedback belongs in the inner loop; release confidence comes from the
whole product.

WHEN changing Rust behavior THEN you SHALL use RED → GREEN → REFACTOR: add or
identify a failing test, confirm that it fails for the intended reason, make
the smallest correct change, and rerun the focused suite before broader gates.

WHEN changing TypeScript, CSS, WASM boundaries, persistence, editing, or UI
behavior THEN you SHALL run:

```sh
pnpm run check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
pnpm run build
xvfb-run -a pnpm run e2e
```

WHEN claiming release readiness THEN you SHALL additionally run:

```sh
cargo build --release -p mica-cli --locked
pnpm run smoke
pnpm run check:release:assets
pnpm audit --audit-level high
cargo deny check advisories
xvfb-run -a pnpm run e2e:mobile
xvfb-run -a pnpm run e2e:minimum
xvfb-run -a pnpm run e2e:latest
```

WHEN a change is documentation-only and does not alter a command, contract, or
generated artifact THEN you MAY limit verification to formatting, link/path
inspection, and `git diff --check`. You SHALL NOT call a partial gate evidence
for runtime or release readiness.

## One authority per concern

Mica stays reliable by refusing competing implementations.

- Structural truth lives in the Rust CST and reducer.
- Live note text is the authority at mutation time.
- Exact CST source is the authority for source-preserving projections.
- Persisted sidecar objects and ledger events are verified at their storage
  boundary.
- Rendered DOM is a view, never a serialization format or data source.

You SHALL NOT add a second parser, serializer, structural mutator, identity
resolver, or history interpretation in TypeScript.

WHEN adding a structural mutation THEN you SHALL express it as a `StructOp`,
apply it through `mica-core::ops`, mirror its tagged serde shape in
`src/cst/ops.ts`, rebuild WASM, and test the same operation through every
consumer that exposes it.

WHEN applying an edit THEN you SHALL re-scan the live document, resolve the
target unambiguously, reduce against a fresh parse, and dispatch one guarded
replacement. You SHALL NOT write from cached offsets or mutate a cached CST.

WHEN the UI and reducer disagree about whether an operation is legal THEN you
SHALL restore parity. You SHALL NOT let the UI advertise a no-op or rejected
operation; the reducer remains the final authority.

## Preserve bytes unless the user changed them

`parse → serialize` is byte-identical for an unedited tree. Leaves represent
contiguous source spans; containers own their exact opening and closing lines.

WHEN changing parsing, serialization, hashing, line handling, or structural
normalization THEN you SHALL pin current behavior first and keep round-trip
coverage for LF, CRLF, BOMs where supported, missing final newlines, deep
nesting, large documents, inner fences, and real-note fixtures.

You SHALL distinguish authored content from structural scaffolding:

- indentation, spaces, tabs, hard line breaks, code fences, callout quoting,
  and internal blank lines are content;
- whitespace-only leaves at a selected container's outer boundary may be
  scaffolding;
- adjacent projected sections need one semantic separation, not accumulated
  wrapper whitespace.

WHEN implementing copy, export, preview, or migration THEN you SHALL project
from the CST or exact source spans, never from `textContent`, rendered HTML, or
a lossy reparse.

WHEN a projection offers content, structural syntax, and an outer envelope
THEN you SHALL model them as independent transforms:

1. select exact source-backed content;
2. optionally retain recognized structure;
3. optionally add a fresh outer envelope.

WHEN generating an envelope THEN you SHALL omit source identity and appearance
metadata unless the operation explicitly promises cloning, and you SHALL size
its delimiters from the payload so nested fences cannot terminate it.

## Validate first, publish last

All note files, Mica blocks, sidecars, ledgers, migration journals, clipboard
payloads, and bridge messages are untrusted at their boundary.

WHEN an operation can write user data THEN you SHALL validate every
precondition before its first persistent side effect. Ambiguous identity,
duplicate live IDs, stale expected text, corrupt objects, conflicting
representations, unsafe paths, invalid sizes, or malformed events are invalid
preconditions; WHEN any is present THEN you SHALL fail closed.

WHEN overwriting mutable user data THEN you SHALL use an exact preimage or
generation guard. WHEN an operation is stale THEN you SHALL preserve both the
current data and the user's draft.

WHEN publishing multiple related effects THEN you SHALL make them atomic or
recoverable:

- you SHALL write replacement files atomically in their destination directory;
- you SHALL preserve relevant permissions and source conventions;
- you SHALL make immutable objects verifiable before publication;
- you SHALL serialize concurrent appenders;
- you SHALL isolate torn append tails before accepting new events;
- you SHALL journal resumable migrations against exact source generations;
- you SHALL roll back a published note if a required post-publication effect
  fails.

WHEN reading content-addressed or compressed data THEN you SHALL verify its
address and enforce compressed and decompressed size bounds before returning
it. You SHALL NOT follow symlinks through vault or sidecar trust boundaries.

WHEN handling an error THEN you SHALL make failure visible and preserve the
last known-good state. You MAY catch and ignore only explicitly best-effort
cleanup.

## Complexity is part of correctness

WHEN preparing an implementation plan THEN you SHALL identify whether the
changed path runs per keystroke, per cursor transaction, per pointer frame, per
render, per edit, per file, or per release. The hotter the path, the smaller
its allocation and scan budget.

WHEN touching a hot path THEN you SHALL state and verify its expected
time/space complexity. You SHALL prefer one pass and output-proportional space.
You SHALL NOT accept hidden quadratic behavior from repeated scans,
`shift()`, front insertion, nested serialization, cloning in fold loops, or
DOM queries inside geometry loops.

### Per keystroke and cursor transaction

WHEN a cursor-only transaction leaves block reveal state unchanged THEN you
SHALL reuse the previous decoration set. WHEN a document changes THEN you SHALL
scan it once and carry every downstream field needed by rendering and identity
logic in that result. Scan results are immutable aliases, not objects for
consumers to rewrite.

### Per pointer move and animation frame

WHEN a gesture starts THEN you SHALL collect structural membership, indices,
and stable elements once. During frame loops you SHALL re-read only geometry
that can move. You SHALL NOT query the DOM tree, parse attributes, allocate
candidate collections, or recompute after a scroll position has saturated.

WHEN computing drop targets THEN you SHALL describe visible, reachable
interaction space. A target behind clipping, scrolling, or sticky controls is
not a valid affordance. You SHALL clamp targets derived from partially visible
items to their visible interaction boundary, and you SHALL NOT create phantom
targets from completely offscreen items.

### Per edit, file, and history view

WHEN implementing normalization or reducer passes THEN you SHALL keep them
linear in the affected tree or output. You SHALL use maps for repeated identity
lookups, pre-size known collections, sort references instead of owned values,
stream into hashers, and build exact output capacity where practical.

WHEN a history or registry UI can grow with user data THEN you SHALL window or
page its collection. You SHALL NOT render or retain an unbounded number of rows
merely because the backing data is available.

WHEN maintaining a registry keyed by block ID, path, or document content THEN
you SHALL bound and sweep it. You SHALL NOT evict unsaved drafts
opportunistically.

WHEN proposing a performance optimization THEN you SHALL measure a
representative large input and keep semantic pin tests green. A smaller diff,
binary, or allocation count is not an improvement if it adds a second source
of truth or weakens failure behavior.

## UI behavior follows user intent

Creating structure and creating content are separate actions.

WHEN the user creates a container THEN you SHALL start with the smallest valid
empty structure unless the user explicitly selected initial content. You SHALL
NOT synthesize placeholder cells, prose, or editors merely to make the
container look populated.

Focus and reveal are effects of explicit user intent. WHEN an operation
creates only a container THEN you SHALL NOT target a nonexistent child or open
an editor. WHEN the user selects a content type THEN you MAY create that child
and focus its editor.

WHEN adding a read-only action such as copy, inspect, reveal, or navigate THEN
you SHALL expose it in both Reading view and Live Preview. You SHALL keep
mutation controls conditional on an editable context.

WHEN already-rendered controls depend on settings THEN you SHALL read the
current setting at activation time or use a deliberately invalidated render
epoch. You SHALL NOT capture a stale settings snapshot in a long-lived widget.

## Controls must survive every input mode

WHEN adding an actionable icon THEN you SHALL use a real `button` with a type,
accessible name, dedicated identity class, and stable semantic data attribute
when tests or integrations need to locate it. You SHALL use a separate base
class for shared visual styling.

WHEN a control sits inside another clickable or draggable surface THEN you
SHALL stop both its pointer-start and activation events as needed so copy,
delete, and menu actions cannot activate, fold, edit, or drag their parent.

WHEN a control is available by pointer THEN you SHALL provide a keyboard path.
WHEN hiding a control until hover THEN you SHALL keep it focusable, use opacity
and pointer-event state rather than `display: none`, reveal it on
`:focus-within`, and expose it without hover on coarse-pointer layouts.

Touch layout is not desktop layout at a smaller width. Persistent controls
consume interaction space. WHEN changing controls or layout THEN you SHALL
verify overflow, drag targets, sticky controls, and minimum target sizes under
a coarse pointer and narrow viewport.

## The host environment is adversarial

Mica renders inside CodeMirror, Obsidian, and arbitrary community themes.

WHEN adding light-DOM controls THEN you SHALL use Obsidian-compatible button
classes, explicit icon geometry, inherited design tokens, and opaque floating
surfaces. WHEN styling editor internals THEN you SHOULD keep them in the
shadow-root theme where host selectors cannot rewrite them.

WHEN adding markup THEN you SHALL add its styles and inspect it in the same
change. You SHALL NOT treat browser-default rendering as an acceptable
intermediate component.

WHEN solving overflow or stacking THEN you SHALL solve it at the owning
boundary. A descendant cannot out-z-index a sibling stacking context, and
content positioned outside a clipped owner is not reachable. WHEN adding an
overlay THEN you SHALL use the established layer tiers instead of arbitrary
z-index escalation.

The rendered widget is a `contenteditable=false` island inside editable
CodeMirror content. WHEN handling widget chrome THEN you SHALL account for
native caret placement as well as event propagation. WHEN deciding whether to
reveal raw source THEN you SHALL accept only user-driven selection
transactions.

Obsidian menus and overlays have their own lifecycle. WHEN an interaction
depends on pointer-start, focus restoration, outside dismissal, or exit
animation THEN you SHALL model the complete sequence in implementation and
tests, not only dispatch `.click()` or wait for a generic DOM node to exist.

## Structural DOM membership and gesture rules

Container membership is defined by the nearest owning container, not by
descendant selectors. WHEN collecting draggable children or drop slots THEN
you SHALL verify that each candidate's nearest container is the collector.

Friendly closer-free tab syntax absorbs following siblings. WHEN inserting or
moving content after such a group THEN you SHALL directivize or otherwise
guard the group before serialization.

WHEN a gesture is active THEN you SHALL make one suppression state own the UI,
and you SHALL hide insert zones, hover tools, and unrelated resizers in favor
of the active drag/resize indicator.

WHEN a pointer gesture ends THEN you SHALL clean up listeners, timers,
animation frames, classes, ghosts, and indicators on success, cancellation,
escape, teardown, and stale-target failure.

## Lifecycle ownership

WHEN anything outlives a function call THEN you SHALL give it an owner:

- WHEN a component owns an observer or listener THEN you SHALL register its
  teardown with the component.
- WHEN an element owns an observer THEN you SHALL disconnect it when the
  element leaves the DOM.
- WHEN adding a global listener THEN you SHALL remove it on every exit path.
- WHEN starting a timer or RAF loop THEN you SHALL provide an explicit
  cancellation path.
- WHEN adding a body-level overlay THEN you SHALL close it on teardown as well
  as user dismissal.

WHEN a widget rebuild destroys DOM without an explicit destroy callback THEN
you SHALL sweep disconnected entries rather than retaining them indefinitely.

## Code quality without ceremony

WHEN adding an abstraction THEN you SHALL ensure it removes real duplication
or protects an invariant.

WHEN a repeated operation has one meaning and at least three call sites THEN
you SHOULD extract one small helper. WHEN only two call sites are merely
similar THEN you SHOULD keep them local until their shared contract is proven.

You SHALL NOT split modules, add layers, introduce frameworks, or create
configuration merely to satisfy line-count aesthetics. File length is a
signal to inspect cohesion, not a defect by itself.

WHEN implementing a pure projection or policy THEN you SHOULD use a
dependency-free function with narrow types. WHEN introducing a side effect THEN
you SHOULD keep it in a thin adapter at a UI, filesystem, bridge, or process
boundary.

User-facing vocabulary is a contract. WHEN exposing one concept across
settings, menus, notices, documentation, and tests THEN you SHALL use one name.
You MAY retain a different internal implementation name where changing it
would add churn without user value.

WHEN writing comments THEN you SHALL explain invariants, ownership, complexity,
or non-obvious host contracts. You SHALL NOT preserve debugging chronology or
narrate the diff.

## Testing proves outcomes

WHEN adding or changing behavior THEN you SHALL verify it at the cheapest layer
that can contain the defect:

- pure projection and policy tests for exact input/output matrices;
- Rust reducer/parser tests for structural and byte-level invariants;
- integration tests for filesystem transactions and recovery;
- real-Obsidian tests for rendering, focus, input, themes, and lifecycle.

WHEN writing E2E assertions THEN you SHALL prefer persisted note text or public
plugin contracts over incidental DOM shape. You MAY use DOM assertions for
accessibility, visibility, and interaction availability.

WHEN querying the DOM in E2E THEN you SHALL scope the query to the active
Markdown view or an explicitly owned fixture root. Background leaves and
dismissed overlays may remain mounted.

WHEN selecting a menu or overlay in a test THEN you SHALL identify the current
instance semantically, not accept the first generic match. WHEN production
behavior depends on `pointerdown`, focus, keyboard routing, or dismissal THEN
you SHALL make the test dispatch that real sequence.

WHEN writing pointer or layout tests THEN you SHALL use fresh element geometry,
prove that the intended indicator or state became visible, and only then
release the gesture. You SHALL NOT release at stale or viewport-absolute
coordinates and wait for luck.

WHEN a UI intentionally transitions THEN you SHALL wait for the observable end
state rather than sample the first animation frame.

WHEN writing exact-output tests for projections THEN you SHALL cover the
orthogonal option matrix, empty content, nested containers, authored
whitespace, LF and CRLF, safe delimiter growth, identity omission, and the
supported depth limit.

WHEN scripting a source rewrite THEN you SHALL assert that every intended match
exists and is unique enough before replacement. A silent no-op rewrite is a
failed change.

## Shipping and active state

WHEN shipping through the GitOps workflow THEN you SHALL use its scripts for
sync, inventory, staged sensitive-data scanning, signed Conventional Commit
batches, push, and receipt generation. WHEN writing commit bodies THEN you
SHALL explain intent and outcome, not line-by-line mechanics.

You SHALL NOT infer permission to create or expose a remote repository. WHEN
no push destination exists THEN you SHALL finish safe local commits, report the
exact publication blocker, and request the remote or explicit repository
creation authority.

WHEN work becomes complete THEN you SHALL remove it from `state.md`. You SHALL
keep active state limited to unresolved work, future plans, and current risks;
durable system knowledge belongs in code, architecture documents, tests, or
this file.

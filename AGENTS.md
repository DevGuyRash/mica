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

## Review before promotion

WHEN starting new work THEN you SHALL commit and push it to the permanent
`review` branch first. Isolated work branches may integrate into `review`;
preserve existing work and history when switching or integrating branches.

WHEN `review` is ready THEN you SHALL open the entry's Obsidian Community
**Review branch** control, enter the full current `review` HEAD commit SHA, and
select **Run preview scan**. Record that SHA and the actual report. Every change
to `review` HEAD invalidates its earlier pass and requires a fresh preview.

UNTIL that exact SHA has an actual passing preview with zero errors and every
warning fixed or documented as intentional necessity with a reviewed reason
THEN you SHALL stop before opening the `review` → `main` PR, merging into
`main`, tagging, or publishing. Unreviewed warnings block promotion. Keep
recommendations and unverified optional capabilities or attestations explicit.
GitHub PR checks and local lint are separate evidence; neither is an Obsidian
preview result, and no Obsidian GitHub status name is assumed.

WHEN preparing the PR THEN you SHALL include the exact SHA and preview evidence
using the PR template. After merge, the release source and root manifest SHALL
match that reviewed candidate; content changes return through `review` and a
fresh preview. Follow [RELEASING.md](RELEASING.md) for the complete procedure.

WHEN using the local preflight THEN you SHALL run `pnpm run lint:obsidian`
separately from broader checks, within the authorized scope. It combines the
official source rules with local `lint:review-css` tripwires. Native DOM
creation in plugin source is an error. Keep other warnings visible and review
them without suppressing rules. Do not introduce stylesheet priority overrides,
`:has()`, or the rejected decoration longhands; use owned state classes and CSS
variables. The CSS tripwires cover those patterns only. They do not establish
complete CSS compatibility, reproducible builds, attestations, or an official
preview pass. Follow the component contracts in `RELEASING.md`.

## Verification is risk-scaled

Fast feedback belongs in the inner loop; release confidence comes from the
whole product.

WHEN changing Rust behavior THEN you SHALL use RED → GREEN → REFACTOR: add or
identify a failing test, confirm that it fails for the intended reason, make
the smallest correct change, and rerun the focused suite before broader gates.

WHEN changing TypeScript, CSS, WASM boundaries, persistence, editing, or UI
behavior THEN you SHALL run:

```sh
pnpm run build
pnpm run check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
pnpm run e2e
```

The aggregate `check` includes the storage fallback fixture and therefore
requires WASM generated from the same current source. A clean checkout must
build first; do not substitute another candidate's generated artifacts.

WHEN claiming release readiness THEN you SHALL additionally run:

```sh
cargo build --release -p mica-cli --locked
pnpm run smoke
pnpm run check:release:assets
pnpm run audit:prod
cargo deny check advisories
pnpm run test:version-stress
pnpm run e2e:mobile
pnpm run e2e:minimum
pnpm run e2e:latest
```

WHEN you add, rename, split, or remove a mandatory verification gate THEN you
SHALL update the human release procedure and this command inventory in the same
change. Keep authorized automation consistent; hosted CI is not required. You
SHALL NOT call a subset release-ready.

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

WHEN the UI filters candidates for an operation the reducer permits THEN the
exclusions SHALL remain visible in what the UI names. Dropping an eligible
neighbour from a candidate index silently redefines "the one below" as "the next
one I happen to accept", and the operation then lands somewhere the user never
pointed at.

WHEN a surface can be rendered, described, exported, and copied THEN you SHALL
derive all of them from one ordered plan computed once. You SHALL NOT re-derive
what is displayed inside the exporter; a second derivation is how a clipboard
comes to hold a different comparison than the screen.

WHEN a plan lays several versions of one thing side by side THEN you SHALL order
the display chronologically and decide inclusion separately. A list offered
newest-first orders the picker, not the comparison; laying it out as it arrived
makes a diff read backwards in time.

WHEN a control does not apply in the current mode THEN you SHALL disable it with
its reason. You SHALL NOT leave it enabled and inert, and you SHALL NOT hide a
selection the user made — an input the plan excludes SHALL be reported with why.

WHEN naming a structural element for a user THEN you SHALL identify it by
location, type, and position among same-kind siblings, preserving authored
casing. You SHALL NOT name it from its content: a leaf's derived label is its
first source line, which neither survives edits nor separates siblings. WHEN a
value is case-folded or grouped for matching THEN you SHALL keep the authored
value alongside it for display.

WHEN an entity has a stable identity plus mutable, content-derived, or
presentational aliases THEN you SHALL persist relations and target mutations,
recovery, and follow-up actions by stable identity. You MAY accept an alias only
as compatibility input when it resolves uniquely; ambiguity SHALL fail closed.

WHEN an entity can be hidden or removed from a view without being destroyed THEN
you SHALL distinguish visible membership from authoritative existence and
define which operations address each set. Exact stable identity SHALL remain
sufficient for recovery unless the operation explicitly promises irreversible
deletion.

## Preserve bytes unless the user changed them

`parse → serialize` is byte-identical for an unedited tree. Leaves represent
contiguous source spans; containers own their exact opening and closing lines.

WHEN changing parsing, serialization, hashing, line handling, or structural
normalization THEN you SHALL pin current behavior first and keep round-trip
coverage for LF, CRLF, BOMs where supported, missing final newlines, deep
nesting, large documents, inner fences, and real-note fixtures.

WHEN converting text offsets THEN you SHALL name the unit: UTF-8 bytes, Unicode
scalars, or UTF-16 code units. You SHALL combine UTF-16 units only for a valid
surrogate pair and test isolated surrogates and non-BMP text.

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

WHEN resolving central storage THEN you SHALL use the portable vault-root
`mica.json` as the routing authority and the shared Rust policy for paths.
Plugin preferences SHALL follow the active route, and `--store-dir` SHALL agree
with it. Root selection SHALL work for plain directories independently of Git;
pending or inconsistent routing SHALL fail closed.

WHEN initializing central storage THEN you SHALL record the chosen store UUID
and `initializing:true` in the locator before creating directories. Recovery
SHALL resume only that recorded intent with an absent or empty directory or
the exact UUID marker, reject unknown contents, and clear the flag through an
exact locator guard. An active null-UUID route SHALL NOT adopt existing storage.

WHEN relocating central storage THEN you SHALL perform the guarded whole-folder
move at startup with CLI/watch writers stopped, before engine, bridge, or
identity-index work starts. Publish a pending route before the move, preserve
the store UUID and every history file's bytes, and activate only a verified
destination. Recovery SHALL preserve conflicting copies. Legacy sidecar
conversion remains outside this location-change operation.

WHEN an operation can write user data THEN you SHALL validate every
precondition before its first persistent side effect. Ambiguous identity,
duplicate live IDs, stale expected text, corrupt objects, conflicting
representations, unsafe paths, invalid sizes, or malformed events are invalid
preconditions; WHEN any is present THEN you SHALL fail closed.

WHEN overwriting mutable user data THEN you SHALL use an exact preimage or
generation guard. WHEN an operation is stale THEN you SHALL preserve both the
current data and the user's draft.

WHEN an operation suspends after reading mutable authority THEN its validation
is stale; you SHALL re-read and revalidate every generation or preimage guard
after the last suspension and before the first persistent side effect.

WHEN persisted state names an optional or network-backed provider THEN you SHALL
treat the identifier as data, not enablement. You SHALL revalidate current
policy before discovery, resolution, or fetch and after any suspension; a
disabled provider SHALL perform no network work.

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

WHEN read-modify-writing an extensible object THEN you SHALL preserve unknown
fields; otherwise you SHALL reject them before writing. You SHALL NOT silently
drop fields you do not understand.

WHEN handling an error THEN you SHALL make failure visible at its owning
boundary and preserve the last known-good state. You SHALL NOT emit repeated
user notices from a hot loop; you SHALL coalesce them or report through the
owning operation. You MAY catch and ignore only explicitly best-effort cleanup.

WHEN folding append-only, resumable, or legacy events THEN each event SHALL
establish every state-existence fact it asserts. You SHALL NOT require an
earlier creation event unless the format does, and you SHALL test valid
prefixes and isolated compatibility events.

WHEN a persisted discriminated union is shared across hosts or binaries THEN
you SHALL update every in-repo reader, writer, and parity test in the same
change. A known variant SHALL have identical validity and state effects
everywhere; an unknown typed variant SHALL fail closed, and legacy fallback
SHALL run only when the input is not a typed variant.

WHEN a new persisted variant is not backward-readable THEN you SHALL make it a
coordinated upgrade and document that boundary before any release can emit it.

WHEN output is hashed, content-addressed, persisted, or compared THEN you SHALL
derive its bytes and order canonically from explicit inputs. You SHALL NOT rely
on map iteration, locale, or ambient time or randomness unless recorded.

## Complexity is part of correctness

WHEN preparing an implementation plan THEN you SHALL identify whether the
changed path runs per keystroke, per cursor transaction, per pointer frame, per
render, per edit, per file, or per release. The hotter the path, the smaller
its allocation and scan budget.

WHEN touching a user-sized path THEN you SHALL state and verify its time,
peak auxiliary space, full-input pass count, and expensive boundary operations:
I/O, parsing, bridge crossings, decompression, DOM queries, and layout reads.
Several `O(n)` passes are still duplicated work.

On user-sized paths you SHALL prefer one pass, borrowed input, and
output-proportional space. You SHALL NOT repeat scans; front-remove or insert;
query a growing collection from its own loop; repeatedly serialize or clone;
or query DOM structure inside geometry loops.

### Data movement, lookup, and caching

WHEN several consumers need facts from one document, file, or ledger generation
THEN you SHALL build one validated index or report and reuse it. You SHALL
discard it when its authority changes; cached text, CST nodes, and offsets
SHALL NOT outlive that generation. You SHALL NOT reread storage merely to get
another projection of it.

WHEN repeated membership and stable order are both required THEN you SHALL use
a map or set for lookup plus an ordered vector or final sort. You SHALL NOT pay
quadratic lookup cost merely to preserve order.

WHEN consuming large input THEN you SHALL borrow, stream, advance a
source-ordered cursor, or emit through a callback. You SHALL NOT materialize
lines, matches, filtered copies, serialized subtrees, or whole-input joins
merely to inspect, count, hash, or compare them.

WHEN preallocating THEN you SHALL derive capacity from known output
cardinality or use a conservative cap. You SHALL NOT reserve memory from input
byte length when the number of produced items can be far smaller.

WHEN adding a cache THEN you SHALL define its authority generation, reuse
condition, entry and byte bounds, eviction, and owner. Single-use values SHOULD
bypass it; reusable values SHOULD leave after their last use. You SHALL budget
peak memory across input, cache, candidate, rollback, and final output together.

### Per keystroke and cursor transaction

WHEN a cursor-only transaction leaves block reveal state unchanged THEN you
SHALL reuse the previous decoration set. WHEN a document changes THEN you SHALL
scan it once and carry every downstream field needed by rendering and identity
logic in that result. Scan results are immutable aliases, not objects for
consumers to rewrite.

### Per pointer move and animation frame

WHEN a gesture starts THEN you SHALL collect structural membership, indices,
and stable elements once. In frame loops you SHALL batch reads before writes,
re-read only moving geometry, and reuse measurements. You SHALL NOT re-query
known membership, re-parse attributes, rebuild candidates, or recompute after
scroll saturation. You MAY live-hit-test where clipping, transforms, or
stacking make cached geometry insufficient.

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
you SHALL expose it in Reading view and Live Preview wherever the action has a
referent in that mode. You SHALL keep mutation controls conditional on an
editable context.

WHEN already-rendered controls depend on settings THEN you SHALL read the
current setting at activation time or use a deliberately invalidated render
epoch. You SHALL NOT capture a stale settings snapshot in a long-lived widget.

WHEN one mutation can be undone from multiple surfaces THEN you SHALL make every
surface advance the same history entry and refresh from that state. You SHALL
NOT represent a compensating write as unrelated history or leave simultaneous
Undo and Redo claims.

WHEN two commands produce identical bytes THEN you SHALL offer one. A permission
the reducer requires is not a choice the user makes: state its consequence in
that command's label rather than splitting it into a pair to tell apart.

WHEN a control is the only route to a region's contents THEN its plain
activation SHALL navigate and SHALL NOT consume the selection — otherwise
reaching the second region discards what was picked in the first, and a
selection spanning both can never be assembled. You SHALL keep the container
itself selectable by a distinct gesture and from its actions menu.

WHEN a selection is numbered THEN the numbers SHALL be the order of the work
they produce, and you SHALL say which order that is. An unlabelled ordinal beside
a thing just clicked reads as click order, so any other rule looks like a bug.

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

WHEN a root rerender, early return, or close replaces an owned surface THEN you
SHALL invoke one idempotent teardown for its children, observers, listeners,
timers, workers, asynchronous work, and stale DOM references. You SHALL cancel
work when possible and discard results returned after teardown or generation
advance.

WHEN an operation is one-shot THEN you SHALL use the shortest-lived API that
satisfies it. You SHALL NOT create a retained, watch, or incremental context
only to perform one operation and immediately dispose it.

WHEN a widget rebuild destroys DOM without an explicit destroy callback THEN
you SHALL sweep disconnected entries rather than retaining them indefinitely.

## Code quality without ceremony

WHEN adding an abstraction THEN you SHALL ensure it removes real duplication
or protects an invariant.

WHEN a repeated operation has one meaning and at least three call sites THEN
you SHOULD extract one small helper. WHEN only two call sites are merely
similar THEN you SHOULD keep them local until their shared contract is proven.

WHEN extracting or broadening a helper THEN you SHALL preserve its scope,
ordering, availability, fallback, timing, ownership, and failure contract. A
wait-then-act helper SHALL act on the resolved instance and SHALL NOT silently
succeed when unresolved.

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

Tests SHALL stay inside the typechecked project. A fixture the compiler never
sees keeps constructing an outdated shape, so a newly required field arrives as
`undefined`, the behavior it feeds silently stops running, and the test that
should have caught it passes.

WHEN optimizing THEN you SHALL pin semantics before the refactor and add the
cheapest resource contract that would fail under the rejected design. You
SHALL test relevant adversarial cardinalities: one huge line, duplicates,
all-unique values, cache reuse, and valid event prefixes. You SHALL prefer
structural bounds and eviction assertions over timing-sensitive unit tests;
benchmarks supplement, never replace, semantic tests.

WHEN writing E2E assertions THEN you SHALL prefer persisted note text or public
plugin contracts over incidental DOM shape. You MAY use DOM assertions for
accessibility, visibility, and interaction availability.

WHEN a test acts on an entity THEN you SHALL address it by an identity the
operation under test cannot change. A displayed ordinal derived from what is
currently visible — `v{n}` renumbers whenever a checkpoint leaves the timeline —
may locate a row, but every action and assertion after that SHALL use the stable
id. You SHALL expose that id as a data attribute rather than have tests infer it.

WHEN a fixture owns persistent state outside the file it seeds — a sidecar
ledger, stored objects, remembered settings — THEN each test SHALL get its own,
or SHALL reset that state explicitly. Rewriting a note body does not clear its
history, and accumulated state makes a test assert something different on its
second run than its first. WHEN tests are isolated this way THEN every fixture
query SHALL be scoped to its own block or view: per-test fixtures multiply the
mounted blocks a bare selector can match, so isolation without scoping trades a
stale-state bug for an intermittent wrong-element one.

WHEN a test needs a state to persist THEN you SHALL provoke the event that would
destroy it and assert survival, rather than waiting and observing that nothing
happened. A fixed pause proves neither that the state held nor that anything
occurred at all.

WHEN running the E2E suite THEN you SHALL invoke it through the repository's
`e2e` scripts, which launch Obsidian on a virtual display where one exists. You
SHALL NOT call `wdio` directly: a real Obsidian window takes focus from whatever
the user is doing, and the suite launches one repeatedly.

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

## Precedence

WHEN a correctness, security, or user-data-preservation rule conflicts with a
cost or cleanliness rule THEN correctness, security, and preservation prevail.
WHEN clauses collide with no tiebreak written THEN the prohibition beats the
mandate; failing that you SHALL take the more reversible course and report the
collision.

## Shipping and active state

WHEN preparing a plugin update THEN you SHALL follow `RELEASING.md`: synchronize
package, manifest, Rust workspace/lockfile and version mappings on `review`,
clear its exact-SHA preview gate, merge the reviewed candidate into `main`, and
publish its exact version tag with matching runtime attachments. Verify
downloaded release bytes. A completed plugin delivery is a verified GitHub
Release.
Repository pushes and workflow artifacts have their own completion state.

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

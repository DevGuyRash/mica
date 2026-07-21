//! Structural operations on a block CST — the single reducer shared by the
//! Obsidian plugin (via WASM) and the `mica` CLI.
//!
//! Every user gesture (typing in a region, adding/removing/renaming a tab,
//! moving a node, changing grid columns, inserting a group or a leaf) becomes
//! one [`StructOp`] applied by the pure reducer [`apply_op_impl`], then
//! serialized and written by the host as a single change. `path` is a
//! child-index path from the block root to the target node.
//!
//! The reducer REJECTS (returns `false`, mutating nothing) any op whose target
//! is missing, whose `expected` text no longer matches, or whose move would
//! create an invalid tree — so a change that happened underneath an editor is
//! never clobbered, and a group can never be dropped into its own subtree.

use crate::parser::{parse_block_impl, Cst, Node};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Result of parsing, reducing, and serializing one block in core.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AppliedText {
    /// Whether the reducer accepted and changed the CST.
    pub changed: bool,
    /// Serialized block content; exact input bytes when `changed` is false.
    pub text: String,
}

/// Purpose: report whether a block body was already one logical section or
/// provide the byte-preserving wrapped body.
///
/// # Arguments
/// Not applicable; values are returned by [`normalize_section_impl`].
///
/// # Returns
/// `AlreadyNormalized` for one closed root `section`, otherwise `Wrapped`
/// with the replacement source.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{normalize_section_impl, SectionNormalization};
/// let result = normalize_section_impl("hello\n")?;
/// assert_eq!(result, SectionNormalization::Wrapped(":::section\nhello\n:::\n".into()));
/// # Ok::<(), mica_core::SectionNormalizationError>(())
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionNormalization {
    /// The input already consists of exactly one closed root `section`.
    AlreadyNormalized,
    /// The input wrapped in exactly one closed, collision-safe root `section`.
    Wrapped(String),
}

/// Purpose: explain why a block body cannot be wrapped as one logical section
/// without changing its authored bytes or content identity.
///
/// # Arguments
/// Not applicable; values are returned by [`normalize_section_impl`].
///
/// # Returns
/// A structured failure category suitable for CLI conflict reporting.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{normalize_section_impl, SectionNormalizationError};
/// assert_eq!(
///     normalize_section_impl("unterminated"),
///     Err(SectionNormalizationError::MissingTerminalNewline),
/// );
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionNormalizationError {
    /// A nonempty payload lacks the line break required before the closer.
    MissingTerminalNewline,
    /// Re-parsing the candidate did not preserve bytes, shape, or signature.
    ValidationFailed,
}

impl fmt::Display for SectionNormalizationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTerminalNewline => f.write_str(
                "section normalization failed: the body has no terminal newline; add one before normalizing",
            ),
            Self::ValidationFailed => f.write_str(
                "section normalization failed: the wrapped body changed its parsed content; leave this body unchanged and inspect it manually",
            ),
        }
    }
}

impl std::error::Error for SectionNormalizationError {}

/// Wrap a block body in exactly one logical `section` without changing any
/// authored payload byte.
///
/// Purpose: provide the structural normalization authority shared by CLI
/// migrations and any future host that needs a single editor per block body.
///
/// # Arguments
/// * `content` - exact source bytes from inside one Mica block
///
/// # Returns
/// [`SectionNormalization::AlreadyNormalized`] for one closed root section,
/// [`SectionNormalization::Wrapped`] for a validated replacement, or a
/// [`SectionNormalizationError`] when exact wrapping is impossible.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{normalize_section_impl, SectionNormalization};
/// let normalized = normalize_section_impl("alpha\n\nbeta\n")?;
/// assert!(matches!(normalized, SectionNormalization::Wrapped(_)));
/// # Ok::<(), mica_core::SectionNormalizationError>(())
/// ```
pub fn normalize_section_impl(
    content: &str,
) -> Result<SectionNormalization, SectionNormalizationError> {
    let cst = parse_block_impl(content);
    if matches!(
        cst.children.as_slice(),
        [Node::Container {
            name,
            close_line,
            ..
        }] if name == "section" && !close_line.is_empty()
    ) {
        return Ok(SectionNormalization::AlreadyNormalized);
    }
    if !content.is_empty() && !content.ends_with('\n') {
        return Err(SectionNormalizationError::MissingTerminalNewline);
    }
    let mut style = line_style_at(&cst, &[]);
    style.indent.clear();
    let wrapped = Cst {
        children: vec![new_section_styled(cst.children, &style)],
    };
    let text = crate::parser::serialize_impl(&wrapped);
    let reparsed = parse_block_impl(&text);
    let [Node::Container {
        name,
        children,
        close_line,
        ..
    }] = reparsed.children.as_slice()
    else {
        return Err(SectionNormalizationError::ValidationFailed);
    };
    if name != "section"
        || close_line.is_empty()
        || crate::parser::serialize_nodes(children) != content
        || crate::versions::content_signature_impl(content)
            != crate::versions::content_signature_impl(&text)
    {
        return Err(SectionNormalizationError::ValidationFailed);
    }
    Ok(SectionNormalization::Wrapped(text))
}

/// Which kind of group an `InsertGroup` op creates.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    /// A tab group (`tab:` friendly form at an empty root, else `:::tabs`).
    Tabs,
    /// An empty `:::grid` with a two-column default.
    Grid,
}

/// One structural edit to a block, expressed against the CST.
///
/// Serialized form matches the TypeScript `StructOp` union (tag `op`,
/// camelCase variants and fields) so the plugin can pass ops across the WASM
/// boundary unchanged.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum StructOp {
    /// Replace the leaf run `[start, end)` of the container at `path` with
    /// `text` (parsed as block content), iff the run still serializes to
    /// `expected`.
    SaveRegion {
        /// Container whose children hold the region (`[]` = block root).
        path: Vec<usize>,
        /// First child index of the region.
        start: usize,
        /// One past the last child index of the region.
        end: usize,
        /// The region's serialization when the editor opened.
        expected: String,
        /// Replacement markdown.
        text: String,
    },
    /// Insert a new empty tab into the tabs group at `path`, at child index `at`.
    InsertTab {
        /// Path of the tabs group.
        path: Vec<usize>,
        /// Insertion index among the group's children.
        at: usize,
    },
    /// Delete the tab at child `index` of the tabs group at `path`.
    DeleteTab {
        /// Path of the tabs group.
        path: Vec<usize>,
        /// Child index of the tab to delete.
        index: usize,
    },
    /// Retitle the tab at child `index` of the tabs group at `path`.
    RenameTab {
        /// Path of the tabs group.
        path: Vec<usize>,
        /// Child index of the tab.
        index: usize,
        /// New title (display part; `{...}` attrs are preserved).
        title: String,
    },
    /// Set or remove one `{key=value}` attribute on a tab's title.
    #[serde(rename_all = "camelCase")]
    SetTabAttr {
        /// Path of the tabs group.
        path: Vec<usize>,
        /// Child index of the tab.
        index: usize,
        /// Attribute key (e.g. `icon`).
        key: String,
        /// New value, or `None` to remove the attribute.
        value: Option<String>,
    },
    /// Insert a new empty cell into the grid at `path`, at child index `at`.
    InsertCell {
        /// Path of the grid.
        path: Vec<usize>,
        /// Insertion index among the grid's children.
        at: usize,
    },
    /// Delete the cell at child `index` of the grid at `path`.
    DeleteCell {
        /// Path of the grid.
        path: Vec<usize>,
        /// Child index of the cell to delete.
        index: usize,
    },
    /// Set the `{cols=N}` attribute of the grid at `path` (clamped to >= 1).
    SetCols {
        /// Path of the grid.
        path: Vec<usize>,
        /// New column count.
        cols: usize,
    },
    /// Reorder a cell WITHIN its column: the cell bubbles from flow index
    /// `from` to `to` (same column under the grid's `cols`), passed
    /// same-column cells shift one row, and every other flow index — the
    /// other columns — is untouched. A plain splice cannot do this under
    /// row-major flow.
    #[serde(rename_all = "camelCase")]
    MoveCellInColumn {
        /// Path of the grid.
        path: Vec<usize>,
        /// The cell's current flow index.
        from: usize,
        /// The target flow index (`from ≡ to (mod cols)`).
        to: usize,
    },
    /// Insert an empty COLUMN at column index `at`: one empty cell splices
    /// into every row, `cols` bumps, and a `colw` list (if present) gains a
    /// `1` share at the same position — all atomically.
    InsertColumn {
        /// Path of the grid.
        path: Vec<usize>,
        /// Column index (`0..=cols`).
        at: usize,
    },
    /// Insert an empty ROW at row index `at_row`: `cols` empty cells splice
    /// in at that flow position; a `rowh` list (if present) gains an `auto`
    /// slot at the same position.
    #[serde(rename_all = "camelCase")]
    InsertRow {
        /// Path of the grid.
        path: Vec<usize>,
        /// Row index (`0..=rows`).
        at_row: usize,
    },
    /// Delete the COLUMN at index `at`: the cell at that column leaves every
    /// row, `cols` drops, and a `colw` list loses its entry. Rejected for the
    /// last remaining column (delete the grid instead).
    DeleteColumn {
        /// Path of the grid.
        path: Vec<usize>,
        /// Column index (`0..cols`).
        at: usize,
    },
    /// Delete the ROW at index `at_row` (its consecutive cells); a `rowh`
    /// list loses its entry. Deleting the only row removes the grid.
    #[serde(rename_all = "camelCase")]
    DeleteRow {
        /// Path of the grid.
        path: Vec<usize>,
        /// Row index (`0..rows`).
        at_row: usize,
    },
    /// Move the whole COLUMN `from` to column index `to`; the `colw` entry
    /// travels with it. A ragged grid is padded rectangular first (row-major
    /// flow cannot express mid-grid raggedness).
    MoveColumn {
        /// Path of the grid.
        path: Vec<usize>,
        /// Current column index.
        from: usize,
        /// Target column index (after the move).
        to: usize,
    },
    /// Move the whole ROW `from` to row index `to`; the `rowh` entry travels
    /// with it. A ragged grid is padded rectangular first.
    MoveRow {
        /// Path of the grid.
        path: Vec<usize>,
        /// Current row index.
        from: usize,
        /// Target row index (after the move).
        to: usize,
    },
    /// Empty the cell at flow `index` — grid geometry stays intact (removing
    /// a cell from flow would shift every later cell across columns).
    ClearCell {
        /// Path of the grid.
        path: Vec<usize>,
        /// Flow index of the cell.
        index: usize,
    },
    /// Write or clear a `{key=value}` header token on the GROUP container
    /// (grid or directive tabs) at `path` — e.g. `colw` fractions.
    #[serde(rename_all = "camelCase")]
    SetGroupAttr {
        /// Path of the grid / tabs container.
        path: Vec<usize>,
        /// Token key (ascii alphanumeric / dash).
        key: String,
        /// New value, or `None` to remove the token.
        value: Option<String>,
    },
    /// Insert a new empty group into the container at `path`, at index `at`.
    InsertGroup {
        /// Target container (`[]` = block root).
        path: Vec<usize>,
        /// Insertion index among the container's children.
        at: usize,
        /// Group kind to create.
        kind: GroupKind,
    },
    /// Insert `text` (parsed as block content) into the container at `path`
    /// at child index `at` — prose, a callout, or a code block between siblings.
    InsertLeaf {
        /// Target container (`[]` = block root).
        path: Vec<usize>,
        /// Insertion index among the container's children.
        at: usize,
        /// Markdown to insert.
        text: String,
    },
    /// Remove the node at an absolute child path.
    DeleteNode {
        /// Absolute path of the node to remove (parent = path minus last).
        path: Vec<usize>,
    },
    /// Deep-copy the node at `path` and insert the copy right after it.
    /// A copied tab gets `" (copy)"` appended to its display title.
    DuplicateNode {
        /// Absolute path of the node to duplicate.
        path: Vec<usize>,
    },
    /// Move the node at `from` into `to_parent` at `to_index`.
    ///
    /// Tabs may only land in tabs groups, cells only in grids, and groups may
    /// not land inside tabs/grid child lists directly (only inside a tab, a
    /// cell, or the root). Moves into the moved node's own subtree are rejected.
    #[serde(rename_all = "camelCase")]
    MoveNode {
        /// Absolute path of the node to move.
        from: Vec<usize>,
        /// Path of the destination container (`[]` = block root).
        to_parent: Vec<usize>,
        /// Insertion index in the destination's children.
        to_index: usize,
    },
    /// Move a leaf RUN (`[start, end)` of the container at `path`) — prose,
    /// callouts, code blocks — into `to_parent` at `to_index`. Leaves may land
    /// in any container except directly inside a tabs strip or a grid's cell
    /// list (they would be invisible there).
    #[serde(rename_all = "camelCase")]
    MoveRegion {
        /// Container whose children hold the run (`[]` = block root).
        path: Vec<usize>,
        /// First child index of the run.
        start: usize,
        /// One past the last child index of the run.
        end: usize,
        /// Path of the destination container (`[]` = block root).
        to_parent: Vec<usize>,
        /// Insertion index in the destination's children.
        to_index: usize,
    },
    /// Combine two compatible Markdown regions into one reversible logical
    /// `:::section`, guarded by both exact serialized pre-images.
    #[serde(rename_all = "camelCase")]
    CombineRegions {
        /// Container holding the dragged source region.
        source_path: Vec<usize>,
        /// First child index of the source leaf run.
        source_start: usize,
        /// One past the source leaf run.
        source_end: usize,
        /// Exact source serialization observed when the gesture began.
        source_expected: String,
        /// Container holding the receiving target region.
        target_path: Vec<usize>,
        /// First child index of the target leaf run.
        target_start: usize,
        /// One past the target leaf run.
        target_end: usize,
        /// Exact target serialization observed when the gesture began.
        target_expected: String,
    },
    /// Remove one logical `:::section` wrapper while preserving its children.
    UncombineSection {
        /// Absolute path of the `section` container.
        path: Vec<usize>,
    },
}

/// Apply `op` to `cst` in place.
///
/// Purpose: the one reducer both hosts use for every structural edit.
///
/// # Arguments
/// * `cst` - parsed block content, mutated in place on success
/// * `op` - the structural edit to apply
///
/// # Returns
/// `true` if the tree changed; `false` if the op was rejected as a no-op
/// (missing target, stale `expected` text, or an invalid move). On `false`
/// the tree is unchanged.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{apply_op_impl, parse_block_impl, serialize_impl, StructOp};
/// let mut cst = parse_block_impl("tab: A\nbody\n");
/// let changed = apply_op_impl(&mut cst, &StructOp::RenameTab { path: vec![0], index: 0, title: "B".into() });
/// assert!(changed);
/// assert_eq!(serialize_impl(&cst), "tab: B\nbody\n");
/// ```
pub fn apply_op_impl(cst: &mut Cst, op: &StructOp) -> bool {
    apply_ops_impl(cst, std::slice::from_ref(op))
}

/// Apply dependent structural operations as one all-or-nothing transaction.
///
/// Purpose: allow compound gestures such as insert-then-title to share one
/// fresh CST, normalize once, and never expose a partially applied prefix.
///
/// # Arguments
/// * `cst` - parsed block content, mutated only when every operation succeeds
/// * `ops` - dependent operations in execution order
///
/// # Returns
/// `true` when every operation succeeded and the final normalized CST differs;
/// `false` for an empty batch, any rejected operation, or a net no-op.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{apply_ops_impl, parse_block_impl, serialize_impl, StructOp};
/// let mut cst = parse_block_impl("tab: A\nbody\n");
/// let ops = [
///     StructOp::InsertTab { path: vec![0], at: 1 },
///     StructOp::RenameTab { path: vec![0], index: 1, title: "B".into() },
/// ];
/// assert!(apply_ops_impl(&mut cst, &ops));
/// assert!(serialize_impl(&cst).contains("tab: B"));
/// ```
pub fn apply_ops_impl(cst: &mut Cst, ops: &[StructOp]) -> bool {
    if ops.is_empty() {
        return false;
    }
    // Apply against a private candidate so every rejection path is atomic.
    // This deliberately makes the reducer's documented `false => unchanged`
    // contract structural instead of relying on every helper to roll back all
    // of its intermediate edits correctly.
    let mut candidate = cst.clone();
    for op in ops {
        if !apply_op_inner(&mut candidate, op) {
            return false;
        }
    }
    // One normalization pass after the dependent sequence keeps paths stable
    // during the batch and re-establishes the seam invariant before commit.
    normalize_tree(&mut candidate.children);
    if candidate == *cst {
        return false;
    }
    *cst = candidate;
    true
}

/// Parse, reduce, and serialize one structural edit without crossing the host
/// boundary with a full CST.
///
/// Purpose: keep the one-reducer invariant while eliminating repeated
/// Rust-to-JavaScript tree copies for mutations.
///
/// # Arguments
/// * `content` - current exact block content
/// * `op` - structural operation to apply
///
/// # Returns
/// [`AppliedText`] with exact original content on rejection.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{apply_op_text_impl, StructOp};
/// let result = apply_op_text_impl(
///     "tab: A\nbody\n",
///     &StructOp::RenameTab { path: vec![0], index: 0, title: "B".into() },
/// );
/// assert!(result.changed);
/// assert_eq!(result.text, "tab: B\nbody\n");
/// ```
pub fn apply_op_text_impl(content: &str, op: &StructOp) -> AppliedText {
    apply_ops_text_impl(content, std::slice::from_ref(op))
}

/// Parse, atomically apply dependent operations, and serialize the result.
///
/// Purpose: provide the host an all-or-nothing batch without transferring a
/// full CST across the WASM boundary.
///
/// # Arguments
/// * `content` - current exact block content
/// * `ops` - dependent structural operations in execution order
///
/// # Returns
/// [`AppliedText`] with exact original content when the batch is rejected.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{apply_ops_text_impl, StructOp};
/// let result = apply_ops_text_impl(
///     "tab: A\nbody\n",
///     &[
///         StructOp::InsertTab { path: vec![0], at: 1 },
///         StructOp::RenameTab { path: vec![0], index: 1, title: "B".into() },
///     ],
/// );
/// assert!(result.changed);
/// assert!(result.text.contains("tab: B"));
/// ```
pub fn apply_ops_text_impl(content: &str, ops: &[StructOp]) -> AppliedText {
    if ops.is_empty() {
        return AppliedText {
            changed: false,
            text: content.to_string(),
        };
    }
    let mut cst = parse_block_impl(content);
    for op in ops {
        if !apply_op_inner(&mut cst, op) {
            return AppliedText {
                changed: false,
                text: content.to_string(),
            };
        }
    }
    normalize_tree(&mut cst.children);
    let text = crate::parser::serialize_impl(&cst);
    if text == content {
        AppliedText {
            changed: false,
            text,
        }
    } else {
        AppliedText {
            changed: true,
            text,
        }
    }
}

/// Two content leaves flush against each other re-parse as ONE prose run on
/// the next round-trip (or lazily continue a callout in raw markdown) — the
/// "my sections combined" bug. After any successful op, restore the
/// invariant everywhere: a blank-line leaf between adjacent content leaves,
/// and no whitespace-only leaf at a container's edges (a leading one renders
/// as a phantom newline in editors). Normalizing the whole tree (instead of
/// just the spliced list) makes "forgot a call site" impossible; blocks are
/// small and ops are per-gesture, so the walk is cheap.
fn normalize_tree(nodes: &mut Vec<Node>) {
    normalize_leaf_seams(nodes);
    for n in nodes {
        if let Node::Container { children, .. } = n {
            normalize_tree(children);
        }
    }
}

fn normalize_leaf_seams(children: &mut Vec<Node>) {
    let is_ws = |n: &Node| matches!(n, Node::Leaf { text, .. } if text.trim().is_empty());
    let is_content = |n: &Node| matches!(n, Node::Leaf { text, .. } if !text.trim().is_empty());
    let Some(first_content) = children.iter().position(|n| !is_ws(n)) else {
        children.clear();
        return;
    };
    if first_content > 0 {
        children.drain(..first_content);
    }
    if let Some(last_content) = children.iter().rposition(|n| !is_ws(n)) {
        children.truncate(last_content + 1);
    }

    let seams = children
        .windows(2)
        .filter(|pair| is_content(&pair[0]) && is_content(&pair[1]))
        .count();
    if seams == 0 {
        return;
    }

    let old = std::mem::take(children);
    let mut normalized = Vec::with_capacity(old.len() + seams);
    for node in old {
        if normalized.last().is_some_and(is_content) && is_content(&node) {
            // A final line without its newline needs the terminator too.
            let sep = match normalized.last() {
                Some(Node::Leaf { text, .. }) if !text.ends_with('\n') => "\n\n",
                _ => "\n",
            };
            normalized.push(Node::Leaf {
                text: sep.to_string(),
                is_code: false,
            });
        }
        normalized.push(node);
    }
    *children = normalized;
}

fn apply_op_inner(cst: &mut Cst, op: &StructOp) -> bool {
    match op {
        StructOp::SaveRegion {
            path,
            start,
            end,
            expected,
            text,
        } => {
            let style = line_style_at(cst, path);
            let inside_section =
                node_at(cst, path).is_some_and(|node| is_container_named(node, "section"));
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            if *end > children.len() || start > end {
                return false;
            }
            if !region_matches(&children[*start..*end], expected) {
                return false; // structure changed underneath the editor — abort
            }
            // Terminate the replacement's last line so serializing INSIDE a
            // directive container never glues typed text onto its `:::` closer.
            let mut replacement = parse_block_impl(&terminated(text)).children;
            if !inside_section && plain_content_count(&replacement).is_some_and(|count| count > 1) {
                replacement = vec![new_section_styled(replacement, &style)];
            }
            if region_matches(&replacement, expected) {
                return false;
            }
            children.splice(*start..*end, replacement);
            if inside_section {
                grow_section_fence_at(cst, path);
            }
            true
        }
        StructOp::InsertTab { path, at } => {
            let Some((directive, colons)) = group_form(cst, path, "tabs") else {
                return false;
            };
            let style = line_style_at(cst, path);
            let tab = if directive {
                directive_tab_styled("New tab", colons, &style)
            } else {
                friendly_tab_styled("New tab", &style)
            };
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            let at = (*at).min(children.len());
            children.insert(at, tab);
            true
        }
        StructOp::DeleteTab { path, index } => {
            let Some(children) = named_children_at_mut(cst, path, "tabs") else {
                return false;
            };
            if children
                .get(*index)
                .is_none_or(|child| !is_container_named(child, "tab"))
            {
                return false;
            }
            children.remove(*index);
            // An empty tabs group serializes away (friendly form) and dead-ends
            // its path — remove the whole group once its last tab is gone.
            if !children.iter().any(|c| is_container_named(c, "tab")) {
                remove_node_at(cst, path);
            }
            true
        }
        StructOp::RenameTab { path, index, title } => {
            if title.chars().any(char::is_control) {
                return false;
            }
            let Some(tab) = tab_at_mut(cst, path, *index) else {
                return false;
            };
            let (_, attrs) = match tab {
                Node::Container { title: t, .. } => split_title_attrs(t),
                Node::Leaf { .. } => return false,
            };
            set_tab_title(tab, &compose_title(title, &attrs))
        }
        StructOp::SetTabAttr {
            path,
            index,
            key,
            value,
        } => {
            if !valid_attr(key, value.as_deref()) {
                return false;
            }
            let Some(tab) = tab_at_mut(cst, path, *index) else {
                return false;
            };
            let (display, attrs) = match tab {
                Node::Container { title: t, .. } => split_title_attrs(t),
                Node::Leaf { .. } => return false,
            };
            let attrs = set_attr_token(&attrs, key, value.as_deref());
            set_tab_title(tab, &compose_title(&display, &attrs))
        }
        StructOp::InsertCell { path, at } => {
            if grid_layout_at(cst, path).is_none() {
                return false;
            }
            let style = line_style_at(cst, path);
            let Some(children) = named_children_at_mut(cst, path, "grid") else {
                return false;
            };
            let at = (*at).min(children.len());
            children.insert(at, new_cell_styled(&style));
            true
        }
        StructOp::DeleteCell { path, index } => {
            if grid_layout_at(cst, path).is_none() {
                return false;
            }
            let Some(children) = named_children_at_mut(cst, path, "grid") else {
                return false;
            };
            if children
                .get(*index)
                .is_none_or(|child| !is_container_named(child, "cell"))
            {
                return false;
            }
            children.remove(*index);
            // A grid with no cells left is just scaffolding — remove it.
            if !children.iter().any(|c| is_container_named(c, "cell")) {
                remove_node_at(cst, path);
            }
            true
        }
        StructOp::SetCols { path, cols } => {
            if grid_layout_at(cst, path).is_none() {
                return false;
            }
            let Some(Node::Container {
                name,
                open_line,
                children,
                ..
            }) = node_at(cst, path)
            else {
                return false;
            };
            if name != "grid" || !is_directive_line(open_line) {
                return false;
            }
            // A different column count changes the ROW count — prune a now-
            // longer rowh list or its extra entries lay out as phantom empty
            // tracks (dead space below the grid).
            let new_cols = (*cols).max(1);
            let rows = children.len().div_ceil(new_cols).max(1);
            let header_changed = set_group_attr(cst, path, "cols", Some(&new_cols.to_string()));
            let rowh_changed = edit_list_attr(cst, path, "rowh", |parts| parts.truncate(rows));
            header_changed || rowh_changed
        }
        StructOp::MoveCellInColumn { path, from, to } => move_cell_in_column(cst, path, *from, *to),
        StructOp::InsertColumn { path, at } => insert_column(cst, path, *at),
        StructOp::InsertRow { path, at_row } => insert_row(cst, path, *at_row),
        StructOp::DeleteColumn { path, at } => delete_column(cst, path, *at),
        StructOp::DeleteRow { path, at_row } => delete_row(cst, path, *at_row),
        StructOp::MoveColumn { path, from, to } => move_column(cst, path, *from, *to),
        StructOp::MoveRow { path, from, to } => move_row(cst, path, *from, *to),
        StructOp::ClearCell { path, index } => clear_cell(cst, path, *index),
        StructOp::SetGroupAttr { path, key, value } => {
            set_group_attr(cst, path, key, value.as_deref())
        }
        StructOp::InsertGroup { path, at, kind } => {
            let style = line_style_at(cst, path);
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            let empty = children.iter().all(|c| match c {
                Node::Leaf { text, .. } => text.trim().is_empty(),
                Node::Container { .. } => false,
            });
            // Nested groups always use explicit `:::` bounds; only an empty
            // root block gets the friendly closer-free form.
            let directive = !path.is_empty() || !empty;
            let group = match kind {
                GroupKind::Grid => new_grid_styled(2, &style),
                GroupKind::Tabs => new_tabs_group_styled(directive, &style),
            };
            let at = (*at).min(children.len());
            children.insert(at, group);
            guard_friendly_glue(children, at);
            true
        }
        StructOp::InsertLeaf { path, at, text } => {
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            let nodes = parse_block_impl(&terminated(text)).children;
            if nodes.is_empty() {
                return false;
            }
            let at = (*at).min(children.len());
            children.splice(at..at, nodes);
            guard_friendly_glue(children, at);
            true
        }
        StructOp::DeleteNode { path } => remove_node_at(cst, path),
        StructOp::DuplicateNode { path } => {
            let Some(node) = node_at(cst, path) else {
                return false;
            };
            let mut copy = node.clone();
            if is_container_named(&copy, "tab") {
                let (display, attrs) = match &copy {
                    Node::Container { title, .. } => split_title_attrs(title),
                    Node::Leaf { .. } => return false,
                };
                let _ = set_tab_title(
                    &mut copy,
                    &compose_title(&format!("{display} (copy)"), &attrs),
                );
            }
            let Some((&last, parent)) = path.split_last() else {
                return false;
            };
            let Some(children) = children_at_mut(cst, parent) else {
                return false;
            };
            children.insert(last + 1, copy);
            guard_friendly_glue(children, last + 1);
            true
        }
        StructOp::MoveNode {
            from,
            to_parent,
            to_index,
        } => move_node(cst, from, to_parent, *to_index),
        StructOp::MoveRegion {
            path,
            start,
            end,
            to_parent,
            to_index,
        } => move_region(cst, path, *start, *end, to_parent, *to_index),
        StructOp::CombineRegions {
            source_path,
            source_start,
            source_end,
            source_expected,
            target_path,
            target_start,
            target_end,
            target_expected,
        } => combine_regions(
            cst,
            RegionPreimage {
                path: source_path,
                start: *source_start,
                end: *source_end,
                expected: source_expected,
            },
            RegionPreimage {
                path: target_path,
                start: *target_start,
                end: *target_end,
                expected: target_expected,
            },
        ),
        StructOp::UncombineSection { path } => uncombine_section(cst, path),
    }
}

#[derive(Clone, Copy)]
struct RegionPreimage<'a> {
    path: &'a [usize],
    start: usize,
    end: usize,
    expected: &'a str,
}

fn combine_regions(
    cst: &mut Cst,
    source_ref: RegionPreimage<'_>,
    target_ref: RegionPreimage<'_>,
) -> bool {
    if source_ref.start >= source_ref.end
        || target_ref.start >= target_ref.end
        || (source_ref.path == target_ref.path
            && source_ref.start < target_ref.end
            && target_ref.start < source_ref.end)
    {
        return false;
    }
    let style = line_style_at(cst, target_ref.path);
    let Some(source) = combine_snapshot(cst, source_ref) else {
        return false;
    };
    let Some(target) = combine_snapshot(cst, target_ref) else {
        return false;
    };
    let target_node = combined_target_node(target, source.children, &style);

    if source_ref.path != target_ref.path {
        // Neither region may own the other's parent container. Apart from being
        // ambiguous, replacing the outer region would discard the inner result.
        if path_enters_region(source_ref.path, target_ref)
            || path_enters_region(target_ref.path, source_ref)
        {
            return false;
        }
        // Replacing a multi-leaf target with one wrapper can shift a later
        // sibling container that owns the source. Rebase that path before the
        // first mutation so root↔nested combines remain valid.
        let mut source_path = source_ref.path.to_vec();
        if !adjust_path_after_splice(
            &mut source_path,
            target_ref.path,
            target_ref.start,
            target_ref.end,
            1,
        ) {
            return false;
        }
        let Some(target_children) = children_at_mut(cst, target_ref.path) else {
            return false;
        };
        target_children.splice(
            target_ref.start..target_ref.end,
            std::iter::once(target_node),
        );
        let Some(source_children) = children_at_mut(cst, &source_path) else {
            return false;
        };
        source_children.drain(source_ref.start..source_ref.end);
        return true;
    }

    let Some(children) = children_at_mut(cst, target_ref.path) else {
        return false;
    };
    let insert_at = if source_ref.start < target_ref.start {
        target_ref.start - (source_ref.end - source_ref.start)
    } else {
        target_ref.start
    };
    let (later_start, later_end, earlier_start, earlier_end) =
        if source_ref.start > target_ref.start {
            (
                source_ref.start,
                source_ref.end,
                target_ref.start,
                target_ref.end,
            )
        } else {
            (
                target_ref.start,
                target_ref.end,
                source_ref.start,
                source_ref.end,
            )
        };
    children.drain(later_start..later_end);
    children.drain(earlier_start..earlier_end);
    children.insert(insert_at, target_node);
    true
}

fn path_enters_region(path: &[usize], region: RegionPreimage<'_>) -> bool {
    path.len() > region.path.len()
        && path[..region.path.len()] == *region.path
        && (region.start..region.end).contains(&path[region.path.len()])
}

fn adjust_path_after_splice(
    path: &mut [usize],
    parent: &[usize],
    start: usize,
    end: usize,
    inserted: usize,
) -> bool {
    if path.len() <= parent.len() || path[..parent.len()] != *parent {
        return true;
    }
    let index = &mut path[parent.len()];
    if (*index >= start) && (*index < end) {
        return false;
    }
    if *index >= end {
        *index = *index - (end - start) + inserted;
    }
    true
}

struct CombineSnapshot {
    children: Vec<Node>,
    wrapper: Option<Node>,
}

fn combine_snapshot(cst: &Cst, region: RegionPreimage<'_>) -> Option<CombineSnapshot> {
    let children = children_at(cst, region.path)?;
    if region.end > children.len() {
        return None;
    }
    let nodes = &children[region.start..region.end];
    if !region_matches(nodes, region.expected) {
        return None;
    }
    if is_plain_region(nodes) {
        return Some(CombineSnapshot {
            children: nodes.to_vec(),
            wrapper: None,
        });
    }
    let [section @ Node::Container { name, children, .. }] = nodes else {
        return None;
    };
    if name != "section" || !is_plain_section_content(children) {
        return None;
    }
    Some(CombineSnapshot {
        children: children.clone(),
        wrapper: Some(section.clone()),
    })
}

fn combined_target_node(
    mut target: CombineSnapshot,
    source_children: Vec<Node>,
    style: &LineStyle,
) -> Node {
    target.children.extend(source_children);
    if let Some(mut wrapper) = target.wrapper {
        if let Node::Container { children, .. } = &mut wrapper {
            *children = target.children;
        }
        grow_section_fence(&mut wrapper);
        wrapper
    } else {
        new_section_styled(target.children, style)
    }
}

fn uncombine_section(cst: &mut Cst, path: &[usize]) -> bool {
    let Some((&index, parent)) = path.split_last() else {
        return false;
    };
    let Some(children) = children_at_mut(cst, parent) else {
        return false;
    };
    if children
        .get(index)
        .is_none_or(|node| !is_container_named(node, "section"))
    {
        return false;
    }
    let Node::Container {
        children: section_children,
        ..
    } = children.remove(index)
    else {
        return false;
    };
    children.splice(index..index, section_children);
    true
}

fn is_plain_region(nodes: &[Node]) -> bool {
    plain_content_count(nodes) == Some(1)
}

fn is_plain_section_content(nodes: &[Node]) -> bool {
    plain_content_count(nodes).is_some_and(|count| count > 0)
}

fn plain_content_count(nodes: &[Node]) -> Option<usize> {
    let mut content = 0;
    for node in nodes {
        let Node::Leaf { text, is_code } = node else {
            return None;
        };
        if *is_code {
            return None;
        }
        if !text.trim().is_empty() {
            if text.lines().next().is_some_and(crate::parser::callout_open) {
                return None;
            }
            content += 1;
        }
    }
    Some(content)
}

// ---------------------------------------------------------------------------
// Tree navigation and mutation helpers
// ---------------------------------------------------------------------------

/// The node at a child-index `path`, or `None` (a leaf mid-path dead-ends).
fn node_at<'a>(cst: &'a Cst, path: &[usize]) -> Option<&'a Node> {
    let (&last, rest) = path.split_last()?;
    let mut children = &cst.children;
    for &i in rest {
        match children.get(i)? {
            Node::Container { children: c, .. } => children = c,
            Node::Leaf { .. } => return None,
        }
    }
    children.get(last)
}

/// Mutable twin of [`node_at`].
fn node_at_mut<'a>(cst: &'a mut Cst, path: &[usize]) -> Option<&'a mut Node> {
    let (&last, rest) = path.split_last()?;
    let mut children = &mut cst.children;
    for &i in rest {
        match children.get_mut(i)? {
            Node::Container { children: c, .. } => children = c,
            Node::Leaf { .. } => return None,
        }
    }
    children.get_mut(last)
}

/// The child list of the container at `path` (`[]` = the block root).
fn children_at<'a>(cst: &'a Cst, path: &[usize]) -> Option<&'a [Node]> {
    let mut children = cst.children.as_slice();
    for &i in path {
        match children.get(i)? {
            Node::Container {
                children: nested, ..
            } => children = nested,
            Node::Leaf { .. } => return None,
        }
    }
    Some(children)
}

/// The child list of the container at `path` (`[]` = the block root).
fn children_at_mut<'a>(cst: &'a mut Cst, path: &[usize]) -> Option<&'a mut Vec<Node>> {
    let mut children = &mut cst.children;
    for &i in path {
        match children.get_mut(i)? {
            Node::Container { children: c, .. } => children = c,
            Node::Leaf { .. } => return None,
        }
    }
    Some(children)
}

/// The children of a container named `name` at `path`.
fn named_children_at_mut<'a>(
    cst: &'a mut Cst,
    path: &[usize],
    name: &str,
) -> Option<&'a mut Vec<Node>> {
    let Node::Container {
        name: found,
        children,
        ..
    } = node_at_mut(cst, path)?
    else {
        return None;
    };
    (found == name).then_some(children)
}

/// Whether the node at `path` is a container named `name`.
fn is_named(cst: &Cst, path: &[usize], name: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    node_at(cst, path).is_some_and(|n| is_container_named(n, name))
}

/// Whether `node` is a container named `name`.
fn is_container_named(node: &Node, name: &str) -> bool {
    matches!(node, Node::Container { name: n, .. } if n == name)
}

/// Remove the node at an absolute child path (parent = path minus last index).
fn remove_node_at(cst: &mut Cst, path: &[usize]) -> bool {
    let Some((&last, parent)) = path.split_last() else {
        return false;
    };
    let Some(children) = children_at_mut(cst, parent) else {
        return false;
    };
    if last >= children.len() {
        return false;
    }
    children.remove(last);
    true
}

/// The tab container at `index` of the tabs group at `path`.
fn tab_at_mut<'a>(cst: &'a mut Cst, path: &[usize], index: usize) -> Option<&'a mut Node> {
    let children = named_children_at_mut(cst, path, "tabs")?;
    let node = children.get_mut(index)?;
    is_container_named(node, "tab").then_some(node)
}

/// The (directive?, colons) form new tabs in the group at `path` should take.
fn group_form(cst: &Cst, path: &[usize], name: &str) -> Option<(bool, usize)> {
    if !is_named(cst, path, name) {
        return None;
    }
    let Some(Node::Container { children, .. }) = node_at(cst, path) else {
        return None;
    };
    let first = children.iter().find(|c| is_container_named(c, "tab"));
    match first {
        Some(Node::Container {
            open_line, colons, ..
        }) if is_directive_line(open_line) => Some((true, (*colons).max(3))),
        _ => Some((false, 0)),
    }
}

/// `"Title" + "k=v k2=v2"` → `"Title {k=v k2=v2}"` (attrs omitted when empty).
fn compose_title(display: &str, attrs: &str) -> String {
    let display = display.trim();
    if attrs.is_empty() {
        display.to_string()
    } else if display.is_empty() {
        format!("{{{attrs}}}")
    } else {
        format!("{display} {{{attrs}}}")
    }
}

/// Read a grid container's column count from its header attrs.
fn grid_cols(node: &Node) -> Option<usize> {
    match node {
        Node::Container { name, title, .. } if name == "grid" => Some(
            title_attr(title, "cols")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(2)
                .max(1),
        ),
        _ => None,
    }
}

/// Validated grid dimensions. Direct prose or another container at grid level
/// is malformed and must never be interpreted as a cell by geometry edits.
fn grid_layout_at(cst: &Cst, path: &[usize]) -> Option<(usize, usize)> {
    let node = node_at(cst, path)?;
    let cols = grid_cols(node)?;
    let Node::Container {
        open_line,
        children,
        ..
    } = node
    else {
        return None;
    };
    if !is_directive_line(open_line)
        || !children
            .iter()
            .all(|child| is_container_named(child, "cell"))
    {
        return None;
    }
    Some((cols, children.len()))
}

/// Edit a comma-list attr in place, if the attr exists (missing attrs stay
/// missing — defaults already apply). An emptied list drops the attr.
fn edit_list_attr(
    cst: &mut Cst,
    path: &[usize],
    key: &str,
    f: impl FnOnce(&mut Vec<String>),
) -> bool {
    let Some(Node::Container { title, .. }) = node_at(cst, path) else {
        return false;
    };
    let (_, attrs) = split_title_attrs(title);
    let Some(current) = attrs.split_whitespace().find_map(|token| {
        let (found, value) = token.split_once('=')?;
        (found == key).then(|| value.to_string())
    }) else {
        return false;
    };
    let mut parts: Vec<String> = current.split(',').map(str::to_string).collect();
    f(&mut parts);
    if parts.is_empty() {
        set_group_attr(cst, path, key, None)
    } else {
        set_group_attr(cst, path, key, Some(&parts.join(",")))
    }
}

/// Insert one list entry at `pos` (columns/rows gaining a slot).
fn insert_list_attr(cst: &mut Cst, path: &[usize], key: &str, pos: usize, entry: &str) {
    edit_list_attr(cst, path, key, |parts| {
        if pos <= parts.len() {
            parts.insert(pos, entry.to_string());
        }
    });
}

/// Remove the `pos` entry (a deleted column/row takes its share with it).
fn remove_list_attr(cst: &mut Cst, path: &[usize], key: &str, pos: usize) {
    edit_list_attr(cst, path, key, |parts| {
        if pos < parts.len() {
            parts.remove(pos);
        }
    });
}

/// Move the `from` entry to `to` (a moved column/row keeps its share).
fn move_list_attr(cst: &mut Cst, path: &[usize], key: &str, from: usize, to: usize) {
    edit_list_attr(cst, path, key, |parts| {
        if from < parts.len() && to < parts.len() {
            let v = parts.remove(from);
            parts.insert(to, v);
        }
    });
}

/// The `InsertColumn` implementation: consume the old row-major vector into a
/// preallocated result in one pass, then bump `cols` and the `colw` list.
fn insert_column(cst: &mut Cst, path: &[usize], at: usize) -> bool {
    let Some((cols, child_count)) = grid_layout_at(cst, path) else {
        return false;
    };
    if at > cols {
        return false;
    }
    let style = line_style_at(cst, path);
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let rows = child_count.div_ceil(cols).max(1);
        let old = std::mem::take(children);
        let mut source = old.into_iter();
        let mut rebuilt = Vec::with_capacity(child_count + rows);
        for row in 0..rows {
            let row_start = row * cols;
            let row_len = child_count.saturating_sub(row_start).min(cols);
            let insertion = at.min(row_len);
            for column in 0..=row_len {
                if column == insertion {
                    rebuilt.push(new_cell_styled(&style));
                }
                if column < row_len {
                    let Some(cell) = source.next() else {
                        return false;
                    };
                    rebuilt.push(cell);
                }
            }
        }
        *children = rebuilt;
    }
    let next = cols + 1;
    if !set_group_attr(cst, path, "cols", Some(&next.to_string())) {
        return false;
    }
    insert_list_attr(cst, path, "colw", at, "1");
    true
}

/// The `InsertRow` implementation: `cols` empty cells at the row's flow
/// position, plus an `auto` slot in the `rowh` list.
fn insert_row(cst: &mut Cst, path: &[usize], at_row: usize) -> bool {
    let Some((cols, _)) = grid_layout_at(cst, path) else {
        return false;
    };
    let style = line_style_at(cst, path);
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let rows = children.len().div_ceil(cols);
        if at_row > rows {
            return false;
        }
        let idx = (at_row * cols).min(children.len());
        children.splice(idx..idx, (0..cols).map(|_| new_cell_styled(&style)));
    }
    insert_list_attr(cst, path, "rowh", at_row, "auto");
    true
}

/// The `DeleteColumn` implementation: filter the old row-major vector into a
/// preallocated result in one pass; `cols` and `colw` then follow.
fn delete_column(cst: &mut Cst, path: &[usize], at: usize) -> bool {
    let Some((cols, child_count)) = grid_layout_at(cst, path) else {
        return false;
    };
    if at >= cols || cols == 1 {
        return false; // the last column IS the grid — delete the grid instead
    }
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let old = std::mem::take(children);
        let removed = (0..child_count).filter(|index| index % cols == at).count();
        let mut rebuilt = Vec::with_capacity(child_count - removed);
        rebuilt.extend(
            old.into_iter()
                .enumerate()
                .filter_map(|(index, cell)| (index % cols != at).then_some(cell)),
        );
        *children = rebuilt;
    }
    let next = cols - 1;
    if !set_group_attr(cst, path, "cols", Some(&next.to_string())) {
        return false;
    }
    remove_list_attr(cst, path, "colw", at);
    true
}

/// The `DeleteRow` implementation: the row's consecutive cells leave the
/// flow (later rows stay aligned); the `rowh` entry goes with it. A grid
/// whose last row leaves is scaffolding and removes itself.
fn delete_row(cst: &mut Cst, path: &[usize], at_row: usize) -> bool {
    let Some((cols, _)) = grid_layout_at(cst, path) else {
        return false;
    };
    let emptied;
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let rows = children.len().div_ceil(cols);
        if at_row >= rows {
            return false;
        }
        let start = at_row * cols;
        let end = ((at_row + 1) * cols).min(children.len());
        children.drain(start..end);
        emptied = !children.iter().any(|c| is_container_named(c, "cell"));
    }
    remove_list_attr(cst, path, "rowh", at_row);
    if emptied {
        remove_node_at(cst, path);
    }
    true
}

/// The `MoveColumn` implementation: rebuild one short row at a time so vector
/// shifts cost O(columns), not O(the entire grid), and total work stays O(N).
fn move_column(cst: &mut Cst, path: &[usize], from: usize, to: usize) -> bool {
    let Some((cols, _)) = grid_layout_at(cst, path) else {
        return false;
    };
    if from >= cols || to >= cols || from == to {
        return false;
    }
    let style = line_style_at(cst, path);
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        if children.is_empty() {
            return false;
        }
        pad_to_rect(children, cols, &style);
        let old = std::mem::take(children);
        let mut source = old.into_iter();
        let mut rebuilt = Vec::with_capacity(source.len());
        while source.len() > 0 {
            let mut row: Vec<Node> = source.by_ref().take(cols).collect();
            let cell = row.remove(from);
            row.insert(to, cell);
            rebuilt.extend(row);
        }
        *children = rebuilt;
    }
    move_list_attr(cst, path, "colw", from, to);
    true
}

/// The `MoveRow` implementation: drain the row's cells and re-splice at the
/// target row's flow position (post-drain, `to * cols` IS the final slot for
/// both directions); `rowh` follows.
fn move_row(cst: &mut Cst, path: &[usize], from: usize, to: usize) -> bool {
    let Some((cols, _)) = grid_layout_at(cst, path) else {
        return false;
    };
    let style = line_style_at(cst, path);
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        if children.is_empty() {
            return false;
        }
        let rows = children.len().div_ceil(cols);
        if from >= rows || to >= rows || from == to {
            return false;
        }
        pad_to_rect(children, cols, &style);
        let moved: Vec<Node> = children.drain(from * cols..(from + 1) * cols).collect();
        let insert_at = to * cols;
        children.splice(insert_at..insert_at, moved);
    }
    move_list_attr(cst, path, "rowh", from, to);
    true
}

/// The `ClearCell` implementation: empty the cell in place — geometry is
/// sacred (flow removal would shift every later cell across columns).
fn clear_cell(cst: &mut Cst, path: &[usize], index: usize) -> bool {
    if grid_layout_at(cst, path).is_none() {
        return false;
    }
    let Some(children) = named_children_at_mut(cst, path, "grid") else {
        return false;
    };
    let Some(cell) = children.get_mut(index) else {
        return false;
    };
    if !is_container_named(cell, "cell") {
        return false;
    }
    let Node::Container { children: kids, .. } = cell else {
        return false;
    };
    if kids.is_empty() {
        return false; // already clear — a no-op
    }
    kids.clear();
    true
}

/// Pad a ragged grid rectangular with empty cells — row-major flow cannot
/// express raggedness anywhere but the very end, so row/column moves need a
/// full lattice to stay column-true.
fn pad_to_rect(children: &mut Vec<Node>, cols: usize, style: &LineStyle) {
    while !children.is_empty() && !children.len().is_multiple_of(cols) {
        children.push(new_cell_styled(style));
    }
}

fn move_cell_in_column(cst: &mut Cst, path: &[usize], from: usize, to: usize) -> bool {
    let Some((cols, _)) = grid_layout_at(cst, path) else {
        return false;
    };
    let Some(children) = children_at_mut(cst, path) else {
        return false;
    };
    if from == to || from >= children.len() || to >= children.len() || from % cols != to % cols {
        return false;
    }
    if !is_container_named(&children[from], "cell") || !is_container_named(&children[to], "cell") {
        return false;
    }
    let mut i = from;
    while i != to {
        let j = if to > from { i + cols } else { i - cols };
        children.swap(i, j);
        i = j;
    }
    true
}

/// Write/remove one `{key=value}` token on a grid or directive-tabs header.
/// Friendly tab groups have no header line to carry attrs — rejected.
fn set_group_attr(cst: &mut Cst, path: &[usize], key: &str, value: Option<&str>) -> bool {
    if !valid_attr(key, value) {
        return false;
    }
    let Some(node) = node_at_mut(cst, path) else {
        return false;
    };
    let Node::Container {
        name,
        title,
        colons,
        open_line,
        ..
    } = node
    else {
        return false;
    };
    if (name != "grid" && name != "tabs") || !is_directive_line(open_line) {
        return false;
    }
    let (_, attrs) = split_title_attrs(title);
    let attrs = set_attr_token(&attrs, key, value);
    let next_title = format!("{{{attrs}}}");
    let c = ":".repeat((*colons).max(3));
    let indent = line_indent(open_line);
    let eol = line_ending(open_line);
    let next_open_line = format!("{indent}{c}{name} {{{attrs}}}{eol}");
    if *title == next_title && *open_line == next_open_line {
        return false;
    }
    *title = next_title;
    *open_line = next_open_line;
    true
}

/// Whether a key/value pair can be represented in a directive attribute
/// token without changing lines or confusing the token grammar.
fn valid_attr(key: &str, value: Option<&str>) -> bool {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    value.is_none_or(|v| {
        !v.is_empty()
            && !v
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == '{' || c == '}')
    })
}

/// Indentation prefix of a stored opening line.
fn line_indent(line: &str) -> &str {
    let content = line
        .strip_suffix("\r\n")
        .or_else(|| line.strip_suffix('\n'))
        .unwrap_or(line);
    &content[..content.len() - content.trim_start_matches(' ').len()]
}

/// Exact line ending used by a stored opening line.
fn line_ending(line: &str) -> &str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

/// Whether a stored line is an indented or unindented colon directive.
fn is_directive_line(line: &str) -> bool {
    line.trim_start_matches(' ').starts_with(":::")
}

#[derive(Clone)]
struct LineStyle {
    indent: String,
    eol: String,
}

impl Default for LineStyle {
    fn default() -> Self {
        Self {
            indent: String::new(),
            eol: "\n".to_string(),
        }
    }
}

/// Infer generated-directive formatting from the nearest existing source.
fn line_style_at(cst: &Cst, path: &[usize]) -> LineStyle {
    if path.is_empty() {
        return node_line_style(&cst.children).unwrap_or_default();
    }
    if let Some(Node::Container {
        open_line,
        children,
        ..
    }) = node_at(cst, path)
    {
        if !open_line.is_empty() {
            return LineStyle {
                indent: line_indent(open_line).to_string(),
                eol: line_ending(open_line).to_string(),
            };
        }
        return node_line_style(children).unwrap_or_default();
    }
    LineStyle::default()
}

fn node_line_style(nodes: &[Node]) -> Option<LineStyle> {
    for node in nodes {
        match node {
            Node::Container {
                open_line,
                children,
                ..
            } => {
                if !open_line.is_empty() {
                    return Some(LineStyle {
                        indent: line_indent(open_line).to_string(),
                        eol: line_ending(open_line).to_string(),
                    });
                }
                if let Some(style) = node_line_style(children) {
                    return Some(style);
                }
            }
            Node::Leaf { text, .. } => {
                if text.contains("\r\n") {
                    return Some(LineStyle {
                        indent: String::new(),
                        eol: "\r\n".to_string(),
                    });
                }
                if text.contains('\n') {
                    return Some(LineStyle::default());
                }
            }
        }
    }
    None
}

fn set_attr_token(attrs: &str, key: &str, value: Option<&str>) -> String {
    let mut tokens: Vec<String> = attrs
        .split_whitespace()
        .filter(|tok| tok.split_once('=').is_none_or(|(k, _)| k != key))
        .map(str::to_string)
        .collect();
    if let Some(v) = value {
        // Keep a replaced key at its original position when possible.
        let pos = attrs
            .split_whitespace()
            .position(|tok| tok.split_once('=').is_some_and(|(k, _)| k == key));
        let token = format!("{key}={v}");
        match pos {
            Some(p) if p <= tokens.len() => tokens.insert(p, token),
            _ => tokens.push(token),
        }
    }
    tokens.join(" ")
}

/// Rewrite a tab's title and open line, preserving its form.
fn set_tab_title(tab: &mut Node, full_title: &str) -> bool {
    if full_title.chars().any(char::is_control) {
        return false;
    }
    if let Node::Container {
        title,
        colons,
        open_line,
        ..
    } = tab
    {
        let indent = line_indent(open_line);
        let eol = line_ending(open_line);
        let next_open_line = if is_directive_line(open_line) {
            let c = ":".repeat((*colons).max(3));
            format!("{indent}{c}tab {full_title}{eol}")
        } else {
            format!("{indent}tab: {full_title}{eol}")
        };
        if title == full_title && *open_line == next_open_line {
            return false;
        }
        *open_line = next_open_line;
        *title = full_title.to_string();
        return true;
    }
    false
}

/// Whether `nodes`' serialization equals `expected` byte-for-byte, WITHOUT
/// building the string: each stored segment is matched against the front of
/// `expected`, failing fast on the first divergence.
fn region_matches(nodes: &[Node], expected: &str) -> bool {
    /// Strip `seg` off the front of `rest`; `false` on mismatch.
    fn eat(rest: &mut &str, seg: &str) -> bool {
        match rest.strip_prefix(seg) {
            Some(r) => {
                *rest = r;
                true
            }
            None => false,
        }
    }
    fn eat_node(rest: &mut &str, node: &Node) -> bool {
        match node {
            Node::Leaf { text, .. } => eat(rest, text),
            Node::Container {
                open_line,
                children,
                close_line,
                ..
            } => {
                eat(rest, open_line)
                    && children.iter().all(|c| eat_node(rest, c))
                    && eat(rest, close_line)
            }
        }
    }
    let mut rest = expected;
    nodes.iter().all(|n| eat_node(&mut rest, n)) && rest.is_empty()
}

/// Terminate `text` with a newline (empty stays empty) so a serialized region
/// can never glue onto a following `:::` / fence line. Borrows when already
/// terminated — the common editor case.
fn terminated(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.is_empty() && !text.ends_with('\n') {
        std::borrow::Cow::Owned(format!("{text}\n"))
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

/// A group with no tabs (tabs) or no cells (grid) left — pure scaffolding.
fn is_empty_group(node: &Node) -> bool {
    match node {
        Node::Container { name, children, .. } if name == "tabs" => {
            !children.iter().any(|c| is_container_named(c, "tab"))
        }
        Node::Container { name, children, .. } if name == "grid" => {
            !children.iter().any(|c| is_container_named(c, "cell"))
        }
        _ => false,
    }
}

/// Convert a friendly tab to directive form (or back), preserving title/children.
fn conform_tab(tab: &mut Node, directive: bool, colons: usize) {
    let Node::Container {
        title,
        colons: tc,
        open_line,
        close_line,
        ..
    } = tab
    else {
        return;
    };
    let indent = line_indent(open_line).to_string();
    let eol = line_ending(open_line).to_string();
    if directive {
        let c = ":".repeat(colons.max(3));
        *open_line = format!("{indent}{c}tab {title}{eol}");
        *close_line = format!("{indent}{c}{eol}");
        *tc = colons.max(3);
    } else {
        // Friendly tabs are recognized only at column zero.
        *open_line = format!("tab: {title}{eol}");
        *close_line = String::new();
        *tc = 0;
    }
}

/// Convert a friendly tabs group to explicit `:::tabs` form in place.
fn directivize_group(group: &mut Node) {
    let Node::Container {
        name,
        colons,
        open_line,
        close_line,
        children,
        ..
    } = group
    else {
        return;
    };
    if name != "tabs" || is_directive_line(open_line) {
        return;
    }
    let eol = children
        .iter()
        .find_map(|child| match child {
            Node::Container { open_line, .. } => Some(line_ending(open_line)),
            Node::Leaf { .. } => None,
        })
        .unwrap_or("\n");
    *open_line = format!(":::tabs{eol}");
    *close_line = format!(":::{eol}");
    *colons = 3;
    for child in children.iter_mut() {
        if is_container_named(child, "tab") {
            conform_tab(child, true, 3);
        }
    }
}

/// Anything inserted after a closer-free `tab:` group at the same level
/// would re-parse INTO the group's last tab (the friendly form absorbs until
/// EOF or an ancestor closer). Directivize the nearest preceding container if
/// it is a friendly tabs group — leaves in between don't break the hazard.
fn guard_friendly_glue(children: &mut [Node], at: usize) {
    for i in (0..at.min(children.len())).rev() {
        match &children[i] {
            Node::Leaf { .. } => continue,
            Node::Container { .. } => {
                directivize_group(&mut children[i]);
                return;
            }
        }
    }
}

/// The full `MoveNode` implementation: validate, detach, re-path, conform, insert, prune.
fn move_node(cst: &mut Cst, from: &[usize], to_parent: &[usize], to_index: usize) -> bool {
    let Some((&from_idx, from_parent)) = from.split_last() else {
        return false;
    };
    // A node may not move into its own subtree (this includes onto itself).
    if to_parent.len() >= from.len() && to_parent[..from.len()] == *from {
        return false;
    }
    // Validate the moved node's kind against the destination BEFORE mutating.
    let Some(moved_ref) = node_at(cst, from) else {
        return false;
    };
    let moved_name = match moved_ref {
        Node::Container { name, .. } => name.clone(),
        Node::Leaf { .. } => return false, // only containers move
    };
    let dest_name: Option<String> = if to_parent.is_empty() {
        None // block root
    } else {
        match node_at(cst, to_parent) {
            Some(Node::Container { name, .. }) => Some(name.clone()),
            _ => return false,
        }
    };
    let dest_form = if moved_name == "tab" {
        group_form(cst, to_parent, "tabs")
    } else {
        None
    };
    match (moved_name.as_str(), dest_name.as_deref()) {
        ("tab", Some("tabs")) => {}
        ("tab", _) => return false,
        ("cell", Some("grid")) => {}
        ("cell", _) => return false,
        // Groups (and other containers) live inside tabs' bodies, cells, or the
        // root — never as direct children of a tabs strip or a grid.
        (_, Some("tabs") | Some("grid")) => return false,
        (_, _) => {}
    }

    let same_parent = to_parent == from_parent;

    // Detach.
    let Some(src_children) = children_at_mut(cst, from_parent) else {
        return false;
    };
    if from_idx >= src_children.len() {
        return false;
    }
    let mut moved = src_children.remove(from_idx);

    // Re-path the destination for the removal shift (removal only shifts
    // sibling indices AFTER from_idx at from's parent level).
    let mut dest_path: Vec<usize> = to_parent.to_vec();
    let d = from_parent.len();
    if !same_parent
        && dest_path.len() > d
        && dest_path[..d] == *from_parent
        && dest_path[d] > from_idx
    {
        dest_path[d] -= 1;
    }

    // Same-parent index adjustment (the removal shifted later indices left).
    let mut at = to_index;
    if same_parent && from_idx < at {
        at -= 1;
    }

    // No-op move — put it back and report no change.
    if same_parent && at == from_idx {
        if let Some(src) = children_at_mut(cst, from_parent) {
            src.insert(from_idx, moved);
        }
        return false;
    }

    // Conform forms so the result reparses to the same structure:
    // tabs adopt their new group's form; friendly groups leaving the root
    // become explicit `:::tabs`.
    if moved_name == "tab" {
        if let Some((directive, colons)) = dest_form {
            conform_tab(&mut moved, directive, colons);
        }
    } else if moved_name == "tabs" && !dest_path.is_empty() {
        directivize_group(&mut moved);
    }

    // Insert.
    let Some(dest_children) = children_at_mut(cst, &dest_path) else {
        // Destination vanished (shouldn't happen after validation) — restore.
        if let Some(src) = children_at_mut(cst, from_parent) {
            let idx = from_idx.min(src.len());
            src.insert(idx, moved);
        }
        return false;
    };
    let at = at.min(dest_children.len());
    dest_children.insert(at, moved);
    guard_friendly_glue(dest_children, at);

    // Prune the source group if the move emptied it (path adjusted for the
    // insertion: indices inside dest_path at depth dest_path.len() shifted).
    if !same_parent && !from_parent.is_empty() {
        let mut src_parent_path: Vec<usize> = from_parent.to_vec();
        let dd = dest_path.len();
        if src_parent_path.len() > dd
            && src_parent_path[..dd] == dest_path
            && src_parent_path[dd] >= at
        {
            src_parent_path[dd] += 1;
        }
        let empty = node_at(cst, &src_parent_path).is_some_and(is_empty_group);
        if empty {
            remove_node_at(cst, &src_parent_path);
        }
    }
    true
}

/// The `MoveRegion` implementation: validate, splice out, re-index, splice in.
fn move_region(
    cst: &mut Cst,
    path: &[usize],
    start: usize,
    end: usize,
    to_parent: &[usize],
    to_index: usize,
) -> bool {
    if start >= end {
        return false;
    }
    // Destination must be a container that RENDERS leaves: not a tabs strip,
    // not a grid's cell list.
    if !to_parent.is_empty() {
        match node_at(cst, to_parent) {
            Some(Node::Container { name, .. }) if name != "tabs" && name != "grid" => {}
            _ => return false,
        }
    }
    // The run must be all-leaf and in range.
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        if end > children.len()
            || !children[start..end]
                .iter()
                .all(|n| matches!(n, Node::Leaf { .. }))
        {
            return false;
        }
    }
    let same = to_parent == path;
    let count = end - start;
    // Same-container no-op: dropping back into (or adjacent to) its own span.
    if same && to_index >= start && to_index <= end {
        return false;
    }

    let Some(src_children) = children_at_mut(cst, path) else {
        return false;
    };
    let run: Vec<Node> = src_children
        .splice(start..end, std::iter::empty())
        .collect();

    // Re-index the destination for the removal.
    let mut at = to_index;
    let mut dest_path: Vec<usize> = to_parent.to_vec();
    if same {
        if at > end {
            at -= count;
        }
    } else {
        let d = path.len();
        if dest_path.len() > d && dest_path[..d] == *path && dest_path[d] >= end {
            dest_path[d] -= count;
        }
    }

    let Some(dest_children) = children_at_mut(cst, &dest_path) else {
        // Destination vanished — restore the run.
        if let Some(src) = children_at_mut(cst, path) {
            let idx = start.min(src.len());
            src.splice(idx..idx, run);
        }
        return false;
    };
    let at = at.min(dest_children.len());
    dest_children.splice(at..at, run);
    guard_friendly_glue(dest_children, at);
    true
}

/// Build a friendly, closer-free tab (`tab: Title`) with one empty leaf.
#[cfg(test)]
fn friendly_tab(title: &str) -> Node {
    friendly_tab_styled(title, &LineStyle::default())
}

fn friendly_tab_styled(title: &str, style: &LineStyle) -> Node {
    Node::Container {
        name: "tab".to_string(),
        title: title.to_string(),
        colons: 0,
        // Friendly syntax is structural only at column zero.
        open_line: format!("tab: {title}{}", style.eol),
        children: vec![empty_leaf()],
        close_line: String::new(),
    }
}

/// A fresh empty prose leaf (new structures are created EMPTY so adding one
/// is never a content change).
fn empty_leaf() -> Node {
    Node::Leaf {
        text: String::new(),
        is_code: false,
    }
}

/// Build an explicit `:::tab` with `colons` colons and one empty leaf.
#[cfg(test)]
fn directive_tab(title: &str, colons: usize) -> Node {
    directive_tab_styled(title, colons, &LineStyle::default())
}

fn directive_tab_styled(title: &str, colons: usize, style: &LineStyle) -> Node {
    let c = ":".repeat(colons.max(3));
    Node::Container {
        name: "tab".to_string(),
        title: title.to_string(),
        colons: colons.max(3),
        open_line: format!("{}{c}tab {title}{}", style.indent, style.eol),
        children: vec![empty_leaf()],
        close_line: format!("{}{c}{}", style.indent, style.eol),
    }
}

/// Build a new empty `:::cell`.
#[cfg(test)]
fn new_cell() -> Node {
    new_cell_styled(&LineStyle::default())
}

fn new_cell_styled(style: &LineStyle) -> Node {
    Node::Container {
        name: "cell".to_string(),
        title: String::new(),
        colons: 3,
        open_line: format!("{}:::cell{}", style.indent, style.eol),
        children: vec![empty_leaf()],
        close_line: format!("{}:::{}", style.indent, style.eol),
    }
}

fn new_section_styled(children: Vec<Node>, style: &LineStyle) -> Node {
    let colons = section_fence_len(&children);
    let fence = ":".repeat(colons);
    Node::Container {
        name: "section".to_string(),
        title: String::new(),
        colons,
        open_line: format!("{}{fence}section{}", style.indent, style.eol),
        children,
        close_line: format!("{}{fence}{}", style.indent, style.eol),
    }
}

/// A logical section's fence must be longer than every closer-like line in its
/// Markdown body, otherwise reparsing would truncate the section. O(n) in the
/// exact stored payload bytes; section creation already owns those nodes.
fn section_fence_len(nodes: &[Node]) -> usize {
    fn max_closer(node: &Node) -> usize {
        match node {
            Node::Leaf { text, .. } => text
                .lines()
                .filter_map(crate::parser::colon_close_len)
                .max()
                .unwrap_or(0),
            Node::Container { children, .. } => children.iter().map(max_closer).max().unwrap_or(0),
        }
    }

    nodes
        .iter()
        .map(max_closer)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        .max(3)
}

fn grow_section_fence_at(cst: &mut Cst, path: &[usize]) {
    if let Some(node) = node_at_mut(cst, path) {
        grow_section_fence(node);
    }
}

/// Grow an existing logical-section fence around its exact payload. Never
/// shrink: an authored longer fence may be intentional and is already valid.
fn grow_section_fence(node: &mut Node) {
    let Node::Container {
        name,
        colons,
        open_line,
        children,
        close_line,
        ..
    } = node
    else {
        return;
    };
    if name != "section" {
        return;
    }
    let required = section_fence_len(children).max(*colons);
    if required == *colons {
        return;
    }
    *open_line = grow_colon_line(open_line, required);
    if !close_line.is_empty() {
        *close_line = grow_colon_line(close_line, required);
    }
    *colons = required;
}

fn grow_colon_line(line: &str, required: usize) -> String {
    let indent = line.len() - line.trim_start_matches(' ').len();
    let run = line[indent..]
        .bytes()
        .take_while(|&byte| byte == b':')
        .count();
    if run >= required {
        return line.to_string();
    }
    let mut grown = String::with_capacity(line.len() + required - run);
    grown.push_str(&line[..indent]);
    grown.push_str(&":".repeat(required));
    grown.push_str(&line[indent + run..]);
    grown
}

/// Build a new empty `:::grid {cols=N}`.
#[cfg(test)]
fn new_grid(cols: usize) -> Node {
    new_grid_styled(cols, &LineStyle::default())
}

fn new_grid_styled(cols: usize, style: &LineStyle) -> Node {
    let cols = cols.max(1);
    Node::Container {
        name: "grid".to_string(),
        title: format!("{{cols={cols}}}"),
        colons: 3,
        open_line: format!("{}:::grid {{cols={cols}}}{}", style.indent, style.eol),
        children: Vec::new(),
        close_line: format!("{}:::{}", style.indent, style.eol),
    }
}

/// Build a new tabs group with one "New tab".
#[cfg(test)]
fn new_tabs_group(directive: bool) -> Node {
    new_tabs_group_styled(directive, &LineStyle::default())
}

fn new_tabs_group_styled(directive: bool, style: &LineStyle) -> Node {
    Node::Container {
        name: "tabs".to_string(),
        title: String::new(),
        colons: if directive { 3 } else { 0 },
        open_line: if directive {
            format!("{}:::tabs{}", style.indent, style.eol)
        } else {
            String::new()
        },
        children: vec![if directive {
            directive_tab_styled("New tab", 3, style)
        } else {
            friendly_tab_styled("New tab", style)
        }],
        close_line: if directive {
            format!("{}:::{}", style.indent, style.eol)
        } else {
            String::new()
        },
    }
}

/// Split a tab title into its display part and `{...}` attr block, if any.
///
/// Purpose: tabs carry per-tab attrs (e.g. `{icon=rocket}`) inline in the
/// title; renderers show only the display part.
///
/// # Arguments
/// * `title` - the raw title string from the CST
///
/// # Returns
/// `(display, attrs)` where `attrs` is the raw inner text of a trailing
/// `{...}` block (empty when absent).
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// assert_eq!(mica_core::ops::split_title_attrs("A {icon=rocket}"), ("A".to_string(), "icon=rocket".to_string()));
/// assert_eq!(mica_core::ops::split_title_attrs("A"), ("A".to_string(), String::new()));
/// ```
pub fn split_title_attrs(title: &str) -> (String, String) {
    let t = title.trim_end();
    if t.ends_with('}') {
        if let Some(open) = t.rfind('{') {
            let attrs = t[open + 1..t.len() - 1].trim().to_string();
            let display = t[..open].trim().to_string();
            return (display, attrs);
        }
    }
    (t.trim().to_string(), String::new())
}

/// Read one `key=value` attr from a title's `{...}` block.
fn title_attr(title: &str, key: &str) -> Option<String> {
    let title = title.trim_end();
    if !title.ends_with('}') {
        return None;
    }
    let open = title.rfind('{')?;
    let attrs = title[open + 1..title.len() - 1].trim();
    attrs.split_whitespace().find_map(|tok| {
        let (k, v) = tok.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn normalize_section_wraps_mixed_markdown_as_one_exact_payload() {
        let source = "First paragraph.\n\n> [!note] Context\n> Keep this attached.\n\n````md\n:::\n``` nested\n````\n\nLast paragraph.\n";
        let expected = "::::section\nFirst paragraph.\n\n> [!note] Context\n> Keep this attached.\n\n````md\n:::\n``` nested\n````\n\nLast paragraph.\n::::\n";

        assert_eq!(
            normalize_section_impl(source),
            Ok(SectionNormalization::Wrapped(expected.to_string()))
        );
    }

    #[test]
    fn normalize_section_is_idempotent_for_one_closed_root_section() {
        let source = "::::section\r\nalpha\r\n\r\nbeta\r\n::::\r\n";

        assert_eq!(
            normalize_section_impl(source),
            Ok(SectionNormalization::AlreadyNormalized)
        );
    }

    #[test]
    fn normalize_section_rejects_nonempty_payload_without_terminal_newline() {
        assert_eq!(
            normalize_section_impl("alpha"),
            Err(SectionNormalizationError::MissingTerminalNewline)
        );
    }

    #[test]
    fn normalize_section_rejects_a_wrapper_that_changes_content_signature() {
        let mut source = String::new();
        for _ in 0..128 {
            source.push_str(":::box\n");
        }
        source.push_str("payload\n");
        for _ in 0..128 {
            source.push_str(":::\n");
        }

        assert_eq!(
            normalize_section_impl(&source),
            Err(SectionNormalizationError::ValidationFailed)
        );
    }

    #[test]
    fn normalize_section_preserves_crlf_and_whitespace_only_payloads() {
        assert_eq!(
            normalize_section_impl("\r\n \r\n"),
            Ok(SectionNormalization::Wrapped(
                ":::section\r\n\r\n \r\n:::\r\n".to_string()
            ))
        );
        assert_eq!(
            normalize_section_impl(""),
            Ok(SectionNormalization::Wrapped(
                ":::section\n:::\n".to_string()
            ))
        );
    }

    #[test]
    fn normalize_section_sizes_fence_above_literal_root_closers() {
        let source = "alpha\n:::::\nomega\n";

        assert_eq!(
            normalize_section_impl(source),
            Ok(SectionNormalization::Wrapped(
                "::::::section\nalpha\n:::::\nomega\n::::::\n".to_string()
            ))
        );
    }

    #[test]
    fn normalize_section_rejects_an_unclosed_root_section() {
        assert_eq!(
            normalize_section_impl(":::section\nalpha\n"),
            Err(SectionNormalizationError::ValidationFailed)
        );
    }

    #[test]
    fn combine_plain_regions_wraps_without_changing_paragraphs() {
        let src = "Alpha\n\nBeta\n";
        let (changed, out) = apply(
            src,
            StructOp::CombineRegions {
                source_path: vec![],
                source_start: 2,
                source_end: 3,
                source_expected: "Beta\n".into(),
                target_path: vec![],
                target_start: 0,
                target_end: 2,
                target_expected: "Alpha\n\n".into(),
            },
        );
        assert!(changed);
        assert_eq!(out, ":::section\nAlpha\n\nBeta\n:::\n");
    }

    #[test]
    fn combine_plain_regions_across_nested_parents_keeps_containers() {
        let src = ":::tabs\n:::tab A\nSource\n:::\n:::tab B\nTarget\n:::\n:::\n";
        let (changed, out) = apply(
            src,
            StructOp::CombineRegions {
                source_path: vec![0, 0],
                source_start: 0,
                source_end: 1,
                source_expected: "Source\n".into(),
                target_path: vec![0, 1],
                target_start: 0,
                target_end: 1,
                target_expected: "Target\n".into(),
            },
        );
        assert!(changed);
        assert_eq!(
            out,
            ":::tabs\n:::tab A\n:::\n:::tab B\n:::section\nTarget\n\nSource\n:::\n:::\n:::\n"
        );
    }

    #[test]
    fn combine_root_target_adjusts_a_later_nested_source_path() {
        let src = "Target\n\n:::tabs\n:::tab A\nSource\n:::\n:::\n";
        let (changed, out) = apply(
            src,
            StructOp::CombineRegions {
                source_path: vec![2, 0],
                source_start: 0,
                source_end: 1,
                source_expected: "Source\n".into(),
                target_path: vec![],
                target_start: 0,
                target_end: 2,
                target_expected: "Target\n\n".into(),
            },
        );
        assert!(changed);
        assert_eq!(
            out,
            ":::section\nTarget\n\nSource\n:::\n:::tabs\n:::tab A\n:::\n:::\n"
        );
    }

    #[test]
    fn combine_plain_region_into_existing_section_keeps_one_wrapper() {
        let src = "Gamma\n\n:::section\nAlpha\n\nBeta\n:::\n";
        let (changed, out) = apply(
            src,
            StructOp::CombineRegions {
                source_path: vec![],
                source_start: 0,
                source_end: 2,
                source_expected: "Gamma\n\n".into(),
                target_path: vec![],
                target_start: 2,
                target_end: 3,
                target_expected: ":::section\nAlpha\n\nBeta\n:::\n".into(),
            },
        );
        assert!(changed);
        assert_eq!(out, ":::section\nAlpha\n\nBeta\n\nGamma\n:::\n");
    }

    #[test]
    fn combine_into_existing_section_grows_fence_above_literal_closer() {
        let src = "Gamma\n:::::\nmore\n\n:::section\nAlpha\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::CombineRegions {
                source_path: vec![],
                source_start: 0,
                source_end: 2,
                source_expected: "Gamma\n:::::\nmore\n\n".into(),
                target_path: vec![],
                target_start: 2,
                target_end: 3,
                target_expected: ":::section\nAlpha\n:::\n".into(),
            },
        );
        assert!(ok);
        assert_eq!(out, "::::::section\nAlpha\n\nGamma\n:::::\nmore\n::::::\n");
        assert_eq!(parse_block_impl(&out).children.len(), 1);
    }

    #[test]
    fn combine_regions_rejects_stale_or_incompatible_inputs() {
        let prose = "Alpha\n\nBeta\n";
        for op in [
            StructOp::CombineRegions {
                source_path: vec![],
                source_start: 2,
                source_end: 3,
                source_expected: "Beta\n".into(),
                target_path: vec![],
                target_start: 0,
                target_end: 2,
                target_expected: "stale\n".into(),
            },
            StructOp::CombineRegions {
                source_path: vec![],
                source_start: 0,
                source_end: 2,
                source_expected: "Alpha\n\n".into(),
                target_path: vec![],
                target_start: 0,
                target_end: 2,
                target_expected: "Alpha\n\n".into(),
            },
        ] {
            assert_eq!(apply(prose, op), (false, prose.to_string()));
        }

        let code = "Alpha\n\n```js\nconst beta = 1;\n```\n";
        assert_eq!(
            apply(
                code,
                StructOp::CombineRegions {
                    source_path: vec![],
                    source_start: 2,
                    source_end: 3,
                    source_expected: "```js\nconst beta = 1;\n```\n".into(),
                    target_path: vec![],
                    target_start: 0,
                    target_end: 2,
                    target_expected: "Alpha\n\n".into(),
                },
            ),
            (false, code.to_string())
        );

        let callout = "Alpha\n\n> [!note]\n> Beta\n";
        assert_eq!(
            apply(
                callout,
                StructOp::CombineRegions {
                    source_path: vec![],
                    source_start: 2,
                    source_end: 3,
                    source_expected: "> [!note]\n> Beta\n".into(),
                    target_path: vec![],
                    target_start: 0,
                    target_end: 2,
                    target_expected: "Alpha\n\n".into(),
                },
            ),
            (false, callout.to_string())
        );
    }

    #[test]
    fn uncombine_section_restores_children() {
        let src = ":::section\nAlpha\n\nBeta\n:::\n";
        let (changed, out) = apply(src, StructOp::UncombineSection { path: vec![0] });
        assert!(changed);
        assert_eq!(out, "Alpha\n\nBeta\n");
        assert_eq!(
            apply(
                ":::grid {cols=2}\n:::\n",
                StructOp::UncombineSection { path: vec![0] }
            ),
            (false, ":::grid {cols=2}\n:::\n".to_string())
        );
    }
    use crate::parser::{parse_block_impl, serialize_impl};

    fn ser(cst: &Cst) -> String {
        serialize_impl(cst)
    }

    // --- factories -------------------------------------------------------

    #[test]
    fn factories_serialize_to_exact_source() {
        let tab = friendly_tab("New tab");
        let mut cst = Cst {
            children: vec![tab],
        };
        assert_eq!(
            ser(&cst),
            "tab: New tab
"
        );

        cst = Cst {
            children: vec![directive_tab("Inner", 3)],
        };
        assert_eq!(
            ser(&cst),
            ":::tab Inner
:::
"
        );

        cst = Cst {
            children: vec![new_cell()],
        };
        assert_eq!(
            ser(&cst),
            ":::cell
:::
"
        );

        cst = Cst {
            children: vec![new_grid(2)],
        };
        assert_eq!(
            ser(&cst),
            ":::grid {cols=2}
:::
"
        );

        cst = Cst {
            children: vec![new_tabs_group(false)],
        };
        assert_eq!(
            ser(&cst),
            "tab: New tab
"
        );
        cst = Cst {
            children: vec![new_tabs_group(true)],
        };
        assert_eq!(
            ser(&cst),
            ":::tabs
:::tab New tab
:::
:::
"
        );
    }

    #[test]
    fn title_attr_helpers_split_and_read() {
        assert_eq!(
            split_title_attrs("A {icon=rocket}"),
            ("A".to_string(), "icon=rocket".to_string())
        );
        assert_eq!(split_title_attrs("A"), ("A".to_string(), String::new()));
        assert_eq!(
            split_title_attrs("{cols=3}"),
            (String::new(), "cols=3".to_string())
        );
        assert_eq!(
            title_attr("A {icon=rocket color=red}", "color").as_deref(),
            Some("red")
        );
        assert_eq!(title_attr("A {icon=rocket}", "cols"), None);
        assert_eq!(title_attr("A", "icon"), None);
    }

    // --- reducer -----------------------------------------------------------

    fn apply(src: &str, op: StructOp) -> (bool, String) {
        let mut cst = parse_block_impl(src);
        let changed = apply_op_impl(&mut cst, &op);
        (changed, ser(&cst))
    }

    #[test]
    fn rename_tab_keeps_attrs_and_friendly_form() {
        let (ok, out) = apply(
            "tab: A {icon=rocket}\nbody\n",
            StructOp::RenameTab {
                path: vec![0],
                index: 0,
                title: "B".into(),
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: B {icon=rocket}\nbody\n");
    }

    #[test]
    fn rename_tab_directive_form() {
        let (ok, out) = apply(
            ":::tabs\n:::tab A\nx\n:::\n:::\n",
            StructOp::RenameTab {
                path: vec![0],
                index: 0,
                title: "Z".into(),
            },
        );
        assert!(ok);
        assert_eq!(out, ":::tabs\n:::tab Z\nx\n:::\n:::\n");
    }

    #[test]
    fn tab_header_edits_reject_control_characters_without_mutating() {
        let src = "tab: A {icon=rocket}\nbody\n";
        for op in [
            StructOp::RenameTab {
                path: vec![0],
                index: 0,
                title: "injected\n:::grid".into(),
            },
            StructOp::SetTabAttr {
                path: vec![0],
                index: 0,
                key: "icon".into(),
                value: Some("star\rmalicious".into()),
            },
            StructOp::SetTabAttr {
                path: vec![0],
                index: 0,
                key: "bad\tkey".into(),
                value: Some("star".into()),
            },
        ] {
            let (changed, out) = apply(src, op);
            assert!(!changed);
            assert_eq!(out, src);
        }
    }

    #[test]
    fn header_edits_preserve_indent_and_crlf() {
        let src = "  :::tabs\r\n  :::tab A\r\nbody\r\n  :::\r\n  :::\r\n";
        let (changed, renamed) = apply(
            src,
            StructOp::RenameTab {
                path: vec![0],
                index: 0,
                title: "B".into(),
            },
        );
        assert!(changed);
        assert_eq!(
            renamed,
            "  :::tabs\r\n  :::tab B\r\nbody\r\n  :::\r\n  :::\r\n"
        );

        let (changed, out) = apply(
            &renamed,
            StructOp::SetGroupAttr {
                path: vec![0],
                key: "style".into(),
                value: Some("boxed".into()),
            },
        );
        assert!(changed);
        assert_eq!(
            out,
            "  :::tabs {style=boxed}\r\n  :::tab B\r\nbody\r\n  :::\r\n  :::\r\n"
        );
    }

    #[test]
    fn save_region_replaces_and_terminates() {
        let (ok, out) = apply(
            "tab: A\nold\n",
            StructOp::SaveRegion {
                path: vec![0, 0],
                start: 0,
                end: 1,
                expected: "old\n".into(),
                text: "new body".into(), // no trailing newline on purpose
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A\nnew body\n");
    }

    #[test]
    fn save_region_with_multiple_paragraphs_keeps_one_logical_section() {
        let (ok, out) = apply(
            "old\n",
            StructOp::SaveRegion {
                path: vec![],
                start: 0,
                end: 1,
                expected: "old\n".into(),
                text: "first paragraph\n\nsecond paragraph".into(),
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::section\nfirst paragraph\n\nsecond paragraph\n:::\n"
        );
    }

    #[test]
    fn save_region_inside_logical_section_does_not_nest_wrappers() {
        let (ok, out) = apply(
            ":::section\nold\n:::\n",
            StructOp::SaveRegion {
                path: vec![0],
                start: 0,
                end: 1,
                expected: "old\n".into(),
                text: "first paragraph\n\nsecond paragraph".into(),
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::section\nfirst paragraph\n\nsecond paragraph\n:::\n"
        );
    }

    #[test]
    fn save_region_sizes_section_fence_above_literal_closers() {
        let (ok, out) = apply(
            "old\n",
            StructOp::SaveRegion {
                path: vec![],
                start: 0,
                end: 1,
                expected: "old\n".into(),
                text: "first paragraph\n\n:::::\nsecond paragraph".into(),
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            "::::::section\nfirst paragraph\n\n:::::\nsecond paragraph\n::::::\n"
        );
        assert_eq!(parse_block_impl(&out).children.len(), 1);
    }

    #[test]
    fn save_region_grows_existing_section_fence_atomically() {
        let (ok, out) = apply(
            ":::section\nold\n:::\n",
            StructOp::SaveRegion {
                path: vec![0],
                start: 0,
                end: 1,
                expected: "old\n".into(),
                text: "first paragraph\n\n:::::\nsecond paragraph".into(),
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            "::::::section\nfirst paragraph\n\n:::::\nsecond paragraph\n::::::\n"
        );
        assert_eq!(parse_block_impl(&out).children.len(), 1);
    }

    #[test]
    fn save_region_rejects_expected_prefix_and_superset() {
        // `expected` must equal the region's serialization EXACTLY — a strict
        // prefix of it, or a superset carrying extra trailing text, is stale.
        let src = "tab: A\nalpha\n";
        for expected in ["alpha", "alpha\nextra\n"] {
            let (ok, out) = apply(
                src,
                StructOp::SaveRegion {
                    path: vec![0, 0],
                    start: 0,
                    end: 1,
                    expected: expected.into(),
                    text: "clobber\n".into(),
                },
            );
            assert!(!ok, "expected {expected:?} must be rejected");
            assert_eq!(out, src);
        }
    }

    #[test]
    fn save_region_rejects_stale_expected() {
        let src = "tab: A\nreal\n";
        let (ok, out) = apply(
            src,
            StructOp::SaveRegion {
                path: vec![0, 0],
                start: 0,
                end: 1,
                expected: "SOMETHING ELSE\n".into(),
                text: "clobber\n".into(),
            },
        );
        assert!(!ok);
        assert_eq!(out, src, "rejected op must not mutate");
    }

    #[test]
    fn apply_op_text_keeps_exact_input_on_rejection() {
        let src = "tab: A\r\nbody\r\n";
        let rejected = apply_op_text_impl(
            src,
            &StructOp::RenameTab {
                path: vec![0],
                index: 0,
                title: "bad\nheader".into(),
            },
        );
        assert_eq!(
            rejected,
            AppliedText {
                changed: false,
                text: src.into()
            }
        );

        let applied = apply_op_text_impl(
            src,
            &StructOp::RenameTab {
                path: vec![0],
                index: 0,
                title: "B".into(),
            },
        );
        assert!(applied.changed);
        assert_eq!(applied.text, "tab: B\r\nbody\r\n");
    }

    #[test]
    fn atomic_batch_commits_all_or_rejects_all() {
        let src = "tab: A\nbody\n";
        let applied = apply_ops_text_impl(
            src,
            &[
                StructOp::InsertTab {
                    path: vec![0],
                    at: 1,
                },
                StructOp::RenameTab {
                    path: vec![0],
                    index: 1,
                    title: "Named once".into(),
                },
            ],
        );
        assert!(applied.changed);
        assert_eq!(applied.text, "tab: A\nbody\ntab: Named once\n");

        let rejected = apply_ops_text_impl(
            src,
            &[
                StructOp::InsertTab {
                    path: vec![0],
                    at: 1,
                },
                StructOp::RenameTab {
                    path: vec![9],
                    index: 1,
                    title: "missing target".into(),
                },
            ],
        );
        assert!(!rejected.changed);
        assert_eq!(rejected.text, src, "successful prefix must roll back");
        assert!(!apply_ops_text_impl(src, &[]).changed);
    }

    #[test]
    fn insert_tab_matches_group_form() {
        let (ok, out) = apply(
            "tab: A\nx\n",
            StructOp::InsertTab {
                path: vec![0],
                at: 1,
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A\nx\ntab: New tab\n");

        let (ok, out) = apply(
            ":::tabs\n:::tab A\nx\n:::\n:::\n",
            StructOp::InsertTab {
                path: vec![0],
                at: 1,
            },
        );
        assert!(ok);
        assert_eq!(out, ":::tabs\n:::tab A\nx\n:::\n:::tab New tab\n:::\n:::\n");
    }

    #[test]
    fn delete_last_tab_removes_group() {
        let (ok, out) = apply(
            "tab: A\nx\n",
            StructOp::DeleteTab {
                path: vec![0],
                index: 0,
            },
        );
        assert!(ok);
        assert_eq!(out, "");
    }

    #[test]
    fn set_tab_attr_add_update_remove() {
        let (ok, out) = apply(
            "tab: A\nx\n",
            StructOp::SetTabAttr {
                path: vec![0],
                index: 0,
                key: "icon".into(),
                value: Some("rocket".into()),
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A {icon=rocket}\nx\n");

        let (ok, out) = apply(
            "tab: A {icon=rocket color=red}\nx\n",
            StructOp::SetTabAttr {
                path: vec![0],
                index: 0,
                key: "icon".into(),
                value: Some("star".into()),
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A {icon=star color=red}\nx\n");

        let (ok, out) = apply(
            "tab: A {icon=rocket}\nx\n",
            StructOp::SetTabAttr {
                path: vec![0],
                index: 0,
                key: "icon".into(),
                value: None,
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A\nx\n");
    }

    #[test]
    fn cell_insert_and_delete_prunes_empty_grid() {
        let src = ":::grid {cols=2}\n:::cell\na\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::InsertCell {
                path: vec![0],
                at: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\n:::\n:::\n"
        );

        let (ok, out) = apply(
            src,
            StructOp::DeleteCell {
                path: vec![0],
                index: 0,
            },
        );
        assert!(ok);
        assert_eq!(out, "", "grid with no cells left is scaffolding");
    }

    #[test]
    fn save_region_with_empty_text_deletes_the_run() {
        // The region "x" toolbar uses this as its delete op.
        // Tab A children: [prose "alpha\n", ws "\n", callout].
        let src = "tab: A\nalpha\n\n> [!note] Hi\n";
        let (ok, out) = apply(
            src,
            StructOp::SaveRegion {
                path: vec![0, 0],
                start: 2,
                end: 3,
                expected: "> [!note] Hi\n".into(),
                text: String::new(),
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A\nalpha\n", "trailing spacing goes with it");
    }

    #[test]
    fn set_group_attr_writes_and_removes_tokens() {
        // Write colw next to cols…
        let (ok, out) = apply(
            ":::grid {cols=2}\n:::cell\na\n:::\n:::\n",
            StructOp::SetGroupAttr {
                path: vec![0],
                key: "colw".into(),
                value: Some("1.3,0.7".into()),
            },
        );
        assert!(ok);
        assert_eq!(out, ":::grid {cols=2 colw=1.3,0.7}\n:::cell\na\n:::\n:::\n");
        // …and remove it again.
        let (ok2, out2) = apply(
            &out,
            StructOp::SetGroupAttr {
                path: vec![0],
                key: "colw".into(),
                value: None,
            },
        );
        assert!(ok2);
        assert_eq!(out2, ":::grid {cols=2}\n:::cell\na\n:::\n:::\n");
    }

    #[test]
    fn set_group_attr_rejects_bad_targets_and_values() {
        // A cell is not a group.
        let (ok, _) = apply(
            ":::grid {cols=2}\n:::cell\na\n:::\n:::\n",
            StructOp::SetGroupAttr {
                path: vec![0, 0],
                key: "colw".into(),
                value: Some("1".into()),
            },
        );
        assert!(!ok);
        // Values with whitespace or braces would corrupt the header line.
        let (ok2, _) = apply(
            ":::grid {cols=2}\n:::cell\na\n:::\n:::\n",
            StructOp::SetGroupAttr {
                path: vec![0],
                key: "colw".into(),
                value: Some("1 2}".into()),
            },
        );
        assert!(!ok2);
    }

    #[test]
    fn set_cols_preserves_other_attrs() {
        let (ok, out) = apply(
            ":::grid {cols=2 gap=8}\n:::cell\na\n:::\n:::\n",
            StructOp::SetCols {
                path: vec![0],
                cols: 3,
            },
        );
        assert!(ok);
        assert_eq!(out, ":::grid {cols=3 gap=8}\n:::cell\na\n:::\n:::\n");
    }

    #[test]
    fn insert_group_friendly_only_at_empty_root() {
        let (ok, out) = apply(
            "",
            StructOp::InsertGroup {
                path: vec![],
                at: 0,
                kind: GroupKind::Tabs,
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: New tab\n");

        let (ok, out) = apply(
            "some prose\n",
            StructOp::InsertGroup {
                path: vec![],
                at: 1,
                kind: GroupKind::Tabs,
            },
        );
        assert!(ok);
        assert_eq!(out, "some prose\n:::tabs\n:::tab New tab\n:::\n:::\n");
    }

    #[test]
    fn inserted_grid_starts_without_cells() {
        let (ok, out) = apply(
            "",
            StructOp::InsertGroup {
                path: vec![],
                at: 0,
                kind: GroupKind::Grid,
            },
        );

        assert!(ok);
        assert_eq!(out, ":::grid {cols=2}\n:::\n");
    }

    #[test]
    fn insert_leaf_parses_markdown() {
        let (ok, out) = apply(
            "tab: A\nx\n",
            StructOp::InsertLeaf {
                path: vec![0, 0],
                at: 1,
                text: "> [!tip] Hi\n> There".into(),
            },
        );
        assert!(ok);
        // The seam invariant separates the new callout from the paragraph.
        assert_eq!(out, "tab: A\nx\n\n> [!tip] Hi\n> There\n");
    }

    #[test]
    fn duplicate_tab_appends_copy_suffix() {
        let (ok, out) = apply(
            "tab: A {icon=zap}\nbody\n",
            StructOp::DuplicateNode { path: vec![0, 0] },
        );
        assert!(ok);
        assert_eq!(
            out,
            "tab: A {icon=zap}\nbody\ntab: A (copy) {icon=zap}\nbody\n"
        );
    }

    #[test]
    fn move_tab_reorders_within_group() {
        let (ok, out) = apply(
            "tab: A\na\ntab: B\nb\ntab: C\nc\n",
            StructOp::MoveNode {
                from: vec![0, 0],
                to_parent: vec![0],
                to_index: 3,
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: B\nb\ntab: C\nc\ntab: A\na\n");
    }

    #[test]
    fn move_same_position_is_noop() {
        let src = "tab: A\na\ntab: B\nb\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveNode {
                from: vec![0, 0],
                to_parent: vec![0],
                to_index: 0,
            },
        );
        assert!(!ok);
        assert_eq!(out, src);
    }

    #[test]
    fn exact_value_setters_are_noops() {
        let cases = [
            (
                "tab: A\nbody\n",
                StructOp::SaveRegion {
                    path: vec![0, 0],
                    start: 0,
                    end: 1,
                    expected: "body\n".into(),
                    text: "body\n".into(),
                },
            ),
            (
                "tab: A\nbody\n",
                StructOp::RenameTab {
                    path: vec![0],
                    index: 0,
                    title: "A".into(),
                },
            ),
            (
                "tab: A {icon=rocket}\nbody\n",
                StructOp::SetTabAttr {
                    path: vec![0],
                    index: 0,
                    key: "icon".into(),
                    value: Some("rocket".into()),
                },
            ),
            (
                ":::grid {cols=2}\n:::cell\nbody\n:::\n:::\n",
                StructOp::SetCols {
                    path: vec![0],
                    cols: 2,
                },
            ),
            (
                ":::grid {cols=2 colw=1,1}\n:::cell\nbody\n:::\n:::\n",
                StructOp::SetGroupAttr {
                    path: vec![0],
                    key: "colw".into(),
                    value: Some("1,1".into()),
                },
            ),
            (
                ":::grid {cols=2}\n:::cell\nbody\n:::\n:::\n",
                StructOp::SetGroupAttr {
                    path: vec![0],
                    key: "colw".into(),
                    value: None,
                },
            ),
        ];

        for (src, op) in cases {
            let mut cst = parse_block_impl(src);
            let before = cst.clone();
            assert!(!apply_op_impl(&mut cst, &op), "must reject {op:?}");
            assert_eq!(cst, before, "rejected op mutated the tree: {op:?}");
        }
    }

    #[test]
    fn move_rejects_wrong_kind_and_own_subtree() {
        // tab into a grid: grid first, then a friendly group ([0]=grid, [1]=tabs).
        let src = ":::grid {cols=2}\n:::cell\nc\n:::\n:::\ntab: A\na\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveNode {
                from: vec![1, 0],
                to_parent: vec![0],
                to_index: 0,
            },
        );
        assert!(!ok, "tab may not land in a grid");
        assert_eq!(out, src);

        // group into its own subtree
        let nested = ":::tabs\n:::tab Outer\n:::grid {cols=2}\n:::cell\nx\n:::\n:::\n:::\n:::\n";
        let (ok, _) = apply(
            nested,
            StructOp::MoveNode {
                from: vec![0],
                to_parent: vec![0, 0, 0, 0],
                to_index: 0,
            },
        );
        assert!(!ok, "a node may not move into its own subtree");
    }

    #[test]
    fn move_tab_across_groups_conforms_form_and_prunes_empty_source() {
        // Outer friendly group tab A; nested directive group inside a cell.
        let src = "tab: A\na\ntab: B\n:::tabs\n:::tab Inner\ni\n:::\n:::\n";
        // Move friendly tab A (path 0.0) into the nested directive group (path 0.1.0).
        let (ok, out) = apply(
            src,
            StructOp::MoveNode {
                from: vec![0, 0],
                to_parent: vec![0, 1, 0],
                to_index: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            "tab: B\n:::tabs\n:::tab Inner\ni\n:::\n:::tab A\na\n:::\n:::\n"
        );
    }

    #[test]
    fn move_friendly_group_into_cell_directivizes() {
        // Grid first ([0]) so the friendly group ([1]) doesn't swallow it.
        let src = ":::grid {cols=2}\n:::cell\nc\n:::\n:::\ntab: A\na\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveNode {
                from: vec![1],
                to_parent: vec![0, 0],
                to_index: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\nc\n:::tabs\n:::tab A\na\n:::\n:::\n:::\n:::\n"
        );
        // The result must reparse to the same structure (no silent flattening).
        let re = parse_block_impl(&out);
        let grid = match &re.children[0] {
            Node::Container { name, children, .. } if name == "grid" => children,
            other => panic!("expected grid, got {other:?}"),
        };
        let cell = match &grid[0] {
            Node::Container { name, children, .. } if name == "cell" => children,
            other => panic!("expected cell, got {other:?}"),
        };
        assert!(
            cell.iter().any(|n| is_container_named(n, "tabs")),
            "moved group must survive a reparse inside the cell"
        );
    }

    #[test]
    fn move_directive_group_to_root_of_another_container() {
        let src = ":::tabs\n:::tab A\na\n:::\n:::\n:::grid {cols=2}\n:::cell\nc\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveNode {
                from: vec![0],
                to_parent: vec![1, 0],
                to_index: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\nc\n:::tabs\n:::tab A\na\n:::\n:::\n:::\n:::\n"
        );
    }

    #[test]
    fn insert_column_splices_a_cell_per_row_and_adjusts_attrs() {
        // 2-col [a b / c d] + column at index 1 → 3-col [a _ b / c _ d],
        // cols bumped, colw gains a 1 share at the same position.
        let src = ":::grid {cols=2 colw=1.5,0.5}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::InsertColumn {
                path: vec![0],
                at: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=3 colw=1.5,1,0.5}\n:::cell\na\n:::\n:::cell\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\n:::\n:::cell\nd\n:::\n:::\n"
        );
    }

    #[test]
    fn insert_column_at_edges_and_rejects_bad_targets() {
        let src = ":::grid {cols=1}\n:::cell\nx\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::InsertColumn {
                path: vec![0],
                at: 0,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\n:::\n:::cell\nx\n:::\n:::\n"
        );
        let (ok2, _) = apply(
            src,
            StructOp::InsertColumn {
                path: vec![0],
                at: 5,
            },
        );
        assert!(!ok2, "past-the-end column index must be rejected");
    }

    #[test]
    fn inserted_grid_structure_preserves_indent_and_crlf() {
        let src = "  :::grid {cols=1}\r\n  :::cell\r\nx\r\n  :::\r\n  :::\r\n";
        let (changed, out) = apply(
            src,
            StructOp::InsertColumn {
                path: vec![0],
                at: 1,
            },
        );
        assert!(changed);
        assert_eq!(
            out,
            "  :::grid {cols=2}\r\n  :::cell\r\nx\r\n  :::\r\n  :::cell\r\n  :::\r\n  :::\r\n"
        );
    }

    #[test]
    fn insert_row_splices_cols_cells_and_adjusts_rowh() {
        // 2-col [a b / c d] with rowh → new middle row of empty cells,
        // rowh gains an auto slot at the same position.
        let src = ":::grid {cols=2 rowh=100,200}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::InsertRow {
                path: vec![0],
                at_row: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2 rowh=100,auto,200}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\n:::\n:::cell\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n"
        );
    }

    #[test]
    fn move_cell_in_column_bubbles_without_touching_the_other_column() {
        // 2-col grid, row-major flow: [a b / c d / e f]. Column 0 = a,c,e.
        // Bubble a (flow 0) to the bottom of ITS column (flow 4): column 0
        // becomes c,e,a; column 1 (b,d,f) must be byte-identical.
        let src = ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::cell\ne\n:::\n:::cell\nf\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveCellInColumn {
                path: vec![0],
                from: 0,
                to: 4,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\nc\n:::\n:::cell\nb\n:::\n:::cell\ne\n:::\n:::cell\nd\n:::\n:::cell\na\n:::\n:::cell\nf\n:::\n:::\n"
        );
        // And back up one row: a (flow 4) above e (now flow 2).
        let (ok2, out2) = apply(
            &out,
            StructOp::MoveCellInColumn {
                path: vec![0],
                from: 4,
                to: 2,
            },
        );
        assert!(ok2);
        assert_eq!(
            out2,
            ":::grid {cols=2}\n:::cell\nc\n:::\n:::cell\nb\n:::\n:::cell\na\n:::\n:::cell\nd\n:::\n:::cell\ne\n:::\n:::cell\nf\n:::\n:::\n"
        );
    }

    #[test]
    fn move_cell_in_column_rejects_cross_column_and_bad_targets() {
        let src = ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n";
        for (from, to) in [(0usize, 1usize), (0, 3), (0, 0), (0, 9)] {
            let (ok, _) = apply(
                src,
                StructOp::MoveCellInColumn {
                    path: vec![0],
                    from,
                    to,
                },
            );
            assert!(!ok, "should reject from={from} to={to}");
        }
    }

    #[test]
    fn move_node_after_friendly_tabs_directivizes_the_group() {
        // tab: A holds a grid; move the grid to root AFTER the friendly group.
        let src = "tab: A\n:::grid {cols=1}\n:::cell\nx\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveNode {
                from: vec![0, 0, 0],
                to_parent: vec![],
                to_index: 1,
            },
        );
        assert!(ok);
        let reparsed = parse_block_impl(&out);
        assert_eq!(
            reparsed.children.len(),
            2,
            "grid must stay at root: {out:?}"
        );
        assert!(matches!(&reparsed.children[1], Node::Container { name, .. } if name == "grid"));
    }

    #[test]
    fn move_region_after_friendly_tabs_directivizes_the_group() {
        // A leaf run dropped AFTER a closer-free `tab:` group would re-parse
        // into the group's last tab (the friendly form has no closer). The
        // reducer must directivize the group so the run stays at root.
        let src = "tab: A\nalpha\ntab: B\nbeta\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveRegion {
                path: vec![0, 0],
                start: 0,
                end: 1,
                to_parent: vec![],
                to_index: 1,
            },
        );
        assert!(ok);
        let reparsed = parse_block_impl(&out);
        assert_eq!(reparsed.children.len(), 2, "run must stay at root: {out:?}");
        assert!(
            matches!(&reparsed.children[1], Node::Leaf { text, .. } if text == "alpha\n"),
            "got: {out:?}"
        );
    }

    #[test]
    fn insert_leaf_after_friendly_tabs_directivizes_the_group() {
        let src = "tab: A\nalpha\n";
        let (ok, out) = apply(
            src,
            StructOp::InsertLeaf {
                path: vec![],
                at: 1,
                text: "\nnew section\n".into(),
            },
        );
        assert!(ok);
        let reparsed = parse_block_impl(&out);
        assert!(
            matches!(reparsed.children.last(), Some(Node::Leaf { text, .. }) if text.contains("new section")),
            "leaf must stay at root: {out:?}"
        );
        assert!(
            matches!(reparsed.children.first(), Some(Node::Container { name, .. }) if name == "tabs"),
            "group must survive directivized: {out:?}"
        );
    }

    #[test]
    fn move_region_relocates_leaf_runs() {
        // Tab A parses as [prose "alpha\n", ws, callout leaf] — move just the
        // callout into tab B, after its existing content.
        let src = "tab: A\nalpha\n\n> [!note] Hi\ntab: B\nbeta\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveRegion {
                path: vec![0, 0],
                start: 2,
                end: 3,
                to_parent: vec![0, 1],
                to_index: 1,
            },
        );
        assert!(ok);
        assert_eq!(out, "tab: A\nalpha\ntab: B\nbeta\n\n> [!note] Hi\n");
    }

    #[test]
    fn move_region_within_same_container_reorders_around_sibling() {
        // Root: [leaf intro, grid, leaf outro] — move outro before the grid.
        let src = "intro\n:::grid {cols=2}\n:::cell\na\n:::\n:::\noutro\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveRegion {
                path: vec![],
                start: 2,
                end: 3,
                to_parent: vec![],
                to_index: 1,
            },
        );
        assert!(ok);
        // The seam invariant keeps intro and outro their own sections.
        assert_eq!(
            out,
            "intro\n\noutro\n:::grid {cols=2}\n:::cell\na\n:::\n:::\n"
        );
    }

    #[test]
    fn move_region_same_position_is_noop() {
        let src = "intro\n:::grid {cols=2}\n:::cell\na\n:::\n:::\noutro\n";
        for to_index in [2usize, 3usize] {
            let (ok, out) = apply(
                src,
                StructOp::MoveRegion {
                    path: vec![],
                    start: 2,
                    end: 3,
                    to_parent: vec![],
                    to_index,
                },
            );
            assert!(!ok, "to_index {to_index} is the run's own position");
            assert_eq!(out, src);
        }
    }

    #[test]
    fn move_region_rejects_bad_targets() {
        let src = "tab: A\nalpha\ntab: B\nbeta\n";
        // Into the tabs STRIP (children of tabs) — leaves are invisible there.
        let (ok, out) = apply(
            src,
            StructOp::MoveRegion {
                path: vec![0, 0],
                start: 0,
                end: 1,
                to_parent: vec![0],
                to_index: 1,
            },
        );
        assert!(!ok);
        assert_eq!(out, src);
        // Out-of-range run.
        let (ok2, _) = apply(
            src,
            StructOp::MoveRegion {
                path: vec![0, 0],
                start: 5,
                end: 6,
                to_parent: vec![0, 1],
                to_index: 0,
            },
        );
        assert!(!ok2);
    }

    #[test]
    fn reducer_rejects_missing_targets() {
        let src = "tab: A\na\n";
        for op in [
            StructOp::InsertTab {
                path: vec![9],
                at: 0,
            },
            StructOp::DeleteTab {
                path: vec![0],
                index: 9,
            },
            StructOp::RenameTab {
                path: vec![0],
                index: 9,
                title: "X".into(),
            },
            StructOp::InsertCell {
                path: vec![0],
                at: 0,
            }, // tabs group, not a grid
            StructOp::SetCols {
                path: vec![0],
                cols: 3,
            }, // tabs group, not a grid
            StructOp::DeleteNode { path: vec![] },
            StructOp::DuplicateNode { path: vec![7] },
        ] {
            let (ok, out) = apply(src, op);
            assert!(!ok);
            assert_eq!(out, src);
        }
    }

    #[test]
    fn typed_deletes_reject_children_of_the_wrong_kind() {
        let cases = [
            (
                ":::tabs\npreamble\n:::tab A\nbody\n:::\n:::\n",
                StructOp::DeleteTab {
                    path: vec![0],
                    index: 0,
                },
            ),
            (
                ":::grid {cols=1}\npreamble\n:::cell\nbody\n:::\n:::\n",
                StructOp::DeleteCell {
                    path: vec![0],
                    index: 0,
                },
            ),
        ];

        for (src, op) in cases {
            let mut cst = parse_block_impl(src);
            let before = cst.clone();
            assert!(!apply_op_impl(&mut cst, &op), "must reject {op:?}");
            assert_eq!(cst, before, "rejected op mutated the tree: {op:?}");
        }
    }

    // ------------------------------------------------------------------
    // Leaf-seam normalization: two content leaves flush against each other
    // re-parse as ONE prose run (the "my sections combined" bug). Every op
    // that splices leaves must leave a blank-line leaf between sections.
    // ------------------------------------------------------------------

    #[test]
    fn insert_leaf_seams_against_prose_neighbors() {
        // [alpha, ws, omega] + "mid" before omega → separated on BOTH sides.
        let (ok, out) = apply(
            "alpha\n\nomega\n",
            StructOp::InsertLeaf {
                path: vec![],
                at: 2,
                text: "mid".into(),
            },
        );
        assert!(ok);
        assert_eq!(out, "alpha\n\nmid\n\nomega\n");
    }

    #[test]
    fn insert_leaf_legacy_leading_newline_causes_no_phantom_blank() {
        // The old UI sent "\nWrite here…\n"; the reducer must not leave a
        // leading blank glued to the top of the container.
        let (ok, out) = apply(
            "alpha\n",
            StructOp::InsertLeaf {
                path: vec![],
                at: 0,
                text: "\nnew\n".into(),
            },
        );
        assert!(ok);
        assert_eq!(out, "new\n\nalpha\n");
    }

    #[test]
    fn moved_prose_keeps_its_own_section() {
        // [a, ws, b, ws, g]: gamma dropped above alpha stays its own section.
        let (ok, out) = apply(
            "alpha\n\nbeta\n\ngamma\n",
            StructOp::MoveRegion {
                path: vec![],
                start: 4,
                end: 5,
                to_parent: vec![],
                to_index: 0,
            },
        );
        assert!(ok);
        assert_eq!(out, "gamma\n\nalpha\n\nbeta\n");
    }

    #[test]
    fn deleting_a_container_between_prose_does_not_merge_neighbors() {
        let src = "alpha\n:::grid {cols=1}\n:::cell\nx\n:::\n:::\nomega\n";
        let (ok, out) = apply(src, StructOp::DeleteNode { path: vec![1] });
        assert!(ok);
        assert_eq!(out, "alpha\n\nomega\n");
    }

    #[test]
    fn save_region_cannot_glue_into_the_next_section() {
        // The unit [0..2) carries its trailing blank; the editor may hand back
        // text without one — the seam must be restored.
        let (ok, out) = apply(
            "alpha\n\nbeta\n",
            StructOp::SaveRegion {
                path: vec![],
                start: 0,
                end: 2,
                expected: "alpha\n\n".into(),
                text: "alpha2".into(),
            },
        );
        assert!(ok);
        assert_eq!(out, "alpha2\n\nbeta\n");
    }

    #[test]
    fn duplicated_leaf_gets_a_seam() {
        let (ok, out) = apply("alpha\n", StructOp::DuplicateNode { path: vec![0] });
        assert!(ok);
        assert_eq!(out, "alpha\n\nalpha\n");
    }

    // ------------------------------------------------------------------
    // Excel-grade grid ops: whole-column/row delete + move, cell clear.
    // ------------------------------------------------------------------

    #[test]
    fn delete_column_removes_cells_and_adjusts_attrs() {
        let src = ":::grid {cols=3 colw=1,2,3}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::cell\ne\n:::\n:::cell\nf\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::DeleteColumn {
                path: vec![0],
                at: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2 colw=1,3}\n:::cell\na\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::cell\nf\n:::\n:::\n"
        );
    }

    #[test]
    fn column_ops_reject_non_cell_grid_children_atomically() {
        let src =
            ":::grid {cols=2}\nprose that must survive\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n";
        for op in [
            StructOp::InsertColumn {
                path: vec![0],
                at: 1,
            },
            StructOp::DeleteColumn {
                path: vec![0],
                at: 0,
            },
            StructOp::MoveColumn {
                path: vec![0],
                from: 0,
                to: 1,
            },
        ] {
            let (changed, out) = apply(src, op);
            assert!(!changed);
            assert_eq!(out, src);
        }
    }

    #[test]
    fn rejected_op_never_leaves_partial_mutation() {
        // The public reducer enforces false => unchanged independently of the
        // helper rejection point.
        let mut cst = Cst {
            children: vec![Node::Container {
                name: "grid".into(),
                title: "{cols=2}".into(),
                colons: 3,
                open_line: "not a directive\r\n".into(),
                children: vec![new_cell(), new_cell()],
                close_line: "  :::\r\n".into(),
            }],
        };
        let before = cst.clone();
        assert!(!apply_op_impl(
            &mut cst,
            &StructOp::InsertColumn {
                path: vec![0],
                at: 1,
            }
        ));
        assert_eq!(cst, before, "false must mean byte-for-byte unchanged CST");
    }

    #[test]
    fn delete_column_handles_ragged_and_rejects_last() {
        // Rows [a b] [c]: column 0 takes a AND c with it.
        let ragged = ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::\n";
        let (ok, out) = apply(
            ragged,
            StructOp::DeleteColumn {
                path: vec![0],
                at: 0,
            },
        );
        assert!(ok);
        assert_eq!(out, ":::grid {cols=1}\n:::cell\nb\n:::\n:::\n");
        let single = ":::grid {cols=1}\n:::cell\nx\n:::\n:::\n";
        let (ok2, _) = apply(
            single,
            StructOp::DeleteColumn {
                path: vec![0],
                at: 0,
            },
        );
        assert!(!ok2, "the last column is the grid itself");
    }

    #[test]
    fn delete_row_removes_cells_and_rowh_entry() {
        let src = ":::grid {cols=2 rowh=100,200}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::DeleteRow {
                path: vec![0],
                at_row: 0,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2 rowh=200}\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n"
        );
    }

    #[test]
    fn deleting_the_only_row_removes_the_grid() {
        let src = ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::DeleteRow {
                path: vec![0],
                at_row: 0,
            },
        );
        assert!(ok);
        assert_eq!(out, "", "a rowless grid is scaffolding");
    }

    #[test]
    fn move_column_reorders_every_row_and_colw() {
        let src = ":::grid {cols=2 colw=1,2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveColumn {
                path: vec![0],
                from: 0,
                to: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2 colw=2,1}\n:::cell\nb\n:::\n:::cell\na\n:::\n:::cell\nd\n:::\n:::cell\nc\n:::\n:::\n"
        );
    }

    #[test]
    fn move_column_pads_a_ragged_grid_first() {
        let src = ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveColumn {
                path: vec![0],
                from: 0,
                to: 1,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\nb\n:::\n:::cell\na\n:::\n:::cell\n:::\n:::cell\nc\n:::\n:::\n"
        );
    }

    #[test]
    fn column_ops_scale_across_a_large_rectangular_grid() {
        // Large enough that the former one-global-Vec remove/insert per row
        // became visibly quadratic; this remains a routine unit test with the
        // row-local/preallocated linear implementations.
        let rows = 4_096;
        let cols = 12;
        let mut cst = Cst {
            children: vec![Node::Container {
                name: "grid".into(),
                title: format!("{{cols={cols}}}"),
                colons: 3,
                open_line: format!(":::grid {{cols={cols}}}\n"),
                children: (0..rows * cols)
                    .map(|index| {
                        let mut cell = new_cell();
                        if let Node::Container { children, .. } = &mut cell {
                            children[0] = Node::Leaf {
                                text: format!("cell {index}\n"),
                                is_code: false,
                            };
                        }
                        cell
                    })
                    .collect(),
                close_line: ":::\n".into(),
            }],
        };
        assert!(apply_op_impl(
            &mut cst,
            &StructOp::InsertColumn {
                path: vec![0],
                at: 6,
            }
        ));
        let Node::Container {
            title, children, ..
        } = &cst.children[0]
        else {
            panic!("grid remains a container")
        };
        assert_eq!(title, "{cols=13}");
        assert_eq!(children.len(), rows * 13);

        assert!(apply_op_impl(
            &mut cst,
            &StructOp::MoveColumn {
                path: vec![0],
                from: 0,
                to: 12,
            }
        ));
        assert!(apply_op_impl(
            &mut cst,
            &StructOp::DeleteColumn {
                path: vec![0],
                at: 6,
            }
        ));
        let Node::Container {
            title, children, ..
        } = &cst.children[0]
        else {
            panic!("grid remains a container")
        };
        assert_eq!(title, "{cols=12}");
        assert_eq!(children.len(), rows * cols);
    }

    #[test]
    fn move_row_reorders_cells_and_rowh() {
        let src = ":::grid {cols=2 rowh=100,200}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::MoveRow {
                path: vec![0],
                from: 1,
                to: 0,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2 rowh=200,100}\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n"
        );
    }

    #[test]
    fn set_cols_prunes_a_now_longer_rowh_list() {
        // 6 cells: 3 rows at cols=2 → 2 rows at cols=3. The third rowh entry
        // would otherwise become a phantom empty track below the grid.
        let src = ":::grid {cols=2 rowh=100,200,300}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::cell\ne\n:::\n:::cell\nf\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::SetCols {
                path: vec![0],
                cols: 3,
            },
        );
        assert!(ok);
        assert!(
            out.starts_with(":::grid {cols=3 rowh=100,200}\n"),
            "rowh must shrink with the row count: {out}"
        );
    }

    #[test]
    fn clear_cell_empties_but_keeps_geometry() {
        let src = ":::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n";
        let (ok, out) = apply(
            src,
            StructOp::ClearCell {
                path: vec![0],
                index: 0,
            },
        );
        assert!(ok);
        assert_eq!(
            out,
            ":::grid {cols=2}\n:::cell\n:::\n:::cell\nb\n:::\n:::\n"
        );
        let (ok2, _) = apply(
            &out,
            StructOp::ClearCell {
                path: vec![0],
                index: 0,
            },
        );
        assert!(!ok2, "clearing an empty cell is a no-op");
    }
}

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

/// Which kind of group an `InsertGroup` op creates.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    /// A tab group (`tab:` friendly form at an empty root, else `:::tabs`).
    Tabs,
    /// A `:::grid` with two empty cells.
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
    let changed = apply_op_inner(cst, op);
    if changed {
        // Every successful op re-establishes the leaf-seam invariant tree-wide
        // (a missed splice site would silently merge sections — see below).
        normalize_tree(&mut cst.children);
    }
    changed
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
    while children.first().is_some_and(is_ws) {
        children.remove(0);
    }
    while children.last().is_some_and(is_ws) {
        children.pop();
    }
    let mut i = 0;
    while i + 1 < children.len() {
        if is_content(&children[i]) && is_content(&children[i + 1]) {
            // A final line without its newline needs the terminator too.
            let sep = match &children[i] {
                Node::Leaf { text, .. } if !text.ends_with('\n') => "\n\n",
                _ => "\n",
            };
            children.insert(
                i + 1,
                Node::Leaf {
                    text: sep.to_string(),
                    is_code: false,
                },
            );
            i += 2;
        } else {
            i += 1;
        }
    }
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
            let replacement = parse_block_impl(&terminated(text)).children;
            children.splice(*start..*end, replacement);
            true
        }
        StructOp::InsertTab { path, at } => {
            let Some((directive, colons)) = group_form(cst, path, "tabs") else {
                return false;
            };
            let tab = if directive {
                directive_tab("New tab", colons)
            } else {
                friendly_tab("New tab")
            };
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            let at = (*at).min(children.len());
            children.insert(at, tab);
            true
        }
        StructOp::DeleteTab { path, index } => {
            if !is_named(cst, path, "tabs") {
                return false;
            }
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            if *index >= children.len() {
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
            let Some(tab) = tab_at_mut(cst, path, *index) else {
                return false;
            };
            let (_, attrs) = match tab {
                Node::Container { title: t, .. } => split_title_attrs(t),
                Node::Leaf { .. } => return false,
            };
            set_tab_title(tab, &compose_title(title, &attrs));
            true
        }
        StructOp::SetTabAttr {
            path,
            index,
            key,
            value,
        } => {
            let Some(tab) = tab_at_mut(cst, path, *index) else {
                return false;
            };
            let (display, attrs) = match tab {
                Node::Container { title: t, .. } => split_title_attrs(t),
                Node::Leaf { .. } => return false,
            };
            let attrs = set_attr_token(&attrs, key, value.as_deref());
            set_tab_title(tab, &compose_title(&display, &attrs));
            true
        }
        StructOp::InsertCell { path, at } => {
            if !is_named(cst, path, "grid") {
                return false;
            }
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            let at = (*at).min(children.len());
            children.insert(at, new_cell());
            true
        }
        StructOp::DeleteCell { path, index } => {
            if !is_named(cst, path, "grid") {
                return false;
            }
            let Some(children) = children_at_mut(cst, path) else {
                return false;
            };
            if *index >= children.len() {
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
            if name != "grid" {
                return false;
            }
            let (_, attrs) = split_title_attrs(title);
            let attrs = set_attr_token(&attrs, "cols", Some(&cols.max(&1).to_string()));
            *title = format!("{{{attrs}}}");
            let c = ":".repeat((*colons).max(3));
            *open_line = format!("{c}grid {{{attrs}}}\n");
            true
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
                GroupKind::Grid => new_grid(2),
                GroupKind::Tabs => new_tabs_group(directive),
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
                set_tab_title(
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
    }
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
    if !is_named(cst, path, "tabs") {
        return None;
    }
    let children = children_at_mut(cst, path)?;
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
        }) if open_line.starts_with(":::") => Some((true, (*colons).max(3))),
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

/// Column-preserving cell reorder: a chain of same-column swaps bubbles the
/// cell from `from` to `to`; each swap touches exactly two same-column flow
/// indices, so the other columns cannot move.
/// Read a grid container's column count from its header attrs.
fn grid_cols(node: &Node) -> Option<usize> {
    match node {
        Node::Container { name, title, .. } if name == "grid" => {
            let (_, attrs) = split_title_attrs(title);
            Some(
                attrs
                    .split_whitespace()
                    .find_map(|t| t.strip_prefix("cols="))
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(2)
                    .max(1),
            )
        }
        _ => None,
    }
}

/// Edit a comma-list attr in place, if the attr exists (missing attrs stay
/// missing — defaults already apply). An emptied list drops the attr.
fn edit_list_attr(cst: &mut Cst, path: &[usize], key: &str, f: impl FnOnce(&mut Vec<String>)) {
    let Some(Node::Container { title, .. }) = node_at(cst, path) else {
        return;
    };
    let (_, attrs) = split_title_attrs(title);
    let Some(current) = attrs
        .split_whitespace()
        .find_map(|t| t.strip_prefix(&format!("{key}=")).map(str::to_string))
    else {
        return;
    };
    let mut parts: Vec<String> = current.split(',').map(str::to_string).collect();
    f(&mut parts);
    if parts.is_empty() {
        set_group_attr(cst, path, key, None);
    } else {
        set_group_attr(cst, path, key, Some(&parts.join(",")));
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

/// The `InsertColumn` implementation: splice bottom-up so earlier rows'
/// indices stay valid, then bump `cols` and the `colw` list.
fn insert_column(cst: &mut Cst, path: &[usize], at: usize) -> bool {
    let Some(cols) = node_at(cst, path).and_then(grid_cols) else {
        return false;
    };
    if at > cols {
        return false;
    }
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let rows = children.len().div_ceil(cols).max(1);
        for r in (0..rows).rev() {
            let idx = (r * cols + at).min(children.len());
            children.insert(idx, new_cell());
        }
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
    let Some(cols) = node_at(cst, path).and_then(grid_cols) else {
        return false;
    };
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let rows = children.len().div_ceil(cols);
        if at_row > rows {
            return false;
        }
        let idx = (at_row * cols).min(children.len());
        children.splice(idx..idx, (0..cols).map(|_| new_cell()));
    }
    insert_list_attr(cst, path, "rowh", at_row, "auto");
    true
}

/// The `DeleteColumn` implementation: bottom-up removal keeps earlier rows'
/// indices valid; `cols` drops and the `colw` entry leaves with the column.
fn delete_column(cst: &mut Cst, path: &[usize], at: usize) -> bool {
    let Some(cols) = node_at(cst, path).and_then(grid_cols) else {
        return false;
    };
    if at >= cols || cols == 1 {
        return false; // the last column IS the grid — delete the grid instead
    }
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        let rows = children.len().div_ceil(cols);
        for r in (0..rows).rev() {
            let idx = r * cols + at;
            if idx < children.len() {
                children.remove(idx);
            }
        }
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
    let Some(cols) = node_at(cst, path).and_then(grid_cols) else {
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

/// The `MoveColumn` implementation: per-row remove/insert inside each row's
/// span (row lengths never change, so bases stay valid); `colw` follows.
fn move_column(cst: &mut Cst, path: &[usize], from: usize, to: usize) -> bool {
    let Some(cols) = node_at(cst, path).and_then(grid_cols) else {
        return false;
    };
    if from >= cols || to >= cols || from == to {
        return false;
    }
    {
        let Some(children) = children_at_mut(cst, path) else {
            return false;
        };
        if children.is_empty() {
            return false;
        }
        pad_to_rect(children, cols);
        let rows = children.len() / cols;
        for r in 0..rows {
            let base = r * cols;
            let cell = children.remove(base + from);
            children.insert(base + to, cell);
        }
    }
    move_list_attr(cst, path, "colw", from, to);
    true
}

/// The `MoveRow` implementation: drain the row's cells and re-splice at the
/// target row's flow position (post-drain, `to * cols` IS the final slot for
/// both directions); `rowh` follows.
fn move_row(cst: &mut Cst, path: &[usize], from: usize, to: usize) -> bool {
    let Some(cols) = node_at(cst, path).and_then(grid_cols) else {
        return false;
    };
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
        pad_to_rect(children, cols);
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
    if !is_named(cst, path, "grid") {
        return false;
    }
    let Some(children) = children_at_mut(cst, path) else {
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
fn pad_to_rect(children: &mut Vec<Node>, cols: usize) {
    while !children.is_empty() && !children.len().is_multiple_of(cols) {
        children.push(new_cell());
    }
}

fn move_cell_in_column(cst: &mut Cst, path: &[usize], from: usize, to: usize) -> bool {
    let cols = match node_at(cst, path) {
        Some(Node::Container { name, title, .. }) if name == "grid" => {
            let (_, attrs) = split_title_attrs(title);
            attrs
                .split_whitespace()
                .find_map(|t| t.strip_prefix("cols="))
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(2)
                .max(1)
        }
        _ => return false,
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

/// Set / replace / remove a `key=value` token in an attrs string.
/// Write/remove one `{key=value}` token on a grid or directive-tabs header.
/// Friendly tab groups have no header line to carry attrs — rejected.
fn set_group_attr(cst: &mut Cst, path: &[usize], key: &str, value: Option<&str>) -> bool {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    if let Some(v) = value {
        if v.is_empty() || v.chars().any(|c| c.is_whitespace() || c == '{' || c == '}') {
            return false;
        }
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
    if (name != "grid" && name != "tabs") || !open_line.starts_with(':') {
        return false;
    }
    let (_, attrs) = split_title_attrs(title);
    let attrs = set_attr_token(&attrs, key, value);
    *title = format!("{{{attrs}}}");
    let c = ":".repeat((*colons).max(3));
    *open_line = format!(
        "{c}{name} {{{attrs}}}
"
    );
    true
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

/// Rewrite a tab's title AND its open line, preserving its form.
fn set_tab_title(tab: &mut Node, full_title: &str) {
    if let Node::Container {
        title,
        colons,
        open_line,
        ..
    } = tab
    {
        if open_line.starts_with(":::") {
            let c = ":".repeat((*colons).max(3));
            *open_line = format!("{c}tab {full_title}\n");
        } else {
            *open_line = format!("tab: {full_title}\n");
        }
        *title = full_title.to_string();
    }
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
    if directive {
        let c = ":".repeat(colons.max(3));
        *open_line = format!("{c}tab {title}\n");
        *close_line = format!("{c}\n");
        *tc = colons.max(3);
    } else {
        *open_line = format!("tab: {title}\n");
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
    if name != "tabs" || open_line.starts_with(":::") {
        return;
    }
    *open_line = ":::tabs\n".to_string();
    *close_line = ":::\n".to_string();
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
///
/// Purpose: factory for new tabs in friendly groups.
///
/// # Arguments
/// * `title` - the tab's display title
///
/// # Returns
/// A `tab` container node.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let tab = mica_core::ops::friendly_tab("New tab");
/// ```
pub fn friendly_tab(title: &str) -> Node {
    Node::Container {
        name: "tab".to_string(),
        title: title.to_string(),
        colons: 0,
        open_line: format!("tab: {title}\n"),
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
///
/// Purpose: factory for new tabs in directive groups (nesting).
///
/// # Arguments
/// * `title` - the tab's display title
/// * `colons` - fence width (>= 3)
///
/// # Returns
/// A `tab` container node.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let tab = mica_core::ops::directive_tab("Inner", 3);
/// ```
pub fn directive_tab(title: &str, colons: usize) -> Node {
    let c = ":".repeat(colons.max(3));
    Node::Container {
        name: "tab".to_string(),
        title: title.to_string(),
        colons: colons.max(3),
        open_line: format!("{c}tab {title}\n"),
        children: vec![empty_leaf()],
        close_line: format!("{c}\n"),
    }
}

/// Build a new empty `:::cell`.
///
/// Purpose: factory for grid cells.
///
/// # Returns
/// A `cell` container node.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let cell = mica_core::ops::new_cell();
/// ```
pub fn new_cell() -> Node {
    Node::Container {
        name: "cell".to_string(),
        title: String::new(),
        colons: 3,
        open_line: ":::cell\n".to_string(),
        children: vec![empty_leaf()],
        close_line: ":::\n".to_string(),
    }
}

/// Build a new `:::grid {cols=N}` holding two empty cells.
///
/// Purpose: factory for grids.
///
/// # Arguments
/// * `cols` - initial column count
///
/// # Returns
/// A `grid` container node.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let grid = mica_core::ops::new_grid(2);
/// ```
pub fn new_grid(cols: usize) -> Node {
    let cols = cols.max(1);
    Node::Container {
        name: "grid".to_string(),
        title: format!("{{cols={cols}}}"),
        colons: 3,
        open_line: format!(":::grid {{cols={cols}}}\n"),
        children: vec![new_cell(), new_cell()],
        close_line: ":::\n".to_string(),
    }
}

/// Build a new tabs group with one "New tab".
///
/// Purpose: factory for tab groups. `directive` selects the explicit
/// `:::tabs` form (needed everywhere except an empty block root).
///
/// # Arguments
/// * `directive` - `true` for `:::tabs`, `false` for the friendly form
///
/// # Returns
/// A `tabs` container node.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let group = mica_core::ops::new_tabs_group(false);
/// ```
pub fn new_tabs_group(directive: bool) -> Node {
    Node::Container {
        name: "tabs".to_string(),
        title: String::new(),
        colons: if directive { 3 } else { 0 },
        open_line: if directive {
            ":::tabs\n".to_string()
        } else {
            String::new()
        },
        children: vec![if directive {
            directive_tab("New tab", 3)
        } else {
            friendly_tab("New tab")
        }],
        close_line: if directive {
            ":::\n".to_string()
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
///
/// Purpose: shared accessor for per-tab / per-grid attrs (`icon`, `cols`, …).
///
/// # Arguments
/// * `title` - the raw title string from the CST
/// * `key` - attribute name
///
/// # Returns
/// The attribute value if present.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// assert_eq!(mica_core::ops::title_attr("{cols=3}", "cols").as_deref(), Some("3"));
/// ```
pub fn title_attr(title: &str, key: &str) -> Option<String> {
    let (_, attrs) = split_title_attrs(title);
    attrs.split_whitespace().find_map(|tok| {
        let (k, v) = tok.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;
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
:::cell
:::
:::cell
:::
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

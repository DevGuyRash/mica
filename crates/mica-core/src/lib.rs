//! Mica core — the pure, I/O-free engine behind the Mica Obsidian plugin.
//!
//! This crate compiles to WebAssembly (via `wasm-pack`) for the plugin and to a
//! native `rlib` for `cargo test`. Public logic lives in `*_impl` functions that
//! are unit-tested natively; thin `#[wasm_bindgen]` wrappers expose them to
//! TypeScript. Nothing here touches the filesystem, the network, or Obsidian.
//! The crate owns scanning, byte-exact CST parsing/serialization, structural
//! edits, content signatures, version folding, migration, reconciliation, and
//! diffing so both hosts share the same behavior.

use uuid::Uuid;
use wasm_bindgen::prelude::*;

mod checkpoints;
mod diff;
mod edit;
mod migrate;
pub mod ops;
mod parser;
mod reconcile;
mod scanner;
mod store;
mod util;
mod versions;
pub use diff::{diff_impl, make_patch_impl, DiffChange, DiffResult, Hunk, Span};
pub use edit::{
    block_content_edit_impl, ensure_ids_impl, guarded_block_content_edit_at_impl,
    guarded_block_content_edit_impl, replace_block_content_impl, rewrite_block_id_at_impl,
    set_block_attr_edit_impl, set_block_attr_impl, BlockEdit,
};
pub use migrate::{migrate_tabs_impl, MigratedBlock, MigratedVersion, MigrationResult};
pub use ops::{
    apply_op_impl, apply_op_text_impl, apply_ops_impl, apply_ops_text_impl, normalize_section_impl,
    AppliedText, GroupKind, SectionNormalization, SectionNormalizationError, StructOp,
};
pub use parser::{parse_block_impl, serialize_impl, Cst, Node};
pub use reconcile::{reconcile_impl, ContentRef, ReconcileAction, SidecarRef};
pub use scanner::{scan_impl, scan_view_impl, BlockSpan, BlockView};
pub use store::{
    is_managed_path_impl, note_id_impl, note_paths_impl, object_paths_impl, resolve_object_hash_impl,
    set_note_id_impl, storage_layout_impl, validate_store_marker_impl, NotePaths, ObjectPaths,
    StorageLayout, StoreError, StoreMarker,
};
pub use versions::{
    content_signature_impl, fold_ledger_impl, has_content_impl, resolve_ledger_impl,
    should_snapshot_impl, BlockState, Event, HeadRef, LedgerError, LedgerResolution,
    ResolvedReplacement, VersionMeta,
};

// --- Pure core (unit-tested natively) ------------------------------------

/// Crate version, for a plugin/core version handshake at load time.
pub fn mica_version_impl() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Content address of `text`: a full 256-bit BLAKE3 digest tagged `b3:`.
/// This is the block dirty-check key and the version-object name. Readers keep
/// accepting the legacy 64-bit prefix form, but every new write uses the full
/// digest so two distinct objects cannot alias through a truncated address.
pub fn hash_content_impl(text: &str) -> String {
    b3_tag(&blake3::hash(text.as_bytes()))
}

/// Format a BLAKE3 digest as the `b3:` + 64-hex-char content address.
pub(crate) fn b3_tag(hash: &blake3::Hash) -> String {
    format!("b3:{}", hash.to_hex())
}

/// Mint a new time-ordered UUIDv7 — used for block ids (fence header) and note
/// anchors (frontmatter `mica-id`). Time ordering makes ids sort by creation.
pub fn new_id_impl() -> String {
    Uuid::now_v7().to_string()
}

// --- WASM boundary (thin wrappers) ---------------------------------------

/// Crate version, for a plugin/core version handshake at load time.
#[wasm_bindgen]
pub fn mica_version() -> String {
    mica_version_impl()
}

/// Content address of `text` (`b3:` + full 64-hex-char BLAKE3 digest).
#[wasm_bindgen]
pub fn hash_content(text: &str) -> String {
    hash_content_impl(text)
}

/// Mint a new time-ordered UUIDv7.
#[wasm_bindgen]
pub fn new_id() -> String {
    new_id_impl()
}

/// Return the vault-wide layout without creating any storage.
#[wasm_bindgen]
pub fn storage_layout() -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&storage_layout_impl())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Derive safe, identity-bound note paths relative to the vault root.
#[wasm_bindgen]
pub fn note_paths(note_id: &str) -> Result<JsValue, JsValue> {
    let paths = note_paths_impl(note_id).map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_wasm_bindgen::to_value(&paths)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Derive shared object paths from a complete canonical BLAKE3 address.
#[wasm_bindgen]
pub fn object_paths(full_hash: &str) -> Result<JsValue, JsValue> {
    let paths = object_paths_impl(full_hash).map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_wasm_bindgen::to_value(&paths)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Test an already-normalized vault-relative path for managed-store membership.
#[wasm_bindgen]
pub fn is_managed_path(vault_relative: &str) -> bool {
    is_managed_path_impl(vault_relative)
}

/// Read a note's source-backed identity without preparing or stamping it.
#[wasm_bindgen]
pub fn note_id(source: &str) -> Result<Option<String>, JsValue> {
    note_id_impl(source).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Set a note identity under an exact expected-identity guard.
#[wasm_bindgen]
pub fn set_note_id(
    source: &str,
    expected: Option<String>,
    id: &str,
) -> Result<String, JsValue> {
    set_note_id_impl(source, expected.as_deref(), id)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Validate an already JSON-decoded store marker, rejecting unknown fields.
#[wasm_bindgen]
pub fn validate_store_marker(marker: JsValue) -> Result<JsValue, JsValue> {
    let marker: StoreMarker = serde_wasm_bindgen::from_value(marker)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let marker = validate_store_marker_impl(marker)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    serde_wasm_bindgen::to_value(&marker)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Resolve a legacy object address through note-scoped aliases only.
#[wasm_bindgen]
pub fn resolve_object_hash(hash: &str, aliases: JsValue) -> Result<String, JsValue> {
    let aliases: std::collections::BTreeMap<String, String> = serde_wasm_bindgen::from_value(aliases)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    resolve_object_hash_impl(hash, &aliases)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Locate every top-level ` ```mica ` block in a document. Returns `BlockSpan[]`.
#[wasm_bindgen]
pub fn scan(src: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&scan_impl(src)).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Locate blocks with UTF-16 offsets + id/name, for CodeMirror decorations.
#[wasm_bindgen]
pub fn scan_view(src: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&scan_view_impl(src))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse one block's content into a `Cst`.
#[wasm_bindgen]
pub fn parse_block(content: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&parse_block_impl(content))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Serialize a `Cst` back to source (byte-exact for unedited trees).
#[wasm_bindgen]
pub fn serialize(cst: JsValue) -> Result<String, JsValue> {
    let cst: Cst =
        serde_wasm_bindgen::from_value(cst).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(serialize_impl(&cst))
}

/// Compute the CodeMirror change (UTF-16 offsets) that replaces block `id`'s
/// content with `new_content`. Returns `null` if the block is not found. Bounds
/// are recomputed live, so this can never append-instead-of-replace.
#[wasm_bindgen]
pub fn block_content_edit(doc: &str, id: &str, new_content: &str) -> Result<JsValue, JsValue> {
    match block_content_edit_impl(doc, id, new_content) {
        Some(e) => serde_wasm_bindgen::to_value(&e).map_err(|e| JsValue::from_str(&e.to_string())),
        None => Ok(JsValue::NULL),
    }
}

/// Build a UTF-16 content edit only when the block still has `expected` text.
#[wasm_bindgen]
pub fn guarded_block_content_edit(
    doc: &str,
    id: &str,
    expected: &str,
    new_content: &str,
) -> Result<JsValue, JsValue> {
    match guarded_block_content_edit_impl(doc, id, expected, new_content) {
        Some(edit) => {
            serde_wasm_bindgen::to_value(&edit).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        None => Ok(JsValue::NULL),
    }
}

/// Build a UTF-16 content edit for one exact block occurrence only when its
/// content still equals `expected`.
#[wasm_bindgen]
pub fn guarded_block_content_edit_at(
    doc: &str,
    block_start: usize,
    expected: &str,
    new_content: &str,
) -> Result<JsValue, JsValue> {
    match guarded_block_content_edit_at_impl(doc, block_start, expected, new_content) {
        Some(edit) => {
            serde_wasm_bindgen::to_value(&edit).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        None => Ok(JsValue::NULL),
    }
}

/// Rewrite the `id=` on one exact UTF-16 block-start occurrence.
#[wasm_bindgen]
pub fn rewrite_block_id_at(
    doc: &str,
    block_start: usize,
    expected_id: &str,
    new_id: &str,
) -> Result<JsValue, JsValue> {
    match rewrite_block_id_at_impl(doc, block_start, expected_id, new_id) {
        Some(edit) => {
            serde_wasm_bindgen::to_value(&edit).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        None => Ok(JsValue::NULL),
    }
}

/// Replace block `id`'s content in `doc`; returns the full new document, or null.
#[wasm_bindgen]
pub fn replace_block_content(doc: &str, id: &str, new_content: &str) -> Result<JsValue, JsValue> {
    match replace_block_content_impl(doc, id, new_content) {
        Some(s) => Ok(JsValue::from_str(&s)),
        None => Ok(JsValue::NULL),
    }
}

/// Insert a fresh `id=` into any ` ```mica ` block that lacks one.
#[wasm_bindgen]
pub fn ensure_ids(doc: &str) -> String {
    ensure_ids_impl(doc)
}

/// Fold an append-only ledger (array of events) into current per-block state,
/// returned as a plain object keyed by block id.
#[wasm_bindgen]
pub fn fold_ledger(events: JsValue) -> Result<JsValue, JsValue> {
    use serde::Serialize;
    let events: Vec<Event> =
        serde_wasm_bindgen::from_value(events).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    fold_ledger_impl(&events)
        .map_err(|error| JsValue::from_str(&error.to_string()))?
        .serialize(&ser)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Diff `base` vs `other` (`granularity` = line|word|char) with `context` lines.
#[wasm_bindgen]
pub fn diff(
    base: &str,
    other: &str,
    granularity: &str,
    context: usize,
) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&diff_impl(base, other, granularity, context))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// A unified-diff patch (line granularity) between `base` and `other`.
#[wasm_bindgen]
pub fn make_patch(base: &str, other: &str, context: usize) -> String {
    make_patch_impl(base, other, context)
}

/// Classify content vs sidecar block-id indexes into reconciliation actions.
#[wasm_bindgen]
pub fn reconcile(content: JsValue, sidecar: JsValue) -> Result<JsValue, JsValue> {
    let content: Vec<ContentRef> =
        serde_wasm_bindgen::from_value(content).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let sidecar: Vec<SidecarRef> =
        serde_wasm_bindgen::from_value(sidecar).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&reconcile_impl(&content, &sidecar))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Convert every legacy ```tabs block in `doc` into a ```mica block.
/// `callout_types` is a comma-separated allowlist of callout types imported as
/// version history (empty = every type).
#[wasm_bindgen]
pub fn migrate_tabs(doc: &str, callout_types: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&migrate_tabs_impl(doc, callout_types))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Apply one structural op (JSON, tagged `op`) to a block CST (JSON).
/// Returns `{ changed: bool, cst: Cst }`; on `changed == false` the tree is
/// returned unmodified (the op was rejected as a no-op).
#[wasm_bindgen]
pub fn apply_op(cst: JsValue, op: JsValue) -> Result<JsValue, JsValue> {
    #[derive(serde::Serialize)]
    struct Applied {
        changed: bool,
        cst: Cst,
    }
    let mut cst: Cst =
        serde_wasm_bindgen::from_value(cst).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let op: StructOp =
        serde_wasm_bindgen::from_value(op).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let changed = apply_op_impl(&mut cst, &op);
    serde_wasm_bindgen::to_value(&Applied { changed, cst })
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse, apply one structural op, and serialize without exposing the CST.
#[wasm_bindgen]
pub fn apply_op_text(content: &str, op: JsValue) -> Result<JsValue, JsValue> {
    let op: StructOp =
        serde_wasm_bindgen::from_value(op).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&apply_op_text_impl(content, &op))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse, atomically apply dependent structural ops, and serialize once.
#[wasm_bindgen]
pub fn apply_ops_text(content: &str, ops: JsValue) -> Result<JsValue, JsValue> {
    let ops: Vec<StructOp> =
        serde_wasm_bindgen::from_value(ops).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&apply_ops_text_impl(content, &ops))
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// A hash of the block's *content* only (trimmed leaf texts, sorted) — the
/// key auto-versioning gates on.
#[wasm_bindgen]
pub fn content_signature(content: &str) -> String {
    content_signature_impl(content)
}

/// Whether a block carries any non-empty leaf content, including code/callouts.
#[wasm_bindgen]
pub fn has_content(content: &str) -> bool {
    has_content_impl(content)
}

/// Set / replace / remove one fence-header attribute on block `id`.
/// `value = None` removes the attribute. Returns the new document or null.
#[wasm_bindgen]
pub fn set_block_attr(
    doc: &str,
    id: &str,
    key: &str,
    value: Option<String>,
) -> Result<JsValue, JsValue> {
    match set_block_attr_impl(doc, id, key, value.as_deref()) {
        Some(s) => Ok(JsValue::from_str(&s)),
        None => Ok(JsValue::NULL),
    }
}

/// Build an exact UTF-16 header edit for one non-identity block attribute.
#[wasm_bindgen]
pub fn set_block_attr_edit(
    doc: &str,
    id: &str,
    key: &str,
    value: Option<String>,
) -> Result<JsValue, JsValue> {
    match set_block_attr_edit_impl(doc, id, key, value.as_deref()) {
        Some(edit) => {
            serde_wasm_bindgen::to_value(&edit).map_err(|e| JsValue::from_str(&e.to_string()))
        }
        None => Ok(JsValue::NULL),
    }
}

#[cfg(test)]
mod large_input {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    /// Large synthetic block content: prose, callouts, code fences, friendly
    /// tabs, and nested directives — shaped like a heavy real note.
    fn synthetic_content(sections: usize) -> String {
        let mut s = String::new();
        for i in 0..sections {
            s.push_str(&format!("tab: Section {i}\n"));
            for j in 0..8 {
                s.push_str(&format!(
                    "paragraph {i}.{j} with some **markdown** text, emoji \u{1F600} and links\n\n"
                ));
            }
            s.push_str("> [!note] A callout\n> with a body line\n> and another\n\n");
            s.push_str("```js\nconst x = 1;\nfunction f() { return x; }\n```\n\n");
            s.push_str(":::grid {cols=2}\n:::cell\ncell text\n:::\n:::cell\nmore\n:::\n:::\n");
        }
        s
    }

    /// Guards the hot paths at realistic scale (~85 KB of block content,
    /// multi-block doc): byte-exact round-trip, scan/edit consistency, and a
    /// SaveRegion whose `expected` is the full serialized region.
    #[test]
    fn large_doc_hot_paths_stay_consistent() {
        let content = synthetic_content(60);
        let mut doc = String::new();
        for i in 0..4 {
            doc.push_str("intro prose between blocks\n\n");
            doc.push_str(&format!("````mica id=blk-{i} name=\"Block {i}\"\n"));
            doc.push_str(&content);
            doc.push_str("````\n\n");
        }

        // Parse/serialize round-trip is byte-exact at scale.
        let cst = parse_block_impl(&content);
        assert_eq!(serialize_impl(&cst), content);

        // The scanner finds every block; content slices match the parser input.
        let blocks = scan_impl(&doc);
        assert_eq!(blocks.len(), 4);
        assert!(blocks
            .iter()
            .all(|b| doc[b.content_start..b.content_end] == content));

        // UTF-16 views agree with the char-by-char reference at scale.
        let views = scan_view_impl(&doc);
        let reference: usize = doc[..blocks[3].content_start]
            .chars()
            .map(char::len_utf16)
            .sum();
        assert_eq!(views[3].content_start, reference);
        let edit = block_content_edit_impl(&doc, "blk-3", "x\n");
        assert_eq!(edit.map(|e| (e.from, e.to)), {
            let len: usize = content.chars().map(char::len_utf16).sum();
            Some((reference, reference + len))
        });

        // SaveRegion accepts a full-region `expected` and applies cleanly.
        let mut work = cst.clone();
        let end = work.children.len();
        let expected = serialize_impl(&cst);
        assert!(apply_op_impl(
            &mut work,
            &StructOp::SaveRegion {
                path: vec![],
                start: 0,
                end,
                expected,
                text: "replaced\n".into(),
            }
        ));
        assert_eq!(serialize_impl(&work), "replaced\n");

        // Signature is insensitive to the doc wrapper and stable across calls.
        assert_eq!(
            content_signature_impl(&content),
            content_signature_impl(&content)
        );
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn hash_is_deterministic_tagged_and_distinct() {
        assert_eq!(hash_content_impl("hello"), hash_content_impl("hello"));
        assert!(hash_content_impl("hello").starts_with("b3:"));
        assert_eq!(hash_content_impl("hello").len(), 3 + 64);
        assert_ne!(hash_content_impl("a"), hash_content_impl("b"));
    }

    #[test]
    fn ids_are_unique_and_version_7() {
        let a = new_id_impl();
        let b = new_id_impl();
        assert_ne!(a, b);
        // "xxxxxxxx-xxxx-7xxx-yxxx-..." — the version nibble is at byte index 14.
        assert_eq!(a.as_bytes()[14], b'7');
    }

    #[test]
    fn version_is_nonempty() {
        assert!(!mica_version_impl().is_empty());
    }
}

//! Mica core — the pure, I/O-free engine behind the Mica Obsidian plugin.
//!
//! This crate compiles to WebAssembly (via `wasm-pack`) for the plugin and to a
//! native `rlib` for `cargo test`. Public logic lives in `*_impl` functions that
//! are unit-tested natively; thin `#[wasm_bindgen]` wrappers expose them to
//! TypeScript. Nothing here touches the filesystem, the network, or Obsidian.
//!
//! Milestone status: M0 seeds identity + content-addressing. The fence scanner,
//! CST, serializer, and diff arrive in M1/M4.

use uuid::Uuid;
use wasm_bindgen::prelude::*;

mod diff;
mod edit;
mod migrate;
mod parser;
mod reconcile;
mod scanner;
mod util;
mod versions;
pub use diff::{diff_impl, make_patch_impl, DiffChange, DiffResult, Hunk, Span};
pub use migrate::{migrate_tabs_impl, MigratedBlock, MigrationResult};
pub use reconcile::{reconcile_impl, ContentRef, ReconcileAction, SidecarRef};
pub use edit::{block_content_edit_impl, ensure_ids_impl, replace_block_content_impl, BlockEdit};
pub use parser::{parse_block_impl, serialize_impl, Cst, Node};
pub use scanner::{scan_impl, scan_view_impl, BlockSpan, BlockView};
pub use versions::{fold_ledger_impl, BlockState, Event, VersionMeta};

// --- Pure core (unit-tested natively) ------------------------------------

/// Crate version, for a plugin/core version handshake at load time.
pub fn mica_version_impl() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Content address of `text`: a BLAKE3 digest truncated to a 64-bit hex prefix,
/// tagged `b3:`. This is the block dirty-check key and the version-object name.
///
/// A 64-bit prefix keeps fence headers and object filenames short while giving
/// ample collision resistance for per-note dedup.
pub fn hash_content_impl(text: &str) -> String {
    let hex = blake3::hash(text.as_bytes()).to_hex();
    format!("b3:{}", &hex[..16])
}

/// Mint a new time-ordered UUIDv7 — used for block ids (fence header) and note
/// anchors (frontmatter `mica-id`). Time ordering makes ids sort by creation.
pub fn new_id_impl() -> String {
    Uuid::now_v7().to_string()
}

// --- WASM boundary (thin wrappers) ---------------------------------------

#[wasm_bindgen]
pub fn mica_version() -> String {
    mica_version_impl()
}

#[wasm_bindgen]
pub fn hash_content(text: &str) -> String {
    hash_content_impl(text)
}

#[wasm_bindgen]
pub fn new_id() -> String {
    new_id_impl()
}

/// Locate every top-level ` ```mica ` block in a document. Returns `BlockSpan[]`.
#[wasm_bindgen]
pub fn scan(src: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&scan_impl(src)).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Locate blocks with UTF-16 offsets + id/name, for CodeMirror decorations.
#[wasm_bindgen]
pub fn scan_view(src: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&scan_view_impl(src)).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse one block's content into a `Cst`.
#[wasm_bindgen]
pub fn parse_block(content: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&parse_block_impl(content)).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Serialize a `Cst` back to source (byte-exact for unedited trees).
#[wasm_bindgen]
pub fn serialize(cst: JsValue) -> Result<String, JsValue> {
    let cst: Cst = serde_wasm_bindgen::from_value(cst).map_err(|e| JsValue::from_str(&e.to_string()))?;
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
    let events: Vec<Event> = serde_wasm_bindgen::from_value(events).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    fold_ledger_impl(&events).serialize(&ser).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Diff `base` vs `other` (`granularity` = line|word|char) with `context` lines.
#[wasm_bindgen]
pub fn diff(base: &str, other: &str, granularity: &str, context: usize) -> Result<JsValue, JsValue> {
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
    let content: Vec<ContentRef> = serde_wasm_bindgen::from_value(content).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let sidecar: Vec<SidecarRef> = serde_wasm_bindgen::from_value(sidecar).map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&reconcile_impl(&content, &sidecar)).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Convert every legacy ```tabs block in `doc` into a ```mica block.
#[wasm_bindgen]
pub fn migrate_tabs(doc: &str) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&migrate_tabs_impl(doc)).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_tagged_and_distinct() {
        assert_eq!(hash_content_impl("hello"), hash_content_impl("hello"));
        assert!(hash_content_impl("hello").starts_with("b3:"));
        assert_eq!(hash_content_impl("hello").len(), 3 + 16);
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

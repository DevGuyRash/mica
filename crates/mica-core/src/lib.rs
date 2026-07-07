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

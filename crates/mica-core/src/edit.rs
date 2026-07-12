//! Corruption-proof block editing.
//!
//! Given a document and a block `id`, these functions recompute the block's
//! bounds from a live scan — never from a cached line number — and produce
//! either the full new document or a CodeMirror change spec. Offsets for the
//! change spec are in UTF-16 code units (what CodeMirror / JS strings use), so
//! multi-byte content (emoji, box-drawing) can never desynchronize positions.
//!
//! This is where the `obsidian-tabs` append bug is made structurally
//! impossible: the replacement range is always exact, even when content grows.

use crate::scanner::scan_impl;
use crate::util::utf16_len;
use serde::Serialize;

/// A position-mapped edit to a block's content, in UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlockEdit {
    /// Replace-range start (UTF-16 code units).
    pub from: usize,
    /// Replace-range end (UTF-16 code units).
    pub to: usize,
    /// Replacement text.
    pub insert: String,
}

/// The full document that results from replacing block `id`'s content with
/// `new_content`. Returns `None` if no block carries that `id`.
pub fn replace_block_content_impl(doc: &str, id: &str, new_content: &str) -> Option<String> {
    let b = scan_impl(doc).into_iter().find(|b| b.id() == Some(id))?;
    let mut out =
        String::with_capacity(doc.len() - (b.content_end - b.content_start) + new_content.len());
    out.push_str(&doc[..b.content_start]);
    out.push_str(new_content);
    out.push_str(&doc[b.content_end..]);
    Some(out)
}

/// The CodeMirror change (UTF-16 offsets) that replaces block `id`'s content.
pub fn block_content_edit_impl(doc: &str, id: &str, new_content: &str) -> Option<BlockEdit> {
    let b = scan_impl(doc).into_iter().find(|b| b.id() == Some(id))?;
    Some(BlockEdit {
        from: utf16_len(&doc[..b.content_start]),
        to: utf16_len(&doc[..b.content_end]),
        insert: new_content.to_string(),
    })
}

/// Ensure every ` ```mica ` block carries an `id=`; id-less blocks get a fresh
/// UUIDv7 inserted into their header. Returns the (possibly unchanged) document.
pub fn ensure_ids_impl(doc: &str) -> String {
    let mut out = doc.to_string();
    // Reverse order so each insertion leaves earlier byte offsets valid.
    for b in scan_impl(doc).iter().rev() {
        if b.id().is_some() {
            continue;
        }
        let line = &doc[b.start..b.content_start];
        let indent = line.len() - line.trim_start_matches(' ').len();
        let tag_start = b.start + indent + b.fence_len;
        let insert_at = tag_start + "mica".len();
        if doc.get(tag_start..insert_at) != Some("mica") {
            continue;
        }
        out.insert_str(insert_at, &format!(" id={}", crate::new_id_impl()));
    }
    out
}

/// Set, replace, or remove one header attribute on the block with `id`.
///
/// Purpose: per-block appearance (`accent=`, `density=`, …) and names live as
/// fence-header attrs; this is the one writer both hosts use.
///
/// # Arguments
/// * `doc` - the full document
/// * `id` - the target block's `id` attr
/// * `key` - attribute name (`name`, `accent`, `density`, …); `id` itself is refused
/// * `value` - new value (quoted automatically when it contains whitespace),
///   or `None` to remove the attribute
///
/// # Returns
/// The new document, or `None` when no block carries `id` or `key` is `id`.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let doc = "```mica id=a\nx\n```\n";
/// let out = mica_core::set_block_attr_impl(doc, "a", "name", Some("My block")).unwrap();
/// assert!(out.contains("name=\"My block\""));
/// ```
pub fn set_block_attr_impl(doc: &str, id: &str, key: &str, value: Option<&str>) -> Option<String> {
    if key == "id"
        || key.is_empty()
        || key.contains(|c: char| c.is_whitespace() || c == '=' || c == '`')
    {
        return None; // id is identity; malformed keys can't round-trip
    }
    if let Some(v) = value {
        // The attr grammar has no escapes, and a backtick would end the fence's
        // info string per CommonMark — refuse values that can't round-trip.
        if v.contains('"') || v.contains('`') || v.contains('\n') || v.contains('\r') {
            return None;
        }
    }
    let b = scan_impl(doc).into_iter().find(|b| b.id() == Some(id))?;
    let header = &doc[b.start..b.content_start];
    let indent_len = header.len() - header.trim_start_matches(' ').len();
    let indent = &header[..indent_len];
    let fence = &header[indent_len..indent_len + b.fence_len];

    let mut attrs = b.attrs.clone();
    match value {
        Some(v) => {
            if let Some(slot) = attrs.iter_mut().find(|(k, _)| k == key) {
                slot.1 = v.to_string();
            } else {
                attrs.push((key.to_string(), v.to_string()));
            }
        }
        None => attrs.retain(|(k, _)| k != key),
    }

    let mut line = format!("{indent}{fence}mica");
    for (k, v) in &attrs {
        if v.is_empty() {
            line.push_str(&format!(" {k}"));
        } else if v.contains(char::is_whitespace) {
            line.push_str(&format!(" {k}=\"{v}\""));
        } else {
            line.push_str(&format!(" {k}={v}"));
        }
    }
    line.push('\n');

    let mut out = String::with_capacity(doc.len() + 32);
    out.push_str(&doc[..b.start]);
    out.push_str(&line);
    out.push_str(&doc[b.content_start..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn grow_content_replaces_cleanly() {
        // The exact obsidian-tabs failure: edited content is LONGER than before.
        let doc = "intro\n```mica id=abc\nshort\n```\ntail\n";
        let out = replace_block_content_impl(doc, "abc", "much longer\ncontent\nhere\n").unwrap();
        assert_eq!(
            out,
            "intro\n```mica id=abc\nmuch longer\ncontent\nhere\n```\ntail\n"
        );
        assert!(!out.contains("short"), "old content must not survive");
        assert_eq!(out.matches("```mica").count(), 1, "no duplicated fence");
        assert_eq!(out.matches("tail").count(), 1, "trailing content intact");
    }

    #[test]
    fn shrink_content_replaces_cleanly() {
        let doc = "```mica id=x\nline1\nline2\nline3\n```\n";
        let out = replace_block_content_impl(doc, "x", "one\n").unwrap();
        assert_eq!(out, "```mica id=x\none\n```\n");
    }

    #[test]
    fn replace_respects_inner_fences() {
        // A 3-backtick sample inside a 4-backtick block; replacement stays exact.
        let doc = "````mica id=q\n```js\nx\n```\n````\n";
        let out = replace_block_content_impl(doc, "q", "```py\ny\n```\n").unwrap();
        assert_eq!(out, "````mica id=q\n```py\ny\n```\n````\n");
    }

    #[test]
    fn unknown_id_returns_none() {
        assert!(replace_block_content_impl("```mica id=a\nx\n```\n", "b", "y").is_none());
        assert!(block_content_edit_impl("```mica id=a\nx\n```\n", "b", "y").is_none());
    }

    #[test]
    fn edit_offsets_are_utf16_not_bytes() {
        // 😀 = 2 UTF-16 units / 4 bytes; █ = 1 unit / 3 bytes. Offsets must be UTF-16.
        let doc = "😀█\n```mica id=x\nold\n```\n";
        let e = block_content_edit_impl(doc, "x", "new\n").unwrap();
        let prefix_utf16: usize = "😀█\n```mica id=x\n".chars().map(|c| c.len_utf16()).sum();
        assert_eq!(e.from, prefix_utf16);
        assert_eq!(
            e.to,
            e.from + "old\n".chars().map(|c| c.len_utf16()).sum::<usize>()
        );
        assert_eq!(e.insert, "new\n");
    }

    #[test]
    fn ensure_ids_adds_to_idless_and_keeps_existing() {
        let doc = "```mica\na\n```\n\n```mica id=keep\nb\n```\n";
        let out = ensure_ids_impl(doc);
        let blocks = scan_impl(&out);
        assert_eq!(blocks.len(), 2);
        assert!(blocks.iter().all(|b| b.id().is_some()));
        assert!(out.contains("id=keep"));
    }

    #[test]
    fn ensure_ids_is_noop_when_all_present() {
        let doc = "```mica id=x\na\n```\n";
        assert_eq!(ensure_ids_impl(doc), doc);
    }

    #[test]
    fn ensure_ids_preserves_inner_content() {
        let doc = "intro\n````mica\n```js\nx\n```\n````\n";
        let out = ensure_ids_impl(doc);
        assert!(out.contains("```js\nx\n```"));
        assert!(scan_impl(&out)[0].id().is_some());
    }

    #[test]
    fn set_attr_adds_updates_and_removes() {
        let doc = "```mica id=a\nx\n```\n";
        let out = set_block_attr_impl(doc, "a", "accent", Some("#ff0000")).unwrap();
        assert_eq!(out, "```mica id=a accent=#ff0000\nx\n```\n");

        let out2 = set_block_attr_impl(&out, "a", "accent", Some("#00ff00")).unwrap();
        assert_eq!(out2, "```mica id=a accent=#00ff00\nx\n```\n");

        let out3 = set_block_attr_impl(&out2, "a", "accent", None).unwrap();
        assert_eq!(out3, doc);
    }

    #[test]
    fn set_attr_quotes_values_with_spaces_and_preserves_order() {
        let doc = "```mica id=a density=compact\nx\n```\n";
        let out = set_block_attr_impl(doc, "a", "name", Some("My block")).unwrap();
        assert_eq!(
            out,
            "```mica id=a density=compact name=\"My block\"\nx\n```\n"
        );
        // Round-trips through the scanner.
        let b = &scan_impl(&out)[0];
        assert_eq!(b.get("name"), Some("My block"));
        assert_eq!(b.get("density"), Some("compact"));
    }

    #[test]
    fn set_attr_refuses_id_unknown_block_and_unsafe_values() {
        let doc = "```mica id=a\nx\n```\n";
        assert!(
            set_block_attr_impl(doc, "a", "id", Some("b")).is_none(),
            "id is identity"
        );
        assert!(
            set_block_attr_impl(doc, "zzz", "name", Some("n")).is_none(),
            "unknown block"
        );
        assert!(
            set_block_attr_impl(doc, "a", "name", Some("has ` tick")).is_none(),
            "backtick breaks fence"
        );
        assert!(
            set_block_attr_impl(doc, "a", "name", Some("has \" quote")).is_none(),
            "unescapable"
        );
        assert!(
            set_block_attr_impl(doc, "a", "name", Some("has\nnewline")).is_none(),
            "newline"
        );
    }

    #[test]
    fn set_attr_removing_missing_key_is_noop() {
        let doc = "```mica id=a\nx\n```\n";
        assert_eq!(set_block_attr_impl(doc, "a", "accent", None).unwrap(), doc);
    }
}

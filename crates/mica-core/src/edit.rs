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
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// The full document that results from replacing block `id`'s content with
/// `new_content`. Returns `None` if no block carries that `id`.
pub fn replace_block_content_impl(doc: &str, id: &str, new_content: &str) -> Option<String> {
    let b = scan_impl(doc).into_iter().find(|b| b.id() == Some(id))?;
    let mut out = String::with_capacity(doc.len() - (b.content_end - b.content_start) + new_content.len());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grow_content_replaces_cleanly() {
        // The exact obsidian-tabs failure: edited content is LONGER than before.
        let doc = "intro\n```mica id=abc\nshort\n```\ntail\n";
        let out = replace_block_content_impl(doc, "abc", "much longer\ncontent\nhere\n").unwrap();
        assert_eq!(out, "intro\n```mica id=abc\nmuch longer\ncontent\nhere\n```\ntail\n");
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
        assert_eq!(e.to, e.from + "old\n".chars().map(|c| c.len_utf16()).sum::<usize>());
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
}

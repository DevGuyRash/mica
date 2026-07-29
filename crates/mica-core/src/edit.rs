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

use crate::scanner::{scan_impl, scan_with, BlockSpan};
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
    let b = unique_block_by_id(doc, id)?;
    let replacement = content_replacement_for_block(doc, &b, new_content)?;
    let mut out = String::with_capacity(
        doc.len() - (replacement.to - replacement.from) + replacement.insert.len(),
    );
    out.push_str(&doc[..replacement.from]);
    out.push_str(&replacement.insert);
    out.push_str(&doc[replacement.to..]);
    Some(out)
}

/// The CodeMirror change (UTF-16 offsets) that replaces block `id`'s content.
pub fn block_content_edit_impl(doc: &str, id: &str, new_content: &str) -> Option<BlockEdit> {
    let b = unique_block_by_id(doc, id)?;
    // `to` continues from `from` so the prefix is only walked once.
    let from = utf16_len(&doc[..b.content_start]);
    Some(BlockEdit {
        from,
        to: from + utf16_len(&doc[b.content_start..b.content_end]),
        insert: new_content.to_string(),
    })
}

/// Build a guarded content edit for exactly one block identity.
///
/// Purpose: prevent a full-block editor from overwriting content that changed
/// after the editor opened.
///
/// # Arguments
/// * `doc` - the freshly read full document
/// * `id` - the target block identity, which must occur exactly once
/// * `expected` - exact block content observed when editing began
/// * `new_content` - replacement block content
///
/// # Returns
/// A UTF-16 [`BlockEdit`], or `None` for a missing/duplicate identity, stale
/// content, or a no-op replacement.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let doc = "```mica id=a\nold\n```\n";
/// let edit = mica_core::guarded_block_content_edit_impl(doc, "a", "old\n", "new\n");
/// assert_eq!(edit.map(|edit| edit.insert), Some("new\n".to_string()));
/// ```
pub fn guarded_block_content_edit_impl(
    doc: &str,
    id: &str,
    expected: &str,
    new_content: &str,
) -> Option<BlockEdit> {
    if expected == new_content {
        return None;
    }
    let block = unique_block_by_id(doc, id)?;
    if &doc[block.content_start..block.content_end] != expected {
        return None;
    }
    content_edit_for_block(doc, &block, new_content)
}

/// Build a guarded content edit for one exact scanned block occurrence.
///
/// Purpose: give id-less Live Preview widgets the same stale-content and
/// fence-safety guarantees as id-addressed block editors.
///
/// # Arguments
/// * `doc` - the freshly read full document
/// * `block_start` - UTF-16 opening-fence offset from `scan_view_impl`
/// * `expected` - exact block content observed when editing began
/// * `new_content` - replacement block content
///
/// # Returns
/// A UTF-16 [`BlockEdit`], or `None` when the occurrence moved, the content is
/// stale, the replacement is a no-op, or the block is not closed.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let doc = "```mica\nold\n```\n";
/// let edit = mica_core::guarded_block_content_edit_at_impl(doc, 0, "old\n", "new\n");
/// assert!(edit.is_some());
/// ```
pub fn guarded_block_content_edit_at_impl(
    doc: &str,
    block_start: usize,
    expected: &str,
    new_content: &str,
) -> Option<BlockEdit> {
    if expected == new_content {
        return None;
    }
    let block = block_at_utf16_start(doc, block_start)?;
    if !block.closed || &doc[block.content_start..block.content_end] != expected {
        return None;
    }
    content_edit_for_block(doc, &block, new_content)
}

/// Build a header-only edit that sets one non-identity block attribute.
///
/// Purpose: avoid replacing the entire note for a one-line appearance or name
/// change while still resolving the target from a fresh scan.
///
/// # Arguments
/// * `doc` - the freshly read full document
/// * `id` - target identity, which must occur exactly once
/// * `key` - non-`id` attribute key
/// * `value` - replacement value, or `None` to remove the attribute
///
/// # Returns
/// A UTF-16 header edit, or `None` when the identity is ambiguous, input is
/// unsafe, or the reconstructed header is unchanged.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let doc = "```mica id=a\nx\n```\n";
/// let edit = mica_core::set_block_attr_edit_impl(doc, "a", "name", Some("Example"));
/// assert!(edit.is_some());
/// ```
pub fn set_block_attr_edit_impl(
    doc: &str,
    id: &str,
    key: &str,
    value: Option<&str>,
) -> Option<BlockEdit> {
    if key == "id" || !valid_header_attr(key, value) {
        return None;
    }
    let block = unique_block_by_id(doc, id)?;
    header_edit_for_block(doc, &block, key, value)
}

/// Rewrite the identity of one exact block occurrence.
///
/// Purpose: repair duplicate IDs without accidentally rewriting the first
/// same-ID block in the note.
///
/// # Arguments
/// * `doc` - the freshly read full document
/// * `block_start` - UTF-16 opening-fence offset from `scan_view_impl`
/// * `expected_id` - identity currently expected at that occurrence
/// * `new_id` - fresh non-empty identity, unique within the document
///
/// # Returns
/// A UTF-16 header edit, or `None` if the occurrence moved, its identity is
/// stale, the new identity is unsafe/duplicate, or the edit is a no-op.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let doc = "```mica id=dup\na\n```\n```mica id=dup\nb\n```\n";
/// let second = mica_core::scan_view_impl(doc)[1].start;
/// let edit = mica_core::rewrite_block_id_at_impl(doc, second, "dup", "fresh");
/// assert!(edit.is_some());
/// ```
pub fn rewrite_block_id_at_impl(
    doc: &str,
    block_start: usize,
    expected_id: &str,
    new_id: &str,
) -> Option<BlockEdit> {
    if expected_id == new_id || !valid_header_attr("id", Some(new_id)) || new_id.is_empty() {
        return None;
    }
    let mut cursor_byte = 0;
    let mut cursor_utf16 = 0;
    let mut block = None;
    let mut duplicate_new_id = false;
    // One canonical scan establishes both the exact occurrence and global
    // uniqueness in O(n) document time and O(1) lookup space. The previous two
    // scans doubled per-repair document work and retained every block span.
    scan_with(doc, |candidate| {
        if candidate.id() == Some(new_id) {
            duplicate_new_id = true;
            return false;
        }
        cursor_utf16 += utf16_len(&doc[cursor_byte..candidate.start]);
        cursor_byte = candidate.start;
        if cursor_utf16 == block_start {
            block = Some(candidate);
            return true;
        }
        // Once the requested position is behind us, it cannot match a later
        // block; stop unless the target was already found and uniqueness still
        // needs checking through EOF.
        block.is_some() || cursor_utf16 < block_start
    });
    if duplicate_new_id {
        return None;
    }
    let block = block?;
    if block.id() != Some(expected_id) {
        return None;
    }
    header_edit_for_block(doc, &block, "id", Some(new_id))
}

fn unique_block_by_id(doc: &str, id: &str) -> Option<BlockSpan> {
    let mut found = None;
    let mut ambiguous = false;
    // O(n) document time; only the first matching span is retained.
    scan_with(doc, |block| {
        if block.id() != Some(id) {
            return true;
        }
        if found.is_some() {
            ambiguous = true;
            return false;
        }
        found = Some(block);
        true
    });
    if ambiguous {
        None
    } else {
        found
    }
}

fn block_at_utf16_start(doc: &str, block_start: usize) -> Option<BlockSpan> {
    let mut cursor_byte = 0;
    let mut cursor_utf16 = 0;
    let mut found = None;
    // O(n) where n = document bytes; each prefix segment is visited once.
    scan_with(doc, |block| {
        cursor_utf16 += utf16_len(&doc[cursor_byte..block.start]);
        cursor_byte = block.start;
        if cursor_utf16 == block_start {
            found = Some(block);
            return false;
        }
        cursor_utf16 < block_start
    });
    found
}

fn content_edit_for_block(doc: &str, block: &BlockSpan, new_content: &str) -> Option<BlockEdit> {
    let replacement = content_replacement_for_block(doc, block, new_content)?;
    let from = utf16_len(&doc[..replacement.from]);
    Some(BlockEdit {
        from,
        to: from + utf16_len(&doc[replacement.from..replacement.to]),
        insert: replacement.insert,
    })
}

struct ContentReplacement {
    from: usize,
    to: usize,
    insert: String,
}

fn content_replacement_for_block(
    doc: &str,
    block: &BlockSpan,
    new_content: &str,
) -> Option<ContentReplacement> {
    let conflicting_run = longest_closing_fence_run(new_content, block.fence_char);
    if conflicting_run >= block.fence_len {
        let fence_len = conflicting_run + 1;
        let header = &doc[block.start..block.content_start];
        let closer = &doc[block.content_end..block.end];
        let grown_header = grow_fence_line(header, block.fence_char, fence_len)?;
        let grown_closer = if closer.is_empty() {
            String::new()
        } else {
            grow_fence_line(closer, block.fence_char, fence_len)?
        };
        let mut insert =
            String::with_capacity(grown_header.len() + new_content.len() + grown_closer.len());
        insert.push_str(&grown_header);
        insert.push_str(new_content);
        insert.push_str(&grown_closer);
        return Some(ContentReplacement {
            from: block.start,
            to: block.end,
            insert,
        });
    }
    Some(ContentReplacement {
        from: block.content_start,
        to: block.content_end,
        insert: new_content.to_string(),
    })
}

fn longest_closing_fence_run(content: &str, fence_char: u8) -> usize {
    let mut longest = 0;
    // O(n) where n = replacement bytes (expected: one Mica block body).
    for line in content.split('\n') {
        let text = line.strip_suffix('\r').unwrap_or(line);
        let indent = text.bytes().take_while(|byte| *byte == b' ').count();
        if indent > 3 {
            continue;
        }
        let rest = &text[indent..];
        let run = rest.bytes().take_while(|byte| *byte == fence_char).count();
        if run >= 3 && rest[run..].trim().is_empty() {
            longest = longest.max(run);
        }
    }
    longest
}

fn grow_fence_line(line: &str, fence_char: u8, fence_len: usize) -> Option<String> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let run = line[indent..]
        .bytes()
        .take_while(|byte| *byte == fence_char)
        .count();
    if run < 3 {
        return None;
    }
    let replacement_len = run.max(fence_len);
    let mut grown = String::with_capacity(line.len() + replacement_len - run);
    grown.push_str(&line[..indent]);
    for _ in 0..replacement_len {
        grown.push(fence_char as char);
    }
    grown.push_str(&line[indent + run..]);
    Some(grown)
}

fn header_edit_for_block(
    doc: &str,
    block: &BlockSpan,
    key: &str,
    value: Option<&str>,
) -> Option<BlockEdit> {
    let header = &doc[block.start..block.content_start];
    let line = header_replacement_for_block(doc, block, key, value)?;
    let from = utf16_len(&doc[..block.start]);
    Some(BlockEdit {
        from,
        to: from + utf16_len(header),
        insert: line,
    })
}

fn header_replacement_for_block(
    doc: &str,
    block: &BlockSpan,
    key: &str,
    value: Option<&str>,
) -> Option<String> {
    let header = &doc[block.start..block.content_start];
    let indent_len = header.len() - header.trim_start_matches(' ').len();
    let indent = &header[..indent_len];
    let fence = &header[indent_len..indent_len + block.fence_len];
    let eol = if header.ends_with("\r\n") {
        "\r\n"
    } else if header.ends_with('\n') {
        "\n"
    } else {
        ""
    };

    let mut line = String::with_capacity(header.len() + value.map_or(0, str::len) + key.len() + 4);
    line.push_str(indent);
    line.push_str(fence);
    line.push_str("mica");
    let mut replaced = false;
    for (attr_key, attr_value) in &block.attrs {
        if attr_key == key {
            if let Some(value) = value {
                if !replaced {
                    write_header_attr(&mut line, key, value);
                    replaced = true;
                } else {
                    write_header_attr(&mut line, attr_key, attr_value);
                }
            }
        } else {
            write_header_attr(&mut line, attr_key, attr_value);
        }
    }
    if let Some(value) = value {
        if !replaced {
            write_header_attr(&mut line, key, value);
        }
    }
    line.push_str(eol);
    if line == header {
        return None;
    }
    Some(line)
}

fn write_header_attr(line: &mut String, key: &str, value: &str) {
    line.push(' ');
    line.push_str(key);
    if value.is_empty() {
    } else if value.contains(char::is_whitespace) {
        line.push_str("=\"");
        line.push_str(value);
        line.push('"');
    } else {
        line.push('=');
        line.push_str(value);
    }
}

fn valid_header_attr(key: &str, value: Option<&str>) -> bool {
    if key.is_empty()
        || key.contains(|c: char| c.is_control() || c.is_whitespace() || c == '=' || c == '`')
    {
        return false;
    }
    value.is_none_or(|value| !value.contains(|c: char| c.is_control() || c == '"' || c == '`'))
}

/// Ensure every ` ```mica ` block carries an `id=`; id-less blocks get a fresh
/// UUIDv7 inserted into their header. Returns the (possibly unchanged) document.
pub fn ensure_ids_impl(doc: &str) -> String {
    let blocks = scan_impl(doc);
    let mut insertions = Vec::new();
    // Preserve the established reverse-document UUID generation order while
    // collecting offsets; output is assembled once in forward order below.
    for b in blocks.iter().rev() {
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
        insertions.push((insert_at, crate::new_id_impl()));
    }
    if insertions.is_empty() {
        return doc.to_string();
    }

    let added: usize = insertions
        .iter()
        .map(|(_, id)| " id=".len() + id.len())
        .sum();
    let mut out = String::with_capacity(doc.len() + added);
    let mut cursor = 0;
    for (insert_at, id) in insertions.into_iter().rev() {
        out.push_str(&doc[cursor..insert_at]);
        out.push_str(" id=");
        out.push_str(&id);
        cursor = insert_at;
    }
    out.push_str(&doc[cursor..]);
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
    if key == "id" || !valid_header_attr(key, value) {
        return None;
    }
    let block = unique_block_by_id(doc, id)?;
    let Some(replacement) = header_replacement_for_block(doc, &block, key, value) else {
        return Some(doc.to_string());
    };
    // This full-document compatibility API uses known byte boundaries directly;
    // unlike the editor API it does not pay for a discarded UTF-16 prefix map.
    let mut out =
        String::with_capacity(doc.len() - (block.content_start - block.start) + replacement.len());
    out.push_str(&doc[..block.start]);
    out.push_str(&replacement);
    out.push_str(&doc[block.content_start..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn guarded_edit_grows_outer_fence_atomically() {
        let doc = "before\r\n   ```mica id=a name=Example\r\nold\r\n   ```   \r\nafter\r\n";
        let replacement = "```rust\r\nfn main() {}\r\n```\r\n";
        let edit = guarded_block_content_edit_impl(doc, "a", "old\r\n", replacement)
            .expect("matching unique block should produce an edit");
        assert_eq!(edit.from, "before\r\n".encode_utf16().count());
        assert_eq!(
            edit.insert,
            "   ````mica id=a name=Example\r\n```rust\r\nfn main() {}\r\n```\r\n   ````   \r\n"
        );
        assert_eq!(
            edit.to,
            "before\r\n   ```mica id=a name=Example\r\nold\r\n   ```   \r\n"
                .encode_utf16()
                .count()
        );
    }

    #[test]
    fn occurrence_guard_rejects_moved_or_stale_block() {
        let doc = "😀\n```mica\nold\n```\n";
        let start = crate::scanner::scan_view_impl(doc)[0].start;
        let edit = guarded_block_content_edit_at_impl(doc, start, "old\n", "new\n")
            .expect("exact occurrence and preimage should be accepted");
        assert_eq!(edit.insert, "new\n");
        assert!(guarded_block_content_edit_at_impl(doc, start + 1, "old\n", "new\n").is_none());
        assert!(guarded_block_content_edit_at_impl(doc, start, "stale\n", "new\n").is_none());
        assert!(guarded_block_content_edit_at_impl(doc, start, "old\n", "old\n").is_none());
    }

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
    fn by_id_edits_reject_ambiguous_duplicates() {
        let doc = "```mica id=dup\na\n```\n```mica id=dup\nb\n```\n";
        assert!(block_content_edit_impl(doc, "dup", "new\n").is_none());
        assert!(replace_block_content_impl(doc, "dup", "new\n").is_none());
        assert!(guarded_block_content_edit_impl(doc, "dup", "a\n", "new\n").is_none());
        assert!(set_block_attr_edit_impl(doc, "dup", "name", Some("x")).is_none());
    }

    #[test]
    fn guarded_edit_rejects_stale_and_noop_content() {
        let doc = "```mica id=a\ncurrent\n```\n";
        assert!(guarded_block_content_edit_impl(doc, "a", "stale\n", "new\n").is_none());
        assert!(guarded_block_content_edit_impl(doc, "a", "current\n", "current\n").is_none());
        let edit = guarded_block_content_edit_impl(doc, "a", "current\n", "new\n").unwrap();
        assert_eq!(edit.insert, "new\n");
    }

    #[test]
    fn occurrence_rewrite_targets_only_requested_duplicate() {
        let doc = "😀\n```mica id=dup name=first\na\n```\n```mica id=dup name=second\nb\n```\n";
        let view = crate::scanner::scan_view_impl(doc);
        let edit = rewrite_block_id_at_impl(doc, view[1].start, "dup", "fresh").unwrap();
        assert_eq!(edit.from, view[1].start);
        assert_eq!(edit.insert, "```mica id=fresh name=second\n");
        assert!(rewrite_block_id_at_impl(doc, view[1].start, "wrong", "fresh").is_none());
        assert!(rewrite_block_id_at_impl(doc, view[1].start + 1, "dup", "fresh").is_none());
    }

    #[test]
    fn occurrence_rewrite_rejects_duplicate_or_unsafe_new_id() {
        let doc = "```mica id=a\na\n```\n```mica id=b\nb\n```\n";
        let start = crate::scanner::scan_view_impl(doc)[1].start;
        assert!(rewrite_block_id_at_impl(doc, start, "b", "a").is_none());
        assert!(rewrite_block_id_at_impl(doc, start, "b", "bad\nid").is_none());
        assert!(rewrite_block_id_at_impl(doc, start, "b", "b").is_none());
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
    fn header_edit_preserves_indent_crlf_and_has_exact_range() {
        let doc = "😀\r\n  ````mica id=a density=compact\r\nx\r\n  ````\r\n";
        let edit = set_block_attr_edit_impl(doc, "a", "name", Some("My block")).unwrap();
        assert_eq!(edit.from, "😀\r\n".encode_utf16().count());
        assert_eq!(
            edit.insert,
            "  ````mica id=a density=compact name=\"My block\"\r\n"
        );
        assert_eq!(
            set_block_attr_impl(doc, "a", "name", Some("My block")).unwrap(),
            "😀\r\n  ````mica id=a density=compact name=\"My block\"\r\nx\r\n  ````\r\n"
        );
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

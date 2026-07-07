//! Top-level block scanner: locates ` ```mica ` fenced blocks in a document,
//! honoring CommonMark fence rules so inner code fences never mislocate a
//! block's true end, and parsing each block's header attributes (`id`, `name`, …).
//!
//! This is the structural fix for the `obsidian-tabs` append bug: a block's end
//! is derived from the fence grammar at scan time, never guessed by counting
//! backticks nor cached as a line number.

use crate::util::utf16_len;
use serde::Serialize;

/// Info string tag that marks a Mica block.
const MICA_TAG: &str = "mica";

/// Byte-offset span of one top-level ` ```mica ` block within a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlockSpan {
    /// Offset of the first byte of the opening fence line.
    pub start: usize,
    /// Offset one past the last byte of the closing fence line (or EOF).
    pub end: usize,
    /// Fence character: `` b'`' `` or `b'~'`.
    pub fence_char: u8,
    /// Number of fence characters in the opening fence.
    pub fence_len: usize,
    /// Offset of the first content byte (start of the line after the opener).
    pub content_start: usize,
    /// Offset one past the last content byte: the start of the closing fence
    /// line, or EOF for an unterminated block.
    pub content_end: usize,
    /// Whether a closing fence was found (`false` = the block ran to EOF).
    pub closed: bool,
    /// Header attributes parsed from the opening line (`id=…`, `name="…"`, …),
    /// in source order.
    pub attrs: Vec<(String, String)>,
}

impl BlockSpan {
    /// Value of header attribute `key`, if present.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// The block's stable `id`, if it carries a non-empty one.
    pub fn id(&self) -> Option<&str> {
        self.get("id").filter(|s| !s.is_empty())
    }
}

struct Open {
    start: usize,
    fence_char: u8,
    fence_len: usize,
    content_start: usize,
    attrs: Vec<(String, String)>,
}

/// Scan `src` for every top-level ` ```mica ` block, in document order.
///
/// Only the outermost blocks are returned; nested structure (colon-fence
/// directives, inner code fences) is the CST parser's job.
pub fn scan_impl(src: &str) -> Vec<BlockSpan> {
    let mut blocks = Vec::new();
    let mut offset = 0usize;
    let mut open: Option<Open> = None;

    for line in src.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();

        let text = trim_eol(line);

        match &open {
            None => {
                if let Some((fence_char, fence_len, attrs)) = parse_open_fence(text) {
                    open = Some(Open {
                        start: line_start,
                        fence_char,
                        fence_len,
                        content_start: offset,
                        attrs,
                    });
                }
            }
            Some(o) => {
                if is_close_fence(text, o.fence_char, o.fence_len) {
                    let o = open.take().unwrap();
                    blocks.push(BlockSpan {
                        start: o.start,
                        end: offset,
                        fence_char: o.fence_char,
                        fence_len: o.fence_len,
                        content_start: o.content_start,
                        content_end: line_start,
                        closed: true,
                        attrs: o.attrs,
                    });
                }
            }
        }
    }

    if let Some(o) = open {
        blocks.push(BlockSpan {
            start: o.start,
            end: offset,
            fence_char: o.fence_char,
            fence_len: o.fence_len,
            content_start: o.content_start,
            content_end: offset,
            closed: false,
            attrs: o.attrs,
        });
    }

    blocks
}

/// If `text` opens a ` ```mica ` fence, return `(fence_char, fence_len, attrs)`.
fn parse_open_fence(text: &str) -> Option<(u8, usize, Vec<(String, String)>)> {
    let indent = leading_spaces(text);
    if indent > 3 {
        return None;
    }
    let rest = &text[indent..];
    let fence_char = rest.as_bytes().first().copied()?;
    if fence_char != b'`' && fence_char != b'~' {
        return None;
    }
    let fence_len = rest.bytes().take_while(|&b| b == fence_char).count();
    if fence_len < 3 {
        return None;
    }
    let info = rest[fence_len..].trim();
    if fence_char == b'`' && info.contains('`') {
        return None;
    }
    let (tag, attr_str) = info.split_once(|c: char| c.is_whitespace()).unwrap_or((info, ""));
    if tag != MICA_TAG {
        return None;
    }
    Some((fence_char, fence_len, parse_attrs(attr_str.trim())))
}

/// Parse a header attribute list: `key=value`, `key="quoted value"`, or a bare
/// `key` flag, whitespace-separated.
fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let bytes = s.as_bytes();
    let mut attrs = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key = s[key_start..i].to_string();
        if key.is_empty() {
            break;
        }
        let mut val = String::new();
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            if i < bytes.len() && bytes[i] == b'"' {
                i += 1;
                let vstart = i;
                while i < bytes.len() && bytes[i] != b'"' {
                    i += 1;
                }
                val = s[vstart..i].to_string();
                if i < bytes.len() {
                    i += 1; // closing quote
                }
            } else {
                let vstart = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                val = s[vstart..i].to_string();
            }
        }
        attrs.push((key, val));
    }
    attrs
}

/// Whether `text` is a closing fence for a block of `fence_char` x `fence_len`.
fn is_close_fence(text: &str, fence_char: u8, fence_len: usize) -> bool {
    let indent = leading_spaces(text);
    if indent > 3 {
        return false;
    }
    let rest = &text[indent..];
    let run = rest.bytes().take_while(|&b| b == fence_char).count();
    run >= fence_len && rest[run..].trim().is_empty()
}

fn leading_spaces(text: &str) -> usize {
    text.len() - text.trim_start_matches(' ').len()
}

fn trim_eol(line: &str) -> &str {
    let l = line.strip_suffix('\n').unwrap_or(line);
    l.strip_suffix('\r').unwrap_or(l)
}

/// A block located for the editor: like [`BlockSpan`] but with UTF-16 offsets
/// (CodeMirror positions) and the id/name hoisted out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlockView {
    pub start: usize,
    pub end: usize,
    pub content_start: usize,
    pub content_end: usize,
    pub fence_len: usize,
    pub closed: bool,
    pub id: Option<String>,
    pub name: Option<String>,
}

/// Scan for blocks with UTF-16 offsets, ready for CodeMirror decorations.
pub fn scan_view_impl(src: &str) -> Vec<BlockView> {
    scan_impl(src)
        .into_iter()
        .map(|b| BlockView {
            start: utf16_len(&src[..b.start]),
            end: utf16_len(&src[..b.end]),
            content_start: utf16_len(&src[..b.content_start]),
            content_end: utf16_len(&src[..b.content_end]),
            fence_len: b.fence_len,
            closed: b.closed,
            id: b.id().map(str::to_string),
            name: b.get("name").map(str::to_string),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_simple_block() {
        let src = "before\n```mica\nhi\n```\nafter\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].fence_len, 3);
        assert_eq!(b[0].fence_char, b'`');
        assert_eq!(&src[b[0].content_start..b[0].content_end], "hi\n");
        assert!(b[0].closed);
    }

    #[test]
    fn inner_shorter_fence_does_not_close_block() {
        // The bug case: a 3-backtick code sample inside a 4-backtick mica block.
        let src = "````mica\n```js\ncode\n```\n````\ntail\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].fence_len, 4);
        assert_eq!(&src[b[0].content_start..b[0].content_end], "```js\ncode\n```\n");
        assert!(b[0].closed);
    }

    #[test]
    fn tilde_fences_work() {
        let b = scan_impl("~~~mica\nx\n~~~\n");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].fence_char, b'~');
    }

    #[test]
    fn parses_header_attributes() {
        let src = "```mica id=0192-7c name=\"Review Instruments\" template=foo flag\nbody\n```\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].id(), Some("0192-7c"));
        assert_eq!(b[0].get("name"), Some("Review Instruments"));
        assert_eq!(b[0].get("template"), Some("foo"));
        assert_eq!(b[0].get("flag"), Some(""));
        assert_eq!(b[0].get("missing"), None);
    }

    #[test]
    fn block_without_id_reports_none() {
        assert_eq!(scan_impl("```mica\nx\n```\n")[0].id(), None);
    }

    #[test]
    fn non_mica_fences_are_ignored() {
        assert!(scan_impl("```js\ncode\n```\n").is_empty());
        assert!(scan_impl("```\nplain\n```\n").is_empty());
    }

    #[test]
    fn two_blocks() {
        let src = "```mica id=a\nx\n```\n\n```mica id=b\ny\n```\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].id(), Some("a"));
        assert_eq!(b[1].id(), Some("b"));
    }

    #[test]
    fn unterminated_block_closes_at_eof() {
        let b = scan_impl("```mica\nno close here\n");
        assert_eq!(b.len(), 1);
        assert!(!b[0].closed);
    }

    #[test]
    fn crlf_lines() {
        let b = scan_impl("```mica\r\nhi\r\n```\r\n");
        assert_eq!(b.len(), 1);
        assert!(b[0].closed);
    }

    #[test]
    fn equal_length_inner_fence_closes_early_as_commonmark_dictates() {
        let b = scan_impl("```mica\n```\n");
        assert_eq!(b.len(), 1);
        assert!(b[0].closed);
    }
}

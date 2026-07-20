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
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
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

/// Scanner context: outside any fence, inside a foreign (non-target) fence, or
/// inside a target block. Per CommonMark, everything inside a fence is literal
/// until its closer — so a ` ```mica ` example QUOTED inside a longer plain
/// fence must never be treated as a real block.
enum Ctx {
    None,
    Foreign { fence_char: u8, fence_len: usize },
    Target(Open),
}

/// Scan `src` for every top-level ` ```mica ` block, in document order.
pub fn scan_impl(src: &str) -> Vec<BlockSpan> {
    scan_tag_impl(src, MICA_TAG)
}

/// Scan for fenced blocks whose info tag is `tag` (`mica`, or `tabs` for migration).
///
/// Only the outermost blocks are returned; nested structure is the parser's job.
pub(crate) fn scan_tag_impl(src: &str, tag: &str) -> Vec<BlockSpan> {
    let mut blocks = Vec::new();
    let mut offset = 0usize;
    let mut ctx = Ctx::None;

    for line in src.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();

        let text = trim_eol(line);

        match &ctx {
            Ctx::None => {
                if let Some((fence_char, fence_len, info)) = fence_open(text) {
                    let info = info.trim();
                    let (found, attr_str) = info
                        .split_once(|c: char| c.is_whitespace())
                        .unwrap_or((info, ""));
                    if found == tag {
                        ctx = Ctx::Target(Open {
                            start: line_start,
                            fence_char,
                            fence_len,
                            content_start: offset,
                            attrs: parse_attrs(attr_str.trim()),
                        });
                    } else {
                        ctx = Ctx::Foreign {
                            fence_char,
                            fence_len,
                        };
                    }
                }
            }
            Ctx::Foreign {
                fence_char,
                fence_len,
            } => {
                if is_close_fence(text, *fence_char, *fence_len) {
                    ctx = Ctx::None;
                }
            }
            Ctx::Target(o) => {
                if is_close_fence(text, o.fence_char, o.fence_len) {
                    // We are inside the Target arm, so the replace always yields
                    // Target — the if-let simply avoids a panic path.
                    let Ctx::Target(o) = std::mem::replace(&mut ctx, Ctx::None) else {
                        continue;
                    };
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

    if let Ctx::Target(o) = ctx {
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

/// Any fenced-code opener: a run of >= 3 backticks or tildes at <= 3 spaces of
/// indent → `(fence_char, fence_len, info string)`. Backtick fences may not
/// carry a backtick in the info string (CommonMark) — such lines are not
/// fences at all. One classification serves both target and foreign fences.
pub(crate) fn fence_open(text: &str) -> Option<(u8, usize, &str)> {
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
    let info = &rest[fence_len..];
    if fence_char == b'`' && info.contains('`') {
        return None;
    }
    Some((fence_char, fence_len, info))
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
    /// Offset of the opening fence line (UTF-16).
    pub start: usize,
    /// One past the closing fence line, or EOF (UTF-16).
    pub end: usize,
    /// First content offset (UTF-16).
    pub content_start: usize,
    /// One past the last content offset (UTF-16).
    pub content_end: usize,
    /// Opening-fence character count.
    pub fence_len: usize,
    /// Whether the closing fence exists.
    pub closed: bool,
    /// The `id=` header attribute, when present and non-empty.
    pub id: Option<String>,
    /// The `name=` header attribute, when present.
    pub name: Option<String>,
    /// All fence-header attributes, in header order.
    pub attrs: Vec<(String, String)>,
}

/// Scan for blocks with UTF-16 offsets, ready for CodeMirror decorations.
/// Offsets are converted in one forward pass (a moving byte→utf16 cursor), so
/// the whole conversion is O(document), not O(blocks × document).
pub fn scan_view_impl(src: &str) -> Vec<BlockView> {
    let mut cursor_byte = 0usize;
    let mut cursor_u16 = 0usize;
    let mut to_u16 = |byte: usize| {
        cursor_u16 += utf16_len(&src[cursor_byte..byte]);
        cursor_byte = byte;
        cursor_u16
    };
    scan_impl(src)
        .into_iter()
        .map(|b| {
            let start = to_u16(b.start);
            let content_start = to_u16(b.content_start);
            let content_end = to_u16(b.content_end);
            let end = to_u16(b.end);
            BlockView {
                start,
                end,
                content_start,
                content_end,
                fence_len: b.fence_len,
                closed: b.closed,
                id: b.id().map(str::to_string),
                name: b.get("name").map(str::to_string),
                attrs: b.attrs,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn scan_view_carries_header_attrs() {
        // One scan serves the live preview's geometry AND appearance needs —
        // requiring a second scan for attrs doubled the hottest editor path.
        let v = scan_view_impl(
            "```mica id=x accent=#f00 wrap=off
content
```
",
        );
        assert_eq!(v.len(), 1);
        assert_eq!(
            v[0].attrs,
            vec![
                ("id".to_string(), "x".to_string()),
                ("accent".to_string(), "#f00".to_string()),
                ("wrap".to_string(), "off".to_string()),
            ]
        );
    }

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
        assert_eq!(
            &src[b[0].content_start..b[0].content_end],
            "```js\ncode\n```\n"
        );
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

    #[test]
    fn quoted_mica_inside_foreign_fence_is_ignored() {
        // A documentation note QUOTING a mica example must not create a block.
        let src = "````md\n```mica id=fake\nquoted example\n```\n````\n\n```mica id=real\nx\n```\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].id(), Some("real"));
    }

    #[test]
    fn quoted_tabs_inside_foreign_fence_is_ignored() {
        let src = "``````md\n`````tabs\ntab: Doc\nquoted\n`````\n``````\n";
        assert!(scan_tag_impl(src, "tabs").is_empty());
    }

    #[test]
    fn tilde_foreign_fence_hides_backtick_mica() {
        let src = "~~~\n```mica id=x\nquoted\n```\n~~~\n";
        assert!(scan_impl(src).is_empty());
    }
}

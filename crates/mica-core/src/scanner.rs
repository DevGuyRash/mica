//! Top-level block scanner: locates ` ```mica ` fenced blocks in a document,
//! honoring CommonMark fence rules so inner code fences never mislocate a
//! block's true end.
//!
//! This is the structural fix for the `obsidian-tabs` append bug: a block's end
//! is derived from the fence grammar at scan time, never guessed by counting
//! backticks nor cached as a line number.

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
}

/// Scan `src` for every top-level ` ```mica ` block, in document order.
///
/// Only the outermost blocks are returned; nested structure (colon-fence
/// directives, inner code fences, nested mica blocks) is the CST parser's job.
pub fn scan_impl(src: &str) -> Vec<BlockSpan> {
    let mut blocks = Vec::new();
    let mut offset = 0usize;
    // While inside a block: (start, fence_char, fence_len, content_start).
    let mut open: Option<(usize, u8, usize, usize)> = None;

    for line in src.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();

        // Inspect the line without its trailing newline (handling CRLF).
        let text = line.strip_suffix('\n').unwrap_or(line);
        let text = text.strip_suffix('\r').unwrap_or(text);

        match open {
            None => {
                if let Some((fence_char, fence_len)) = parse_open_fence(text) {
                    open = Some((line_start, fence_char, fence_len, offset));
                }
            }
            Some((start, fence_char, fence_len, content_start)) => {
                if is_close_fence(text, fence_char, fence_len) {
                    blocks.push(BlockSpan {
                        start,
                        end: offset,
                        fence_char,
                        fence_len,
                        content_start,
                        content_end: line_start,
                        closed: true,
                    });
                    open = None;
                }
            }
        }
    }

    // An unterminated block closes at EOF.
    if let Some((start, fence_char, fence_len, content_start)) = open {
        blocks.push(BlockSpan {
            start,
            end: offset,
            fence_char,
            fence_len,
            content_start,
            content_end: offset,
            closed: false,
        });
    }

    blocks
}

/// If `text` opens a ` ```mica ` fence, return its `(fence_char, fence_len)`.
///
/// CommonMark: up to three leading spaces, then a run of >= 3 of `` ` `` or `~`,
/// then an info string whose first token is `mica`. Backtick fences may not
/// carry a backtick in the info string.
fn parse_open_fence(text: &str) -> Option<(u8, usize)> {
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
    if info.split_whitespace().next()? != MICA_TAG {
        return None;
    }
    Some((fence_char, fence_len))
}

/// Whether `text` is a closing fence for a block of `fence_char` x `fence_len`:
/// up to three leading spaces, a run of >= `fence_len` of the same char, then
/// only trailing whitespace.
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
        let src = "~~~mica\nx\n~~~\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].fence_char, b'~');
    }

    #[test]
    fn header_attributes_are_accepted() {
        let src = "```mica id=0192-7c name=\"X\"\nbody\n```\n";
        assert_eq!(scan_impl(src).len(), 1);
    }

    #[test]
    fn non_mica_fences_are_ignored() {
        assert!(scan_impl("```js\ncode\n```\n").is_empty());
        assert!(scan_impl("```\nplain\n```\n").is_empty());
    }

    #[test]
    fn two_blocks() {
        let src = "```mica\na\n```\n\n```mica\nb\n```\n";
        assert_eq!(scan_impl(src).len(), 2);
    }

    #[test]
    fn unterminated_block_closes_at_eof() {
        let src = "```mica\nno close here\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert!(!b[0].closed);
        assert_eq!(b[0].content_end, src.len());
    }

    #[test]
    fn crlf_lines() {
        let src = "```mica\r\nhi\r\n```\r\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert!(b[0].closed);
    }

    #[test]
    fn equal_length_inner_fence_closes_early_as_commonmark_dictates() {
        // A 3-backtick inner fence inside a 3-backtick block is ambiguous; the
        // scanner follows CommonMark and treats the first one as the close.
        // The serializer's fence-normalization rule prevents Mica ever writing
        // this shape, but reads must stay predictable.
        let src = "```mica\n```\n";
        let b = scan_impl(src);
        assert_eq!(b.len(), 1);
        assert_eq!(&src[b[0].content_start..b[0].content_end], "");
        assert!(b[0].closed);
    }
}

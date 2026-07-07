//! Small shared helpers.

/// Number of UTF-16 code units in `s` — CodeMirror / JS string-length semantics.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

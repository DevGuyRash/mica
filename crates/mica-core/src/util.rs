//! Small shared helpers.

/// Number of UTF-16 code units in `s` — CodeMirror / JS string-length semantics.
///
/// Classifies raw UTF-8 bytes instead of decoding chars: every non-continuation
/// byte starts a char (1 unit), and a 4-byte lead (`>= 0xF0`) marks an astral
/// char, which takes a surrogate pair (1 extra unit). `&str` guarantees valid
/// UTF-8, so this equals the per-char `len_utf16()` sum.
pub fn utf16_len(s: &str) -> usize {
    s.bytes()
        .map(|b| usize::from(b & 0xC0 != 0x80) + usize::from(b >= 0xF0))
        .sum()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn utf16_len_matches_the_char_by_char_reference() {
        // Pins JS string-length semantics: BMP chars count 1, astral chars
        // (4-byte UTF-8, e.g. emoji) count 2 (surrogate pair).
        let cases = [
            "",
            "plain ascii",
            "caf\u{e9} \u{2615}",       // 2- and 3-byte sequences
            "\u{1F600}\u{1F680}",       // two astral chars -> 4 units
            "a\u{1F600}b\u{2588}c\r\n", // mixed with CRLF
            "\u{1D11E} music \u{1F3B6} \u{2713}",
        ];
        for s in cases {
            let reference: usize = s.chars().map(char::len_utf16).sum();
            assert_eq!(utf16_len(s), reference, "{s:?}");
        }
    }
}

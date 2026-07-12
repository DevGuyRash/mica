//! Diff engine, backed by `similar`: char / word / line granularity with
//! intra-line emphasis, grouped hunks, and unified-diff patches. Pure
//! computation — the TypeScript side renders the returned hunks. N-way compare
//! is N pairwise diffs against a user-selectable base, assembled in TS.

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

/// A run within a changed line: `same` text or `emph` (the actual changed span).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Span {
    /// `same` or `emph`.
    pub tag: String,
    /// The run's text.
    pub text: String,
}

/// One change: an `equal`, `delete`, or `insert`, with intra-line emphasis.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DiffChange {
    /// `equal`, `delete`, or `insert`.
    pub tag: String,
    /// The changed text (one line at line granularity).
    pub value: String,
    /// Intra-line emphasis runs (empty for `equal` changes).
    pub inline: Vec<Span>,
}

/// A context-bounded group of changes.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Hunk {
    /// The hunk's changes, in document order.
    pub changes: Vec<DiffChange>,
}

/// The result of a pairwise diff.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DiffResult {
    /// Context-bounded change groups.
    pub hunks: Vec<Hunk>,
    /// 0.0–1.0 similarity ratio between the inputs.
    pub similarity: f64,
}

/// Diff `base` vs `other` at the given granularity (`line` | `word` | `char`),
/// grouping changes into hunks with `context` lines of surrounding equality.
pub fn diff_impl(base: &str, other: &str, granularity: &str, context: usize) -> DiffResult {
    let diff = match granularity {
        "char" => TextDiff::from_chars(base, other),
        "word" => TextDiff::from_words(base, other),
        _ => TextDiff::from_lines(base, other),
    };
    let similarity = f64::from(diff.ratio());
    let mut hunks = Vec::new();
    for group in diff.grouped_ops(context) {
        let mut changes = Vec::new();
        for op in &group {
            for change in diff.iter_inline_changes(op) {
                let tag = match change.tag() {
                    ChangeTag::Equal => "equal",
                    ChangeTag::Delete => "delete",
                    ChangeTag::Insert => "insert",
                };
                let mut value = String::new();
                let mut inline = Vec::new();
                for (emph, s) in change.iter_strings_lossy() {
                    value.push_str(&s);
                    inline.push(Span {
                        tag: if emph { "emph" } else { "same" }.into(),
                        text: s.into_owned(),
                    });
                }
                changes.push(DiffChange {
                    tag: tag.into(),
                    value,
                    inline,
                });
            }
        }
        hunks.push(Hunk { changes });
    }
    DiffResult { hunks, similarity }
}

/// A unified-diff patch (line granularity) with `context` lines of context.
pub fn make_patch_impl(base: &str, other: &str, context: usize) -> String {
    TextDiff::from_lines(base, other)
        .unified_diff()
        .context_radius(context)
        .header("base", "other")
        .to_string()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    fn tags(d: &DiffResult) -> Vec<String> {
        d.hunks
            .iter()
            .flat_map(|h| h.changes.iter().map(|c| c.tag.clone()))
            .collect()
    }

    #[test]
    fn detects_equal_delete_insert() {
        let d = diff_impl("a\nb\n", "a\nc\n", "line", 3);
        let t = tags(&d);
        assert!(t.contains(&"equal".into()));
        assert!(t.contains(&"delete".into()));
        assert!(t.contains(&"insert".into()));
        assert!(d.similarity > 0.0 && d.similarity < 1.0);
    }

    #[test]
    fn identical_inputs_are_all_equal() {
        let d = diff_impl("x\ny\n", "x\ny\n", "line", 3);
        assert_eq!(d.similarity, 1.0);
        assert!(d
            .hunks
            .iter()
            .all(|h| h.changes.iter().all(|c| c.tag == "equal")));
    }

    #[test]
    fn inline_emphasis_marks_the_changed_span() {
        let d = diff_impl("hello world\n", "hello there\n", "line", 3);
        let has_emph = d
            .hunks
            .iter()
            .flat_map(|h| &h.changes)
            .any(|c| c.inline.iter().any(|s| s.tag == "emph"));
        assert!(has_emph, "changed line should carry emphasized spans");
    }

    #[test]
    fn make_patch_is_unified() {
        let p = make_patch_impl("a\nb\n", "a\nc\n", 3);
        assert!(p.contains("@@"));
        assert!(p.contains("-b"));
        assert!(p.contains("+c"));
    }
}

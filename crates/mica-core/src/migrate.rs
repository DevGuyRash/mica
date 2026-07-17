//! Migration: convert legacy ```tabs blocks (obsidian-tabs) into ```mica blocks
//! with colon-fence directives, preserving each tab's body verbatim. The outer
//! fence is sized above any inner code fence. Extracted archive entries are
//! returned to the host, which persists them before snapshotting the new head.

use crate::new_id_impl;
use crate::scanner::scan_tag_impl;
use serde::Serialize;
use std::collections::HashSet;

/// A versioned artifact extracted from a legacy tab body: in this vault's
/// convention, each `[!success]-` / `[!bug]-` / `[!todo]-` callout wraps one
/// fenced payload and its title carries a `(Vx.y)` marker.
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct MigratedVersion {
    /// `V0.3`-style label parsed from the callout title, else the title itself.
    pub label: String,
    /// Lowercased callout type (for example `success`, `bug`, or `todo`).
    pub status: String,
    /// The dequoted payload (inner fence stripped when the body is one fence).
    pub content: String,
}

/// One converted legacy block and the history extracted from it.
#[derive(Serialize, Debug, PartialEq)]
pub struct MigratedBlock {
    /// The freshly minted block id.
    pub id: String,
    /// Display name (the first tab's title).
    pub name: Option<String>,
    /// Extracted historical versions, in document order (oldest intent first
    /// is the vault's own ordering; the migrated head is snapshotted last).
    pub versions: Vec<MigratedVersion>,
}

/// The outcome of migrating one document.
#[derive(Serialize, Debug, PartialEq)]
pub struct MigrationResult {
    /// The converted document (identical to the input when `changed` is false).
    pub doc: String,
    /// Per-block conversion details.
    pub blocks: Vec<MigratedBlock>,
    /// Whether anything was converted.
    pub changed: bool,
}

/// Convert every legacy ```tabs block in `doc` into a ```mica block.
///
/// Lossless by construction: content before the first `tab:` line is preserved
/// as a leading leaf, tab bodies are copied verbatim (blank lines, dividers and
/// all), and blocks containing Templater tokens (`<%`) are left untouched.
///
/// `callout_types` selects which callout types inside tab bodies are imported
/// as version history — a comma-separated list (e.g. `"success, bug, todo"`);
/// an EMPTY string imports every callout type.
pub fn migrate_tabs_impl(doc: &str, callout_types: &str) -> MigrationResult {
    let allowed: HashSet<String> = callout_types
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let spans = scan_tag_impl(doc, "tabs");
    if spans.is_empty() {
        return MigrationResult {
            doc: doc.to_string(),
            blocks: Vec::new(),
            changed: false,
        };
    }
    let mut blocks = Vec::new();
    let mut out = String::with_capacity(doc.len() + spans.len() * 48);
    let mut cursor = 0;
    for span in &spans {
        out.push_str(&doc[cursor..span.start]);
        let content = &doc[span.content_start..span.content_end];
        if content.contains("<%") {
            // Templater source: converting would freeze template tokens into a
            // real block. Leave the original bytes exactly as they were.
            out.push_str(&doc[span.start..span.end]);
        } else {
            let (mica, block) = convert(content, &allowed);
            blocks.push(block);
            out.push_str(&mica);
        }
        cursor = span.end;
    }
    out.push_str(&doc[cursor..]);
    let changed = !blocks.is_empty();
    MigrationResult {
        doc: out,
        blocks,
        changed,
    }
}

fn convert(content: &str, allowed_callouts: &HashSet<String>) -> (String, MigratedBlock) {
    let mut preamble = String::new();
    let mut tabs: Vec<(String, String)> = Vec::new();
    let mut name: Option<String> = None;
    let mut body = String::new();
    for line in content.split_inclusive('\n') {
        let text = line.strip_suffix('\n').unwrap_or(line);
        if let Some(rest) = text.strip_prefix("tab:") {
            if let Some(n) = name.take() {
                tabs.push((n, std::mem::take(&mut body)));
            }
            name = Some(rest.trim().to_string());
        } else if name.is_some() {
            body.push_str(line);
        } else {
            preamble.push_str(line); // verbatim content before the first tab:
        }
    }
    if let Some(n) = name.take() {
        tabs.push((n, body));
    }

    let id = new_id_impl();
    let block_name = tabs.first().map(|(name, _)| name).cloned();
    let versions = tabs
        .iter()
        .flat_map(|(_, b)| extract_versions(b, allowed_callouts))
        .collect();

    // Emit the friendly, closer-free `tab:` form — the obsidian-tabs feel.
    let mut inner = preamble;
    if !inner.is_empty() && !inner.ends_with('\n') {
        inner.push('\n');
    }
    for (n, b) in &tabs {
        inner.push_str("tab: ");
        inner.push_str(n);
        inner.push('\n');
        inner.push_str(b); // verbatim body — blank lines and dividers preserved
        if !b.is_empty() && !b.ends_with('\n') {
            inner.push('\n');
        }
    }

    let run = max_fence_run(&inner);
    let fence = "`".repeat(if run == 0 { 3 } else { run + 1 });
    (
        format!("{fence}mica id={id}\n{inner}{fence}\n"),
        MigratedBlock {
            id,
            name: block_name,
            versions,
        },
    )
}

/// Extract versioned callouts from a legacy tab body. Recognizes top-level
/// `> [!type]±  Title (Vx.y)` callouts whose type is in `allowed` (any type
/// when `allowed` is empty); the payload is the callout body dequoted, with a
/// single wrapping code fence stripped when present.
fn extract_versions(body: &str, allowed: &HashSet<String>) -> Vec<MigratedVersion> {
    let mut out = Vec::new();
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let Some((status, title)) = parse_callout_header(line) else {
            continue;
        };
        if !allowed.is_empty() && !allowed.contains(&status) {
            continue;
        }
        // Collect the quoted body, stopping at the NEXT callout header (which is
        // itself a quoted line, so it must be detected before dequoting).
        let mut quoted: Vec<String> = Vec::new();
        while let Some(next) = lines.peek() {
            if parse_callout_header(next).is_some() {
                break;
            }
            if let Some(dequoted) = dequote(next) {
                quoted.push(dequoted);
                lines.next();
            } else {
                break;
            }
        }
        out.push(MigratedVersion {
            label: parse_version_label(&title),
            status,
            content: strip_wrapping_fence(&quoted),
        });
    }
    out
}

/// `> [!type]- Title` → `(type, title)`.
fn parse_callout_header(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix('>')?.trim_start();
    let rest = rest.strip_prefix("[!")?;
    let close = rest.find(']')?;
    let status = rest[..close].trim().to_ascii_lowercase();
    let mut title = rest[close + 1..].trim_start();
    title = title.strip_prefix(['-', '+']).unwrap_or(title);
    Some((status, title.trim().to_string()))
}

/// Strip one level of `> ` quoting; `None` when the line is not quoted.
fn dequote(line: &str) -> Option<String> {
    let rest = line.strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest).to_string())
}

/// `Review Kernel (V1.0)` → `V1.0`; otherwise the whole (nonempty) title.
fn parse_version_label(title: &str) -> String {
    if let Some(open) = title.rfind("(V") {
        if let Some(len) = title[open + 1..].find(')') {
            let candidate = &title[open + 1..open + 1 + len];
            if candidate[1..]
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.')
                && candidate.len() > 1
            {
                return candidate.to_string();
            }
        }
    }
    if title.is_empty() {
        "imported".to_string()
    } else {
        title.to_string()
    }
}

/// When the dequoted body is exactly one fenced block, return its inside;
/// otherwise return the body joined as-is.
fn strip_wrapping_fence(lines: &[String]) -> String {
    if let (Some(first), Some(last)) = (
        lines.iter().position(|line| !line.trim().is_empty()),
        lines.iter().rposition(|line| !line.trim().is_empty()),
    ) {
        let open = lines[first].trim_start();
        let fc = open.as_bytes().first().copied();
        if let (Some(ch @ (b'`' | b'~')), true) = (fc, first != last) {
            let run = open.bytes().take_while(|&b| b == ch).count();
            let close = lines[last].trim_start();
            let close_run = close.bytes().take_while(|&b| b == ch).count();
            if run >= 3 && close_run >= run && close[close_run..].trim().is_empty() {
                return lines[first + 1..last].join("\n");
            }
        }
    }
    lines.join("\n")
}

fn max_fence_run(content: &str) -> usize {
    let mut max = 0;
    for line in content.lines() {
        let indent = line.len() - line.trim_start_matches(' ').len();
        if indent > 3 {
            continue;
        }
        let run = line[indent..].bytes().take_while(|&b| b == b'`').count();
        if run >= 3 {
            max = max.max(run);
        }
    }
    max
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;
    use crate::scanner::scan_impl;

    #[test]
    fn converts_tabs_to_mica() {
        let doc = "before\n```tabs\ntab: A\nhello\ntab: B\nworld\n```\nafter\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(r.changed);
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].name.as_deref(), Some("A"));
        assert_eq!(scan_impl(&r.doc).len(), 1);
        assert!(r.doc.contains("tab: A"));
        assert!(r.doc.contains("tab: B"));
        assert!(
            !r.doc.contains(":::"),
            "friendly output uses no colon fences"
        );
        assert!(r.doc.contains("hello") && r.doc.contains("world"));
        assert!(r.doc.starts_with("before\n"));
        assert!(r.doc.trim_end().ends_with("after"));
    }

    #[test]
    fn sizes_fence_above_inner_code() {
        // Realistic: a 5-backtick tabs block with an inner 3-backtick code sample.
        let doc = "`````tabs\ntab: A\n```js\nx\n```\n`````\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(
            r.doc.contains("````mica"),
            "mica fence must out-length inner code"
        );
        assert_eq!(scan_impl(&r.doc).len(), 1);
    }

    #[test]
    fn no_tabs_is_noop() {
        let r = migrate_tabs_impl("just text\n", "success, bug, todo");
        assert!(!r.changed);
        assert_eq!(r.doc, "just text\n");
    }

    #[test]
    fn preamble_before_first_tab_is_preserved() {
        let doc = "```tabs\nPREAMBLE KEEP ME\n\ntab: A\nbody\n```\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(r.changed);
        assert!(
            r.doc.contains("PREAMBLE KEEP ME"),
            "preamble must survive: {}",
            r.doc
        );
        // Preamble sits before the first tab, inside the mica block.
        let pre = r.doc.find("PREAMBLE").unwrap();
        let first_tab = r.doc.find("tab: A").unwrap();
        assert!(pre < first_tab);
    }

    #[test]
    fn tab_bodies_are_copied_verbatim_including_blank_runs() {
        let doc = "```tabs\ntab: A\nline\n\n\n%% divider %%\n\ntab: B\nx\n```\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(
            r.doc.contains("line\n\n\n%% divider %%\n\n"),
            "blank runs preserved: {}",
            r.doc
        );
    }

    #[test]
    fn templater_blocks_are_left_untouched() {
        let doc = "```tabs\ntab: <% tp.file.cursor() %>\nbody\n```\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(!r.changed);
        assert_eq!(r.doc, doc);
    }

    #[test]
    fn extracts_versioned_callouts_from_real_shape() {
        // Mirrors the vault's actual convention: callout title carries (Vx.y),
        // body is a quoted 4-backtick fenced payload.
        let doc = concat!(
            "`````tabs\n",
            "tab: Kernel\n",
            "> [!success]- Review Kernel (V1.0)\n",
            "> ````md\n",
            "> KERNEL LINE ONE\n",
            "> KERNEL LINE TWO\n",
            "> ````\n",
            "\n",
            "tab: Frame Gate\n",
            "> [!bug]- Frame Gate (V0.3)\n",
            "> ````md\n",
            "> OLD FRAME BODY\n",
            "> ````\n",
            "`````\n",
        );
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert_eq!(r.blocks.len(), 1);
        let vs = &r.blocks[0].versions;
        assert_eq!(vs.len(), 2, "one version per callout: {vs:?}");
        assert_eq!(vs[0].label, "V1.0");
        assert_eq!(vs[0].status, "success");
        assert_eq!(vs[0].content, "KERNEL LINE ONE\nKERNEL LINE TWO");
        assert_eq!(vs[1].label, "V0.3");
        assert_eq!(vs[1].status, "bug");
        assert_eq!(vs[1].content, "OLD FRAME BODY");
    }

    #[test]
    fn non_version_callouts_are_not_extracted() {
        let doc = "```tabs\ntab: A\n> [!example]- Sample Data\n> stuff\nbody\n```\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(r.blocks[0].versions.is_empty());
    }

    #[test]
    fn empty_allowlist_imports_any_callout_type() {
        let doc = "```tabs\ntab: A\n> [!example]- Custom (V2.1)\n> data body\n```\n";
        let r = migrate_tabs_impl(doc, "");
        let vs = &r.blocks[0].versions;
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].status, "example");
        assert_eq!(vs[0].label, "V2.1");
        assert_eq!(vs[0].content, "data body");
    }

    #[test]
    fn official_callout_list_covers_common_types() {
        let list = "note, info, tip, success, question, warning, danger, bug, example, quote";
        let doc = "```tabs\ntab: A\n> [!info]- Note (V1)\n> body one\n> [!quote]- Cite (V2)\n> body two\n```\n";
        let r = migrate_tabs_impl(doc, list);
        assert_eq!(r.blocks[0].versions.len(), 2);
        assert_eq!(r.blocks[0].versions[0].status, "info");
        assert_eq!(r.blocks[0].versions[1].status, "quote");
    }

    #[test]
    fn custom_allowlist_selects_types() {
        let doc = "```tabs\ntab: A\n> [!note]- One\n> a\n> [!bug]- Two\n> b\n```\n";
        // Only [!note] requested → [!bug] is ignored.
        let r = migrate_tabs_impl(doc, "note");
        let vs = &r.blocks[0].versions;
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].status, "note");
    }

    #[test]
    fn unfenced_callout_body_is_taken_verbatim() {
        let doc = "```tabs\ntab: A\n> [!todo]- Draft idea\n> plain line\n> another\n```\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        let vs = &r.blocks[0].versions;
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0].label, "Draft idea");
        assert_eq!(vs[0].content, "plain line\nanother");
    }

    #[test]
    fn quoted_tabs_examples_are_not_migrated() {
        // A tabs example inside a longer documentation fence stays untouched.
        let doc = "``````md\n`````tabs\ntab: Doc\nquoted\n`````\n``````\n";
        let r = migrate_tabs_impl(doc, "success, bug, todo");
        assert!(!r.changed);
        assert_eq!(r.doc, doc);
    }
}

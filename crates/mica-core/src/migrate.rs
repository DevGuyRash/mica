//! Migration: convert legacy ```tabs blocks (obsidian-tabs) into ```mica blocks
//! with colon-fence directives, preserving each tab's body verbatim. The outer
//! fence is sized above any inner code fence. Archive-as-history import is
//! layered on by the plugin (it snapshots the migrated blocks afterward).

use crate::new_id_impl;
use crate::scanner::scan_tag_impl;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct MigratedBlock {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct MigrationResult {
    pub doc: String,
    pub blocks: Vec<MigratedBlock>,
    pub changed: bool,
}

/// Convert every legacy ```tabs block in `doc` into a ```mica block.
///
/// Lossless by construction: content before the first `tab:` line is preserved
/// as a leading leaf, tab bodies are copied verbatim (blank lines, dividers and
/// all), and blocks containing Templater tokens (`<%`) are left untouched.
pub fn migrate_tabs_impl(doc: &str) -> MigrationResult {
    let spans = scan_tag_impl(doc, "tabs");
    if spans.is_empty() {
        return MigrationResult { doc: doc.to_string(), blocks: Vec::new(), changed: false };
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
            let (mica, block) = convert(content);
            blocks.push(block);
            out.push_str(&mica);
        }
        cursor = span.end;
    }
    out.push_str(&doc[cursor..]);
    let changed = !blocks.is_empty();
    MigrationResult { doc: out, blocks, changed }
}

fn convert(content: &str) -> (String, MigratedBlock) {
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
    let block_name = tabs.first().map(|(n, _)| n.clone());

    let mut inner = preamble;
    if !inner.is_empty() && !inner.ends_with('\n') {
        inner.push('\n');
    }
    inner.push_str(":::tabs\n");
    for (n, b) in &tabs {
        inner.push_str(":::tab ");
        inner.push_str(n);
        inner.push('\n');
        inner.push_str(b); // verbatim body — blank lines and dividers preserved
        if !b.is_empty() && !b.ends_with('\n') {
            inner.push('\n');
        }
        inner.push_str(":::\n");
    }
    inner.push_str(":::\n");

    let run = max_fence_run(&inner);
    let fence = "`".repeat(if run == 0 { 3 } else { run + 1 });
    (format!("{fence}mica id={id}\n{inner}{fence}\n"), MigratedBlock { id, name: block_name })
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
    use super::*;
    use crate::scanner::scan_impl;

    #[test]
    fn converts_tabs_to_mica() {
        let doc = "before\n```tabs\ntab: A\nhello\ntab: B\nworld\n```\nafter\n";
        let r = migrate_tabs_impl(doc);
        assert!(r.changed);
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].name.as_deref(), Some("A"));
        assert_eq!(scan_impl(&r.doc).len(), 1);
        assert!(r.doc.contains(":::tabs"));
        assert!(r.doc.contains(":::tab A"));
        assert!(r.doc.contains(":::tab B"));
        assert!(r.doc.contains("hello") && r.doc.contains("world"));
        assert!(r.doc.starts_with("before\n"));
        assert!(r.doc.trim_end().ends_with("after"));
    }

    #[test]
    fn sizes_fence_above_inner_code() {
        // Realistic: a 5-backtick tabs block with an inner 3-backtick code sample.
        let doc = "`````tabs\ntab: A\n```js\nx\n```\n`````\n";
        let r = migrate_tabs_impl(doc);
        assert!(r.doc.contains("````mica"), "mica fence must out-length inner code");
        assert_eq!(scan_impl(&r.doc).len(), 1);
    }

    #[test]
    fn no_tabs_is_noop() {
        let r = migrate_tabs_impl("just text\n");
        assert!(!r.changed);
        assert_eq!(r.doc, "just text\n");
    }

    #[test]
    fn preamble_before_first_tab_is_preserved() {
        let doc = "```tabs\nPREAMBLE KEEP ME\n\ntab: A\nbody\n```\n";
        let r = migrate_tabs_impl(doc);
        assert!(r.changed);
        assert!(r.doc.contains("PREAMBLE KEEP ME"), "preamble must survive: {}", r.doc);
        // Preamble sits before the tabs container, inside the mica block.
        let pre = r.doc.find("PREAMBLE").unwrap();
        let tabs = r.doc.find(":::tabs").unwrap();
        assert!(pre < tabs);
    }

    #[test]
    fn tab_bodies_are_copied_verbatim_including_blank_runs() {
        let doc = "```tabs\ntab: A\nline\n\n\n%% divider %%\n\ntab: B\nx\n```\n";
        let r = migrate_tabs_impl(doc);
        assert!(r.doc.contains("line\n\n\n%% divider %%\n\n:::"), "blank runs preserved: {}", r.doc);
    }

    #[test]
    fn templater_blocks_are_left_untouched() {
        let doc = "```tabs\ntab: <% tp.file.cursor() %>\nbody\n```\n";
        let r = migrate_tabs_impl(doc);
        assert!(!r.changed);
        assert_eq!(r.doc, doc);
    }

    #[test]
    fn quoted_tabs_examples_are_not_migrated() {
        // A tabs example inside a longer documentation fence stays untouched.
        let doc = "``````md\n`````tabs\ntab: Doc\nquoted\n`````\n``````\n";
        let r = migrate_tabs_impl(doc);
        assert!(!r.changed);
        assert_eq!(r.doc, doc);
    }
}

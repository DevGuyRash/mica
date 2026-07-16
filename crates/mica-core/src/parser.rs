//! Block CST parser + serializer.
//!
//! Parses the content *inside* a ` ```mica ` block into a tree of colon-fence
//! directives (`:::tabs`, `:::tab`, `:::grid`, `:::cell`, …) and opaque leaves
//! (markdown, code blocks). Structure is exposed for rendering/editing; every
//! node also stores its exact source bytes, so `serialize(parse(x)) == x`
//! byte-for-byte when nothing is edited.
//!
//! Nesting uses colon count, mirroring the CommonMark fence rule: a `::::`
//! container may hold `:::` containers. Colons inside a code block are inert.

use serde::{Deserialize, Serialize};

/// Parsed content of one block: an ordered list of top-level nodes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Cst {
    /// Top-level nodes in document order.
    pub children: Vec<Node>,
}

/// A CST node. `Container` is a colon-fence directive; `Leaf` is opaque content
/// (markdown or a fenced code block) handed verbatim to Obsidian's renderer.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    /// A colon-fence directive (`:::tabs`, `:::tab`, `:::grid`, `:::cell`, …)
    /// or a synthetic friendly-form tabs/tab wrapper.
    Container {
        /// Directive name: `tabs`, `tab`, `grid`, `cell`, …
        name: String,
        /// Everything after the name on the opening line (title and/or `{attrs}`).
        title: String,
        /// Number of colons in the opening fence (for normalization/nesting).
        colons: usize,
        /// Exact opening line, including its trailing newline.
        open_line: String,
        /// Child nodes in source order.
        children: Vec<Node>,
        /// Exact closing line (incl. newline), or empty if unterminated.
        close_line: String,
    },
    /// Opaque content handed verbatim to the markdown renderer.
    Leaf {
        /// Exact source text, including newlines.
        text: String,
        /// Whether this leaf is a fenced code block (vs. prose/callout markdown).
        is_code: bool,
    },
}

/// Parse block content into a [`Cst`].
pub fn parse_block_impl(content: &str) -> Cst {
    let src = Src::new(content);
    let mut pos = 0;
    let (children, _stop) = parse_children(&src, &mut pos, None, false, false);
    Cst { children }
}

/// The source text plus a line-start offset table: line `i` spans
/// `starts[i]..starts[i + 1]` (newline included). Because every leaf — a prose
/// run, a code fence, a callout — is a CONTIGUOUS span of the source, its text
/// is built with one exact-size copy of `slice(a, b)` instead of per-line
/// `push_str` accumulation.
struct Src<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Src<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = Vec::with_capacity(text.len() / 32 + 2);
        starts.push(0);
        // match_indices uses std's SIMD-accelerated byte search.
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        if starts.last() != Some(&text.len()) {
            starts.push(text.len()); // final line without a trailing newline
        }
        Self { text, starts }
    }

    /// Number of lines.
    fn line_count(&self) -> usize {
        self.starts.len() - 1
    }

    /// Line `i`, including its newline (when present).
    fn line(&self, i: usize) -> &'a str {
        &self.text[self.starts[i]..self.starts[i + 1]]
    }

    /// The exact source of lines `a..b`.
    fn slice(&self, a: usize, b: usize) -> &'a str {
        &self.text[self.starts[a]..self.starts[b]]
    }
}

/// Serialize a [`Cst`] back to source. Concatenates the exact stored strings,
/// guaranteeing a byte-exact round-trip for unedited trees.
pub fn serialize_impl(cst: &Cst) -> String {
    serialize_nodes(&cst.children)
}

/// Serialize a slice of nodes (also used by the ops reducer). Preallocates the
/// exact output length (a cheap walk) so the buffer never reallocates.
pub(crate) fn serialize_nodes(nodes: &[Node]) -> String {
    let mut out = String::with_capacity(nodes.iter().map(node_len).sum());
    for node in nodes {
        write_node(node, &mut out);
    }
    out
}

/// Exact serialized length of one node, for preallocation.
fn node_len(node: &Node) -> usize {
    match node {
        Node::Leaf { text, .. } => text.len(),
        Node::Container {
            open_line,
            children,
            close_line,
            ..
        } => open_line.len() + children.iter().map(node_len).sum::<usize>() + close_line.len(),
    }
}

fn write_node(node: &Node, out: &mut String) {
    match node {
        Node::Leaf { text, .. } => out.push_str(text),
        Node::Container {
            open_line,
            children,
            close_line,
            ..
        } => {
            out.push_str(open_line);
            for child in children {
                write_node(child, out);
            }
            out.push_str(close_line);
        }
    }
}

/// Why [`parse_children`] stopped.
enum Stop {
    /// Input exhausted.
    Eof,
    /// A `:::` closer for the current container was consumed (its exact line).
    Closed(String),
    /// A `tab:` delimiter is next (not consumed) — only while parsing a tab body.
    NextTab,
    /// A `:::` closer for an ANCESTOR is next (not consumed) — only in a tab body.
    AncestorClose,
}

/// Parse children until the current scope ends. Handles two tab syntaxes:
/// the friendly, closer-free `tab: Title` delimiters (which auto-close at the
/// next `tab:`, an enclosing `:::`, or end of block) and the explicit `:::`
/// colon-fence directives used for nesting. Code fences are opaque.
fn parse_children(
    src: &Src<'_>,
    pos: &mut usize,
    close_colons: Option<usize>,
    in_tab_body: bool,
    in_tabs_group: bool,
) -> (Vec<Node>, Stop) {
    let mut children = Vec::new();
    // First line of the currently open prose run, if any, and whether that
    // run is blank lines (spacing) or content (a paragraph).
    let mut md_start: Option<usize> = None;
    let mut md_blank = false;

    while *pos < src.line_count() {
        let line = src.line(*pos);
        let text = trim_eol(line);

        // 1. A closing fence for the current (or, in a tab body, an ancestor) container?
        if let Some(cc) = close_colons {
            if let Some(n) = colon_close_len(text) {
                if n >= cc {
                    flush_md(&mut children, src, &mut md_start, *pos);
                    if in_tab_body {
                        return (children, Stop::AncestorClose); // belongs to an ancestor
                    }
                    *pos += 1;
                    return (children, Stop::Closed(line.to_string()));
                }
            }
        }

        // 2. A `tab:` delimiter — the friendly, closer-free tab syntax.
        if tab_delim(text).is_some() {
            flush_md(&mut children, src, &mut md_start, *pos);
            if in_tab_body {
                return (children, Stop::NextTab); // end this tab; leave the delimiter
            }
            // Inside an explicit `:::tabs`, delimiters ARE the group's tabs —
            // wrapping them in a second tabs group hides them from renderers.
            if in_tabs_group {
                children.extend(collect_delim_tab_nodes(src, pos, close_colons));
            } else {
                children.push(collect_delim_tabs(src, pos, close_colons));
            }
            continue;
        }

        // 3. A colon-fence directive opens a nested container (explicit nesting).
        if let Some((colons, name, title)) = colon_open(text) {
            flush_md(&mut children, src, &mut md_start, *pos);
            let open_line = line.to_string();
            *pos += 1;
            let (kids, stop) = parse_children(src, pos, Some(colons), false, name == "tabs");
            let close_line = if let Stop::Closed(l) = stop {
                l
            } else {
                String::new()
            };
            children.push(Node::Container {
                name,
                title,
                colons,
                open_line,
                children: kids,
                close_line,
            });
            continue;
        }

        // 4. A code fence opens an opaque code leaf (colons/tabs inside are inert).
        if let Some((fc, fl)) = code_open(text) {
            flush_md(&mut children, src, &mut md_start, *pos);
            let start = *pos;
            *pos += 1;
            while *pos < src.line_count() {
                let l = src.line(*pos);
                *pos += 1;
                if is_code_close(trim_eol(l), fc, fl) {
                    break;
                }
            }
            children.push(Node::Leaf {
                text: src.slice(start, *pos).to_string(),
                is_code: true,
            });
            continue;
        }

        // 5. A callout header (`> [!type]`) opens a self-contained callout
        //    leaf — like a code fence, it is a unit users move and edit whole.
        //    Quoted continuations stay inside; a NEW top-level callout header
        //    or any unquoted line ends it.
        if callout_open(text) {
            flush_md(&mut children, src, &mut md_start, *pos);
            let start = *pos;
            *pos += 1;
            while *pos < src.line_count() {
                let t = trim_eol(src.line(*pos));
                if !quoted_line(t) || callout_open(t) {
                    break;
                }
                *pos += 1;
            }
            children.push(Node::Leaf {
                text: src.slice(start, *pos).to_string(),
                is_code: false,
            });
            continue;
        }

        // 6. Ordinary markdown content — extend the open prose run. A
        //    blank⇄content transition ends the run: paragraphs and their
        //    spacing are separate leaves, so leaf granularity IS section
        //    granularity and ops can splice sections without their text
        //    gluing into a neighbour on the next re-parse.
        let blank = text.trim().is_empty();
        match md_start {
            Some(_) if md_blank != blank => {
                flush_md(&mut children, src, &mut md_start, *pos);
                md_start = Some(*pos);
                md_blank = blank;
            }
            None => {
                md_start = Some(*pos);
                md_blank = blank;
            }
            Some(_) => {}
        }
        *pos += 1;
    }

    flush_md(&mut children, src, &mut md_start, src.line_count());
    (children, Stop::Eof)
}

/// Collect a run of consecutive `tab:` sections into an implicit `tabs`
/// container. Each tab auto-closes at the next `tab:`, at an enclosing `:::`
/// closer, or at end of block — no closing fence required. The `tabs` group
/// and each `tab` are synthetic (empty open/close lines), so serialization
/// reproduces exactly the original `tab:` lines and bodies.
/// Consume consecutive `tab:` sections into bare `tab` containers.
fn collect_delim_tab_nodes(
    src: &Src<'_>,
    pos: &mut usize,
    close_colons: Option<usize>,
) -> Vec<Node> {
    let mut tabs = Vec::new();
    while *pos < src.line_count() {
        let line = src.line(*pos);
        let Some(name) = tab_delim(trim_eol(line)) else {
            break;
        };
        let open_line = line.to_string();
        *pos += 1;
        let (body, stop) = parse_children(src, pos, close_colons, true, false);
        tabs.push(Node::Container {
            name: "tab".to_string(),
            title: name.to_string(),
            colons: 0,
            open_line,
            children: body,
            close_line: String::new(),
        });
        if !matches!(stop, Stop::NextTab) {
            break; // Eof or an ancestor's closer ends the group
        }
    }
    tabs
}

/// Wrap a run of `tab:` sections in the implicit (friendly-form) tabs group.
fn collect_delim_tabs(src: &Src<'_>, pos: &mut usize, close_colons: Option<usize>) -> Node {
    Node::Container {
        name: "tabs".to_string(),
        title: String::new(),
        colons: 0,
        open_line: String::new(),
        children: collect_delim_tab_nodes(src, pos, close_colons),
        close_line: String::new(),
    }
}

/// `tab: Title` at column 0 → `Title` — the friendly, closer-free delimiter.
/// Borrows so a "is this a delimiter?" probe allocates nothing.
fn tab_delim(text: &str) -> Option<&str> {
    Some(text.strip_prefix("tab:")?.trim())
}

/// Close the open prose run (lines `md_start..end`) into one leaf.
fn flush_md(children: &mut Vec<Node>, src: &Src<'_>, md_start: &mut Option<usize>, end: usize) {
    if let Some(start) = md_start.take() {
        if end > start {
            children.push(Node::Leaf {
                text: src.slice(start, end).to_string(),
                is_code: false,
            });
        }
    }
}

fn trim_eol(line: &str) -> &str {
    let l = line.strip_suffix('\n').unwrap_or(line);
    l.strip_suffix('\r').unwrap_or(l)
}

fn leading_spaces(text: &str) -> usize {
    text.len() - text.trim_start_matches(' ').len()
}

/// `:::name title` → `(colons, name, title)`. Requires a name (a bare `:::` is a
/// close, not an open).
fn colon_open(text: &str) -> Option<(usize, String, String)> {
    let indent = leading_spaces(text);
    if indent > 3 {
        return None;
    }
    let rest = &text[indent..];
    let colons = rest.bytes().take_while(|&b| b == b':').count();
    if colons < 3 {
        return None;
    }
    let after = rest[colons..].trim_start();
    let name: String = after
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if name.is_empty() {
        return None;
    }
    let title = after[name.len()..].trim().to_string();
    Some((colons, name, title))
}

/// A bare closing fence `:::` (>= 3 colons, only whitespace after) → its length.
fn colon_close_len(text: &str) -> Option<usize> {
    let indent = leading_spaces(text);
    if indent > 3 {
        return None;
    }
    let rest = &text[indent..];
    let colons = rest.bytes().take_while(|&b| b == b':').count();
    if colons >= 3 && rest[colons..].trim().is_empty() {
        Some(colons)
    } else {
        None
    }
}

fn code_open(text: &str) -> Option<(u8, usize)> {
    let indent = leading_spaces(text);
    if indent > 3 {
        return None;
    }
    let rest = &text[indent..];
    let fc = rest.as_bytes().first().copied()?;
    if fc != b'`' && fc != b'~' {
        return None;
    }
    let fl = rest.bytes().take_while(|&b| b == fc).count();
    if fl < 3 {
        return None;
    }
    Some((fc, fl))
}

/// An Obsidian/Admonition callout header: `> [!type] optional title`.
/// A nested `> > [!type]` does NOT match — it belongs to its parent callout.
fn callout_open(text: &str) -> bool {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix('>') else {
        return false;
    };
    rest.trim_start().starts_with("[!")
}

/// Any blockquote-continuation line (`>`-prefixed).
fn quoted_line(text: &str) -> bool {
    text.trim_start().starts_with('>')
}

fn is_code_close(text: &str, fence_char: u8, fence_len: usize) -> bool {
    let indent = leading_spaces(text);
    if indent > 3 {
        return false;
    }
    let rest = &text[indent..];
    let run = rest.bytes().take_while(|&b| b == fence_char).count();
    run >= fence_len && rest[run..].trim().is_empty()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    fn roundtrips(src: &str) {
        assert_eq!(
            serialize_impl(&parse_block_impl(src)),
            src,
            "round-trip mismatch"
        );
    }

    #[test]
    fn roundtrip_markdown_only() {
        roundtrips("just some **markdown**\n\nwith a blank line\n");
    }

    #[test]
    fn roundtrip_empty_and_crlf() {
        roundtrips("");
        roundtrips("tab: A\r\nbody line\r\n\r\ntab: B\r\nmore\r\n");
        roundtrips(":::tabs\r\n:::tab X\r\nhi\r\n:::\r\n:::\r\n");
    }

    #[test]
    fn roundtrip_simple_tabs() {
        roundtrips("::::tabs\n:::tab Kernel\nbody text\n:::\n:::tab Frame Gate\nmore\n:::\n::::\n");
    }

    #[test]
    fn roundtrip_with_code_and_callout() {
        // Callouts are just markdown; a code sample is an opaque leaf.
        roundtrips(":::tab A\n> [!note] hi\n\n```js\nconst x = 1;\n```\n:::\n");
    }

    #[test]
    fn roundtrip_no_trailing_newline() {
        roundtrips(":::tab A\nno newline at end:::not-a-fence");
    }

    #[test]
    fn parses_structure() {
        let cst = parse_block_impl("::::tabs\n:::tab Kernel\nhi\n:::\n::::\n");
        assert_eq!(cst.children.len(), 1);
        match &cst.children[0] {
            Node::Container {
                name,
                colons,
                children,
                ..
            } => {
                assert_eq!(name, "tabs");
                assert_eq!(*colons, 4);
                assert_eq!(children.len(), 1);
                match &children[0] {
                    Node::Container {
                        name,
                        title,
                        children,
                        ..
                    } => {
                        assert_eq!(name, "tab");
                        assert_eq!(title, "Kernel");
                        assert_eq!(children.len(), 1);
                        assert!(matches!(&children[0], Node::Leaf { is_code: false, .. }));
                    }
                    _ => panic!("expected tab container"),
                }
            }
            _ => panic!("expected tabs container"),
        }
    }

    #[test]
    fn grid_attrs_are_kept_in_title() {
        let cst = parse_block_impl(":::grid {cols=3 gap=8}\n:::cell\nx\n:::\n:::\n");
        match &cst.children[0] {
            Node::Container { name, title, .. } => {
                assert_eq!(name, "grid");
                assert_eq!(title, "{cols=3 gap=8}");
            }
            _ => panic!("expected grid"),
        }
    }

    #[test]
    fn friendly_tab_delimiters_need_no_closers() {
        let src = "tab: Kernel\nkernel body\n\ntab: Frame Gate\nframe body\n";
        roundtrips(src);
        let cst = parse_block_impl(src);
        assert_eq!(cst.children.len(), 1);
        let tabs = as_container(&cst.children[0], "tabs");
        assert_eq!(tab_titles(tabs), vec!["Kernel", "Frame Gate"]);
    }

    #[test]
    fn content_before_first_tab_delimiter_is_a_leaf() {
        let src = "intro paragraph\n\ntab: A\nbody a\n";
        roundtrips(src);
        let cst = parse_block_impl(src);
        assert!(matches!(&cst.children[0], Node::Leaf { .. }));
        // children[1] is the spacing leaf; the tabs group follows it.
        assert_eq!(
            tab_titles(as_container(&cst.children[2], "tabs")),
            vec!["A"]
        );
    }

    #[test]
    fn tab_delimiter_body_can_hold_a_nested_directive_group() {
        // Friendly outer tabs; explicit :::tabs only where nesting is needed.
        let src = "tab: Outer\n:::tabs\n:::tab Inner\ndeep\n:::\n:::\n";
        roundtrips(src);
        let cst = parse_block_impl(src);
        let tabs = as_container(&cst.children[0], "tabs");
        let outer = tabs
            .iter()
            .find_map(|n| match n {
                Node::Container { name, children, .. } if name == "tab" => {
                    Some(children.as_slice())
                }
                _ => None,
            })
            .expect("outer tab");
        assert_eq!(tab_titles(find(outer, "tabs")), vec!["Inner"]);
    }

    #[test]
    fn tab_colon_not_matched_when_indented_or_different_word() {
        // Only `tab:` at column 0 is a delimiter — not "tabs:" nor indented text.
        let src = "tabs: not a delimiter\n  tab: indented\n";
        let cst = parse_block_impl(src);
        assert!(cst.children.iter().all(|n| matches!(n, Node::Leaf { .. })));
        roundtrips(src);
    }

    #[test]
    fn deeply_nested_grid_of_tabs_within_tabs() {
        // grid > cell > tabs > [tab A, tab B]; tab B > tabs > [tab B1, tab B2].
        let src = concat!(
            ":::grid\n",
            ":::cell\n",
            ":::tabs\n",
            ":::tab A\n",
            "outer A\n",
            ":::\n",
            ":::tab B\n",
            ":::tabs\n",
            ":::tab B1\n",
            "deep b1\n",
            ":::\n",
            ":::tab B2\n",
            "deep b2\n",
            ":::\n",
            ":::\n", // close inner tabs
            ":::\n", // close tab B
            ":::\n", // close outer tabs
            ":::\n", // close cell
            ":::\n", // close grid
        );
        // 1. Byte-exact round-trip regardless of depth.
        roundtrips(src);

        // 2. The structure parses to the expected tree.
        let cst = parse_block_impl(src);
        let grid = as_container(&cst.children[0], "grid");
        let cell = find(grid, "cell");
        let tabs = find(cell, "tabs");
        assert_eq!(tab_titles(tabs), vec!["A", "B"]);

        // 3. Tab B contains a nested tabs group with B1/B2.
        let tab_b = tabs
            .iter()
            .find_map(|n| match n {
                Node::Container {
                    name,
                    title,
                    children,
                    ..
                } if name == "tab" && title == "B" => Some(children.as_slice()),
                _ => None,
            })
            .expect("tab B");
        let inner = find(tab_b, "tabs");
        assert_eq!(tab_titles(inner), vec!["B1", "B2"]);
    }

    // Helpers for the nesting test.
    fn as_container<'a>(node: &'a Node, name: &str) -> &'a [Node] {
        match node {
            Node::Container {
                name: n, children, ..
            } if n == name => children,
            other => panic!("expected {name} container, got {other:?}"),
        }
    }
    fn find<'a>(children: &'a [Node], name: &str) -> &'a [Node] {
        children
            .iter()
            .find_map(|n| match n {
                Node::Container {
                    name: cn, children, ..
                } if cn == name => Some(children.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no {name} child"))
    }
    fn tab_titles(children: &[Node]) -> Vec<&str> {
        children
            .iter()
            .filter_map(|n| match n {
                Node::Container { name, title, .. } if name == "tab" => Some(title.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn code_fence_hides_colon_directives() {
        // A `:::tab` inside a code block must NOT become a container.
        let cst = parse_block_impl("```md\n:::tab Nope\n```\n");
        assert_eq!(cst.children.len(), 1);
        assert!(matches!(&cst.children[0], Node::Leaf { is_code: true, .. }));
    }

    #[test]
    fn friendly_tabs_inside_directive_tabs_are_direct_children() {
        // `tab:` delimiters inside an explicit `:::tabs` must NOT wrap
        // themselves in a second tabs group — the double wrap rendered as
        // silently invisible content (renderers list direct `tab` children).
        let src = ":::tabs\ntab: Alpha\nbody\n:::\n";
        let cst = parse_block_impl(src);
        let Node::Container { name, children, .. } = &cst.children[0] else {
            panic!("expected tabs container")
        };
        assert_eq!(name, "tabs");
        assert!(
            matches!(&children[0], Node::Container { name, .. } if name == "tab"),
            "tab must be a DIRECT child: {children:?}"
        );
        assert_eq!(serialize_impl(&cst), src);
    }

    #[test]
    fn callout_becomes_its_own_leaf() {
        // Callouts are self-contained blocks users drag and edit as units —
        // the parser gives them their own leaf, exactly like code fences.
        let cst = parse_block_impl("intro\n\n> [!note] Hi\n> body\n\nafter\n");
        let texts: Vec<&str> = cst
            .children
            .iter()
            .map(|n| match n {
                Node::Leaf { text, .. } => text.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(
            texts,
            vec!["intro\n", "\n", "> [!note] Hi\n> body\n", "\n", "after\n"]
        );
        assert_eq!(
            serialize_impl(&cst),
            "intro\n\n> [!note] Hi\n> body\n\nafter\n"
        );
    }

    #[test]
    fn adjacent_callouts_split_into_two_leaves() {
        let cst = parse_block_impl("> [!tip] One\n> [!warning] Two\n> more\n");
        assert_eq!(cst.children.len(), 2);
        let Node::Leaf { text, .. } = &cst.children[1] else {
            panic!("expected leaf")
        };
        assert_eq!(text, "> [!warning] Two\n> more\n");
    }

    #[test]
    fn quoted_fence_stays_inside_callout_and_nested_callout_is_continuation() {
        let src = "> [!note] Outer\n> ```\n> code\n> ```\n> > [!tip] Inner\n> tail\nout\n";
        let cst = parse_block_impl(src);
        assert_eq!(cst.children.len(), 2); // [callout leaf, "out" leaf]
        let Node::Leaf { text, is_code } = &cst.children[0] else {
            panic!("expected leaf")
        };
        assert!(!is_code);
        assert!(text.ends_with("> tail\n"));
        assert_eq!(serialize_impl(&cst), src);
    }

    #[test]
    fn plain_blockquote_stays_in_prose() {
        // Only `[!type]` callouts split — ordinary quotes are just markdown.
        let cst = parse_block_impl("a\n> quoted\nb\n");
        assert_eq!(cst.children.len(), 1);
    }

    #[test]
    fn roundtrip_real_note_content_if_present() {
        // A large real note round-trips byte-exact (no ::: directives — just
        // prose/callout/code leaves; this stresses fidelity on ~700 KB).
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/real-note.md");
        if let Ok(src) = std::fs::read_to_string(path) {
            assert_eq!(serialize_impl(&parse_block_impl(&src)), src);
        }
    }

    fn leaf_texts(src: &str) -> Vec<String> {
        parse_block_impl(src)
            .children
            .iter()
            .map(|n| match n {
                Node::Leaf { text, .. } => text.clone(),
                Node::Container { .. } => panic!("expected only leaves"),
            })
            .collect()
    }

    #[test]
    fn prose_splits_at_blank_lines() {
        // Paragraph granularity IS section granularity: a blank line ends the
        // prose leaf, so sections can move without text-gluing on re-parse.
        assert_eq!(
            leaf_texts("para one\n\npara two\n"),
            ["para one\n", "\n", "para two\n"]
        );
    }

    #[test]
    fn blank_runs_form_one_whitespace_leaf() {
        assert_eq!(leaf_texts("a\n\n\n \t\nb\n"), ["a\n", "\n\n \t\n", "b\n"]);
    }

    #[test]
    fn tight_lists_stay_one_leaf() {
        assert_eq!(leaf_texts("- one\n- two\n"), ["- one\n- two\n"]);
    }
}

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
    pub children: Vec<Node>,
}

/// A CST node. `Container` is a colon-fence directive; `Leaf` is opaque content
/// (markdown or a fenced code block) handed verbatim to Obsidian's renderer.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    Container {
        /// Directive name: `tabs`, `tab`, `grid`, `cell`, …
        name: String,
        /// Everything after the name on the opening line (title and/or `{attrs}`).
        title: String,
        /// Number of colons in the opening fence (for normalization/nesting).
        colons: usize,
        /// Exact opening line, including its trailing newline.
        open_line: String,
        children: Vec<Node>,
        /// Exact closing line (incl. newline), or empty if unterminated.
        close_line: String,
    },
    Leaf {
        /// Exact source text, including newlines.
        text: String,
        /// Whether this leaf is a fenced code block (vs. prose/callout markdown).
        is_code: bool,
    },
}

/// Parse block content into a [`Cst`].
pub fn parse_block_impl(content: &str) -> Cst {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let mut pos = 0;
    let (children, _close) = parse_children(&lines, &mut pos, None);
    Cst { children }
}

/// Serialize a [`Cst`] back to source. Concatenates the exact stored strings,
/// guaranteeing a byte-exact round-trip for unedited trees.
pub fn serialize_impl(cst: &Cst) -> String {
    let mut out = String::new();
    for node in &cst.children {
        write_node(node, &mut out);
    }
    out
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

/// Parse children until a closing colon fence of >= `close_colons` is consumed
/// (when `Some`) or the input is exhausted. Returns the children and the exact
/// closing line (empty if the container was unterminated / at root).
fn parse_children(lines: &[&str], pos: &mut usize, close_colons: Option<usize>) -> (Vec<Node>, String) {
    let mut children = Vec::new();
    let mut md = String::new();
    let mut close_line = String::new();

    while *pos < lines.len() {
        let line = lines[*pos];
        let text = trim_eol(line);

        // 1. A closing fence for the current container?
        if let Some(cc) = close_colons {
            if let Some(n) = colon_close_len(text) {
                if n >= cc {
                    *pos += 1;
                    close_line = line.to_string();
                    break;
                }
            }
        }

        // 2. A colon-fence directive opens a nested container.
        if let Some((colons, name, title)) = colon_open(text) {
            flush_md(&mut children, &mut md);
            let open_line = line.to_string();
            *pos += 1;
            let (kids, close) = parse_children(lines, pos, Some(colons));
            children.push(Node::Container {
                name,
                title,
                colons,
                open_line,
                children: kids,
                close_line: close,
            });
            continue;
        }

        // 3. A code fence opens an opaque code leaf (colons inside are inert).
        if let Some((fc, fl)) = code_open(text) {
            flush_md(&mut children, &mut md);
            let mut code = String::from(line);
            *pos += 1;
            while *pos < lines.len() {
                let l = lines[*pos];
                code.push_str(l);
                *pos += 1;
                if is_code_close(trim_eol(l), fc, fl) {
                    break;
                }
            }
            children.push(Node::Leaf {
                text: code,
                is_code: true,
            });
            continue;
        }

        // 4. Ordinary markdown content.
        md.push_str(line);
        *pos += 1;
    }

    flush_md(&mut children, &mut md);
    (children, close_line)
}

fn flush_md(children: &mut Vec<Node>, md: &mut String) {
    if !md.is_empty() {
        children.push(Node::Leaf {
            text: std::mem::take(md),
            is_code: false,
        });
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
    use super::*;

    fn roundtrips(src: &str) {
        assert_eq!(serialize_impl(&parse_block_impl(src)), src, "round-trip mismatch");
    }

    #[test]
    fn roundtrip_markdown_only() {
        roundtrips("just some **markdown**\n\nwith a blank line\n");
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
            Node::Container { name, colons, children, .. } => {
                assert_eq!(name, "tabs");
                assert_eq!(*colons, 4);
                assert_eq!(children.len(), 1);
                match &children[0] {
                    Node::Container { name, title, children, .. } => {
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
                Node::Container { name, title, children, .. } if name == "tab" && title == "B" => Some(children.as_slice()),
                _ => None,
            })
            .expect("tab B");
        let inner = find(tab_b, "tabs");
        assert_eq!(tab_titles(inner), vec!["B1", "B2"]);
    }

    // Helpers for the nesting test.
    fn as_container<'a>(node: &'a Node, name: &str) -> &'a [Node] {
        match node {
            Node::Container { name: n, children, .. } if n == name => children,
            other => panic!("expected {name} container, got {other:?}"),
        }
    }
    fn find<'a>(children: &'a [Node], name: &str) -> &'a [Node] {
        children
            .iter()
            .find_map(|n| match n {
                Node::Container { name: cn, children, .. } if cn == name => Some(children.as_slice()),
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
    fn roundtrip_real_note_content_if_present() {
        // A large real note round-trips byte-exact (it has no ::: directives, so
        // it is one big markdown leaf — this stresses fidelity on ~700 KB).
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/real-note.md");
        if let Ok(src) = std::fs::read_to_string(path) {
            assert_eq!(serialize_impl(&parse_block_impl(&src)), src);
        }
    }
}

//! Block addressing and note-document helpers shared by all commands.

use crate::error::{CliError, Result};
use mica_core::{parse_block_impl, scan_impl, BlockSpan, Node};

/// A located block plus its inner content, from a live scan.
#[derive(Debug, Clone)]
pub struct Located {
    /// The scanner span (offsets, attrs).
    pub span: BlockSpan,
    /// The block's inner content (owned slice of the doc).
    pub content: String,
}

/// Scan `doc` and resolve `selector` to exactly one block.
///
/// Purpose: `-b` accepts an id, a `name` attr, or a 1-based index; when the
/// note holds exactly one block the selector may be omitted.
///
/// # Arguments
/// * `doc` - full note text
/// * `selector` - id / name / 1-based index, or `None`
///
/// # Returns
/// The matching block.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let doc = "```mica id=a\nx\n```\n";
/// let b = mica_cli::blocks::locate(doc, None).unwrap();
/// assert_eq!(b.span.id(), Some("a"));
/// ```
pub fn locate(doc: &str, selector: Option<&str>) -> Result<Located> {
    let spans = scan_impl(doc);
    let closed: Vec<BlockSpan> = spans.into_iter().filter(|b| b.closed).collect();
    if closed.is_empty() {
        return Err(CliError::NotFound(
            "no mica blocks in this note — add a ```mica fence or run `mica migrate`".to_string(),
        ));
    }
    let pick = |b: &BlockSpan| Located {
        content: doc[b.content_start..b.content_end].to_string(),
        span: b.clone(),
    };
    let Some(sel) = selector else {
        if closed.len() == 1 {
            return Ok(pick(&closed[0]));
        }
        return Err(CliError::BadArgs(format!(
            "note has {} blocks — pick one with -b <id|name|index>",
            closed.len()
        )));
    };
    if let Some(b) = closed.iter().find(|b| b.id() == Some(sel)) {
        return Ok(pick(b));
    }
    if let Some(b) = closed.iter().find(|b| b.get("name") == Some(sel)) {
        return Ok(pick(b));
    }
    if let Ok(idx) = sel.parse::<usize>() {
        if (1..=closed.len()).contains(&idx) {
            return Ok(pick(&closed[idx - 1]));
        }
    }
    Err(CliError::NotFound(format!(
        "no block matching '{sel}' — try `mica ls` to see ids, names, and indexes"
    )))
}

/// Parse a dot-separated child path (`"0.2.1"`, `""`/`"root"` = `[]`).
///
/// Purpose: CLI path addressing for structural ops.
///
/// # Arguments
/// * `s` - the path argument
///
/// # Returns
/// Child indices from the block root.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// assert_eq!(mica_cli::blocks::parse_path("0.2").unwrap(), vec![0, 2]);
/// assert_eq!(mica_cli::blocks::parse_path("root").unwrap(), Vec::<usize>::new());
/// ```
pub fn parse_path(s: &str) -> Result<Vec<usize>> {
    let t = s.trim();
    if t.is_empty() || t == "root" {
        return Ok(Vec::new());
    }
    t.split('.')
        .map(|part| {
            part.trim().parse::<usize>().map_err(|_| {
                CliError::BadArgs(format!(
                    "bad path '{s}' — use dot-separated child indices like 0.2, or 'root'"
                ))
            })
        })
        .collect()
}

/// Find the path of the first container named `name` ("tabs" / "grid") in a
/// block's CST, depth-first.
///
/// Purpose: `tab add` etc. default to the first matching group so simple
/// blocks never need `--path`.
///
/// # Arguments
/// * `content` - block inner content
/// * `name` - container name to find
///
/// # Returns
/// The child path, or `None`.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let p = mica_cli::blocks::first_container("tab: A\nx\n", "tabs");
/// assert_eq!(p, Some(vec![0]));
/// ```
pub fn first_container(content: &str, name: &str) -> Option<Vec<usize>> {
    fn walk(nodes: &[Node], name: &str, prefix: &mut Vec<usize>) -> Option<Vec<usize>> {
        for (i, n) in nodes.iter().enumerate() {
            if let Node::Container {
                name: cn, children, ..
            } = n
            {
                prefix.push(i);
                if cn == name {
                    return Some(prefix.clone());
                }
                if let Some(found) = walk(children, name, prefix) {
                    return Some(found);
                }
                prefix.pop();
            }
        }
        None
    }
    walk(&parse_block_impl(content).children, name, &mut Vec::new())
}

/// A `(path, kind, display title)` row of the `ls --tree` view.
pub type TreeRow = (Vec<usize>, String, String);

/// One row of the `ls --tree` view: an indented label per container.
///
/// Purpose: give users the child paths they need for `--path` / `mv`.
///
/// # Arguments
/// * `content` - block inner content
///
/// # Returns
/// `(path, kind, title)` rows in depth-first order.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let rows = mica_cli::blocks::tree_rows("tab: A\nx\n");
/// assert_eq!(rows[0].1, "tabs");
/// assert_eq!(rows[1], (vec![0, 0], "tab".to_string(), "A".to_string()));
/// ```
pub fn tree_rows(content: &str) -> Vec<TreeRow> {
    fn walk(nodes: &[Node], prefix: &mut Vec<usize>, out: &mut Vec<TreeRow>) {
        for (i, n) in nodes.iter().enumerate() {
            if let Node::Container {
                name,
                title,
                children,
                ..
            } = n
            {
                prefix.push(i);
                let (display, _) = mica_core::ops::split_title_attrs(title);
                out.push((prefix.clone(), name.clone(), display));
                walk(children, prefix, out);
                prefix.pop();
            }
        }
    }
    let mut out = Vec::new();
    walk(
        &parse_block_impl(content).children,
        &mut Vec::new(),
        &mut out,
    );
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    const TWO: &str = "```mica id=a name=First\nx\n```\n\n```mica id=b\ny\n```\n";

    #[test]
    fn locate_by_id_name_index_and_default() {
        assert_eq!(locate(TWO, Some("a")).unwrap().span.id(), Some("a"));
        assert_eq!(locate(TWO, Some("First")).unwrap().span.id(), Some("a"));
        assert_eq!(locate(TWO, Some("2")).unwrap().span.id(), Some("b"));
        assert!(
            matches!(locate(TWO, None), Err(CliError::BadArgs(_))),
            "ambiguous without selector"
        );
        let one = "```mica id=solo\nz\n```\n";
        assert_eq!(locate(one, None).unwrap().span.id(), Some("solo"));
    }

    #[test]
    fn locate_misses_produce_not_found() {
        assert!(matches!(
            locate(TWO, Some("zzz")),
            Err(CliError::NotFound(_))
        ));
        assert!(matches!(
            locate("no blocks here\n", None),
            Err(CliError::NotFound(_))
        ));
    }

    #[test]
    fn parse_path_rejects_garbage() {
        assert!(parse_path("0.x").is_err());
        assert_eq!(parse_path(" 1.2 ").unwrap(), vec![1, 2]);
    }

    #[test]
    fn first_container_finds_nested_grid() {
        // Tab body = [leaf "x\n", grid] → grid sits at 0.0.1.
        let content = "tab: A\nx\n:::grid {cols=2}\n:::cell\ny\n:::\n:::\n";
        assert_eq!(first_container(content, "grid"), Some(vec![0, 0, 1]));
        // With no leading prose the grid is the tab's first child.
        let content2 = "tab: A\n:::grid {cols=2}\n:::cell\ny\n:::\n:::\n";
        assert_eq!(first_container(content2, "grid"), Some(vec![0, 0, 0]));
    }
}

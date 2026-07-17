//! One function per subcommand, plus the dispatcher.
//!
//! Every mutating command follows the plugin's write discipline: re-scan the
//! live document, apply the structural op via `mica-core`, write the whole
//! note back, then let the engine snapshot (change-gated).

use crate::blocks::{self, Located};
use crate::cli::{CellCmd, Cli, Cmd, GridCmd, NoteBlock, TabCmd};
use crate::engine;
use crate::error::{io_ctx, CliError, Result};
use crate::output::{rel_time, Style};
use crate::sidecar;
use crate::vault::{self, NoteRef};
use mica_core::{
    apply_op_impl, diff_impl, ensure_ids_impl, hash_content_impl, make_patch_impl,
    migrate_tabs_impl, new_id_impl, parse_block_impl, reconcile_impl, scan_impl, serialize_impl,
    ContentRef, Cst, Event, GroupKind, Node, SidecarRef, StructOp, VersionMeta,
};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Every built-in Obsidian callout type plus aliases — the default migration
/// allowlist (mirrors the plugin's `OBSIDIAN_CALLOUT_TYPES`).
const OBSIDIAN_CALLOUT_TYPES: &str = "note, abstract, summary, tldr, info, todo, tip, hint, important, success, \
     check, done, question, help, faq, warning, caution, attention, failure, fail, missing, danger, error, bug, \
     example, quote, cite";

/// Route a parsed [`Cli`] to its command function.
///
/// Purpose: keep `main.rs` thin and commands individually testable.
///
/// # Arguments
/// * `cli` - parsed arguments
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// // dispatched from `mica_cli::run()`
/// ```
pub fn dispatch(cli: Cli) -> Result<()> {
    let ctx = Ctx {
        vault: cli.vault,
        json: cli.json,
        style: Style::auto(),
    };
    match cli.cmd {
        Cmd::Ls { note, tree } => ls(&ctx, &note, tree),
        Cmd::Cat { target, tab } => cat(&ctx, &target, tab.as_deref()),
        Cmd::Set { target, file } => set(&ctx, &target, file.as_deref()),
        Cmd::Tab { cmd } => tab(&ctx, &cmd),
        Cmd::Cell { cmd } => cell(&ctx, &cmd),
        Cmd::Grid { cmd } => grid(&ctx, &cmd),
        Cmd::Mv {
            target,
            from,
            to_parent,
            to_index,
        } => mv(&ctx, &target, &from, &to_parent, to_index),
        Cmd::Versions { target } => versions(&ctx, &target),
        Cmd::Show { target, version } => show(&ctx, &target, &version),
        Cmd::Diff {
            target,
            base,
            to,
            granularity,
            patch,
        } => diff(
            &ctx,
            &target,
            base.as_deref(),
            to.as_deref(),
            &granularity,
            patch,
        ),
        Cmd::Restore { target, version } => restore(&ctx, &target, &version),
        Cmd::Label {
            target,
            version,
            label,
        } => label_cmd(&ctx, &target, &version, &label),
        Cmd::Snapshot { note, force } => snapshot(&ctx, &note, force),
        Cmd::Watch { debounce, interval } => watch(&ctx, debounce, interval),
        Cmd::Migrate {
            note,
            dry_run,
            callouts,
        } => migrate(&ctx, note.as_deref(), dry_run, callouts.as_deref()),
        Cmd::Prepare { note } => prepare(&ctx, &note),
        Cmd::Repair => repair(&ctx),
        Cmd::Doctor => doctor(&ctx),
    }
}

/// Shared context for one command invocation.
pub struct Ctx {
    /// `--vault` as given.
    pub vault: Option<PathBuf>,
    /// `--json` mode.
    pub json: bool,
    /// ANSI styling for human output.
    pub style: Style,
}

impl Ctx {
    /// Resolve a note argument against `--vault` / cwd.
    pub fn note(&self, note: &str) -> Result<NoteRef> {
        vault::resolve_note(note, self.vault.as_deref())
    }

    fn vault_root(&self) -> Result<PathBuf> {
        vault::find_vault(self.vault.as_deref(), Path::new("."))
    }
}

/// `mica ls` — list blocks (and optionally the nested tree).
pub fn ls(ctx: &Ctx, note: &str, tree: bool) -> Result<()> {
    let note = ctx.note(note)?;
    let doc = engine::read_doc(&note.abs)?;
    let st = engine::state(&note.abs)?;
    let spans = scan_impl(&doc);
    let s = &ctx.style;

    let mut rows = Vec::new();
    for (i, b) in spans.iter().filter(|b| b.closed).enumerate() {
        let content = &doc[b.content_start..b.content_end];
        let tree_rows = blocks::tree_rows(content);
        let tabs: Vec<String> = tree_rows
            .iter()
            .filter(|(_, kind, _)| kind == "tab")
            .map(|(_, _, title)| title)
            .cloned()
            .collect();
        let nversions = b
            .id()
            .and_then(|id| st.get(id))
            .map(|s| s.versions.len())
            .unwrap_or(0);
        rows.push((
            i + 1,
            b.id().map(str::to_string),
            b.get("name").map(str::to_string),
            tabs,
            nversions,
            tree_rows,
        ));
    }

    if ctx.json {
        let v: Vec<serde_json::Value> = rows
            .iter()
            .map(|(i, id, name, tabs, nv, rows)| {
                let mut o = serde_json::json!({
                    "index": i, "id": id, "name": name, "tabs": tabs, "versions": nv,
                });
                if tree {
                    o["tree"] = serde_json::json!(rows
                        .iter()
                        .map(|(p, k, t)| serde_json::json!({
                            "path": p.iter().map(usize::to_string).collect::<Vec<_>>().join("."),
                            "kind": k, "title": t
                        }))
                        .collect::<Vec<_>>());
                }
                o
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return Ok(());
    }

    for (i, id, name, tabs, nv, tree_rows) in &rows {
        let id_s = id.as_deref().unwrap_or("(no id)");
        let name_s = name
            .as_deref()
            .map(|n| format!(" {}", s.bold(n)))
            .unwrap_or_default();
        let tabs_s = if tabs.is_empty() {
            String::new()
        } else {
            format!("  tabs: {}", tabs.join(", "))
        };
        println!(
            "{} {}{}{}  {}",
            s.dim(&format!("[{i}]")),
            s.cyan(id_s),
            name_s,
            tabs_s,
            s.dim(&format!("{nv} version{}", if *nv == 1 { "" } else { "s" })),
        );
        if tree {
            for (path, kind, title) in tree_rows {
                let depth = path.len().saturating_sub(1);
                let path_s = path
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(".");
                println!(
                    "    {}{} {} {}",
                    "  ".repeat(depth),
                    s.dim(&path_s),
                    kind,
                    if title.is_empty() {
                        s.dim("—")
                    } else {
                        s.bold(title)
                    },
                );
            }
        }
    }
    Ok(())
}

/// `mica cat` — print a block's content or one tab's body.
pub fn cat(ctx: &Ctx, target: &NoteBlock, tab: Option<&str>) -> Result<()> {
    let (_, _, located) = load(ctx, target)?;
    let Some(title) = tab else {
        print!("{}", located.content);
        return Ok(());
    };
    let cst = parse_block_impl(&located.content);
    let mut found = None;
    walk_tabs(&cst.children, &mut |t_title, children| {
        if found.is_none() && t_title == title {
            found = Some(serialize_impl(&mica_core::Cst {
                children: children.to_vec(),
            }));
        }
    });
    match found {
        Some(body) => {
            print!("{body}");
            Ok(())
        }
        None => {
            let mut titles = Vec::new();
            walk_tabs(&cst.children, &mut |t, _| titles.push(t.to_string()));
            Err(CliError::NotFound(format!(
                "no tab titled '{title}' — available: {}",
                titles.join(", ")
            )))
        }
    }
}

/// Depth-first visit of every tab (display title, body children).
fn walk_tabs(nodes: &[Node], f: &mut impl FnMut(&str, &[Node])) {
    for n in nodes {
        if let Node::Container {
            name,
            title,
            children,
            ..
        } = n
        {
            if name == "tab" {
                let (display, _) = mica_core::ops::split_title_attrs(title);
                f(&display, children);
            }
            walk_tabs(children, f);
        }
    }
}

/// `mica set` — replace a block's content from a file or stdin.
pub fn set(ctx: &Ctx, target: &NoteBlock, file: Option<&Path>) -> Result<()> {
    let (note, _, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let content = match file {
        Some(p) => std::fs::read_to_string(p).map_err(io_ctx(p.display().to_string()))?,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(io_ctx("stdin".to_string()))?;
            buf
        }
    };
    engine::set_content(&note, &id, &content)?;
    eprintln!("mica: block {id} updated (pre-image and result versioned)");
    Ok(())
}

/// Apply one structural op to a block and write the note back.
///
/// Purpose: the shared engine behind `tab`/`cell`/`grid`/`mv`. Snapshots run
/// before (pre-image, stamping ids) and after (change-gated) the write.
///
/// # Arguments
/// * `ctx` - invocation context
/// * `target` - note + block selector
/// * `op` - built per subcommand from the live block and its parsed CST
///
/// # Returns
/// `()` on success; `BadArgs` when the reducer rejects the op.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// // used by tab/cell/grid/mv commands
/// ```
fn apply_structural(
    ctx: &Ctx,
    target: &NoteBlock,
    op: impl FnOnce(&Located, &Cst) -> Result<StructOp>,
) -> Result<()> {
    let (note, _, _) = load(ctx, target)?;
    engine::snapshot_note(&note, false, true)?; // pre-image + id stamping
                                                // Reload: stamping may have rewritten the doc.
    let doc = engine::read_doc(&note.abs)?;
    let located = blocks::locate(&doc, target.block.as_deref())?;
    let mut cst = parse_block_impl(&located.content);
    let op = op(&located, &cst)?;
    if !apply_op_impl(&mut cst, &op) {
        return Err(CliError::BadArgs(
            "the operation does not apply (missing target or invalid move) — check `mica ls --tree`".to_string(),
        ));
    }
    let mut next = serialize_impl(&cst);
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    let mut out = String::with_capacity(
        doc.len() - (located.span.content_end - located.span.content_start) + next.len(),
    );
    out.push_str(&doc[..located.span.content_start]);
    out.push_str(&next);
    out.push_str(&doc[located.span.content_end..]);
    std::fs::write(&note.abs, out).map_err(io_ctx(note.abs.display().to_string()))?;
    engine::snapshot_note(&note, false, true)?; // change-gated: structure-only stays quiet
    Ok(())
}

/// Resolve a tab ORDINAL (0-based among tabs) to a raw child index.
fn tab_child_index(cst: &Cst, group_path: &[usize], ordinal: usize) -> Result<usize> {
    nth_child_of_kind(cst, group_path, "tab", ordinal).ok_or_else(|| {
        CliError::NotFound(format!(
            "no tab #{ordinal} in that group — check `mica ls --tree`"
        ))
    })
}

/// Resolve a cell ORDINAL to a raw child index.
fn cell_child_index(cst: &Cst, group_path: &[usize], ordinal: usize) -> Result<usize> {
    nth_child_of_kind(cst, group_path, "cell", ordinal).ok_or_else(|| {
        CliError::NotFound(format!(
            "no cell #{ordinal} in that grid — check `mica ls --tree`"
        ))
    })
}

fn nth_child_of_kind(cst: &Cst, group_path: &[usize], kind: &str, ordinal: usize) -> Option<usize> {
    let mut nodes = &cst.children;
    for &i in group_path {
        match nodes.get(i)? {
            Node::Container { children, .. } => nodes = children,
            Node::Leaf { .. } => return None,
        }
    }
    nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| matches!(n, Node::Container { name, .. } if name == kind))
        .map(|(i, _)| i)
        .nth(ordinal)
}

/// The end-of-group raw insertion index (after the last child).
fn group_len(cst: &Cst, group_path: &[usize]) -> Result<usize> {
    let mut nodes = &cst.children;
    for &i in group_path {
        match nodes.get(i) {
            Some(Node::Container { children, .. }) => nodes = children,
            _ => {
                return Err(CliError::NotFound(
                    "group path not found — check `mica ls --tree`".to_string(),
                ))
            }
        }
    }
    Ok(nodes.len())
}

/// The tabs-group path: `--path` if given, else the first tabs group.
fn tabs_path(cst: &Cst, path: Option<&str>) -> Result<Option<Vec<usize>>> {
    match path {
        Some(p) => Ok(Some(blocks::parse_path(p)?)),
        None => Ok(blocks::first_container_in(&cst.children, "tabs")),
    }
}

/// The grid path: `--path` if given, else the first grid.
fn grid_path(cst: &Cst, path: Option<&str>) -> Result<Vec<usize>> {
    match path {
        Some(p) => blocks::parse_path(p),
        None => blocks::first_container_in(&cst.children, "grid").ok_or_else(|| {
            CliError::NotFound("no grid in this block — check `mica ls --tree`".to_string())
        }),
    }
}

/// `mica tab …` subcommands.
pub fn tab(ctx: &Ctx, cmd: &TabCmd) -> Result<()> {
    match cmd {
        TabCmd::Add {
            target,
            title,
            path,
            at,
        } => {
            // Two-step when a title is requested: insert, then rename the new tab
            // (the factory always creates "New tab").
            let mut inserted_group_path: Option<Vec<usize>> = None;
            let mut insert_at: Option<usize> = None;
            apply_structural(ctx, target, |_, cst| {
                match tabs_path(cst, path.as_deref())? {
                    Some(gp) => {
                        let raw_at = match at {
                            Some(ordinal) => {
                                tab_child_index(cst, &gp, *ordinal).unwrap_or(group_len(cst, &gp)?)
                            }
                            None => group_len(cst, &gp)?,
                        };
                        inserted_group_path = Some(gp.clone());
                        insert_at = Some(raw_at);
                        Ok(StructOp::InsertTab {
                            path: gp,
                            at: raw_at,
                        })
                    }
                    None => {
                        // No tabs group yet: create one at the root's end.
                        let root_len = group_len(cst, &[])?;
                        inserted_group_path = None;
                        Ok(StructOp::InsertGroup {
                            path: vec![],
                            at: root_len,
                            kind: GroupKind::Tabs,
                        })
                    }
                }
            })?;
            if title != "New tab" {
                // Rename the tab we just created (last tab of the target group).
                apply_structural(ctx, target, |_, cst| {
                    let gp =
                        match &inserted_group_path {
                            Some(gp) => gp.clone(),
                            None => blocks::first_container_in(&cst.children, "tabs").ok_or_else(
                                || CliError::Corrupt("tab group vanished after insert".to_string()),
                            )?,
                        };
                    let index = match insert_at {
                        Some(i) => i,
                        None => tab_child_index(cst, &gp, 0)?,
                    };
                    Ok(StructOp::RenameTab {
                        path: gp,
                        index,
                        title: title.clone(),
                    })
                })?;
            }
            Ok(())
        }
        TabCmd::Rm {
            target,
            index,
            path,
        } => apply_structural(ctx, target, |_, cst| {
            let gp = tabs_path(cst, path.as_deref())?
                .ok_or_else(|| CliError::NotFound("no tabs group in this block".to_string()))?;
            let raw = tab_child_index(cst, &gp, *index)?;
            Ok(StructOp::DeleteTab {
                path: gp,
                index: raw,
            })
        }),
        TabCmd::Rename {
            target,
            index,
            title,
            path,
        } => apply_structural(ctx, target, |_, cst| {
            let gp = tabs_path(cst, path.as_deref())?
                .ok_or_else(|| CliError::NotFound("no tabs group in this block".to_string()))?;
            let raw = tab_child_index(cst, &gp, *index)?;
            Ok(StructOp::RenameTab {
                path: gp,
                index: raw,
                title: title.clone(),
            })
        }),
        TabCmd::Mv {
            target,
            from,
            to,
            path,
        } => apply_structural(ctx, target, |_, cst| {
            let gp = tabs_path(cst, path.as_deref())?
                .ok_or_else(|| CliError::NotFound("no tabs group in this block".to_string()))?;
            let raw_from = tab_child_index(cst, &gp, *from)?;
            let raw_to = match tab_child_index(cst, &gp, *to) {
                Ok(i) => {
                    if *to > *from {
                        i + 1 // insert AFTER the ordinal-target when moving right
                    } else {
                        i
                    }
                }
                Err(_) => group_len(cst, &gp)?,
            };
            let mut from_path = gp.clone();
            from_path.push(raw_from);
            Ok(StructOp::MoveNode {
                from: from_path,
                to_parent: gp,
                to_index: raw_to,
            })
        }),
    }
}

/// `mica cell …` subcommands.
pub fn cell(ctx: &Ctx, cmd: &CellCmd) -> Result<()> {
    match cmd {
        CellCmd::Add { target, path, at } => apply_structural(ctx, target, |_, cst| {
            let gp = grid_path(cst, path.as_deref())?;
            let raw_at = match at {
                Some(ordinal) => {
                    cell_child_index(cst, &gp, *ordinal).unwrap_or(group_len(cst, &gp)?)
                }
                None => group_len(cst, &gp)?,
            };
            Ok(StructOp::InsertCell {
                path: gp,
                at: raw_at,
            })
        }),
        CellCmd::Rm {
            target,
            index,
            path,
        } => apply_structural(ctx, target, |_, cst| {
            let gp = grid_path(cst, path.as_deref())?;
            let raw = cell_child_index(cst, &gp, *index)?;
            Ok(StructOp::DeleteCell {
                path: gp,
                index: raw,
            })
        }),
        CellCmd::Mv {
            target,
            from,
            to,
            path,
        } => apply_structural(ctx, target, |_, cst| {
            let gp = grid_path(cst, path.as_deref())?;
            let raw_from = cell_child_index(cst, &gp, *from)?;
            let raw_to = match cell_child_index(cst, &gp, *to) {
                Ok(i) => {
                    if *to > *from {
                        i + 1
                    } else {
                        i
                    }
                }
                Err(_) => group_len(cst, &gp)?,
            };
            let mut from_path = gp.clone();
            from_path.push(raw_from);
            Ok(StructOp::MoveNode {
                from: from_path,
                to_parent: gp,
                to_index: raw_to,
            })
        }),
    }
}

/// `mica grid …` subcommands.
pub fn grid(ctx: &Ctx, cmd: &GridCmd) -> Result<()> {
    match cmd {
        GridCmd::Cols { target, cols, path } => apply_structural(ctx, target, |_, cst| {
            let gp = grid_path(cst, path.as_deref())?;
            Ok(StructOp::SetCols {
                path: gp,
                cols: *cols,
            })
        }),
    }
}

/// `mica mv` — move any node (tab, cell, or whole group).
pub fn mv(
    ctx: &Ctx,
    target: &NoteBlock,
    from: &str,
    to_parent: &str,
    to_index: usize,
) -> Result<()> {
    let from = blocks::parse_path(from)?;
    let to_parent = blocks::parse_path(to_parent)?;
    apply_structural(ctx, target, |_, _| {
        Ok(StructOp::MoveNode {
            from: from.clone(),
            to_parent: to_parent.clone(),
            to_index,
        })
    })
}

/// `mica versions` — list stored versions, newest first.
pub fn versions(ctx: &Ctx, target: &NoteBlock) -> Result<()> {
    let (note, _, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state(&note.abs)?;
    let Some(bs) = st.get(&id) else {
        println!("no versions yet — edit the block or run `mica snapshot`");
        return Ok(());
    };
    if ctx.json {
        let v: Vec<serde_json::Value> = bs
            .versions
            .iter()
            .enumerate()
            .map(|(i, v)| {
                serde_json::json!({
                    "n": i + 1, "hash": v.hash, "ts": v.ts, "label": v.label,
                    "head": bs.head.as_deref() == Some(v.hash.as_str()),
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return Ok(());
    }
    let s = &ctx.style;
    let now = engine::now_ms();
    for (i, v) in bs.versions.iter().enumerate().rev() {
        let head = if bs.head.as_deref() == Some(v.hash.as_str()) {
            s.green(" ● head")
        } else {
            String::new()
        };
        let label = v
            .label
            .as_deref()
            .map(|l| format!("  {}", s.yellow(l)))
            .unwrap_or_default();
        println!(
            "{}  {}  {}{}{}",
            s.bold(&format!("v{}", i + 1)),
            s.cyan(&v.hash),
            s.dim(&rel_time(v.ts, now)),
            label,
            head,
        );
    }
    Ok(())
}

/// `mica show` — print one stored version.
pub fn show(ctx: &Ctx, target: &NoteBlock, version: &str) -> Result<()> {
    let (note, _, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state(&note.abs)?;
    let versions = st.get(&id).map(|b| b.versions.as_slice()).unwrap_or(&[]);
    let hash = resolve_version(versions, version)?;
    match sidecar::read_object(&note.abs, &hash)? {
        Some(content) => {
            print!("{content}");
            Ok(())
        }
        None => Err(CliError::Corrupt(format!(
            "version {hash} is recorded but its object file is missing — run `mica doctor`"
        ))),
    }
}

/// `mica diff` — colored diff or unified patch between versions/current.
pub fn diff(
    ctx: &Ctx,
    target: &NoteBlock,
    base: Option<&str>,
    to: Option<&str>,
    granularity: &str,
    patch: bool,
) -> Result<()> {
    if !matches!(granularity, "line" | "word" | "char") {
        return Err(CliError::BadArgs(format!(
            "granularity must be line, word, or char (got '{granularity}')"
        )));
    }
    let (note, _, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state(&note.abs)?;
    let versions = st.get(&id).map(|b| b.versions.as_slice()).unwrap_or(&[]);

    let read = |hash: &str| -> Result<String> {
        sidecar::read_object(&note.abs, hash)?.ok_or_else(|| {
            CliError::Corrupt(format!(
                "version {hash} is recorded but its object is missing — run `mica doctor`"
            ))
        })
    };

    // Base: --base, else the version before the newest, else the newest.
    let base_text = match base {
        Some(sel) => read(&resolve_version(versions, sel)?)?,
        None => {
            if versions.len() >= 2 {
                read(&versions[versions.len() - 2].hash)?
            } else if let Some(last) = versions.last() {
                read(&last.hash)?
            } else {
                return Err(CliError::NotFound(
                    "no stored versions to diff against — run `mica snapshot` first".to_string(),
                ));
            }
        }
    };
    // To: --to, else the current (working) content.
    let to_text = match to {
        Some(sel) => read(&resolve_version(versions, sel)?)?,
        None => located.content.clone(),
    };

    if patch {
        print!("{}", make_patch_impl(&base_text, &to_text, 3));
        return Ok(());
    }
    let s = &ctx.style;
    let result = diff_impl(&base_text, &to_text, granularity, 3);
    if (result.similarity - 1.0).abs() < f64::EPSILON && result.hunks.is_empty() {
        println!("{}", s.dim("no differences"));
        return Ok(());
    }
    for (i, hunk) in result.hunks.iter().enumerate() {
        if i > 0 {
            println!("{}", s.dim("⋯"));
        }
        for change in &hunk.changes {
            let line = change.value.strip_suffix('\n').unwrap_or(&change.value);
            match change.tag.as_str() {
                "delete" => println!("{}", s.red(&format!("- {line}"))),
                "insert" => println!("{}", s.green(&format!("+ {line}"))),
                _ => println!("{}", s.dim(&format!("  {line}"))),
            }
        }
    }
    Ok(())
}

/// `mica restore` — set a block back to a stored version.
pub fn restore(ctx: &Ctx, target: &NoteBlock, version: &str) -> Result<()> {
    let (note, _, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state(&note.abs)?;
    let versions = st.get(&id).map(|b| b.versions.as_slice()).unwrap_or(&[]);
    let hash = resolve_version(versions, version)?;
    engine::restore(&note, &id, &hash)?;
    eprintln!("mica: block {id} restored to {hash} (previous state snapshotted first)");
    Ok(())
}

/// `mica label` — label a stored version.
pub fn label_cmd(ctx: &Ctx, target: &NoteBlock, version: &str, label: &str) -> Result<()> {
    let (note, _, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state(&note.abs)?;
    let versions = st.get(&id).map(|b| b.versions.as_slice()).unwrap_or(&[]);
    let hash = resolve_version(versions, version)?;
    engine::label(&note, &id, &hash, label)
}

/// `mica snapshot` — snapshot a note now.
pub fn snapshot(ctx: &Ctx, note: &str, force: bool) -> Result<()> {
    let note = ctx.note(note)?;
    let actions = engine::snapshot_note(&note, force, true)?;
    if ctx.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&actions).unwrap_or_default()
        );
        return Ok(());
    }
    let s = &ctx.style;
    if actions.is_empty() {
        println!("{}", s.dim("no mica blocks in this note"));
    }
    for a in actions {
        match (a.hash, a.skipped) {
            (Some(h), _) => println!("{} {} {}", s.green("✓"), a.block, s.cyan(&h)),
            (None, Some(why)) => println!("{} {} {}", s.dim("·"), a.block, s.dim(&why)),
            (None, None) => {}
        }
    }
    Ok(())
}

/// `mica watch` — poll the vault, snapshot notes that settle.
pub fn watch(ctx: &Ctx, debounce: u64, interval: u64) -> Result<()> {
    let root = ctx.vault_root()?;
    let s = &ctx.style;
    eprintln!(
        "mica: watching {} (poll {interval}s, debounce {debounce}s) — Ctrl-C to stop",
        root.display()
    );
    let mut mtimes: BTreeMap<PathBuf, std::time::SystemTime> = BTreeMap::new();
    let mut dirty: BTreeMap<PathBuf, std::time::Instant> = BTreeMap::new();

    // Prime without snapshotting (existing state is not "a change").
    for n in vault::vault_notes(&root)? {
        if let Ok(meta) = std::fs::metadata(&n) {
            if let Ok(m) = meta.modified() {
                mtimes.insert(n, m);
            }
        }
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(interval));
        for n in vault::vault_notes(&root)? {
            let Ok(meta) = std::fs::metadata(&n) else {
                continue;
            };
            let Ok(m) = meta.modified() else { continue };
            let changed = mtimes.insert(n.clone(), m).is_none_or(|prev| prev != m);
            if changed {
                dirty.insert(n, std::time::Instant::now());
            }
        }
        let due: Vec<PathBuf> = dirty
            .iter()
            .filter(|(_, since)| since.elapsed().as_secs() >= debounce)
            .map(|(path, _)| path)
            .cloned()
            .collect();
        for p in due {
            dirty.remove(&p);
            let note = NoteRef {
                abs: p.clone(),
                vault: root.clone(),
            };
            match engine::snapshot_note(&note, false, true) {
                Ok(actions) => {
                    for a in actions.iter().filter(|a| a.hash.is_some()) {
                        println!(
                            "{} {} {} {}",
                            s.green("✓"),
                            note.vault_rel(),
                            a.block,
                            s.cyan(a.hash.as_deref().unwrap_or("")),
                        );
                    }
                }
                Err(e) => eprintln!("mica: snapshot failed for {}: {e}", p.display()),
            }
        }
    }
}

/// `mica migrate` — legacy ```tabs conversion (note or whole vault).
pub fn migrate(ctx: &Ctx, note: Option<&str>, dry_run: bool, callouts: Option<&str>) -> Result<()> {
    let callouts = callouts.unwrap_or(OBSIDIAN_CALLOUT_TYPES);
    let notes: Vec<NoteRef> = match note {
        Some(n) => vec![ctx.note(n)?],
        None => {
            let root = ctx.vault_root()?;
            vault::vault_notes(&root)?
                .into_iter()
                .map(|abs| NoteRef {
                    abs,
                    vault: root.clone(),
                })
                .collect()
        }
    };
    let s = &ctx.style;
    let mut reports = Vec::new();
    for n in notes {
        let doc = engine::read_doc(&n.abs)?;
        let result = migrate_tabs_impl(&doc, callouts);
        if !result.changed {
            continue;
        }
        let imported: usize = result.blocks.iter().map(|b| b.versions.len()).sum();
        if !dry_run {
            // Lossless: store the entire original note as a content-addressed
            // object BEFORE any write.
            let backup = hash_content_impl(&doc);
            sidecar::write_object(&n.abs, &backup, &doc)?;
            std::fs::write(&n.abs, &result.doc).map_err(io_ctx(n.abs.display().to_string()))?;
            ensure_note_frontmatter_id(&n.abs)?;

            // Archived callouts become labeled versions, backdated a second
            // apart so the (ts, eid) fold orders them before the head below.
            let now = engine::now_ms();
            let mut events = Vec::with_capacity(imported);
            for block in &result.blocks {
                let count = block.versions.len() as u64;
                for (i, v) in block.versions.iter().enumerate() {
                    let hash = hash_content_impl(&v.content);
                    sidecar::write_object(&n.abs, &hash, &v.content)?;
                    events.push(Event::AddVersion {
                        eid: new_id_impl(),
                        ts: now - (count - i as u64) * 1000,
                        block: block.id.clone(),
                        hash,
                        label: Some(v.label.clone()),
                        origin: Some(format!("migrated:{}", v.status)),
                        parent: None,
                    });
                }
            }
            sidecar::append_events(&n.abs, &events)?;
            engine::snapshot_note(&n, false, true)?; // head becomes the newest version
        }
        reports.push((n.vault_rel(), result.blocks.len(), imported));
    }
    if ctx.json {
        let v: Vec<serde_json::Value> = reports
            .iter()
            .map(|(path, blocks, imported)| {
                serde_json::json!({"path": path, "blocks": blocks, "versionsImported": imported, "dryRun": dry_run})
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return Ok(());
    }
    if reports.is_empty() {
        println!("{}", s.dim("nothing to migrate"));
        return Ok(());
    }
    let verb = if dry_run {
        "would convert"
    } else {
        "converted"
    };
    for (path, blocks, imported) in &reports {
        println!(
            "{} {path}: {blocks} block(s) {verb}, {imported} archived version(s) imported",
            s.green("✓"),
        );
    }
    Ok(())
}

/// `mica prepare` — stamp frontmatter `mica-id` + block ids.
pub fn prepare(ctx: &Ctx, note: &str) -> Result<()> {
    let note = ctx.note(note)?;
    ensure_note_frontmatter_id(&note.abs)?;
    let doc = engine::read_doc(&note.abs)?;
    let next = ensure_ids_impl(&doc);
    if next != doc {
        std::fs::write(&note.abs, next).map_err(io_ctx(note.abs.display().to_string()))?;
    }
    eprintln!("mica: {} prepared", note.vault_rel());
    Ok(())
}

/// Insert `mica-id` into YAML frontmatter (creating the frontmatter if absent).
/// Never touches other keys.
fn ensure_note_frontmatter_id(path: &Path) -> Result<()> {
    let doc = engine::read_doc(path)?;
    if engine::frontmatter_mica_id(&doc).is_some() {
        return Ok(());
    }
    let id = new_id_impl();
    let next = if let Some(body) = doc.strip_prefix("---\n") {
        if let Some(end) = body.find("\n---") {
            // Existing frontmatter: append before the closer.
            let (fm, rest) = body.split_at(end);
            format!("---\n{fm}\nmica-id: {id}{rest}")
        } else {
            format!("---\nmica-id: {id}\n---\n\n{doc}")
        }
    } else {
        format!("---\nmica-id: {id}\n---\n\n{doc}")
    };
    std::fs::write(path, next).map_err(io_ctx(path.display().to_string()))
}

/// `mica repair` — reconcile sidecars ↔ notes; rehome renamed notes.
pub fn repair(ctx: &Ctx) -> Result<()> {
    let root = ctx.vault_root()?;
    let s = &ctx.style;

    // Content index: every block id in every note.
    let mut content: Vec<ContentRef> = Vec::new();
    for n in vault::vault_notes(&root)? {
        let doc = engine::read_doc(&n)?;
        let rel = n
            .strip_prefix(&root)
            .unwrap_or(&n)
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        for b in scan_impl(&doc) {
            if let Some(id) = b.id() {
                content.push(ContentRef {
                    block: id.to_string(),
                    note: rel.clone(),
                });
            }
        }
    }
    // Sidecar index: every block id in every ledger.
    let mut screfs: Vec<SidecarRef> = Vec::new();
    let sidecars = vault::vault_sidecars(&root)?;
    let mut ledgers = Vec::with_capacity(sidecars.len());
    for sc in &sidecars {
        let events = sidecar::read_ledger_at(&sc.join("ledger.jsonl"))?;
        let rel = sc
            .strip_prefix(&root)
            .unwrap_or(sc)
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for e in &events {
            let block = match e {
                Event::AddVersion { block, .. }
                | Event::SetHead { block, .. }
                | Event::Label { block, .. } => block,
            };
            if seen.insert(block) {
                screfs.push(SidecarRef {
                    block: block.clone(),
                    sidecar: rel.clone(),
                });
            }
        }
        ledgers.push(events);
    }
    let actions = reconcile_impl(&content, &screfs);

    // Rehome: a sidecar whose blocks live in a note elsewhere follows the note.
    let note_by_block: BTreeMap<&str, &str> = content
        .iter()
        .map(|c| (c.block.as_str(), c.note.as_str()))
        .collect();
    let mut rehomed = Vec::new();
    for (sc, events) in sidecars.iter().zip(&ledgers) {
        let target = events.iter().find_map(|e| {
            let block = match e {
                Event::AddVersion { block, .. }
                | Event::SetHead { block, .. }
                | Event::Label { block, .. } => block,
            };
            note_by_block.get(block.as_str())
        });
        let Some(note_rel) = target else { continue };
        let expected = sidecar::sidecar_dir(&root.join(note_rel));
        if &expected != sc && !expected.exists() {
            std::fs::rename(sc, &expected).map_err(io_ctx(sc.display().to_string()))?;
            rehomed.push((sc.clone(), expected));
        }
    }

    if ctx.json {
        let v = serde_json::json!({
            "rehomed": rehomed.iter().map(|(f, t)| serde_json::json!({
                "from": f.display().to_string(), "to": t.display().to_string()
            })).collect::<Vec<_>>(),
            "actions": actions.len(),
        });
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return Ok(());
    }
    for (f, t) in &rehomed {
        println!("{} rehomed {} → {}", s.green("✓"), f.display(), t.display());
    }
    println!(
        "{} issue(s) found, {} sidecar(s) rehomed",
        actions.len(),
        rehomed.len()
    );
    for a in &actions {
        println!("  {}", s.yellow(&format!("{a:?}")));
    }
    Ok(())
}

/// `mica doctor` — sidecar health report.
pub fn doctor(ctx: &Ctx) -> Result<()> {
    let root = ctx.vault_root()?;
    let s = &ctx.style;
    let mut problems = 0usize;
    let mut findings: Vec<serde_json::Value> = Vec::new();
    for sc in vault::vault_sidecars(&root)? {
        let ledger = sc.join("ledger.jsonl");
        let bad = sidecar::ledger_bad_lines(&ledger)?;
        if bad > 0 {
            problems += bad;
            findings.push(serde_json::json!({
                "sidecar": sc.display().to_string(), "kind": "bad-ledger-lines", "count": bad
            }));
        }
        // Note gone but sidecar remains?
        let note = sc.with_extension("md");
        if !note.is_file() {
            problems += 1;
            findings.push(serde_json::json!({
                "sidecar": sc.display().to_string(), "kind": "orphan-sidecar"
            }));
        }
        // Every recorded version must have its object.
        let events = sidecar::read_ledger_at(&ledger)?;
        let st = mica_core::fold_ledger_impl(&events);
        for (block, bs) in &st {
            for v in &bs.versions {
                if !object_exists(&sc, &v.hash) {
                    problems += 1;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(), "kind": "missing-object",
                        "block": block, "hash": v.hash
                    }));
                }
            }
        }
    }
    if ctx.json {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({"problems": problems, "findings": findings})
            )
            .unwrap_or_default()
        );
        return Ok(());
    }
    if problems == 0 {
        println!("{} vault sidecars healthy", s.green("✓"));
        return Ok(());
    }
    println!("{} {} problem(s):", s.red("✗"), problems);
    for f in &findings {
        let kind = f["kind"].as_str().unwrap_or("?");
        let sc = f["sidecar"].as_str().unwrap_or("?");
        match kind {
            "missing-object" => println!(
                "  {} missing object {} for block {} in {}",
                s.red("•"),
                s.cyan(f["hash"].as_str().unwrap_or("?")),
                f["block"].as_str().unwrap_or("?"),
                sc,
            ),
            "orphan-sidecar" => println!("  {} orphan sidecar (no note): {}", s.yellow("•"), sc),
            "bad-ledger-lines" => println!(
                "  {} {} unparseable ledger line(s) in {}",
                s.yellow("•"),
                f["count"],
                sc,
            ),
            _ => println!("  • {f}"),
        }
    }
    Ok(())
}

/// Whether a sidecar contains the recorded object in a supported storage form.
fn object_exists(sidecar: &Path, hash: &str) -> bool {
    let objects = sidecar.join("objects");
    let stem = hash.replace(':', "-");
    objects.join(format!("{stem}.mica.md")).is_file()
        || objects.join(format!("{stem}.mica.gz")).is_file()
}

/// Resolve a version selector (`vN`, `b3:hash`, or unique hash prefix) against
/// a block's stored versions.
///
/// Purpose: shared by `show`/`diff`/`restore`/`label`.
///
/// # Arguments
/// * `versions` - stored versions in add order
/// * `selector` - `vN` (1-based add order), full hash, or unique prefix
///
/// # Returns
/// The resolved hash.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// // resolve_version(&state.versions, "v2")
/// ```
pub fn resolve_version(versions: &[VersionMeta], selector: &str) -> Result<String> {
    if versions.is_empty() {
        return Err(CliError::NotFound(
            "no stored versions — run `mica snapshot` first".to_string(),
        ));
    }
    if let Some(n) = selector
        .strip_prefix('v')
        .and_then(|n| n.parse::<usize>().ok())
    {
        return versions
            .get(n.checked_sub(1).unwrap_or(usize::MAX))
            .map(|v| v.hash.clone())
            .ok_or_else(|| {
                CliError::NotFound(format!("no version v{n} — only {} stored", versions.len()))
            });
    }
    // Labels are addressable too.
    if let Some(v) = versions
        .iter()
        .find(|v| v.label.as_deref() == Some(selector))
    {
        return Ok(v.hash.clone());
    }
    let norm = if selector.starts_with("b3:") {
        selector.to_string()
    } else {
        format!("b3:{selector}")
    };
    let mut matches = versions
        .iter()
        .filter(|version| version.hash.starts_with(&norm));
    let Some(first) = matches.next() else {
        return Err(CliError::NotFound(format!(
            "no version matching '{selector}' — see `mica versions`"
        )));
    };
    let count = 1 + matches.count();
    if count == 1 {
        Ok(first.hash.clone())
    } else {
        Err(CliError::BadArgs(format!(
            "'{selector}' is ambiguous ({count} versions match) — give more hash characters"
        )))
    }
}

/// A block used by versioning must carry an id (stamp with `mica prepare`).
fn require_id(note: &NoteRef, located: &Located) -> Result<String> {
    match located.span.id() {
        Some(id) => Ok(id.to_string()),
        None => Err(CliError::BadArgs(format!(
            "this block has no id yet — run `mica prepare {}` first",
            note.vault_rel()
        ))),
    }
}

/// Read the note, locate the target block, and return everything a command needs.
fn load(ctx: &Ctx, target: &NoteBlock) -> Result<(NoteRef, String, Located)> {
    let note = ctx.note(&target.note)?;
    let doc = engine::read_doc(&note.abs)?;
    let located = blocks::locate(&doc, target.block.as_deref())?;
    Ok((note, doc, located))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn object_exists_accepts_plain_and_compressed_storage() {
        let temp = tempfile::tempdir().expect("temp dir");
        let sidecar = temp.path().join("N.mica");
        let objects = sidecar.join("objects");
        std::fs::create_dir_all(&objects).expect("objects dir");

        std::fs::write(objects.join("b3-plain.mica.md"), "plain").expect("plain object");
        assert!(object_exists(&sidecar, "b3:plain"));

        std::fs::write(objects.join("b3-compressed.mica.gz"), b"gzip").expect("gzip object");
        assert!(object_exists(&sidecar, "b3:compressed"));
    }
}

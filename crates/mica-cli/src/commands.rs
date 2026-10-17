//! One function per subcommand, plus the dispatcher.
//!
//! Every mutating command follows the plugin's write discipline: re-scan the
//! live document, apply the structural op via `mica-core`, write the whole
//! note back, then let the engine snapshot (change-gated).

use crate::blocks::{self, Located};
use crate::cli::{CellCmd, Cli, Cmd, GridCmd, NoteBlock, TabCmd};
use crate::engine;
use crate::error::{io_ctx, CliError, Result};
use crate::fsutil;
use crate::output::{rel_time, Style};
use crate::sidecar::{self, NoteStore, StoreRoot};
use crate::vault::{self, NoteRef};
use mica_core::{
    apply_ops_impl, content_signature_impl, diff_impl, ensure_ids_impl, hash_content_impl,
    make_patch_impl, migrate_tabs_impl, new_id_impl, parse_block_impl, reconcile_impl, scan_impl,
    serialize_impl, ContentRef, Cst, Event, GroupKind, Node, SidecarRef, StructOp, VersionMeta,
};
use std::collections::{BTreeMap, BTreeSet, HashSet};
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
pub fn dispatch(cli: Cli) -> Result<()> {
    let ctx = Ctx {
        vault: cli.vault,
        store_dir: cli.store_dir,
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
        Cmd::ResetHead { target, version } => reset_head(&ctx, &target, &version),
        Cmd::RemoveVersions { target, versions } => {
            set_versions_visible(&ctx, &target, &versions, false)
        }
        Cmd::RestoreVersions { target, versions } => {
            set_versions_visible(&ctx, &target, &versions, true)
        }
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
        Cmd::NormalizeSections {
            path,
            history,
            dry_run,
        } => crate::normalize::run(&ctx, &path, history, dry_run),
        Cmd::ConsolidateTabs {
            path,
            history,
            dry_run,
        } => crate::consolidate::run(&ctx, &path, history, dry_run),
        Cmd::Prepare { note } => prepare(&ctx, &note),
        Cmd::Repair => repair(&ctx),
        Cmd::Doctor => doctor(&ctx),
    }
}

/// Shared context for one command invocation.
pub struct Ctx {
    /// `--vault` as given.
    pub vault: Option<PathBuf>,
    /// Optional vault-relative `--store-dir` selection.
    pub store_dir: Option<String>,
    /// `--json` mode.
    pub json: bool,
    /// ANSI styling for human output.
    pub style: Style,
}

impl Ctx {
    /// Resolve a note argument against `--vault` / cwd.
    pub fn note(&self, note: &str) -> Result<NoteRef> {
        vault::resolve_note_at(note, self.vault.as_deref(), self.store_dir.as_deref())
    }

    fn ready_note(&self, note: &str) -> Result<NoteRef> {
        let note = self.note(note)?;
        note.store_root()?.require_ready()?;
        Ok(note)
    }

    fn store_root(&self) -> Result<StoreRoot> {
        let vault = vault::find_vault(self.vault.as_deref(), Path::new("."))?;
        StoreRoot::open_at(&vault, self.store_dir.as_deref())
    }
}

/// `mica ls` — list blocks (and optionally the nested tree).
pub fn ls(ctx: &Ctx, note: &str, tree: bool) -> Result<()> {
    let note = ctx.ready_note(note)?;
    let doc = engine::read_doc(&note.abs)?;
    let st = engine::state_from_document(&note, &doc)?;
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
    let (_, _, located) = load_ready(ctx, target)?;
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
    let (note, _doc, located) = load(ctx, target)?;
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
    apply_structural_many(ctx, target, |located, cst| {
        op(located, cst).map(|op| vec![op])
    })
}

/// Apply a sequence of dependent reducer operations and publish one note write.
fn apply_structural_many(
    ctx: &Ctx,
    target: &NoteBlock,
    ops: impl FnOnce(&Located, &Cst) -> Result<Vec<StructOp>>,
) -> Result<()> {
    let note = ctx.note(&target.note)?;
    let published = engine::mutate_exact(&note, |doc| {
        let located = blocks::locate(doc, target.block.as_deref())?;
        let mut cst = parse_block_impl(&located.content);
        let ops = ops(&located, &cst)?;
        if !apply_ops_impl(&mut cst, &ops) {
            return Err(CliError::BadArgs(
                "the operation does not apply (missing target, invalid text, or invalid move) — check `mica ls --tree`".to_string(),
            ));
        }
        let mut next = serialize_impl(&cst);
        if !next.is_empty() && !next.ends_with('\n') {
            next.push_str(engine::preferred_line_ending(doc));
        }
        let mut out = String::with_capacity(
            doc.len() - (located.span.content_end - located.span.content_start) + next.len(),
        );
        out.push_str(&doc[..located.span.content_start]);
        out.push_str(&next);
        out.push_str(&doc[located.span.content_end..]);
        Ok(out)
    })?;
    engine::snapshot_published(&note, &published, false)
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
            apply_structural_many(ctx, target, |_, cst| {
                let (insert, group_path, index) = match tabs_path(cst, path.as_deref())? {
                    Some(gp) => {
                        let raw_at = match at {
                            Some(ordinal) => {
                                tab_child_index(cst, &gp, *ordinal).unwrap_or(group_len(cst, &gp)?)
                            }
                            None => group_len(cst, &gp)?,
                        };
                        (
                            StructOp::InsertTab {
                                path: gp.clone(),
                                at: raw_at,
                            },
                            gp,
                            raw_at,
                        )
                    }
                    None => {
                        // No tabs group yet: create one at the root's end.
                        let root_len = group_len(cst, &[])?;
                        (
                            StructOp::InsertGroup {
                                path: vec![],
                                at: root_len,
                                kind: GroupKind::Tabs,
                            },
                            vec![root_len],
                            0,
                        )
                    }
                };
                let mut ops = vec![insert];
                if title != "New tab" {
                    ops.push(StructOp::RenameTab {
                        path: group_path,
                        index,
                        title: title.clone(),
                    });
                }
                Ok(ops)
            })
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
    let (note, doc, located) = load_ready(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state_from_document(&note, &doc)?;
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
                    "n": i + 1, "versionId": v.version_id, "hash": v.hash,
                    "ts": v.ts, "label": v.label,
                    "head": bs.head_version_id.as_deref() == Some(v.version_id.as_str()),
                })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return Ok(());
    }
    let s = &ctx.style;
    let now = engine::now_ms();
    for (i, v) in bs.versions.iter().enumerate().rev() {
        let head = if bs.head_version_id.as_deref() == Some(v.version_id.as_str()) {
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
            "{}  {}  {}  {}{}{}",
            s.bold(&format!("v{}", i + 1)),
            s.dim(&v.version_id),
            s.cyan(&v.hash),
            s.dim(&rel_time(v.ts, now)),
            label,
            head,
        );
    }
    if !bs.removed_versions.is_empty() {
        println!(
            "{}",
            s.dim(&format!(
                "{} removed checkpoint{} (use `mica restore-versions`)",
                bs.removed_versions.len(),
                if bs.removed_versions.len() == 1 {
                    ""
                } else {
                    "s"
                }
            ))
        );
    }
    Ok(())
}

/// `mica show` — print one stored version.
pub fn show(ctx: &Ctx, target: &NoteBlock, version: &str) -> Result<()> {
    let (note, doc, located) = load_ready(ctx, target)?;
    let id = require_id(&note, &located)?;
    let store = engine::require_store(&note, &doc)?;
    let st = engine::state_from_store(&store)?;
    let selected = resolve_history_version_meta(st.get(&id), version)?;
    let hash = &selected.hash;
    match sidecar::read_object(&store, hash)? {
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
    if !matches!(
        granularity,
        "line" | "word" | "char" | "line-word" | "line-char"
    ) {
        return Err(CliError::BadArgs(format!(
            "granularity must be line, word, or char (got '{granularity}')"
        )));
    }
    let (note, doc, located) = load_ready(ctx, target)?;
    let id = require_id(&note, &located)?;
    let store = engine::require_store(&note, &doc)?;
    let st = engine::state_from_store(&store)?;
    let block = st.get(&id);
    let versions = block.map(|block| block.versions.as_slice()).unwrap_or(&[]);

    let read = |hash: &str| -> Result<String> {
        sidecar::read_object(&store, hash)?.ok_or_else(|| {
            CliError::Corrupt(format!(
                "version {hash} is recorded but its object is missing — run `mica doctor`"
            ))
        })
    };

    // Base: --base, else the version before the newest, else the newest.
    let base_text = match base {
        Some(sel) => read(&resolve_history_version_meta(block, sel)?.hash)?,
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
        Some(sel) => read(&resolve_history_version_meta(block, sel)?.hash)?,
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
    let (note, doc, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state_from_document(&note, &doc)?;
    let selected = resolve_history_version_meta(st.get(&id), version)?;
    if engine::restore_as_checkpoint(&note, &id, &selected.version_id, &selected.hash)? {
        eprintln!(
            "mica: block {id} restored from {} as a new checkpoint",
            selected.version_id
        );
    } else {
        eprintln!("mica: no restore checkpoint created — there were no changes");
    }
    Ok(())
}

/// `mica reset-head` — replace the live block and continue from an old checkpoint.
pub fn reset_head(ctx: &Ctx, target: &NoteBlock, version: &str) -> Result<()> {
    let (note, doc, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state_from_document(&note, &doc)?;
    let selected = resolve_history_version_meta(st.get(&id), version)?;
    if engine::reset_head(&note, &id, &selected.version_id, &selected.hash)? {
        eprintln!(
            "mica: block {id} reset to {} — subsequent checkpoints branch from here",
            selected.version_id
        );
    } else {
        eprintln!("mica: block and HEAD already match the selected checkpoint");
    }
    Ok(())
}

/// Hide or restore logical checkpoints without deleting ledger/object data.
pub fn set_versions_visible(
    ctx: &Ctx,
    target: &NoteBlock,
    selectors: &[String],
    visible: bool,
) -> Result<()> {
    let (note, doc, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state_from_document(&note, &doc)?;
    let Some(block) = st.get(&id) else {
        return Err(CliError::NotFound(
            "no stored versions — run `mica snapshot` first".to_string(),
        ));
    };
    let candidates = if visible {
        block.removed_versions.as_slice()
    } else {
        block.versions.as_slice()
    };
    let ids = resolve_unique_version_ids(candidates, selectors)?;
    engine::set_versions_visible(&note, &id, &ids, visible)?;
    eprintln!(
        "mica: {} {} checkpoint{}",
        if visible {
            "restored to timeline"
        } else {
            "removed from timeline"
        },
        ids.len(),
        if ids.len() == 1 { "" } else { "s" }
    );
    Ok(())
}

/// `mica label` — label a stored version.
pub fn label_cmd(ctx: &Ctx, target: &NoteBlock, version: &str, label: &str) -> Result<()> {
    let (note, doc, located) = load(ctx, target)?;
    let id = require_id(&note, &located)?;
    let st = engine::state_from_document(&note, &doc)?;
    let selected = resolve_history_version_meta(st.get(&id), version)?;
    engine::label(&note, &id, &selected.version_id, label)
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
    if interval == 0 {
        return Err(CliError::BadArgs(
            "watch interval must be at least one second — pass --interval 1 or greater".to_string(),
        ));
    }
    let selected_store = ctx.store_root()?;
    let root = selected_store.vault.clone();
    let s = &ctx.style;
    eprintln!(
        "mica: watching {} (poll {interval}s, debounce {debounce}s) — Ctrl-C to stop",
        root.display()
    );
    let mut mtimes: BTreeMap<PathBuf, std::time::SystemTime> = BTreeMap::new();
    let mut dirty: BTreeMap<PathBuf, std::time::Instant> = BTreeMap::new();

    // Prime without snapshotting (existing state is not "a change").
    let initial_notes = vault::vault_notes_in(&selected_store)?;
    engine::refresh_watch_identities(&root, &initial_notes)?;
    for n in initial_notes {
        if let Ok(meta) = std::fs::metadata(&n) {
            if let Ok(m) = meta.modified() {
                mtimes.insert(n, m);
            }
        }
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(interval));
        let notes = vault::vault_notes_in(&selected_store)?;
        engine::refresh_watch_identities(&root, &notes)?;
        let current: BTreeSet<PathBuf> = notes.iter().cloned().collect();
        retain_current_watch_paths(&mut mtimes, &mut dirty, &current);
        for n in notes {
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
                store: Some(selected_store.clone()),
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

fn retain_current_watch_paths(
    mtimes: &mut BTreeMap<PathBuf, std::time::SystemTime>,
    dirty: &mut BTreeMap<PathBuf, std::time::Instant>,
    current: &BTreeSet<PathBuf>,
) {
    mtimes.retain(|path, _| current.contains(path));
    dirty.retain(|path, _| current.contains(path));
}

/// `mica migrate` — legacy ```tabs conversion (note or whole vault).
pub fn migrate(ctx: &Ctx, note: Option<&str>, dry_run: bool, callouts: Option<&str>) -> Result<()> {
    let callouts = callouts.unwrap_or(OBSIDIAN_CALLOUT_TYPES);
    let notes: Vec<NoteRef> = match note {
        Some(n) => {
            let note = ctx.note(n)?;
            if dry_run { note.store_root()?.require_ready()?; }
            vec![note]
        }
        None => {
            let selected_store = ctx.store_root()?;
            if dry_run { selected_store.require_ready()?; }
            let root = selected_store.vault.clone();
            vault::vault_notes_in(&selected_store)?
                .into_iter()
                .map(|abs| NoteRef {
                    abs,
                    vault: root.clone(),
                    store: Some(selected_store.clone()),
                })
                .collect()
        }
    };
    let s = &ctx.style;
    let mut reports = Vec::new();
    for n in notes {
        let source = engine::read_doc(&n.abs)?;
        let (recovery, journal_preimage) = match NoteStore::from_document(&n, &source)? {
            Some(store) => match sidecar::read_migration_journal_record(&store)? {
                Some((journal, bytes)) => (Some((store, journal)), Some(bytes)),
                None => (None, None),
            },
            None => (find_pending_migration_store(&n, &source)?, None),
        };
        if let Some((store, mut journal)) = recovery {
            if journal.status == "pending" {
                let migrated_blocks: BTreeSet<&str> = journal
                    .events
                    .iter()
                    .filter_map(|event| match event {
                        Event::AddVersion {
                            block,
                            origin: Some(origin),
                            ..
                        } if origin.starts_with("migrated:") => Some(block.as_str()),
                        Event::ReplaceVersion { .. }
                        | Event::SetHead { .. }
                        | Event::Label { .. }
                        | Event::Checkpoint { .. }
                        | Event::MoveHead { .. }
                        | Event::VersionLabel { .. }
                        | Event::VersionVisibility { .. } => None,
                        Event::AddVersion { .. } => None,
                    })
                    .collect();
                let imported = journal
                    .events
                    .iter()
                    .filter(|event| {
                        matches!(
                            event,
                            Event::AddVersion {
                                origin: Some(origin),
                                ..
                            } if origin.starts_with("migrated:")
                        )
                    })
                    .count();
                let blocks = sidecar::read_object(&store, &journal.original)?
                    .map(|original| migrate_tabs_impl(&original, callouts).blocks.len())
                    .unwrap_or(migrated_blocks.len());
                if !dry_run {
                    resume_migration(&n, &store, &mut journal)?;
                }
                reports.push((n.vault_rel(), blocks, imported));
                continue;
            }
        }
        let result = migrate_tabs_impl(&source, callouts);
        if !result.changed {
            continue;
        }
        let imported: usize = result.blocks.iter().map(|b| b.versions.len()).sum();
        if !dry_run {
            let doc = engine::prepare_history_document(&n, &source)?;
            let result = migrate_tabs_impl(&doc, callouts);
            let migrated = result.doc.clone();
            let store = engine::require_store(&n, &doc)?;
            engine::validate_journal_generations(&store, &doc, &migrated)?;
            engine::preflight_history_write(&store, &doc)?;
            // Stage both exact whole-note generations and every archive object
            // before publishing the live note. The pending journal below is the
            // durable, discoverable reference that makes an interrupted run
            // resumable rather than an anonymous orphan object.
            let original_hash = hash_content_impl(&doc);
            let migrated_hash = hash_content_impl(&migrated);
            let mut objects = BTreeMap::from([
                (original_hash.clone(), doc.clone()),
                (migrated_hash.clone(), migrated.clone()),
            ]);

            // Archived callouts become labeled versions, backdated a second
            // apart so the (ts, eid) fold orders them before the head below.
            let now = engine::now_ms();
            let mut events = Vec::with_capacity(imported);
            for block in &result.blocks {
                let count = block.versions.len() as u64;
                for (i, v) in block.versions.iter().enumerate() {
                    let hash = hash_content_impl(&v.content);
                    objects.insert(hash.clone(), v.content.clone());
                    events.push(Event::AddVersion {
                        eid: new_id_impl(),
                        ts: now.saturating_sub((count - i as u64).saturating_mul(1000)),
                        block: block.id.clone(),
                        hash,
                        label: Some(v.label.clone()),
                        origin: Some(format!("migrated:{}", v.status)),
                        parent: None,
                    });
                }
            }
            let mut journal = sidecar::MigrationJournal {
                format: 1,
                status: "pending".to_string(),
                note: n.vault_rel(),
                original: original_hash,
                migrated: migrated_hash,
                events,
            };
            for (hash, content) in &objects {
                sidecar::preflight_object_write(&store, hash, content)?;
            }
            sidecar::preflight_migration_journal(&store, &journal)?;
            sidecar::preflight_journal_claim(
                &store,
                &sidecar::migration_journal_path(&store),
                journal_preimage.as_deref(),
            )?;
            engine::preflight_journal_events(&store, &journal.events)?;
            engine::validate_note_identity(&n, &doc)?;
            store.root.claim_location()?;
            sidecar::preflight_note_record(&store)?;
            if doc != source {
                fsutil::atomic_write_if_unchanged(&n.abs, source.as_bytes(), doc.as_bytes())?;
            }
            engine::guard_note_store(&n, &store, &doc)?;
            for (hash, content) in &objects {
                sidecar::write_object(&store, hash, content)?;
                sidecar::verify_written_object(&store, hash, content)?;
            }
            sidecar::claim_migration_journal(
                &store,
                &journal,
                journal_preimage.as_deref(),
            )?;
            engine::guard_note_store(&n, &store, &doc)?;
            fsutil::atomic_write_if_unchanged(&n.abs, doc.as_bytes(), migrated.as_bytes())?;
            finish_migration(&n, &store, &migrated, &mut journal)?;
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

/// Discover only an already-staged central conversion whose exact original is
/// this unanchored source. Enumeration validates the manifest's hashed key and
/// contained current path; this never imports sidecars or creates an identity.
fn find_pending_migration_store(note: &NoteRef, source: &str) -> Result<Option<(NoteStore, sidecar::MigrationJournal)>> {
    let mut selected = None;
    for store in sidecar::enumerate_note_stores_in(&note.store_root()?)? {
        if store.note != note.abs { continue; }
        let Some(journal) = sidecar::read_migration_journal(&store)? else { continue; };
        if journal.status != "pending" { continue; }
        let original = sidecar::read_object(&store, &journal.original)?.ok_or_else(|| CliError::Corrupt(
            "pending central conversion is missing its exact original object; no new note identity was created".to_string()
        ))?;
        if original != source { continue; }
        if selected.replace((store, journal)).is_some() {
            return Err(CliError::Corrupt("multiple pending central conversions match this unanchored source; no history was changed".to_string()));
        }
    }
    Ok(selected)
}

fn guard_pending_migration_source(note: &NoteRef, store: &NoteStore, expected: &str, migrated: &str) -> Result<()> {
    engine::validate_journal_generations(store, expected, migrated)?;
    engine::validate_note_identity(note, migrated)?;
    sidecar::preflight_note_record(store)?;
    if engine::read_doc(&note.abs)? != expected {
        return Err(CliError::Corrupt("pending conversion source changed before publication; the note and journal were preserved".to_string()));
    }
    Ok(())
}

/// Resume a pending migration from either exact journaled generation.
fn resume_migration(note: &NoteRef, store: &NoteStore, journal: &mut sidecar::MigrationJournal) -> Result<()> {
    let original = sidecar::read_object(store, &journal.original)?.ok_or_else(|| {
        CliError::Corrupt(format!(
            "migration pre-image object {} is missing — restore it before retrying",
            journal.original
        ))
    })?;
    let migrated = sidecar::read_object(store, &journal.migrated)?.ok_or_else(|| {
        CliError::Corrupt(format!(
            "migration result object {} is missing — restore it before retrying",
            journal.migrated
        ))
    })?;
    engine::validate_journal_generations(store, &original, &migrated)?;
    engine::preflight_journal_events(store, &journal.events)?;
    let current = engine::read_doc(&note.abs)?;
    if current != original && current != migrated {
        return Err(CliError::Corrupt(format!(
            "note diverged from both generations in pending migration journal: {} — current contents were preserved",
            note.abs.display()
        )));
    }
    store.root.claim_location()?;
    guard_pending_migration_source(note, store, &current, &migrated)?;
    if current == original && original != migrated {
        fsutil::atomic_write_if_unchanged(&note.abs, current.as_bytes(), migrated.as_bytes())?;
    }
    finish_migration(note, store, &migrated, journal)
}

fn finish_migration(
    note: &NoteRef,
    store: &NoteStore,
    migrated: &str,
    journal: &mut sidecar::MigrationJournal,
) -> Result<()> {
    engine::guard_note_store(note, store, migrated)?;
    engine::preflight_journal_events(store, &journal.events)?;
    let status = sidecar::classify_event_batch(store, &journal.events)?;
    sidecar::append_events(store, &status.missing)?;
    if !sidecar::classify_event_batch(store, &journal.events)?.missing.is_empty() {
        return Err(CliError::Corrupt("migration ledger append could not be verified; the pending journal was preserved".to_string()));
    }
    let blocks = scan_impl(migrated);
    engine::snapshot_exact(note, store, migrated, &blocks, false)?;
    engine::guard_note_store(note, store, migrated)?;
    engine::refresh_manifest(note, store, &blocks)?;
    journal.status = "complete".to_string();
    sidecar::write_migration_journal(store, journal)
}

/// `mica prepare` — stamp frontmatter `mica-id` + block ids.
pub fn prepare(ctx: &Ctx, note: &str) -> Result<()> {
    let note = ctx.note(note)?;
    let doc = engine::read_doc(&note.abs)?;
    let next = ensure_ids_impl(&engine::prepare_history_document(&note, &doc)?);
    engine::validate_unique_ids(&next)?;
    let store = engine::require_store(&note, &next)?;
    engine::preflight_history_write(&store, &next)?;
    sidecar::preflight_note_record(&store)?;
    if next != doc {
        store.root.claim_location()?;
        sidecar::preflight_note_record(&store)?;
        fsutil::atomic_write_if_unchanged(&note.abs, doc.as_bytes(), next.as_bytes())?;
    }
    eprintln!("mica: {} prepared", note.vault_rel());
    Ok(())
}

/// `mica repair` — reconcile identity-bound central records and refresh path hints.
pub fn repair(ctx: &Ctx) -> Result<()> {
    let selected_store = ctx.store_root()?;
    let root = selected_store.vault.clone();
    let s = &ctx.style;
    let mut content = Vec::new();
    let mut by_identity = BTreeMap::new();
    for abs in vault::vault_notes_in(&selected_store)? {
        let note = NoteRef { abs, vault: root.clone(), store: Some(selected_store.clone()) };
        let doc = engine::read_doc(&note.abs)?;
        if let Some(id) = mica_core::note_id_impl(&doc)
            .map_err(|error| CliError::Corrupt(error.to_string()))? {
            if by_identity.insert(id.clone(), (note.clone(), doc.clone())).is_some() {
                return Err(CliError::BadArgs(format!(
                    "duplicate mica note id {id:?} — repair the copied identity before updating history hints"
                )));
            }
        }
        for block in scan_impl(&doc) {
            if let Some(id) = block.id() {
                content.push(ContentRef { block: id.to_string(), note: note.vault_rel() });
            }
        }
    }
    let stores = sidecar::enumerate_note_stores_in(&selected_store)?;
    let mut screfs = Vec::new();
    let mut updated_hints = Vec::new();
    for store in &stores {
        let events = sidecar::read_ledger(store)?;
        let record = sidecar::sidecar_dir(store).strip_prefix(&root)
            .map_err(|_| CliError::Corrupt("central note record escaped its vault".to_string()))?
            .to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let mut seen = BTreeSet::new();
        for event in &events {
            let block = match event {
                Event::AddVersion { block, .. } | Event::ReplaceVersion { block, .. }
                | Event::SetHead { block, .. } | Event::Label { block, .. }
                | Event::Checkpoint { block, .. } | Event::MoveHead { block, .. }
                | Event::VersionLabel { block, .. } | Event::VersionVisibility { block, .. } => block,
            };
            if seen.insert(block) {
                screfs.push(SidecarRef { block: block.clone(), sidecar: record.clone() });
            }
        }
        if let Some((note, doc)) = by_identity.get(&store.note_id) {
            if note.abs != store.note {
                let current = engine::require_store(note, doc)?;
                engine::guard_note_store(note, &current, doc)?;
                sidecar::update_note_hint(&current)?;
                updated_hints.push(note.vault_rel());
            }
        }
    }
    let actions = reconcile_impl(&content, &screfs);
    if ctx.json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "updatedHints": updated_hints, "actions": actions.len()
        })).unwrap_or_default());
        return Ok(());
    }
    for path in &updated_hints { println!("{} updated history path hint: {path}", s.green("✓")); }
    println!("{} issue(s) found, {} path hint(s) updated", actions.len(), updated_hints.len());
    for action in &actions { println!("  {}", s.yellow(&format!("{action:?}"))); }
    Ok(())
}

/// `mica doctor` — sidecar health report.
pub fn doctor(ctx: &Ctx) -> Result<()> {
    let selected_store = ctx.store_root()?;
    selected_store.require_ready()?;
    let s = &ctx.style;
    let mut problems = 0usize;
    let mut findings: Vec<serde_json::Value> = Vec::new();
    for store in sidecar::enumerate_note_stores_in(&selected_store)? {
        let sc = sidecar::sidecar_dir(&store);
        let ledger = sidecar::ledger_path(&store);
        let ledger_read = match sidecar::read_ledger_report_at(&ledger) {
            Ok(report) => {
                if report.bad_lines > 0 {
                    problems += report.bad_lines;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(), "kind": "bad-ledger-lines",
                        "count": report.bad_lines
                    }));
                }
                Some(report)
            }
            Err(error) => {
                problems += 1;
                findings.push(serde_json::json!({
                    "sidecar": sc.display().to_string(), "kind": "corrupt-ledger",
                    "detail": error.to_string()
                }));
                None
            }
        };
        // Note gone but sidecar remains?
        let note = store.note.clone();
        if note.is_file() {
            match engine::read_doc(&note).and_then(|source| mica_core::note_id_impl(&source)
                .map_err(|error| CliError::Corrupt(error.to_string()))) {
                Ok(id) if id.as_deref() == Some(store.note_id.as_str()) => {}
                Ok(_) => {
                    problems += 1;
                    findings.push(serde_json::json!({"sidecar": sc.display().to_string(), "kind": "note-identity-mismatch"}));
                }
                Err(error) => {
                    problems += 1;
                    findings.push(serde_json::json!({"sidecar": sc.display().to_string(), "kind": "note-identity-unreadable", "detail": error.to_string()}));
                }
            }
        }
        if !note.is_file() {
            problems += 1;
            findings.push(serde_json::json!({
                "sidecar": sc.display().to_string(), "kind": "orphan-sidecar"
            }));
        }
        match sidecar::read_migration_journal(&store) {
            Ok(Some(journal)) => {
                if journal.status == "pending" {
                    problems += 1;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(), "kind": "pending-migration"
                    }));
                }
                for (role, hash) in [
                    ("original", journal.original.as_str()),
                    ("migrated", journal.migrated.as_str()),
                ] {
                    match sidecar::read_object(&store, hash) {
                        Ok(Some(_)) => {}
                        Ok(None) => {
                            problems += 1;
                            findings.push(serde_json::json!({
                                "sidecar": sc.display().to_string(), "kind": "missing-migration-object",
                                "role": role, "hash": hash
                            }));
                        }
                        Err(error) => {
                            problems += 1;
                            findings.push(serde_json::json!({
                                "sidecar": sc.display().to_string(), "kind": "corrupt-migration-object",
                                "role": role, "hash": hash, "detail": error.to_string()
                            }));
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                problems += 1;
                findings.push(serde_json::json!({
                    "sidecar": sc.display().to_string(), "kind": "corrupt-migration-journal",
                    "detail": error.to_string()
                }));
            }
        }
        match sidecar::read_section_normalization_journal(&store) {
            Ok(Some(journal)) => {
                if journal.status == "pending" {
                    problems += 1;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(), "kind": "pending-normalization"
                    }));
                }
                let current = if journal.status == "pending" && note.is_file() {
                    match engine::read_doc(&note) {
                        Ok(current) => Some(current),
                        Err(error) => {
                            problems += 1;
                            findings.push(serde_json::json!({
                                "sidecar": sc.display().to_string(), "kind": "normalization-live-note-unreadable",
                                "detail": error.to_string()
                            }));
                            None
                        }
                    }
                } else {
                    None
                };
                let inspection = if let Some(ledger_read) = ledger_read.as_ref() {
                    crate::normalize::inspect_normalization_journal_with_ledger(
                        &store,
                        current.as_deref(),
                        &journal,
                        Some(ledger_read),
                    )
                } else {
                    crate::normalize::inspect_normalization_journal(
                        &store,
                        current.as_deref(),
                        &journal,
                    )
                };
                match inspection {
                    Ok(inspection) => {
                        problems += inspection.conflicts.len();
                        findings.extend(inspection.conflicts.into_iter().map(|conflict| {
                            serde_json::json!({
                                "sidecar": sc.display().to_string(),
                                "kind": conflict.kind,
                                "detail": conflict.detail,
                                "block": conflict.block,
                                "target": conflict.target,
                            })
                        }));
                    }
                    Err(error) => {
                        problems += 1;
                        findings.push(serde_json::json!({
                            "sidecar": sc.display().to_string(), "kind": "normalization-journal-validation-error",
                            "detail": error.to_string()
                        }));
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                problems += 1;
                findings.push(serde_json::json!({
                    "sidecar": sc.display().to_string(), "kind": "corrupt-normalization-journal",
                    "detail": error.to_string()
                }));
            }
        }
        match sidecar::read_tab_consolidation_journal(&store) {
            Ok(Some(journal)) if journal.status == "pending" => {
                problems += 1;
                findings.push(serde_json::json!({
                    "sidecar": sc.display().to_string(), "kind": "pending-tab-consolidation"
                }));
                for (role, hash) in [
                    ("original", journal.original.as_str()),
                    ("consolidated", journal.consolidated.as_str()),
                ] {
                    match sidecar::read_object(&store, hash) {
                        Ok(Some(_)) => {}
                        Ok(None) => {
                            problems += 1;
                            findings.push(serde_json::json!({
                                "sidecar": sc.display().to_string(),
                                "kind": "missing-tab-consolidation-object",
                                "role": role,
                                "hash": hash
                            }));
                        }
                        Err(error) => {
                            problems += 1;
                            findings.push(serde_json::json!({
                                "sidecar": sc.display().to_string(),
                                "kind": "corrupt-tab-consolidation-object",
                                "role": role,
                                "hash": hash,
                                "detail": error.to_string()
                            }));
                        }
                    }
                }
            }
            Ok(Some(journal)) => {
                if let Err(error) =
                    crate::consolidate::inspect_completed_journal(&store, &journal)
                {
                    problems += 1;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(),
                        "kind": "tab-consolidation-journal-validation-error",
                        "detail": error.to_string()
                    }));
                }
            }
            Ok(None) => {}
            Err(error) => {
                problems += 1;
                findings.push(serde_json::json!({
                    "sidecar": sc.display().to_string(),
                    "kind": "corrupt-tab-consolidation-journal",
                    "detail": error.to_string()
                }));
            }
        }

        // Validate both the append-only source record and its checked effective view.
        let events = ledger_read
            .map(|ledger_read| ledger_read.events)
            .unwrap_or_default();
        let resolution = match mica_core::resolve_ledger_impl(&events) {
            Ok(resolution) => Some(resolution),
            Err(error) => {
                problems += 1;
                findings.push(serde_json::json!({
                    "sidecar": sc.display().to_string(), "kind": "invalid-ledger-resolution",
                    "detail": error.to_string()
                }));
                None
            }
        };

        let raw_versions: BTreeSet<(&str, &str)> = events
            .iter()
            .filter_map(|event| match event {
                Event::AddVersion { block, hash, .. } | Event::Checkpoint { block, hash, .. } => {
                    Some((block.as_str(), hash.as_str()))
                }
                _ => None,
            })
            .collect();
        for (block, hash) in raw_versions {
            match sidecar::read_object(&store, hash) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    problems += 1;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(), "kind": "missing-raw-object",
                        "block": block, "hash": hash
                    }));
                }
                Err(error) => {
                    problems += 1;
                    findings.push(serde_json::json!({
                        "sidecar": sc.display().to_string(), "kind": "corrupt-raw-object",
                        "block": block, "hash": hash, "detail": error.to_string()
                    }));
                }
            }
        }

        if let Some(resolution) = &resolution {
            for replacement in &resolution.replacements {
                let raw = sidecar::read_object(&store, &replacement.original);
                let replaced = sidecar::read_object(&store, &replacement.replacement);
                match &replaced {
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        problems += 1;
                        findings.push(serde_json::json!({
                            "sidecar": sc.display().to_string(), "kind": "missing-replacement-object",
                            "block": replacement.block, "target": replacement.target,
                            "hash": replacement.replacement
                        }));
                    }
                    Err(error) => {
                        problems += 1;
                        findings.push(serde_json::json!({
                            "sidecar": sc.display().to_string(), "kind": "corrupt-replacement-object",
                            "block": replacement.block, "target": replacement.target,
                            "hash": replacement.replacement, "detail": error.to_string()
                        }));
                    }
                }
                if let (Ok(Some(raw)), Ok(Some(replaced))) = (raw, replaced) {
                    if content_signature_impl(&raw) != content_signature_impl(&replaced) {
                        problems += 1;
                        findings.push(serde_json::json!({
                            "sidecar": sc.display().to_string(), "kind": "replacement-signature-mismatch",
                            "block": replacement.block, "target": replacement.target,
                            "original": replacement.original, "replacement": replacement.replacement
                        }));
                    }
                }
            }
        }

        // Every version and head in the checked effective view must have its object.
        for (block, bs) in resolution
            .as_ref()
            .into_iter()
            .flat_map(|resolution| &resolution.blocks)
        {
            let hashes: BTreeSet<&str> = bs
                .versions
                .iter()
                .map(|version| version.hash.as_str())
                .chain(bs.head.as_deref())
                .collect();
            for hash in hashes {
                match sidecar::read_object(&store, hash) {
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        problems += 1;
                        findings.push(serde_json::json!({
                            "sidecar": sc.display().to_string(), "kind": "missing-object",
                            "block": block, "hash": hash
                        }));
                    }
                    Err(error) => {
                        problems += 1;
                        findings.push(serde_json::json!({
                            "sidecar": sc.display().to_string(), "kind": "corrupt-object",
                            "block": block, "hash": hash, "detail": error.to_string()
                        }));
                    }
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
        println!("{} central note histories healthy", s.green("✓"));
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
            "corrupt-object" => println!(
                "  {} corrupt object {} for block {} in {}: {}",
                s.red("•"),
                s.cyan(f["hash"].as_str().unwrap_or("?")),
                f["block"].as_str().unwrap_or("?"),
                sc,
                f["detail"].as_str().unwrap_or("digest verification failed"),
            ),
            "pending-migration" => println!(
                "  {} pending migration can be resumed in {}",
                s.yellow("•"),
                sc,
            ),
            "missing-migration-object" | "corrupt-migration-object" => println!(
                "  {} {} migration {} object {} in {}",
                s.red("•"),
                if kind.starts_with("missing") {
                    "missing"
                } else {
                    "corrupt"
                },
                f["role"].as_str().unwrap_or("recovery"),
                f["hash"].as_str().unwrap_or("?"),
                sc,
            ),
            "corrupt-migration-journal" => println!(
                "  {} corrupt migration journal in {}: {}",
                s.red("•"),
                sc,
                f["detail"].as_str().unwrap_or("invalid journal"),
            ),
            _ => println!("  • {f}"),
        }
    }
    Ok(())
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
/// ```text
/// resolve_version(versions, "v2")
/// ```
pub fn resolve_version(versions: &[VersionMeta], selector: &str) -> Result<String> {
    resolve_version_meta(versions, selector).map(|version| version.hash.clone())
}

/// Resolve a selector to one logical checkpoint, preserving duplicate hashes.
pub fn resolve_version_meta<'a>(
    versions: &'a [VersionMeta],
    selector: &str,
) -> Result<&'a VersionMeta> {
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
            .ok_or_else(|| {
                CliError::NotFound(format!("no version v{n} — only {} stored", versions.len()))
            });
    }
    if let Some(version) = versions
        .iter()
        .find(|version| version.version_id == selector)
    {
        return Ok(version);
    }
    let id_matches = versions
        .iter()
        .filter(|version| version.version_id.starts_with(selector))
        .collect::<Vec<_>>();
    if id_matches.len() == 1 {
        return Ok(id_matches[0]);
    }
    if id_matches.len() > 1 {
        return Err(CliError::BadArgs(format!(
            "'{selector}' is ambiguous ({} checkpoint ids match) — give more id characters",
            id_matches.len()
        )));
    }
    let label_matches = versions
        .iter()
        .filter(|version| version.label.as_deref() == Some(selector))
        .collect::<Vec<_>>();
    if label_matches.len() == 1 {
        return Ok(label_matches[0]);
    }
    if label_matches.len() > 1 {
        return Err(CliError::BadArgs(format!(
            "'{selector}' is ambiguous ({} labels match) — use a checkpoint id",
            label_matches.len()
        )));
    }
    let norm = if selector.starts_with("b3:") {
        selector.to_string()
    } else {
        format!("b3:{selector}")
    };
    let matches = versions
        .iter()
        .filter(|version| version.hash.starts_with(&norm))
        .collect::<Vec<_>>();
    let Some(first) = matches.first() else {
        return Err(CliError::NotFound(format!(
            "no version matching '{selector}' — see `mica versions`"
        )));
    };
    if matches.len() == 1 {
        Ok(*first)
    } else {
        Err(CliError::BadArgs(format!(
            "'{selector}' is ambiguous ({} checkpoints match) — use a checkpoint id",
            matches.len()
        )))
    }
}

fn resolve_history_version_meta<'a>(
    block: Option<&'a mica_core::BlockState>,
    selector: &str,
) -> Result<&'a VersionMeta> {
    // Exact checkpoint targeting is O(V + R) time and O(1) space across
    // visible (V) and removed (R) history; other selector forms retain the
    // visible-only resolver's existing scope and complexity.
    if let Some(version) = block
        .into_iter()
        .flat_map(|block| block.versions.iter().chain(&block.removed_versions))
        .find(|version| version.version_id == selector)
    {
        return Ok(version);
    }
    let visible = block
        .map(|block| block.versions.as_slice())
        .unwrap_or_default();
    resolve_version_meta(visible, selector)
}

fn resolve_unique_version_ids(
    versions: &[VersionMeta],
    selectors: &[String],
) -> Result<Vec<String>> {
    let mut ids = Vec::with_capacity(selectors.len());
    let mut seen = HashSet::with_capacity(selectors.len());
    // O(k * v) selector resolution plus O(k) expected deduplication, where k
    // is selectors and v is candidate versions. Output preserves first use.
    for selector in selectors {
        let version = resolve_version_meta(versions, selector)?;
        if seen.insert(version.version_id.as_str()) {
            ids.push(version.version_id.clone());
        }
    }
    Ok(ids)
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

/// Ordinary reads must not treat an interrupted initialization as empty history.
fn load_ready(ctx: &Ctx, target: &NoteBlock) -> Result<(NoteRef, String, Located)> {
    let note = ctx.ready_note(&target.note)?;
    let doc = engine::read_doc(&note.abs)?;
    let located = blocks::locate(&doc, target.block.as_deref())?;
    Ok((note, doc, located))
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
    fn bulk_version_ids_deduplicate_in_first_selector_order() {
        let version = |version_id: &str, hash: &str| VersionMeta {
            version_id: version_id.to_string(),
            hash: hash.to_string(),
            ts: 1,
            label: None,
            parent: None,
            parent_version_id: None,
            effective_parent_version_id: None,
            lineage_root: true,
            source_version_id: None,
            cause: None,
            visible: true,
        };
        let versions = vec![
            version("first", "b3:first"),
            version("second", "b3:second"),
            version("third", "b3:third"),
        ];
        let selectors = ["v2", "v1", "second", "third"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();

        assert_eq!(
            resolve_unique_version_ids(&versions, &selectors).expect("resolve selectors"),
            ["second", "first", "third"]
        );
    }

    #[test]
    fn watch_state_forgets_deleted_paths() {
        let kept = PathBuf::from("kept.md");
        let deleted = PathBuf::from("deleted.md");
        let mut mtimes = BTreeMap::from([
            (kept.clone(), std::time::SystemTime::UNIX_EPOCH),
            (deleted.clone(), std::time::SystemTime::UNIX_EPOCH),
        ]);
        let now = std::time::Instant::now();
        let mut dirty = BTreeMap::from([(kept.clone(), now), (deleted.clone(), now)]);
        let current = BTreeSet::from([kept.clone()]);

        retain_current_watch_paths(&mut mtimes, &mut dirty, &current);

        assert_eq!(mtimes.keys().collect::<Vec<_>>(), vec![&kept]);
        assert_eq!(dirty.keys().collect::<Vec<_>>(), vec![&kept]);
    }

    #[test]
    fn frontmatter_id_uses_an_existing_empty_block() {
        let source = "---\n---\n\nbody\n";
        let prepared = with_note_frontmatter_id(source);

        assert!(prepared.starts_with("---\nmica-id: "));
        assert_eq!(prepared.matches("---\n").count(), 2);
        assert!(prepared.ends_with("---\n\nbody\n"));
    }

    #[test]
    fn frontmatter_id_preserves_yaml_document_end_marker() {
        let existing = "---\ntitle: Example\nmica-id: stable-id\n...\nbody\n";
        assert_eq!(with_note_frontmatter_id(existing), existing);

        let missing = "---\ntitle: Example\n...\nbody\n";
        let prepared = with_note_frontmatter_id(missing);
        assert!(prepared.starts_with("---\ntitle: Example\nmica-id: "));
        assert!(prepared.ends_with("\n...\nbody\n"));
        assert_eq!(prepared.matches("---\n").count(), 1);
    }

    fn test_store(note: &NoteRef) -> NoteStore {
        engine::require_store(note, &engine::read_doc(&note.abs).expect("fixture source")).expect("fixture store")
    }

    fn with_note_frontmatter_id(doc: &str) -> String {
        match mica_core::note_id_impl(doc).expect("fixture identity") {
            Some(_) => doc.to_string(),
            None => mica_core::set_note_id_impl(doc, None, "fixture-note").expect("fixture anchor"),
        }
    }

    fn pending_migration_fixture(
        current: &str,
    ) -> (tempfile::TempDir, NoteRef, sidecar::MigrationJournal) {
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = NoteRef {
            abs: dir.path().join("Note.md"),
            vault: dir.path().to_path_buf(),
            store: None,
        };
        std::fs::write(&note.abs, with_note_frontmatter_id(current)).expect("seed note");
        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=block\nold\n```\n";
        let migrated = "---\nmica-id: fixture-note\n---\n\n```mica id=block\nnew\n```\n";
        let archive = "archived\n";
        let original_hash = hash_content_impl(original);
        let migrated_hash = hash_content_impl(migrated);
        let archive_hash = hash_content_impl(archive);
        sidecar::write_object(&test_store(&note), &original_hash, original).expect("original object");
        sidecar::write_object(&test_store(&note), &migrated_hash, migrated).expect("migrated object");
        sidecar::write_object(&test_store(&note), &archive_hash, archive).expect("archive object");
        let journal = sidecar::MigrationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original: original_hash,
            migrated: migrated_hash,
            events: vec![Event::AddVersion {
                eid: "migration-event".to_string(),
                ts: 1,
                block: "block".to_string(),
                hash: archive_hash,
                label: Some("archive".to_string()),
                origin: Some("migrated:test".to_string()),
                parent: None,
            }],
        };
        sidecar::write_migration_journal(&test_store(&note), &journal).expect("pending journal");
        (dir, note, journal)
    }

    #[test]
    fn migration_resumes_from_original_or_migrated_generation() {
        for current in [
            "```mica id=block\nold\n```\n",
            "```mica id=block\nnew\n```\n",
        ] {
            let (_dir, note, mut journal) = pending_migration_fixture(current);
            resume_migration(&note, &test_store(&note), &mut journal).expect("resume migration");
            assert_eq!(
                engine::read_doc(&note.abs).expect("read note"),
                with_note_frontmatter_id("```mica id=block\nnew\n```\n")
            );
            let stored = sidecar::read_migration_journal(&test_store(&note))
                .expect("read journal")
                .expect("journal exists");
            assert_eq!(stored.status, "complete");
            assert!(sidecar::read_object(&test_store(&note), &stored.original)
                .expect("read original")
                .is_some());
            let state = engine::state(&note).expect("state");
            assert_eq!(state.get("block").expect("block").versions.len(), 2);
        }
    }

    #[test]
    fn pending_migration_never_overwrites_a_divergent_note() {
        let divergent = "```mica id=block\nuser edit\n```\n";
        let (_dir, note, mut journal) = pending_migration_fixture(divergent);
        assert!(matches!(
            resume_migration(&note, &test_store(&note), &mut journal),
            Err(CliError::Corrupt(message)) if message.contains("diverged")
        ));
        assert_eq!(engine::read_doc(&note.abs).expect("read note"), with_note_frontmatter_id(divergent));
        assert_eq!(
            sidecar::read_migration_journal(&test_store(&note))
                .expect("read journal")
                .expect("journal")
                .status,
            "pending"
        );
    }

    #[test]
    fn migration_dry_run_does_not_resume_pending_journal() {
        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=block\nold\n```\n";
        let (_dir, note, _journal) = pending_migration_fixture(original);
        let ctx = Ctx {
            vault: Some(note.vault.clone()),
            store_dir: None,
            json: false,
            style: Style::forced(false),
        };
        migrate(&ctx, Some("Note.md"), true, None).expect("dry run");
        assert_eq!(engine::read_doc(&note.abs).expect("read note"), original);
        assert_eq!(
            sidecar::read_migration_journal(&test_store(&note))
                .expect("read journal")
                .expect("journal")
                .status,
            "pending"
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_migration_ledger_append_remains_recoverable() {
        use std::os::unix::fs::symlink;

        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=block\nold\n```\n";
        let (_dir, note, mut journal) = pending_migration_fixture(original);
        let outside = note.vault.join("outside-ledger");
        std::fs::write(&outside, b"outside").expect("outside file");
        symlink(&outside, sidecar::ledger_path(&test_store(&note))).expect("ledger symlink");

        assert!(matches!(
            resume_migration(&note, &test_store(&note), &mut journal),
            Err(CliError::Corrupt(_))
        ));
        let pending = sidecar::read_migration_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal");
        assert_eq!(pending.status, "pending");
        assert!(sidecar::read_object(&test_store(&note), &pending.original)
            .expect("read original")
            .is_some());
        assert_eq!(std::fs::read(&outside).expect("outside"), b"outside");

        std::fs::remove_file(sidecar::ledger_path(&test_store(&note))).expect("remove bad ledger");
        resume_migration(&note, &test_store(&note), &mut journal).expect("retry migration");
        assert_eq!(
            sidecar::read_migration_journal(&test_store(&note))
                .expect("read journal")
                .expect("journal")
                .status,
            "complete"
        );
    }
}

//! Versioning engine — the CLI twin of the plugin's `VersionEngine`, sharing
//! its exact gating semantics through `mica-core`.
//!
//! Invariants (identical to the plugin):
//! - objects are immutable and content-addressed; the ledger is append-only;
//! - a byte-identical head is never re-stored;
//! - without `force`, only *content* changes (signature) mint versions;
//! - destructive operations snapshot the current state first.

use crate::error::{io_ctx, CliError, Result};
use crate::sidecar;
use crate::vault::NoteRef;
use mica_core::{
    ensure_ids_impl, fold_ledger_impl, hash_content_impl, new_id_impl, replace_block_content_impl,
    scan_impl, should_snapshot_impl, BlockState, Event, HeadRef,
};
use std::collections::BTreeMap;
use std::path::Path;

/// What `snapshot_note` did for one block.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SnapshotAction {
    /// Block id.
    pub block: String,
    /// New head hash when a version was written.
    pub hash: Option<String>,
    /// Why nothing was written (`unchanged`, `no content`, …) when `hash` is None.
    pub skipped: Option<String>,
}

/// Fold the note's ledger into per-block state.
///
/// Purpose: single accessor for "what versions exist".
///
/// # Arguments
/// * `note` - the note whose sidecar to fold
///
/// # Returns
/// Block id → state map.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let st = mica_cli::engine::state(std::path::Path::new("Note.md")).unwrap();
/// ```
pub fn state(note: &Path) -> Result<BTreeMap<String, BlockState>> {
    Ok(fold_ledger_impl(&sidecar::read_ledger(note)?))
}

/// Snapshot every id-carrying block in the note (change-gated unless `force`).
/// Also stamps missing block ids when `stamp_ids` and refreshes the manifest
/// after any write.
///
/// Purpose: the `snapshot` command, `watch` ticks, and the pre-write guard
/// used by `set`/`restore`/structural edits.
///
/// # Arguments
/// * `note` - resolved note
/// * `force` - bypass the content-signature gate (manual "Save version")
/// * `stamp_ids` - add ids to id-less blocks first (like the plugin's auto-add)
///
/// # Returns
/// One action per considered block.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::vault::NoteRef = todo!();
/// let report = mica_cli::engine::snapshot_note(&note, false, true).unwrap();
/// ```
pub fn snapshot_note(note: &NoteRef, force: bool, stamp_ids: bool) -> Result<Vec<SnapshotAction>> {
    let mut doc = read_doc(&note.abs)?;
    let mut blocks = scan_impl(&doc);
    if !blocks.iter().any(|b| b.closed) {
        return Ok(Vec::new());
    }
    if stamp_ids && blocks.iter().any(|b| b.closed && b.id().is_none()) {
        let next = ensure_ids_impl(&doc);
        if next != doc {
            std::fs::write(&note.abs, &next).map_err(io_ctx(note.abs.display().to_string()))?;
            doc = next;
            blocks = scan_impl(&doc);
        }
    }

    let st = state(&note.abs)?;
    let mut actions = Vec::new();
    let mut events: Vec<Event> = Vec::new();
    for b in &blocks {
        let Some(id) = b.id() else { continue };
        if !b.closed {
            continue;
        }
        let content = &doc[b.content_start..b.content_end];
        let hash = hash_content_impl(content);
        let head = st.get(id).and_then(|s| s.head.clone());
        if head.as_deref() == Some(hash.as_str()) {
            actions.push(SnapshotAction {
                block: id.to_string(),
                hash: None,
                skipped: Some("unchanged".to_string()),
            });
            continue;
        }
        let head_content = match &head {
            None => None,
            Some(h) => sidecar::read_object(&note.abs, h)?,
        };
        let head_ref = match (&head, &head_content) {
            (None, _) => HeadRef::None,
            (Some(_), None) => HeadRef::Missing,
            (Some(_), Some(c)) => HeadRef::Content(c),
        };
        if should_snapshot_impl(content, head_ref, force) {
            write_version(note, id, &hash, content, &mut events)?;
            actions.push(SnapshotAction {
                block: id.to_string(),
                hash: Some(hash),
                skipped: None,
            });
        } else {
            let why = if head.is_none() {
                "no content yet"
            } else {
                "no content change"
            };
            actions.push(SnapshotAction {
                block: id.to_string(),
                hash: None,
                skipped: Some(why.to_string()),
            });
        }
    }
    sidecar::append_events(&note.abs, &events)?;
    if !events.is_empty() {
        refresh_manifest(note, &doc)?;
    }
    Ok(actions)
}

/// Store one version: object write + add-version/set-head events.
fn write_version(
    note: &NoteRef,
    id: &str,
    hash: &str,
    content: &str,
    events: &mut Vec<Event>,
) -> Result<()> {
    sidecar::write_object(&note.abs, hash, content)?;
    let ts = now_ms();
    events.push(Event::AddVersion {
        eid: new_id_impl(),
        ts,
        block: id.to_string(),
        hash: hash.to_string(),
        label: None,
        origin: None,
        parent: None,
    });
    events.push(Event::SetHead {
        eid: new_id_impl(),
        ts,
        block: id.to_string(),
        hash: hash.to_string(),
    });
    Ok(())
}

/// Rewrite the manifest from the current doc (block names) + frontmatter id.
fn refresh_manifest(note: &NoteRef, doc: &str) -> Result<()> {
    let blocks: Vec<(String, String)> = scan_impl(doc)
        .iter()
        .filter_map(|b| {
            b.id().map(|id| {
                (
                    id.to_string(),
                    b.get("name").unwrap_or_default().to_string(),
                )
            })
        })
        .collect();
    let note_id = frontmatter_mica_id(doc);
    sidecar::write_manifest(
        &note.abs,
        note_id.as_deref(),
        &note.vault_rel(),
        &blocks,
        now_ms(),
    )
}

/// Extract `mica-id: …` from YAML frontmatter, if present.
pub fn frontmatter_mica_id(doc: &str) -> Option<String> {
    let body = doc
        .strip_prefix("---\n")
        .or_else(|| doc.strip_prefix("---\r\n"))?;
    let end = body.find("\n---").map(|i| i + 1)?;
    body[..end].lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == "mica-id").then(|| v.trim().trim_matches('"').to_string())
    })
}

/// Rewrite block `block_id`'s content to a stored version, snapshotting the
/// current state first, and record `set-head`.
///
/// Purpose: the `restore` command.
///
/// # Arguments
/// * `note` - resolved note
/// * `block_id` - target block
/// * `hash` - stored version to restore
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::vault::NoteRef = todo!();
/// mica_cli::engine::restore(&note, "id", "b3:00").unwrap();
/// ```
pub fn restore(note: &NoteRef, block_id: &str, hash: &str) -> Result<()> {
    snapshot_note(note, false, true)?; // preserve whatever is inline right now
    let Some(content) = sidecar::read_object(&note.abs, hash)? else {
        return Err(CliError::NotFound(format!(
            "version object {hash} is missing from the sidecar — run `mica doctor`"
        )));
    };
    let doc = read_doc(&note.abs)?;
    let terminated = terminate(&content);
    let Some(next) = replace_block_content_impl(&doc, block_id, &terminated) else {
        return Err(CliError::NotFound(format!(
            "block {block_id} not found in the note"
        )));
    };
    std::fs::write(&note.abs, next).map_err(io_ctx(note.abs.display().to_string()))?;
    sidecar::append_events(
        &note.abs,
        &[Event::SetHead {
            eid: new_id_impl(),
            ts: now_ms(),
            block: block_id.to_string(),
            hash: hash.to_string(),
        }],
    )
}

/// Replace block content wholesale (the `set` command): snapshot before,
/// write, snapshot after — an external edit can never destroy the only copy.
///
/// Purpose: scripted content updates with the plugin's safety contract.
///
/// # Arguments
/// * `note` - resolved note
/// * `block_id` - target block
/// * `content` - new inner content (newline-terminated automatically)
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::vault::NoteRef = todo!();
/// mica_cli::engine::set_content(&note, "id", "new body\n").unwrap();
/// ```
pub fn set_content(note: &NoteRef, block_id: &str, content: &str) -> Result<()> {
    snapshot_note(note, false, true)?;
    let doc = read_doc(&note.abs)?;
    let terminated = terminate(content);
    let Some(next) = replace_block_content_impl(&doc, block_id, &terminated) else {
        return Err(CliError::NotFound(format!(
            "block {block_id} not found in the note"
        )));
    };
    std::fs::write(&note.abs, next).map_err(io_ctx(note.abs.display().to_string()))?;
    snapshot_note(note, false, true)?;
    Ok(())
}

/// Record a label for a stored version (empty label clears it).
///
/// Purpose: the `label` command; labels power the versions timeline.
///
/// # Arguments
/// * `note` - resolved note
/// * `block_id` - target block
/// * `hash` - stored version to (re)label
/// * `label` - new label; empty clears
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::vault::NoteRef = todo!();
/// mica_cli::engine::label(&note, "id", "b3:00", "v1.0").unwrap();
/// ```
pub fn label(note: &NoteRef, block_id: &str, hash: &str, label: &str) -> Result<()> {
    sidecar::append_events(
        &note.abs,
        &[Event::Label {
            eid: new_id_impl(),
            ts: now_ms(),
            block: block_id.to_string(),
            hash: hash.to_string(),
            label: if label.is_empty() {
                None
            } else {
                Some(label.to_string())
            },
        }],
    )
}

/// Current unix time in milliseconds (the ledger's `ts` unit).
pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => u64::try_from(d.as_millis()).unwrap_or(u64::MAX), // INVARIANT: not before 1970
        Err(_) => 0, // clock before epoch — degrade to 0 rather than fail a snapshot
    }
}

/// Newline-terminate content so it can never glue onto the closing fence.
fn terminate(content: &str) -> String {
    if !content.is_empty() && !content.ends_with('\n') {
        format!("{content}\n")
    } else {
        content.to_string()
    }
}

/// Read a note file with a path-carrying error.
pub fn read_doc(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(io_ctx(path.display().to_string()))
}

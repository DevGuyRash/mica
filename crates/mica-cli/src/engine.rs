//! Versioning engine — the CLI twin of the plugin's `VersionEngine`, sharing
//! its exact gating semantics through `mica-core`.
//!
//! Invariants (identical to the plugin):
//! - objects are immutable and content-addressed; the ledger is append-only;
//! - a byte-identical head is never re-stored;
//! - without `force`, only *content* changes (signature) mint versions;
//! - destructive operations snapshot the current state first.

use crate::error::{io_ctx, CliError, Result};
use crate::fsutil;
use crate::sidecar;
use crate::vault::{self, NoteRef};
use crate::sidecar::NoteStore;
use mica_core::{
    ensure_ids_impl, fold_ledger_impl, hash_content_impl, new_id_impl, replace_block_content_impl,
    scan_impl, should_snapshot_impl, note_id_impl, set_note_id_impl, BlockState, Event, HeadRef,
};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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
/// # let note: mica_cli::vault::NoteRef = todo!();
/// let st = mica_cli::engine::state(&note).unwrap();
/// ```
pub fn state(note: &NoteRef) -> Result<BTreeMap<String, BlockState>> {
    note.store_root()?.require_ready()?;
    state_from_document(note, &read_doc(&note.abs)?)
}

/// Resolve history against the caller's authoritative source generation.
pub(crate) fn state_from_document(note: &NoteRef, doc: &str) -> Result<BTreeMap<String, BlockState>> {
    let Some(store) = NoteStore::from_document(note, doc)? else {
        return Ok(BTreeMap::new());
    };
    state_from_store(&store)
}

pub(crate) fn state_from_store(store: &NoteStore) -> Result<BTreeMap<String, BlockState>> {
    fold_ledger_impl(&sidecar::read_ledger(store)?)
        .map_err(|error| CliError::Corrupt(error.to_string()))
}

/// Existing history operations must never mint a replacement source identity.
pub(crate) fn require_store(note: &NoteRef, doc: &str) -> Result<NoteStore> {
    NoteStore::from_document(note, doc)?.ok_or_else(|| CliError::NotFound(format!(
        "history is not prepared for {} — run `mica prepare` or `mica snapshot` first",
        note.vault_rel()
    )))
}

/// Derive an anchor for an authorized write without publishing it yet.
pub(crate) fn prepare_history_document(note: &NoteRef, doc: &str) -> Result<String> {
    note.store_root()?;
    let prepared = match note_id_impl(doc).map_err(|error| CliError::Corrupt(error.to_string()))? {
        Some(_) => doc.to_string(),
        None => set_note_id_impl(doc, None, &new_id_impl())
            .map_err(|error| CliError::Corrupt(error.to_string()))?,
    };
    validate_note_identity(note, &prepared)?;
    Ok(prepared)
}

/// Bulk dry runs keep unprepared source bytes unchanged and use a transient
/// context only to validate the prospective storage destination. No UUID is
/// minted and no marker, note, manifest, journal, or object is created.
pub(crate) fn plan_history_store(note: &NoteRef, source: &str, dry_run: bool) -> Result<(String, NoteStore)> {
    if dry_run { note.store_root()?.require_ready()?; }
    if let Some(store) = NoteStore::from_document(note, source)? {
        validate_note_identity(note, source)?;
        return Ok((source.to_string(), store));
    }
    if dry_run {
        let prospective = NoteStore::for_id_in(&note.store_root()?, &note.abs, "unprepared-dry-run")?;
        // This transient context may describe only a missing record. It must
        // never interpret some other live note's chosen opaque identity.
        if sidecar::sidecar_dir(&prospective).try_exists()
            .map_err(io_ctx("prospective dry-run note record".to_string()))? {
            return Err(CliError::NotFound("history is not prepared; run `mica prepare` before this dry run".to_string()));
        }
        return Ok((source.to_string(), prospective));
    }
    let prepared = prepare_history_document(note, source)?;
    let store = require_store(note, &prepared)?;
    Ok((prepared, store))
}

/// Validate storage before publishing a newly staged source anchor.
pub(crate) fn preflight_history_write(store: &NoteStore, doc: &str) -> Result<()> {
    sidecar::preflight_note_record(store)?;
    let ledger = sidecar::read_ledger_report(store)?;
    if ledger.bad_lines != 0 {
        return Err(CliError::Corrupt("history contains invalid ledger lines; run `mica doctor` before writing".to_string()));
    }
    let states = fold_ledger_impl(&ledger.events).map_err(|error| CliError::Corrupt(error.to_string()))?;
    for state in states.values() {
        if let Some(head) = state.raw_head.as_deref().or(state.head.as_deref()) {
            sidecar::read_object(store, head)?;
        }
    }
    for span in scan_impl(doc).into_iter().filter(|span| span.closed && span.id().is_some()) {
        let body = &doc[span.content_start..span.content_end];
        sidecar::preflight_object_write(store, &hash_content_impl(body), body)?;
    }
    Ok(())
}

#[derive(Clone)]
struct IndexedIdentity {
    modified: std::time::SystemTime,
    bytes: u64,
    id: Option<String>,
}

#[derive(Default)]
struct IdentityIndex {
    entries: BTreeMap<PathBuf, IndexedIdentity>,
    by_id: BTreeMap<String, BTreeSet<PathBuf>>,
    watching: bool,
}

type IdentityIndexes = BTreeMap<PathBuf, IdentityIndex>;
static IDENTITY_INDEXES: OnceLock<Mutex<IdentityIndexes>> = OnceLock::new();

fn identity_indexes() -> Result<std::sync::MutexGuard<'static, IdentityIndexes>> {
    IDENTITY_INDEXES.get_or_init(|| Mutex::new(BTreeMap::new())).lock()
        .map_err(|_| CliError::Corrupt("note identity index is unavailable".to_string()))
}

fn identity_index_for<'a>(indexes: &'a mut IdentityIndexes, vault: &Path) -> &'a mut IdentityIndex {
    if !indexes.contains_key(vault) && indexes.len() >= 4 {
        if let Some(oldest) = indexes.keys().next().cloned() { indexes.remove(&oldest); }
    }
    indexes.entry(vault.to_path_buf()).or_default()
}

fn refresh_identities(index: &mut IdentityIndex, paths: &[PathBuf]) -> Result<()> {
    let live: BTreeSet<_> = paths.iter().cloned().collect();
    index.entries.retain(|path, _| live.contains(path));
    for path in paths {
        let metadata = std::fs::metadata(path).map_err(io_ctx(path.display().to_string()))?;
        let modified = metadata.modified().map_err(io_ctx(path.display().to_string()))?;
        let bytes = metadata.len();
        if !index.entries.get(path).is_some_and(|entry| entry.modified == modified && entry.bytes == bytes) {
            let source = read_doc(path)?;
            let id = note_id_impl(&source).map_err(|error| CliError::Corrupt(format!(
                "invalid note identity in {}: {error}", path.display()
            )))?;
            index.entries.insert(path.clone(), IndexedIdentity { modified, bytes, id });
        }
    }
    index.by_id.clear();
    for (path, entry) in &index.entries {
        if let Some(id) = &entry.id { index.by_id.entry(id.clone()).or_default().insert(path.clone()); }
    }
    Ok(())
}

/// Watch owns one identity-index generation per poll. It reuses its Markdown
/// inventory and parses only changed notes; snapshots use indexed ID lookup.
pub(crate) fn refresh_watch_identities(vault: &Path, paths: &[PathBuf]) -> Result<()> {
    let mut indexes = identity_indexes()?;
    let index = identity_index_for(&mut indexes, vault);
    refresh_identities(index, paths)?;
    index.watching = true;
    Ok(())
}

/// At most four vault indexes are retained. Outside watch, only metadata-changed
/// document generations are read when validating the current vault inventory.
pub(crate) fn validate_note_identity(note: &NoteRef, doc: &str) -> Result<()> {
    let id = note_id_impl(doc).map_err(|error| CliError::Corrupt(error.to_string()))?
        .ok_or_else(|| CliError::Corrupt("a writable note has no source identity".to_string()))?;
    let mut indexes = identity_indexes()?;
    let index = identity_index_for(&mut indexes, &note.vault);
    if !index.watching { refresh_identities(index, &vault::vault_notes_in(&note.store_root()?)?)?; }
    if let Some(other) = index.by_id.get(&id).and_then(|paths| paths.iter().find(|path| *path != &note.abs)) {
        return Err(CliError::BadArgs(format!(
            "duplicate mica note id {id:?} in {} and {} — repair the copied identity before writing history",
            note.abs.display(), other.display()
        )));
    }
    Ok(())
}

pub(crate) fn guard_note_store(note: &NoteRef, store: &NoteStore, expected: &str) -> Result<()> {
    sidecar::preflight_note_record(store)?;
    if read_doc(&note.abs)? != expected
        || note_id_impl(expected).map_err(|error| CliError::Corrupt(error.to_string()))?.as_deref()
            != Some(store.note_id.as_str())
    {
        return Err(CliError::Corrupt(format!(
            "note identity or source generation changed for {}; current contents were preserved",
            note.vault_rel()
        )));
    }
    validate_note_identity(note, expected)
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
    let doc = read_doc(&note.abs)?;
    // Per watched file: O(document bytes + blocks) time and O(blocks) scan
    // space. A second O(document bytes) allocation occurs only when ids need
    // stamping; already-prepared notes retain the file buffer as the authority.
    let mut prepared = Cow::Borrowed(doc.as_str());
    let mut blocks = scan_impl(&prepared);
    if !blocks.iter().any(|b| b.closed) {
        return Ok(Vec::new());
    }
    if stamp_ids && blocks.iter().any(|b| b.closed && b.id().is_none()) {
        prepared = Cow::Owned(ensure_ids_impl(&prepared));
        blocks = scan_impl(&prepared);
    }
    validate_unique_block_ids(&blocks)?;
    let note_id = note_id_impl(&prepared).map_err(|error| CliError::Corrupt(error.to_string()))?;
    if note_id.is_none()
        && !blocks.iter().filter(|block| block.closed && block.id().is_some())
            .any(|block| should_snapshot_impl(&prepared[block.content_start..block.content_end], HeadRef::None, force)) {
        return Ok(blocks.iter().filter(|block| block.closed).filter_map(|block| block.id().map(|id| SnapshotAction {
            block: id.to_string(), hash: None, skipped: Some("no content yet".to_string()),
        })).collect());
    }
    if note_id.is_none() {
        prepared = Cow::Owned(prepare_history_document(note, &prepared)?);
        blocks = scan_impl(&prepared);
    }
    let store = require_store(note, &prepared)?;
    if prepared.as_ref() != doc {
        validate_note_identity(note, &prepared)?;
        preflight_history_write(&store, &prepared)?;
        store.root.claim_location()?;
        sidecar::preflight_note_record(&store)?;
        fsutil::atomic_write_if_unchanged(&note.abs, doc.as_bytes(), prepared.as_bytes())?;
    }
    snapshot_exact(note, &store, &prepared, &blocks, force)
}

/// Snapshot one exact source generation using the operation's fixed store.
pub(crate) fn snapshot_exact(
    note: &NoteRef,
    store: &NoteStore,
    doc: &str,
    blocks: &[mica_core::BlockSpan],
    force: bool,
) -> Result<Vec<SnapshotAction>> {
    snapshot_exact_classified_in(note, store, doc, blocks, force).map_err(|failure| failure.error)
}

#[derive(Debug)]
struct SnapshotFailure {
    error: CliError,
    rollback_safe: bool,
}

impl SnapshotFailure {
    fn before_commit(error: CliError) -> Self {
        Self {
            error,
            rollback_safe: true,
        }
    }

    fn after_or_unknown_commit(error: CliError) -> Self {
        Self {
            error,
            rollback_safe: false,
        }
    }
}

fn snapshot_exact_classified_in(
    note: &NoteRef,
    store: &NoteStore,
    doc: &str,
    blocks: &[mica_core::BlockSpan],
    force: bool,
) -> std::result::Result<Vec<SnapshotAction>, SnapshotFailure> {
    guard_note_store(note, store, doc).map_err(SnapshotFailure::before_commit)?;
    let prepared = (|| -> Result<(Vec<SnapshotAction>, Vec<Event>)> {
        validate_unique_block_ids(blocks)?;
        let st = state_from_store(store)?;
        let mut actions = Vec::with_capacity(blocks.len());
        let mut events: Vec<Event> = Vec::with_capacity(blocks.len() * 2);
        for b in blocks {
            let Some(id) = b.id() else { continue };
            if !b.closed {
                continue;
            }
            let content = &doc[b.content_start..b.content_end];
            let hash = hash_content_impl(content);
            let block_state = st.get(id);
            let head = block_state.and_then(|s| s.raw_head.as_deref().or(s.head.as_deref()));
            let head_version_id = block_state.and_then(|s| {
                s.raw_head_version_id
                    .as_deref()
                    .or(s.head_version_id.as_deref())
            });
            let head_hash = head.map(|value| sidecar::resolve_note_hash(store, value)).transpose()?;
            if head_hash.as_deref() == Some(hash.as_str()) {
                actions.push(SnapshotAction {
                    block: id.to_string(),
                    hash: None,
                    skipped: Some("unchanged".to_string()),
                });
                continue;
            }
            let head_content = match head {
                None => None,
                Some(h) => sidecar::read_object(store, h)?,
            };
            let head_ref = match (head, head_content.as_deref()) {
                (None, _) => HeadRef::None,
                (Some(_), None) => HeadRef::Missing,
                (Some(_), Some(c)) => HeadRef::Content(c),
            };
            if should_snapshot_impl(content, head_ref, force) {
                write_version(store, id, &hash, content, head_version_id, None, &mut events)?;
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
        Ok((actions, events))
    })()
    .map_err(SnapshotFailure::before_commit)?;
    let (actions, events) = prepared;
    guard_note_store(note, store, doc).map_err(SnapshotFailure::before_commit)?;
    append_events_recovering(store, &events)?;
    if !events.is_empty() {
        guard_note_store(note, store, doc).map_err(SnapshotFailure::after_or_unknown_commit)?;
        refresh_manifest(note, store, blocks).map_err(SnapshotFailure::after_or_unknown_commit)?;
    }
    Ok(actions)
}

fn append_events_recovering(
    note: &NoteStore,
    events: &[Event],
) -> std::result::Result<(), SnapshotFailure> {
    if events.is_empty() {
        return Ok(());
    }
    let mut last_error = match sidecar::append_events(note, events) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    for _ in 0..2 {
        let status = sidecar::classify_event_batch(note, events)
            .map_err(SnapshotFailure::after_or_unknown_commit)?;
        if status.missing.is_empty() {
            return Ok(());
        }
        match sidecar::append_events(note, &status.missing) {
            Ok(()) => continue,
            Err(error) => last_error = error,
        }
    }
    match sidecar::classify_event_batch(note, events) {
        Ok(status) if status.missing.is_empty() => Ok(()),
        Ok(status) => Err(SnapshotFailure {
            error: last_error,
            rollback_safe: status.present == 0,
        }),
        Err(error) => Err(SnapshotFailure::after_or_unknown_commit(error)),
    }
}

/// Result of a note mutation derived from one exact source generation.
pub(crate) struct PublishedMutation {
    store: NoteStore,
    pub(crate) doc: String,
    pub(crate) blocks: Vec<mica_core::BlockSpan>,
    previous: String,
}

/// Derive, pre-image, and publish a note mutation from one exact source.
///
/// The final byte comparison is best-effort conflict detection: portable
/// filesystems do not provide rename-if-destination-still-has-these-bytes, so
/// an uncooperative writer can still race in the final compare→rename window.
pub(crate) fn mutate_exact(
    note: &NoteRef,
    derive: impl FnOnce(&str) -> Result<String>,
) -> Result<PublishedMutation> {
    let original = read_doc(&note.abs)?;
    let prepared = ensure_ids_impl(&prepare_history_document(note, &original)?);
    let store = require_store(note, &prepared)?;
    mutate_exact_prepared(note, store, original, prepared, derive)
}

/// A historical selection stays bound to its original source and store. A
/// reread may reject that generation, but can never select a replacement ID.
fn mutate_exact_bound(
    note: &NoteRef,
    store: &NoteStore,
    expected: &str,
    derive: impl FnOnce(&str) -> Result<String>,
) -> Result<PublishedMutation> {
    guard_note_store(note, store, expected)?;
    let prepared = ensure_ids_impl(expected);
    mutate_exact_prepared(note, store.clone(), expected.to_string(), prepared, derive)
}

fn mutate_exact_prepared(
    note: &NoteRef,
    store: NoteStore,
    original: String,
    prepared: String,
    derive: impl FnOnce(&str) -> Result<String>,
) -> Result<PublishedMutation> {
    sidecar::preflight_note_record(&store)?;
    if read_doc(&note.abs)? != original {
        return Err(CliError::BadArgs(format!(
            "note changed before the mutation could be derived: {}; current contents were preserved",
            note.vault_rel()
        )));
    }
    let prepared_blocks = scan_impl(&prepared);
    validate_unique_block_ids(&prepared_blocks)?;
    if note_id_impl(&prepared).map_err(|error| CliError::Corrupt(error.to_string()))?.as_deref()
        != Some(store.note_id.as_str()) {
        return Err(CliError::Corrupt("prepared source does not match the operation's note identity".to_string()));
    }

    // Derive and validate the complete requested result before any persistent
    // effect. Invalid operations therefore do not even stamp missing IDs.
    let next = derive(&prepared)?;
    let next_blocks = scan_impl(&next);
    validate_unique_block_ids(&next_blocks)?;
    if note_id_impl(&next).map_err(|error| CliError::Corrupt(error.to_string()))?.as_deref()
        != Some(store.note_id.as_str()) {
        return Err(CliError::Corrupt("a structural edit changed the source note identity".to_string()));
    }
    preflight_history_write(&store, &prepared)?;
    for span in next_blocks.iter().filter(|span| span.closed && span.id().is_some()) {
        let body = &next[span.content_start..span.content_end];
        sidecar::preflight_object_write(&store, &hash_content_impl(body), body)?;
    }
    validate_note_identity(note, &prepared)?;
    store.root.claim_location()?;
    sidecar::preflight_note_record(&store)?;
    if prepared != original {
        fsutil::atomic_write_if_unchanged(&note.abs, original.as_bytes(), prepared.as_bytes())?;
    }
    snapshot_exact(note, &store, &prepared, &prepared_blocks, false)?;
    if next != prepared {
        guard_note_store(note, &store, &prepared)?;
        fsutil::atomic_write_if_unchanged(&note.abs, prepared.as_bytes(), next.as_bytes())?;
    }
    Ok(PublishedMutation {
        store,
        doc: next,
        blocks: next_blocks,
        previous: prepared,
    })
}

/// The exact original may precede staged identity publication. A present
/// original ID must match this record; the postimage must carry its fixed ID.
pub(crate) fn validate_journal_generations(store: &NoteStore, original: &str, next: &str) -> Result<()> {
    let original_id = note_id_impl(original).map_err(|error| CliError::Corrupt(error.to_string()))?;
    if original_id.as_deref().is_some_and(|id| id != store.note_id.as_str()) {
        return Err(CliError::Corrupt("journal original source identity conflicts with its retained note record; the note and journal were preserved".to_string()));
    }
    let next_id = note_id_impl(next).map_err(|error| CliError::Corrupt(error.to_string()))?;
    if next_id.as_deref() != Some(store.note_id.as_str()) {
        return Err(CliError::Corrupt("journal postimage source identity does not match its retained note record; the note and journal were preserved".to_string()));
    }
    validate_unique_ids(original)?;
    validate_unique_ids(next)
}

/// Validate the actual merged graph before a journal may publish user bytes or
/// append events. Exact event strings and existing append order are retained.
pub(crate) fn preflight_journal_events(store: &NoteStore, intended: &[Event]) -> Result<()> {
    sidecar::preflight_note_record(store)?;
    let ledger = sidecar::read_ledger_report(store)?;
    if ledger.bad_lines != 0 {
        return Err(CliError::Corrupt("journal recovery requires a ledger without invalid lines; the note and journal were preserved".to_string()));
    }
    let status = sidecar::classify_event_batch_in(&ledger.events, intended)?;
    let mut prospective = ledger.events;
    prospective.extend_from_slice(&status.missing);
    mica_core::resolve_ledger_impl(&prospective).map_err(|error| CliError::Corrupt(format!(
        "journal events conflict with the current history graph: {error}; the note and journal were preserved"
    )))?;
    sidecar::preflight_event_append(store, &status.missing)
}

/// Finalize history after a note publication. A verified no-commit failure
/// rolls the exact note generation back. Partial/unknown ledger outcomes keep
/// the successfully published note and return success; a later snapshot can
/// idempotently repair its head without lying to the caller about the note edit.
pub(crate) fn snapshot_published(
    note: &NoteRef,
    published: &PublishedMutation,
    force: bool,
) -> Result<()> {
    match snapshot_exact_classified_in(note, &published.store, &published.doc, &published.blocks, force) {
        Ok(_) => Ok(()),
        Err(failure) if failure.rollback_safe => {
            guard_note_store(note, &published.store, &published.doc)?;
            fsutil::atomic_write_if_unchanged(
                &note.abs,
                published.doc.as_bytes(),
                published.previous.as_bytes(),
            )?;
            Err(CliError::Io(
                format!(
                    "history update failed; the note edit was rolled back: {}",
                    note.abs.display()
                ),
                std::io::Error::other(failure.error.to_string()),
            ))
        }
        Err(failure) => {
            eprintln!(
                "mica: warning: note edit committed, but history needs a retry for {}: {}",
                note.abs.display(),
                failure.error
            );
            Ok(())
        }
    }
}

fn commit_published_events(
    note: &NoteRef,
    published: &PublishedMutation,
    events: &[Event],
) -> Result<()> {
    let store = &published.store;
    guard_note_store(note, store, &published.doc)?;
    match append_events_recovering(store, events) {
        Ok(()) => Ok(()),
        Err(failure) if failure.rollback_safe => {
            guard_note_store(note, &published.store, &published.doc)?;
            fsutil::atomic_write_if_unchanged(
                &note.abs,
                published.doc.as_bytes(),
                published.previous.as_bytes(),
            )?;
            Err(CliError::Io(
                format!(
                    "history update failed; the note edit was rolled back: {}",
                    note.abs.display()
                ),
                std::io::Error::other(failure.error.to_string()),
            ))
        }
        Err(failure) => {
            eprintln!(
                "mica: warning: note edit committed, but history needs a retry for {}: {}",
                note.abs.display(),
                failure.error
            );
            Ok(())
        }
    }
}

/// Reject histories whose identity would merge two live block occurrences.
pub(crate) fn validate_unique_ids(doc: &str) -> Result<()> {
    validate_unique_block_ids(&scan_impl(doc))
}

fn validate_unique_block_ids(blocks: &[mica_core::BlockSpan]) -> Result<()> {
    let mut seen = HashSet::with_capacity(blocks.len());
    let mut duplicates = BTreeSet::new();
    for block in blocks.iter().filter(|block| block.closed) {
        if let Some(id) = block.id() {
            if !seen.insert(id) {
                duplicates.insert(id);
            }
        }
    }
    if duplicates.is_empty() {
        return Ok(());
    }
    Err(CliError::BadArgs(format!(
        "duplicate mica block id(s): {} — assign a unique id to every block before versioning or editing",
        duplicates.into_iter().collect::<Vec<_>>().join(", ")
    )))
}

/// Store one logical checkpoint and move HEAD to it.
fn write_version(
    note: &NoteStore,
    id: &str,
    hash: &str,
    content: &str,
    parent: Option<&str>,
    source: Option<&str>,
    events: &mut Vec<Event>,
) -> Result<()> {
    sidecar::write_object(note, hash, content)?;
    let ts = now_ms();
    let version_id = new_id_impl();
    events.push(Event::Checkpoint {
        eid: version_id.clone(),
        ts,
        block: id.to_string(),
        hash: hash.to_string(),
        parent: parent.map(ToOwned::to_owned),
        source: source.map(ToOwned::to_owned),
        cause: Some(if source.is_some() {
            "restore".to_string()
        } else {
            "snapshot".to_string()
        }),
    });
    events.push(Event::MoveHead {
        eid: new_id_impl(),
        ts,
        block: id.to_string(),
        target: Some(version_id),
    });
    Ok(())
}

/// Rewrite the manifest from an already-scanned current doc.
fn refresh_manifest(note: &NoteRef, store: &NoteStore, spans: &[mica_core::BlockSpan]) -> Result<()> {
    let blocks: Vec<(String, String)> = spans
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
    sidecar::write_manifest(
        store,
        Some(store.note_id.as_str()),
        &note.vault_rel(),
        &blocks,
        now_ms(),
    )
}

/// Restore stored bytes as a new logical checkpoint.
///
/// Purpose: the `restore` command.
///
/// # Arguments
/// * `note` - resolved note
/// * `block_id` - target block
/// * `source_version_id` - stable identity of the checkpoint being restored
/// * `hash` - stored version to restore
///
/// # Returns
/// Whether a forward checkpoint was created.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::vault::NoteRef = todo!();
/// mica_cli::engine::restore_as_checkpoint(&note, "id", "version-id", "b3:00").unwrap();
/// ```
pub fn restore_as_checkpoint(
    note: &NoteRef,
    block_id: &str,
    source_version_id: &str,
    hash: &str,
) -> Result<bool> {
    let current = read_doc(&note.abs)?;
    let store = require_store(note, &current)?;
    validate_note_identity(note, &current)?;
    let Some(content) = sidecar::read_object(&store, hash)? else {
        return Err(CliError::NotFound(format!(
            "version object {hash} is missing from central history — run `mica doctor`"
        )));
    };
    let current_block = scan_impl(&current)
        .into_iter()
        .find(|block| block.closed && block.id() == Some(block_id))
        .ok_or_else(|| CliError::NotFound(format!("block {block_id} not found in the note")))?;
    if current[current_block.content_start..current_block.content_end] == content {
        return Ok(false);
    }
    let before = state_from_store(&store)?;
    if !before.get(block_id).is_some_and(|block| block.versions.iter().chain(&block.removed_versions)
        .any(|version| version.version_id == source_version_id && version.hash == hash)) {
        return Err(CliError::Corrupt("restore selection no longer belongs to the current note history".to_string()));
    }
    let previous_head = before.get(block_id).and_then(|block| {
        block
            .raw_head_version_id
            .clone()
            .or_else(|| block.head_version_id.clone())
    });
    let published = mutate_exact_bound(note, &store, &current, |doc| {
        let terminated = terminate(&content, preferred_line_ending(doc));
        let next = replace_block_content_impl(doc, block_id, terminated.as_ref())
            .ok_or_else(|| CliError::NotFound(format!("block {block_id} not found in the note")))?;
        Ok(next)
    })?;
    let hash = hash_content_impl(&content);
    let mut events = Vec::with_capacity(2);
    write_version(
        &store,
        block_id,
        &hash,
        &content,
        previous_head.as_deref(),
        Some(source_version_id),
        &mut events,
    )?;
    commit_published_events(note, &published, &events)?;
    Ok(true)
}

/// Reset the live block and HEAD to one existing checkpoint.
pub fn reset_head(
    note: &NoteRef,
    block_id: &str,
    target_version_id: &str,
    hash: &str,
) -> Result<bool> {
    let current = read_doc(&note.abs)?;
    let store = require_store(note, &current)?;
    validate_note_identity(note, &current)?;
    let Some(content) = sidecar::read_object(&store, hash)? else {
        return Err(CliError::NotFound(format!(
            "version object {hash} is missing from central history — run `mica doctor`"
        )));
    };
    let current_block = scan_impl(&current)
        .into_iter()
        .find(|block| block.closed && block.id() == Some(block_id))
        .ok_or_else(|| CliError::NotFound(format!("block {block_id} not found in the note")))?;
    let same_content = current[current_block.content_start..current_block.content_end] == content;
    let before = state_from_store(&store)?;
    if !before.get(block_id).is_some_and(|block| block.versions.iter().chain(&block.removed_versions)
        .any(|version| version.version_id == target_version_id && version.hash == hash)) {
        return Err(CliError::Corrupt("reset selection no longer belongs to the current note history".to_string()));
    }
    let same_head = before.get(block_id).and_then(|block| {
        block
            .raw_head_version_id
            .as_deref()
            .or(block.head_version_id.as_deref())
    }) == Some(target_version_id);
    if same_content && same_head {
        return Ok(false);
    }
    let published = mutate_exact_bound(note, &store, &current, |doc| {
        let terminated = terminate(&content, preferred_line_ending(doc));
        replace_block_content_impl(doc, block_id, terminated.as_ref())
            .ok_or_else(|| CliError::NotFound(format!("block {block_id} not found in the note")))
    })?;
    commit_published_events(
        note,
        &published,
        &[Event::MoveHead {
            eid: new_id_impl(),
            ts: now_ms(),
            block: block_id.to_string(),
            target: Some(target_version_id.to_string()),
        }],
    )?;
    Ok(true)
}

/// Append visibility events for logical checkpoints.
pub fn set_versions_visible(
    note: &NoteRef,
    block_id: &str,
    version_ids: &[String],
    visible: bool,
) -> Result<()> {
    let ts = now_ms();
    let events = version_ids
        .iter()
        .map(|target| Event::VersionVisibility {
            eid: new_id_impl(),
            ts,
            block: block_id.to_string(),
            target: target.clone(),
            visible,
        })
        .collect::<Vec<_>>();
    let doc = read_doc(&note.abs)?;
    let store = require_store(note, &doc)?;
    let history = state_from_store(&store)?;
    if !version_ids.iter().all(|target| history.get(block_id).is_some_and(|block| {
        block.versions.iter().chain(&block.removed_versions).any(|version| &version.version_id == target)
    })) {
        return Err(CliError::Corrupt("version selection no longer belongs to the current note history".to_string()));
    }
    guard_note_store(note, &store, &doc)?;
    sidecar::append_events(&store, &events)
}

/// Replace block content wholesale (the `set` command): snapshot before,
/// write, snapshot after. Edits observed before the final guarded publish are
/// preserved; see `mutate_exact` for the unavoidable final CAS limitation.
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
    let published = mutate_exact(note, |doc| {
        let terminated = terminate(content, preferred_line_ending(doc));
        let next = replace_block_content_impl(doc, block_id, terminated.as_ref())
            .ok_or_else(|| CliError::NotFound(format!("block {block_id} not found in the note")))?;
        Ok(next)
    })?;
    snapshot_published(note, &published, false)
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
pub fn label(note: &NoteRef, block_id: &str, version_id: &str, label: &str) -> Result<()> {
    let doc = read_doc(&note.abs)?;
    let store = require_store(note, &doc)?;
    let history = state_from_store(&store)?;
    if !history.get(block_id).is_some_and(|block| block.versions.iter().chain(&block.removed_versions)
        .any(|version| version.version_id == version_id)) {
        return Err(CliError::Corrupt("label selection no longer belongs to the current note history".to_string()));
    }
    guard_note_store(note, &store, &doc)?;
    sidecar::append_events(
        &store,
        &[Event::VersionLabel {
            eid: new_id_impl(),
            ts: now_ms(),
            block: block_id.to_string(),
            target: version_id.to_string(),
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
fn terminate<'a>(content: &'a str, eol: &str) -> Cow<'a, str> {
    if !content.is_empty() && !content.ends_with('\n') {
        Cow::Owned(format!("{content}{eol}"))
    } else {
        Cow::Borrowed(content)
    }
}

/// Dominant line ending used when a mutation must synthesize a terminator.
pub(crate) fn preferred_line_ending(doc: &str) -> &'static str {
    if doc.find('\n').is_some_and(|index| {
        index > 0 && doc.as_bytes().get(index.saturating_sub(1)) == Some(&b'\r')
    }) {
        "\r\n"
    } else {
        "\n"
    }
}

/// Read a note file with a path-carrying error.
pub fn read_doc(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(io_ctx(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]

    use super::*;

    fn test_store(note: &NoteRef) -> NoteStore {
        let doc = read_doc(&note.abs).expect("read fixture");
        NoteStore::from_document(note, &doc).expect("fixture binding")
            .unwrap_or_else(|| NoteStore::for_id(&note.vault, &note.abs, "fixture-unprepared").expect("fixture handle"))
    }

    fn fixture_source(source: &str) -> String {
        mica_core::set_note_id_impl(source, None, "fixture-note").expect("fixture anchor")
    }

    fn note_fixture(doc: &str) -> (tempfile::TempDir, NoteRef) {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("Note.md");
        std::fs::write(&path, fixture_source(doc)).expect("seed note");
        let note = NoteRef {
            abs: path,
            vault: dir.path().to_path_buf(),
            store: None,
        };
        (dir, note)
    }

    #[test]
    fn duplicate_ids_are_rejected_before_sidecar_writes() {
        let (_dir, note) =
            note_fixture("```mica id=duplicate\none\n```\n\n```mica id=duplicate\ntwo\n```\n");
        assert!(matches!(
            snapshot_note(&note, false, true),
            Err(CliError::BadArgs(message)) if message.contains("duplicate")
        ));
        assert!(!sidecar::sidecar_dir(&test_store(&note)).exists());
    }

    #[test]
    fn set_versions_the_exact_preimage_and_result() {
        let (_dir, note) = note_fixture("```mica id=a\nold\n```\n");
        set_content(&note, "a", "new").expect("set content");

        assert_eq!(
            read_doc(&note.abs).expect("read note"),
            fixture_source("```mica id=a\nnew\n```\n")
        );
        let state = state(&note).expect("fold state");
        let versions = &state.get("a").expect("block state").versions;
        assert_eq!(versions.len(), 2);
        let bodies: Vec<String> = versions
            .iter()
            .map(|version| {
                sidecar::read_object(&test_store(&note), &version.hash)
                    .expect("read object")
                    .expect("object exists")
            })
            .collect();
        assert_eq!(bodies, ["old\n", "new\n"]);
        assert_eq!(versions[0].parent_version_id, None);
        assert_eq!(
            versions[1].parent_version_id.as_deref(),
            Some(versions[0].version_id.as_str()),
            "ordinary snapshots preserve their actual lineage"
        );
    }

    #[test]
    fn synthesized_terminator_preserves_crlf() {
        let (_dir, note) = note_fixture("```mica id=a\r\nold\r\n```\r\n");
        set_content(&note, "a", "new").expect("set content");
        let doc = read_doc(&note.abs).expect("read note");
        assert_eq!(doc, fixture_source("```mica id=a\r\nnew\r\n```\r\n"));
        assert!(!doc.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn invalid_derive_has_no_id_stamp_or_sidecar_effect() {
        let (_dir, note) = note_fixture("```mica\nbody\n```\n");
        let before = read_doc(&note.abs).expect("before");
        let result = mutate_exact(&note, |_doc| {
            Err(CliError::BadArgs("rejected operation".to_string()))
        });
        assert!(matches!(result, Err(CliError::BadArgs(_))));
        assert_eq!(read_doc(&note.abs).expect("after"), before);
        assert!(!sidecar::sidecar_dir(&test_store(&note)).exists());
    }

    #[test]
    fn invalid_restore_object_has_no_snapshot_side_effect() {
        let (_dir, note) = note_fixture("```mica id=a\nbody\n```\n");
        assert!(matches!(
            restore_as_checkpoint(&note, "a", "missing-version", "b3:not-a-digest"),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar::sidecar_dir(&test_store(&note)).exists());
    }

    #[test]
    fn restore_remove_and_reset_use_checkpoint_identity() {
        let (_dir, note) = note_fixture("```mica id=a\nold\n```\n");
        set_content(&note, "a", "new").expect("create initial and changed checkpoints");
        let initial = state(&note).expect("initial state")["a"].clone();
        assert_eq!(initial.versions.len(), 2);
        let old = initial.versions[0].clone();
        let new = initial.versions[1].clone();

        assert!(
            restore_as_checkpoint(&note, "a", &old.version_id, &old.hash)
                .expect("restore as checkpoint")
        );
        let restored = state(&note).expect("restored state")["a"].clone();
        assert_eq!(restored.versions.len(), 3);
        let forward = restored
            .versions
            .last()
            .expect("forward restore checkpoint");
        assert_eq!(forward.hash, old.hash);
        assert_eq!(
            forward.parent_version_id.as_deref(),
            Some(new.version_id.as_str())
        );
        assert_eq!(
            forward.source_version_id.as_deref(),
            Some(old.version_id.as_str())
        );
        assert_eq!(
            restored.head_version_id.as_deref(),
            Some(forward.version_id.as_str())
        );
        assert!(
            !restore_as_checkpoint(&note, "a", &old.version_id, &old.hash)
                .expect("identical restore is a no-op")
        );

        set_versions_visible(&note, "a", std::slice::from_ref(&new.version_id), false)
            .expect("remove middle checkpoint");
        let hidden = state(&note).expect("hidden state")["a"].clone();
        assert_eq!(hidden.versions.len(), 2);
        assert_eq!(hidden.removed_versions.len(), 1);
        assert_eq!(
            hidden.versions[1].effective_parent_version_id.as_deref(),
            Some(old.version_id.as_str())
        );

        assert!(reset_head(&note, "a", &old.version_id, &old.hash).expect("reset logical head"));
        let reset = state(&note).expect("reset state")["a"].clone();
        assert_eq!(
            reset.head_version_id.as_deref(),
            Some(old.version_id.as_str())
        );
        assert_eq!(
            read_doc(&note.abs).expect("live note"),
            fixture_source("```mica id=a\nold\n```\n")
        );
    }

    #[test]
    fn hidden_raw_head_stays_clean_and_parents_the_next_checkpoint() {
        let (_dir, note) = note_fixture("```mica id=a\nold\n```\n");
        set_content(&note, "a", "new").expect("create initial and changed checkpoints");
        let initial = state(&note).expect("initial state")["a"].clone();
        let hidden = initial.versions[1].version_id.clone();

        set_versions_visible(&note, "a", std::slice::from_ref(&hidden), false)
            .expect("hide current checkpoint");
        let removed = state(&note).expect("removed state")["a"].clone();
        assert_eq!(
            removed.head_version_id,
            Some(initial.versions[0].version_id.clone())
        );
        assert_eq!(
            removed.raw_head_version_id.as_deref(),
            Some(hidden.as_str())
        );
        assert_eq!(
            removed.raw_head.as_deref(),
            Some(initial.versions[1].hash.as_str())
        );

        let unchanged = snapshot_note(&note, false, false).expect("snapshot unchanged live bytes");
        assert!(
            unchanged
                .iter()
                .all(|action| action.skipped.as_deref() == Some("unchanged")),
            "hiding the current checkpoint must not manufacture a dirty working copy"
        );

        std::fs::write(&note.abs, fixture_source("```mica id=a\nnewer\n```\n")).expect("edit live note");
        snapshot_note(&note, false, false).expect("snapshot next edit");
        let next = state(&note).expect("next state")["a"].clone();
        let newest = next.versions.last().expect("new visible checkpoint");
        assert_eq!(newest.parent_version_id.as_deref(), Some(hidden.as_str()));
        assert_eq!(
            newest.effective_parent_version_id.as_deref(),
            Some(initial.versions[0].version_id.as_str())
        );
    }

    #[test]
    fn failed_post_publish_snapshot_rolls_back_exact_note_generation() {
        let (_dir, note) = note_fixture("```mica id=a\nnew\n```\n");
        let previous = fixture_source("```mica id=a\nold\n```\n");
        let published = PublishedMutation {
            store: test_store(&note),
            doc: read_doc(&note.abs).expect("published note"),
            blocks: scan_impl(&read_doc(&note.abs).expect("fixture source")),
            previous: previous.clone(),
        };
        sidecar::ensure_note_record(&test_store(&note)).expect("initialize fixture record");
        std::fs::create_dir_all(sidecar::ledger_path(&test_store(&note))).expect("invalid ledger directory");

        assert!(snapshot_published(&note, &published, false).is_err());
        assert_eq!(read_doc(&note.abs).expect("rolled back note"), previous);
    }

    #[test]
    fn unprepared_history_read_preserves_source_and_storage() {
        let dir = tempfile::tempdir().expect("temporary vault");
        let note = NoteRef { abs: dir.path().join("Note.md"), vault: dir.path().to_path_buf(), store: None };
        let source = "```mica id=a\nbody\n```\n";
        std::fs::write(&note.abs, source).expect("seed unprepared note");
        assert!(state(&note).expect("empty history").is_empty());
        assert_eq!(read_doc(&note.abs).expect("unchanged source"), source);
        assert!(!dir.path().join("mica-data").exists());
    }

    #[test]
    fn first_snapshot_binds_source_identity_to_central_history() {
        let dir = tempfile::tempdir().expect("temporary vault");
        let note = NoteRef { abs: dir.path().join("Note.md"), vault: dir.path().to_path_buf(), store: None };
        std::fs::write(&note.abs, "```mica id=a\nbody\n```\n").expect("seed unprepared note");
        snapshot_note(&note, false, true).expect("first history write");
        let source = read_doc(&note.abs).expect("prepared source");
        let id = mica_core::note_id_impl(&source).expect("valid identity").expect("source identity");
        let paths = mica_core::note_paths_impl(&id).expect("central paths");
        assert!(dir.path().join(paths.ledger).is_file());
        assert!(dir.path().join("mica-data/objects").is_dir());
        assert!(!note.abs.with_extension("mica").exists());
        assert_eq!(state(&note).expect("central history")["a"].versions.len(), 1);
    }

    #[test]
    fn copied_source_identity_fails_before_history_writes() {
        let dir = tempfile::tempdir().expect("temporary vault");
        let note = NoteRef { abs: dir.path().join("Note.md"), vault: dir.path().to_path_buf(), store: None };
        let source = fixture_source("```mica id=a\nbody\n```\n");
        std::fs::write(&note.abs, &source).expect("seed note");
        std::fs::write(dir.path().join("Copy.md"), &source).expect("seed duplicate");
        assert!(matches!(snapshot_note(&note, false, true), Err(CliError::BadArgs(message)) if message.contains("duplicate mica note id")));
        assert_eq!(read_doc(&note.abs).expect("unchanged source"), source);
        assert!(!dir.path().join("mica-data").exists());
    }
}

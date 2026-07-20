//! Sidecar storage — byte-compatible with the Obsidian plugin's layout.
//!
//! Next to `Note.md` lives `Note.mica/` holding `objects/<b3-hash>.mica.md`
//! (immutable, content-addressed), `ledger.jsonl` (append-only), and
//! `manifest.json` (human/tool summary; tab-indented like the plugin writes).

use crate::error::{io_ctx, CliError, Result};
use crate::fsutil;
use mica_core::Event;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// `Note.md` → `Note.mica` (sidecar directory path).
pub fn sidecar_dir(note: &Path) -> PathBuf {
    let stem = note.with_extension("");
    let mut s = stem.into_os_string();
    s.push(".mica");
    PathBuf::from(s)
}

/// The sidecar's `objects/` directory.
pub fn objects_dir(note: &Path) -> PathBuf {
    sidecar_dir(note).join("objects")
}

/// The sidecar's append-only ledger path.
pub fn ledger_path(note: &Path) -> PathBuf {
    sidecar_dir(note).join("ledger.jsonl")
}

/// Durable migration transaction record. It deliberately remains after a
/// successful migration so the whole-note pre-image has a named reference.
pub fn migration_journal_path(note: &Path) -> PathBuf {
    sidecar_dir(note).join("migration.json")
}

/// Recoverable state for one legacy-note migration.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationJournal {
    /// Journal schema version.
    pub format: u8,
    /// `pending` until note publication, archive events, and head snapshot finish.
    pub status: String,
    /// Vault-relative note path at the time of migration.
    pub note: String,
    /// Object hash of the exact whole-note pre-image.
    pub original: String,
    /// Object hash of the exact whole-note migrated result.
    pub migrated: String,
    /// Stable archive events to replay after an interrupted publication.
    pub events: Vec<Event>,
}

/// Compressed-object variant path (large objects). Hash is over PLAINTEXT.
pub fn object_path_gz(note: &Path, hash: &str) -> PathBuf {
    objects_dir(note).join(format!("{}.mica.gz", object_stem(hash)))
}

/// Objects at or under this size stay human-readable plaintext `.md`.
/// Shared rule with the plugin — both sides read either form.
pub const COMPRESS_MIN_BYTES: usize = 4096;

/// Maximum plaintext size accepted from one version object (128 MiB).
/// This caps memory use when reading an adversarial gzip object.
const MAX_OBJECT_BYTES: usize = 128 * 1024 * 1024;

/// Maximum accepted ledger size. Shared with the Obsidian host.
pub const MAX_LEDGER_BYTES: usize = 64 * 1024 * 1024;
/// Maximum accepted JSONL event line size. Shared with the Obsidian host.
pub const MAX_LEDGER_LINE_BYTES: usize = 1024 * 1024;
/// Maximum accepted non-empty event lines in one ledger.
pub const MAX_LEDGER_EVENTS: usize = 1_000_000;
/// Fixed cross-host ledger horizon: 3000-01-01T00:00:00Z, inclusive.
/// It is also safely below JavaScript's largest exactly representable integer.
pub const MAX_EVENT_TIMESTAMP_MS: u64 = 32_503_680_000_000;
/// Maximum clock lead accepted from another host before an event is quarantined.
pub const MAX_FUTURE_EVENT_SKEW_MS: u64 = 86_400_000;

/// Object path for `hash` (`b3:abcd` → `objects/b3-abcd.mica.md`).
pub fn object_path(note: &Path, hash: &str) -> PathBuf {
    objects_dir(note).join(format!("{}.mica.md", object_stem(hash)))
}

fn object_stem(hash: &str) -> String {
    hash.replace([':', '/', '\\'], "-")
}

/// Read the ledger; malformed lines are skipped (never lose the whole history
/// to one bad line). Missing ledger = empty.
///
/// Purpose: every versions command starts here.
///
/// # Arguments
/// * `note` - the note whose sidecar to read
///
/// # Returns
/// Events in file order.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let events = mica_cli::sidecar::read_ledger(std::path::Path::new("Note.md")).unwrap();
/// ```
pub fn read_ledger(note: &Path) -> Result<Vec<Event>> {
    read_ledger_at(&ledger_path(note))
}

/// [`read_ledger`] against an explicit ledger path (repair/doctor sweeps).
pub fn read_ledger_at(path: &Path) -> Result<Vec<Event>> {
    let Some(text) = read_ledger_text(path)? else {
        return Ok(Vec::new());
    };
    parse_ledger(&text).map(|(events, _)| events)
}

/// Count of unparseable ledger lines (doctor's corruption signal).
pub fn ledger_bad_lines(path: &Path) -> Result<usize> {
    let Some(text) = read_ledger_text(path)? else {
        return Ok(0);
    };
    parse_ledger(&text).map(|(_, bad)| bad)
}

/// Read the bounded migration journal, if one exists.
pub fn read_migration_journal(note: &Path) -> Result<Option<MigrationJournal>> {
    let path = migration_journal_path(note);
    let Some(file) = open_regular_for_read(&path, "migration journal")? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take((MAX_LEDGER_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(io_ctx(path.display().to_string()))?;
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(format!(
            "migration journal exceeds the {MAX_LEDGER_BYTES} byte safety limit: {}",
            path.display()
        )));
    }
    let journal: MigrationJournal = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::Corrupt(format!(
            "migration journal is invalid at {}: {error}",
            path.display()
        ))
    })?;
    validate_migration_journal(&journal)?;
    Ok(Some(journal))
}

/// Atomically and durably write a validated migration journal.
pub fn write_migration_journal(note: &Path, journal: &MigrationJournal) -> Result<()> {
    validate_migration_journal(journal)?;
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(format!(
            "migration journal exceeds the {MAX_LEDGER_BYTES} byte safety limit"
        )));
    }
    ensure_sidecar(note)?;
    let path = migration_journal_path(note);
    validate_regular_file_or_missing(&path, "migration journal")?;
    fsutil::atomic_write(&path, &bytes)
}

fn validate_migration_journal(journal: &MigrationJournal) -> Result<()> {
    if journal.format != 1 || !matches!(journal.status.as_str(), "pending" | "complete") {
        return Err(CliError::Corrupt(
            "unsupported migration journal format or status".to_string(),
        ));
    }
    validate_hash(&journal.original)?;
    validate_hash(&journal.migrated)?;
    if journal.events.len() > MAX_LEDGER_EVENTS {
        return Err(CliError::Corrupt(format!(
            "migration journal has more than {MAX_LEDGER_EVENTS} events"
        )));
    }
    for event in &journal.events {
        validate_event(event)?;
        let encoded =
            serde_json::to_vec(event).map_err(|error| CliError::Corrupt(error.to_string()))?;
        if encoded.len() > MAX_LEDGER_LINE_BYTES {
            return Err(CliError::Corrupt(format!(
                "migration journal event is {} bytes (limit {MAX_LEDGER_LINE_BYTES})",
                encoded.len()
            )));
        }
    }
    Ok(())
}

/// Append events to the ledger (creating the sidecar as needed).
///
/// Purpose: the only ledger writer; append-only by construction.
///
/// # Arguments
/// * `note` - the note whose sidecar to write
/// * `events` - events to append (no-op when empty)
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// mica_cli::sidecar::append_events(std::path::Path::new("Note.md"), &[]).unwrap();
/// ```
pub fn append_events(note: &Path, events: &[Event]) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    if events.len() > MAX_LEDGER_EVENTS {
        return Err(CliError::Corrupt(format!(
            "refusing to append {} ledger events at once (limit {MAX_LEDGER_EVENTS})",
            events.len()
        )));
    }
    let mut batch_eids: HashMap<&str, &Event> = HashMap::with_capacity(events.len());
    let mut lines = String::new();
    for e in events {
        validate_event(e)?;
        let eid = event_eid(e);
        if let Some(previous) = batch_eids.insert(eid, e) {
            let detail = if previous == e {
                "more than once"
            } else {
                "for conflicting events"
            };
            return Err(CliError::Corrupt(format!(
                "ledger append batch reuses eid {eid:?} {detail} — regenerate the batch before retrying"
            )));
        }
        let line =
            serde_json::to_string(e).map_err(|e| crate::error::CliError::Corrupt(e.to_string()))?;
        if line.len() > MAX_LEDGER_LINE_BYTES {
            return Err(CliError::Corrupt(format!(
                "ledger event is {} bytes (limit {MAX_LEDGER_LINE_BYTES})",
                line.len()
            )));
        }
        lines.push_str(&line);
        lines.push('\n');
        if lines.len() > MAX_LEDGER_BYTES {
            return Err(CliError::Corrupt(format!(
                "ledger append is larger than the {MAX_LEDGER_BYTES} byte safety limit"
            )));
        }
    }
    ensure_sidecar(note)?;
    let path = ledger_path(note);
    validate_regular_file_or_missing(&path, "ledger")?;
    let mut options = fs::OpenOptions::new();
    options
        .create(true)
        .read(true)
        .write(true)
        // O_APPEND makes the final single-buffer write land at the then-current
        // end even when a non-cooperating host writes between seek and write.
        .append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(&path)
        .map_err(io_ctx(path.display().to_string()))?;
    if !file
        .metadata()
        .map_err(io_ctx(path.display().to_string()))?
        .file_type()
        .is_file()
    {
        return Err(CliError::Corrupt(format!(
            "ledger is not a regular file: {}",
            path.display()
        )));
    }
    file.lock().map_err(io_ctx(path.display().to_string()))?;
    let write_result = (|| {
        let len = file
            .metadata()
            .map_err(io_ctx(path.display().to_string()))?
            .len();
        let existing = usize::try_from(len).map_err(|_| {
            CliError::Corrupt(format!(
                "ledger is too large to address: {}",
                path.display()
            ))
        })?;
        let separator = if existing == 0 {
            false
        } else {
            file.seek(SeekFrom::End(-1))
                .map_err(io_ctx(path.display().to_string()))?;
            let mut last = [0_u8; 1];
            file.read_exact(&mut last)
                .map_err(io_ctx(path.display().to_string()))?;
            last[0] != b'\n'
        };
        let appended = lines.len() + usize::from(separator);
        if existing
            .checked_add(appended)
            .is_none_or(|total| total > MAX_LEDGER_BYTES)
        {
            return Err(CliError::Corrupt(format!(
                "ledger would exceed the {MAX_LEDGER_BYTES} byte safety limit: {}",
                path.display()
            )));
        }
        let mut payload = Vec::with_capacity(appended);
        if separator {
            payload.push(b'\n');
        }
        payload.extend_from_slice(lines.as_bytes());
        file.write_all(&payload)
            .map_err(io_ctx(path.display().to_string()))?;
        file.sync_all()
            .map_err(io_ctx(path.display().to_string()))?;
        fsutil::sync_parent(&path)
    })();
    let unlock_result = file.unlock().map_err(io_ctx(path.display().to_string()));
    write_result.and(unlock_result)
}

/// Verified logical status of an append batch after an adapter/filesystem
/// failure. Event ids are immutable identities: exact replays are present,
/// while an eid reused for different data is corruption.
pub(crate) struct EventBatchStatus {
    pub(crate) present: usize,
    pub(crate) missing: Vec<Event>,
}

pub(crate) fn classify_event_batch(note: &Path, intended: &[Event]) -> Result<EventBatchStatus> {
    let existing = read_ledger(note)?;
    let by_eid: HashMap<&str, &Event> = existing
        .iter()
        .map(|event| (event_eid(event), event))
        .collect();
    let mut present = 0;
    let mut missing = Vec::new();
    for event in intended {
        match by_eid.get(event_eid(event)) {
            None => missing.push(event.clone()),
            Some(found) if *found == event => present += 1,
            Some(_) => {
                return Err(CliError::Corrupt(format!(
                    "ledger eid {:?} conflicts with the intended append — repair the ledger before retrying",
                    event_eid(event)
                )));
            }
        }
    }
    Ok(EventBatchStatus { present, missing })
}

/// Create the sidecar + objects directories when missing.
fn ensure_sidecar(note: &Path) -> Result<()> {
    let sidecar = sidecar_dir(note);
    ensure_safe_dir(&sidecar)?;
    let objects = objects_dir(note);
    ensure_safe_dir(&objects)
}

fn ensure_safe_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => return Ok(()),
        Ok(_) => {
            return Err(CliError::Corrupt(format!(
                "sidecar path is not a real directory: {}",
                path.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_ctx(path.display().to_string())(error)),
    }
    match fs::create_dir(path) {
        Ok(()) => fsutil::sync_parent(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io_ctx(path.display().to_string())(error)),
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(CliError::Corrupt(format!(
            "sidecar path is not a real directory: {}",
            path.display()
        ))),
        Err(error) => Err(io_ctx(path.display().to_string())(error)),
    }
}

fn validate_regular_file_or_missing(path: &Path, kind: &str) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(CliError::Corrupt(format!(
            "{kind} is not a regular file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_ctx(path.display().to_string())(error)),
    }
}

fn open_regular_for_read(path: &Path, kind: &str) -> Result<Option<fs::File>> {
    // Check the sidecar/object directory components themselves. O_NOFOLLOW on
    // the final file does not stop an intermediate `Note.mica` symlink.
    for parent in path.ancestors().skip(1).take(2) {
        match fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(CliError::Corrupt(format!(
                    "{kind} parent is not a real directory: {}",
                    parent.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_ctx(parent.display().to_string())(error)),
        }
    }
    if !validate_regular_file_or_missing(path, kind)? {
        return Ok(None);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let file = options
        .open(path)
        .map_err(io_ctx(path.display().to_string()))?;
    if !file
        .metadata()
        .map_err(io_ctx(path.display().to_string()))?
        .file_type()
        .is_file()
    {
        return Err(CliError::Corrupt(format!(
            "{kind} is not a regular file: {}",
            path.display()
        )));
    }
    Ok(Some(file))
}

fn read_ledger_text(path: &Path) -> Result<Option<String>> {
    let Some(file) = open_regular_for_read(path, "ledger")? else {
        return Ok(None);
    };
    let metadata = file
        .metadata()
        .map_err(io_ctx(path.display().to_string()))?;
    if metadata.len() > MAX_LEDGER_BYTES as u64 {
        return Err(CliError::Corrupt(format!(
            "ledger exceeds the {MAX_LEDGER_BYTES} byte safety limit: {}",
            path.display()
        )));
    }
    let limit = u64::try_from(MAX_LEDGER_BYTES).unwrap_or(u64::MAX) + 1;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(io_ctx(path.display().to_string()))?;
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(format!(
            "ledger exceeds the {MAX_LEDGER_BYTES} byte safety limit: {}",
            path.display()
        )));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| CliError::Corrupt(format!("ledger is not valid UTF-8: {}", path.display())))
}

fn parse_ledger(text: &str) -> Result<(Vec<Event>, usize)> {
    let mut events = Vec::new();
    let mut by_eid: HashMap<String, usize> = HashMap::new();
    let mut bad = 0_usize;
    let mut count = 0_usize;
    let now = current_time_ms();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        count += 1;
        if count > MAX_LEDGER_EVENTS {
            return Err(CliError::Corrupt(format!(
                "ledger has more than {MAX_LEDGER_EVENTS} events"
            )));
        }
        if line.len() > MAX_LEDGER_LINE_BYTES {
            return Err(CliError::Corrupt(format!(
                "ledger event line is {} bytes (limit {MAX_LEDGER_LINE_BYTES})",
                line.len()
            )));
        }
        match serde_json::from_str::<Event>(line) {
            Ok(event) if validate_event_at(&event, now).is_ok() => {
                let eid = event_eid(&event);
                if let Some(&index) = by_eid.get(eid) {
                    if events[index] != event {
                        return Err(CliError::Corrupt(format!(
                            "ledger eid {eid:?} has conflicting events — repair the ledger before retrying"
                        )));
                    }
                    continue;
                }
                by_eid.insert(eid.to_string(), events.len());
                events.push(event);
            }
            Ok(_) | Err(_) => bad += 1,
        }
    }
    Ok((events, bad))
}

fn event_eid(event: &Event) -> &str {
    match event {
        Event::AddVersion { eid, .. } | Event::SetHead { eid, .. } | Event::Label { eid, .. } => {
            eid
        }
    }
}

fn validate_event(event: &Event) -> Result<()> {
    validate_event_at(event, current_time_ms())
}

fn validate_event_at(event: &Event, now: u64) -> Result<()> {
    let (ts, hash, parent) = match event {
        Event::AddVersion {
            ts, hash, parent, ..
        } => (*ts, hash.as_str(), parent.as_deref()),
        Event::SetHead { ts, hash, .. } | Event::Label { ts, hash, .. } => {
            (*ts, hash.as_str(), None)
        }
    };
    if ts > MAX_EVENT_TIMESTAMP_MS {
        return Err(CliError::Corrupt(format!(
            "ledger timestamp {ts} exceeds the cross-host integer limit {MAX_EVENT_TIMESTAMP_MS}"
        )));
    }
    let skew_limit = now.saturating_add(MAX_FUTURE_EVENT_SKEW_MS);
    if ts > skew_limit {
        return Err(CliError::Corrupt(format!(
            "ledger timestamp {ts} is more than {MAX_FUTURE_EVENT_SKEW_MS}ms ahead of this host ({now})"
        )));
    }
    validate_hash(hash)?;
    if let Some(parent) = parent {
        validate_hash(parent)?;
    }
    Ok(())
}

fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        Err(_) => 0,
    }
}

/// Content-addressed object write: an existing hash is a no-op.
///
/// Purpose: immutable version storage.
///
/// # Arguments
/// * `note` - the note whose sidecar to write
/// * `hash` - the `b3:`-tagged content hash
/// * `content` - the object body
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let content = "x";
/// let hash = mica_core::hash_content_impl(content);
/// mica_cli::sidecar::write_object(std::path::Path::new("Note.md"), &hash, content).unwrap();
/// ```
pub fn write_object(note: &Path, hash: &str, content: &str) -> Result<()> {
    write_object_with_limit(note, hash, content, MAX_OBJECT_BYTES)
}

fn write_object_with_limit(note: &Path, hash: &str, content: &str, max_bytes: usize) -> Result<()> {
    validate_hash(hash)?;
    verify_hash(hash, content)?;
    if content.len() > max_bytes {
        return Err(object_too_large(hash, max_bytes));
    }
    ensure_sidecar(note)?;
    let plain = object_path(note, hash);
    let gz = object_path_gz(note, hash);
    if object_file_exists(&plain, hash)? || object_file_exists(&gz, hash)? {
        read_object(note, hash)?;
        return Ok(()); // verified immutable object already exists
    }
    if content.len() <= COMPRESS_MIN_BYTES {
        return fsutil::atomic_write(&plain, content.as_bytes());
    }
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    Write::write_all(&mut enc, content.as_bytes())
        .and_then(|()| enc.finish())
        .map_err(io_ctx(gz.display().to_string()))
        .and_then(|bytes| fsutil::atomic_write(&gz, &bytes))
}

/// Read a stored object's content; `None` when the object file is missing.
///
/// Purpose: diff/show/restore all read objects.
///
/// # Arguments
/// * `note` - the note whose sidecar to read
/// * `hash` - the object's hash
///
/// # Returns
/// The object body, or `None`.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let hash = mica_core::hash_content_impl("x");
/// let c = mica_cli::sidecar::read_object(std::path::Path::new("Note.md"), &hash).unwrap();
/// ```
pub fn read_object(note: &Path, hash: &str) -> Result<Option<String>> {
    read_object_with_limit(note, hash, MAX_OBJECT_BYTES)
}

fn read_object_with_limit(note: &Path, hash: &str, max_bytes: usize) -> Result<Option<String>> {
    validate_hash(hash)?;
    let plain = object_path(note, hash);
    let gz = object_path_gz(note, hash);
    let has_plain = object_file_exists(&plain, hash)?;
    let has_gz = object_file_exists(&gz, hash)?;
    if has_plain && has_gz {
        return Err(CliError::Corrupt(format!(
            "object {hash} has both plaintext and compressed files — keep one verified copy"
        )));
    }
    if has_plain {
        let file = open_regular_for_read(&plain, "object")?.ok_or_else(|| {
            CliError::Corrupt(format!("object {hash} disappeared while it was being read"))
        })?;
        let metadata = file
            .metadata()
            .map_err(io_ctx(plain.display().to_string()))?;
        if metadata.len() > max_bytes as u64 {
            return Err(object_too_large(hash, max_bytes));
        }
        let limit = u64::try_from(max_bytes).unwrap_or(u64::MAX) + 1;
        let mut bytes = Vec::new();
        file.take(limit)
            .read_to_end(&mut bytes)
            .map_err(io_ctx(plain.display().to_string()))?;
        if bytes.len() > max_bytes {
            return Err(object_too_large(hash, max_bytes));
        }
        let content = String::from_utf8(bytes).map_err(|_| {
            CliError::Corrupt(format!(
                "object {hash} is not valid UTF-8 — restore it from backup or remove its ledger references"
            ))
        })?;
        verify_hash(hash, &content)?;
        return Ok(Some(content));
    }
    if !has_gz {
        return Ok(None);
    }
    let limit = u64::try_from(max_bytes).unwrap_or(u64::MAX) + 1;
    let mut out = Vec::new();
    let compressed = open_regular_for_read(&gz, "object")?.ok_or_else(|| {
        CliError::Corrupt(format!("object {hash} disappeared while it was being read"))
    })?;
    flate2::read::GzDecoder::new(compressed)
        .take(limit)
        .read_to_end(&mut out)
        .map_err(|error| {
            CliError::Corrupt(format!(
                "object {hash} cannot be decompressed: {error} — restore it from backup or remove its ledger references"
            ))
        })?;
    if out.len() > max_bytes {
        return Err(object_too_large(hash, max_bytes));
    }
    let content = String::from_utf8(out).map_err(|_| {
        CliError::Corrupt(format!(
            "object {hash} is not valid UTF-8 — restore it from backup or remove its ledger references"
        ))
    })?;
    verify_hash(hash, &content)?;
    Ok(Some(content))
}

fn validate_hash(hash: &str) -> Result<()> {
    let valid = hash.strip_prefix("b3:").is_some_and(|hex| {
        matches!(hex.len(), 16 | 64)
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    if valid {
        return Ok(());
    }
    Err(CliError::Corrupt(
        "invalid object hash: expected b3: followed by 16 (legacy) or 64 lowercase hexadecimal characters — repair the ledger before retrying"
            .to_string(),
    ))
}

fn object_file_exists(path: &Path, hash: &str) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(CliError::Corrupt(format!(
            "object {hash} is not a regular file — replace it with a verified object file"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_ctx(path.display().to_string())(error)),
    }
}

fn verify_hash(hash: &str, content: &str) -> Result<()> {
    let actual = mica_core::hash_content_impl(content);
    // The old format encoded the first 16 hex digits of the same digest.
    // Verify the exact width named by the address; every new write is full.
    if actual.get(..hash.len()) == Some(hash) {
        return Ok(());
    }
    Err(CliError::Corrupt(format!(
        "object {hash} failed digest verification (actual {actual}) — restore it from backup or remove its ledger references"
    )))
}

fn object_too_large(hash: &str, max_bytes: usize) -> CliError {
    CliError::Corrupt(format!(
        "object {hash} exceeds the {} byte safety limit — inspect and reduce the object before retrying",
        max_bytes
    ))
}

/// Write `manifest.json` exactly the way the plugin does: tab-indented JSON
/// with key order `noteId`, `path`, `blocks`, `updated`, then a newline —
/// so alternating plugin/CLI writes never churn the file.
///
/// Purpose: keep the human-readable sidecar summary fresh.
///
/// # Arguments
/// * `note` - the note whose sidecar to write
/// * `note_id` - frontmatter `mica-id` when known
/// * `path` - vault-relative note path
/// * `blocks` - block id → display name, in document order
/// * `updated` - unix millis
///
/// # Returns
/// `()` on success.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// mica_cli::sidecar::write_manifest(std::path::Path::new("Note.md"), None, "Note.md", &[], 0).unwrap();
/// ```
pub fn write_manifest(
    note: &Path,
    note_id: Option<&str>,
    path: &str,
    blocks: &[(String, String)],
    updated: u64,
) -> Result<()> {
    ensure_sidecar(note)?;
    // Hand-rolled to match JSON.stringify(manifest, null, "\t") + "\n" byte for
    // byte, including insertion-ordered `blocks` (BTreeMap would reorder).
    let mut out = String::from("{\n");
    out.push_str(&format!("\t\"noteId\": {},\n", json_str_or_null(note_id)));
    out.push_str(&format!("\t\"path\": {},\n", json_str(path)));
    if blocks.is_empty() {
        out.push_str("\t\"blocks\": {},\n");
    } else {
        out.push_str("\t\"blocks\": {\n");
        for (i, (id, name)) in blocks.iter().enumerate() {
            let comma = if i + 1 < blocks.len() { "," } else { "" };
            out.push_str(&format!(
                "\t\t{}: {}{comma}\n",
                json_str(id),
                json_str(name)
            ));
        }
        out.push_str("\t},\n");
    }
    out.push_str(&format!("\t\"updated\": {updated}\n"));
    out.push_str("}\n");
    let p = sidecar_dir(note).join("manifest.json");
    fsutil::atomic_write(&p, out.as_bytes())
}

fn json_str(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

fn json_str_or_null(s: Option<&str>) -> String {
    match s {
        Some(s) => json_str(s),
        None => "null".to_string(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn paths_match_plugin_layout() {
        let note = Path::new("/v/dir/My Note.md");
        assert_eq!(sidecar_dir(note), Path::new("/v/dir/My Note.mica"));
        assert_eq!(
            ledger_path(note),
            Path::new("/v/dir/My Note.mica/ledger.jsonl")
        );
        assert_eq!(
            object_path(note, "b3:abc123"),
            Path::new("/v/dir/My Note.mica/objects/b3-abc123.mica.md")
        );
        assert_eq!(
            object_path(note, "../escape")
                .parent()
                .expect("object parent"),
            objects_dir(note)
        );
    }

    #[test]
    fn manifest_matches_plugin_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("N.md");
        write_manifest(
            &note,
            Some("nid"),
            "N.md",
            &[("b1".into(), "First".into()), ("b2".into(), String::new())],
            42,
        )
        .unwrap();
        let got = fs::read_to_string(tmp.path().join("N.mica/manifest.json")).unwrap();
        // Exactly what JSON.stringify({...}, null, "\t") + "\n" produces.
        let want = "{\n\t\"noteId\": \"nid\",\n\t\"path\": \"N.md\",\n\t\"blocks\": {\n\t\t\"b1\": \"First\",\n\t\t\"b2\": \"\"\n\t},\n\t\"updated\": 42\n}\n";
        assert_eq!(got, want);
    }

    #[test]
    fn ledger_roundtrip_and_bad_line_tolerance() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("N.md");
        let hash = mica_core::hash_content_impl("event");
        let ev = Event::SetHead {
            eid: "e1".into(),
            ts: 1,
            block: "b".into(),
            hash,
        };
        append_events(&note, std::slice::from_ref(&ev)).unwrap();
        // Corrupt line in the middle must not lose the rest.
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(ledger_path(&note))
            .unwrap();
        writeln!(f, "{{not json").unwrap();
        drop(f);
        append_events(&note, std::slice::from_ref(&ev)).unwrap();
        let events = read_ledger(&note).unwrap();
        assert_eq!(
            events,
            vec![ev],
            "exact eid replays are logically deduplicated"
        );
        assert_eq!(ledger_bad_lines(&ledger_path(&note)).unwrap(), 1);
    }

    #[test]
    fn conflicting_ledger_eids_and_duplicate_append_batches_are_rejected() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = tmp.path().join("N.md");
        let first = Event::SetHead {
            eid: "same-eid".into(),
            ts: 1,
            block: "b".into(),
            hash: mica_core::hash_content_impl("first"),
        };
        assert!(matches!(
            append_events(&note, &[first.clone(), first.clone()]),
            Err(CliError::Corrupt(message)) if message.contains("more than once")
        ));
        append_events(&note, std::slice::from_ref(&first)).expect("first event");
        let conflicting = Event::SetHead {
            eid: "same-eid".into(),
            ts: 1,
            block: "b".into(),
            hash: mica_core::hash_content_impl("second"),
        };
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(ledger_path(&note))
                .expect("open ledger"),
            "{}",
            serde_json::to_string(&conflicting).expect("serialize conflict")
        )
        .expect("append conflict");
        assert!(matches!(
            read_ledger(&note),
            Err(CliError::Corrupt(message)) if message.contains("conflicting events")
        ));
    }

    #[test]
    fn torn_ledger_tail_isolated_before_next_event() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = tmp.path().join("N.md");
        ensure_sidecar(&note).expect("sidecar");
        std::fs::write(ledger_path(&note), b"{partial").expect("torn ledger");
        let event = Event::SetHead {
            eid: "e1".into(),
            ts: 1,
            block: "b".into(),
            hash: mica_core::hash_content_impl("body"),
        };
        append_events(&note, std::slice::from_ref(&event)).expect("append");
        assert_eq!(read_ledger(&note).expect("read"), vec![event]);
        assert_eq!(ledger_bad_lines(&ledger_path(&note)).expect("bad"), 1);
    }

    #[test]
    fn ledger_bounds_and_timestamp_are_enforced() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = tmp.path().join("N.md");
        let hash = mica_core::hash_content_impl("body");
        let oversized = Event::Label {
            eid: "e".into(),
            ts: 1,
            block: "b".into(),
            hash: hash.clone(),
            label: Some("x".repeat(MAX_LEDGER_LINE_BYTES)),
        };
        assert!(matches!(
            append_events(&note, &[oversized]),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());

        let now = current_time_ms();
        let too_late = Event::SetHead {
            eid: "e".into(),
            ts: now + MAX_FUTURE_EVENT_SKEW_MS + 60_000,
            block: "b".into(),
            hash: hash.clone(),
        };
        assert!(matches!(
            append_events(&note, &[too_late]),
            Err(CliError::Corrupt(_))
        ));
        let boundary = Event::SetHead {
            eid: "boundary".into(),
            ts: now + MAX_FUTURE_EVENT_SKEW_MS,
            block: "b".into(),
            hash,
        };
        append_events(&note, &[boundary]).expect("timestamp boundary");

        let fixed_boundary = Event::SetHead {
            eid: "fixed-boundary".into(),
            ts: MAX_EVENT_TIMESTAMP_MS,
            block: "b".into(),
            hash: mica_core::hash_content_impl("fixed"),
        };
        assert!(validate_event_at(&fixed_boundary, MAX_EVENT_TIMESTAMP_MS).is_ok());
        let beyond_fixed = Event::SetHead {
            eid: "beyond-fixed".into(),
            ts: MAX_EVENT_TIMESTAMP_MS + 1,
            block: "b".into(),
            hash: mica_core::hash_content_impl("fixed"),
        };
        assert!(validate_event_at(&beyond_fixed, MAX_EVENT_TIMESTAMP_MS).is_err());

        let future_line = serde_json::to_string(&Event::SetHead {
            eid: "future-line".into(),
            ts: current_time_ms() + MAX_FUTURE_EVENT_SKEW_MS + 60_000,
            block: "b".into(),
            hash: mica_core::hash_content_impl("future"),
        })
        .expect("serialize future event");
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(ledger_path(&note))
                .expect("open ledger"),
            "{future_line}"
        )
        .expect("write future event");
        assert_eq!(ledger_bad_lines(&ledger_path(&note)).expect("bad lines"), 1);

        let ledger = ledger_path(&note);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&ledger)
            .expect("open ledger")
            .set_len((MAX_LEDGER_BYTES as u64) + 1)
            .expect("grow sparse ledger");
        assert!(matches!(read_ledger(&note), Err(CliError::Corrupt(_))));
    }

    #[test]
    fn concurrent_ledger_appends_keep_every_event() {
        use std::sync::{Arc, Barrier};

        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = Arc::new(tmp.path().join("N.md"));
        let barrier = Arc::new(Barrier::new(8));
        let hash = mica_core::hash_content_impl("body");
        let mut workers = Vec::new();
        for index in 0..8 {
            let note = Arc::clone(&note);
            let barrier = Arc::clone(&barrier);
            let hash = hash.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                append_events(
                    &note,
                    &[Event::SetHead {
                        eid: format!("event-{index}"),
                        ts: index,
                        block: format!("block-{index}"),
                        hash,
                    }],
                )
            }));
        }
        for worker in workers {
            worker.join().expect("worker").expect("append");
        }
        assert_eq!(read_ledger(&note).expect("read").len(), 8);
        assert_eq!(ledger_bad_lines(&ledger_path(&note)).expect("bad"), 0);
    }

    #[test]
    fn legacy_short_object_addresses_still_verify() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = tmp.path().join("N.md");
        let content = "legacy body";
        let full = mica_core::hash_content_impl(content);
        let legacy = &full[..19];
        ensure_sidecar(&note).expect("sidecar");
        std::fs::write(object_path(&note, legacy), content).expect("legacy object");
        assert_eq!(
            read_object(&note, legacy).expect("read"),
            Some(content.to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_and_ledger_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = tmp.path().join("N.md");
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&outside).expect("outside directory");
        symlink(&outside, sidecar_dir(&note)).expect("sidecar symlink");
        let event = Event::SetHead {
            eid: "e".into(),
            ts: 1,
            block: "b".into(),
            hash: mica_core::hash_content_impl("body"),
        };
        assert!(matches!(
            append_events(&note, std::slice::from_ref(&event)),
            Err(CliError::Corrupt(_))
        ));
        assert!(!outside.join("ledger.jsonl").exists());

        std::fs::remove_file(sidecar_dir(&note)).expect("remove sidecar link");
        ensure_sidecar(&note).expect("real sidecar");
        let outside_ledger = tmp.path().join("outside-ledger");
        std::fs::write(&outside_ledger, b"unchanged").expect("outside ledger");
        symlink(&outside_ledger, ledger_path(&note)).expect("ledger symlink");
        assert!(matches!(
            append_events(&note, &[event]),
            Err(CliError::Corrupt(_))
        ));
        assert_eq!(
            std::fs::read(&outside_ledger).expect("outside unchanged"),
            b"unchanged"
        );
    }

    #[test]
    fn objects_are_immutable() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("N.md");
        let hash = mica_core::hash_content_impl("first");
        write_object(&note, &hash, "first").unwrap();
        let error = write_object(&note, &hash, "SECOND WRITE MUST NOT REPLACE").unwrap_err();
        assert!(matches!(error, CliError::Corrupt(_)));
        assert_eq!(read_object(&note, &hash).unwrap().as_deref(), Some("first"));
        let missing_hash = mica_core::hash_content_impl("missing");
        assert_eq!(read_object(&note, &missing_hash).unwrap(), None);
    }

    #[test]
    fn large_objects_compress_small_stay_plaintext_and_both_read_back() {
        let dir = tempfile::tempdir().expect("tmp");
        let note = dir.path().join("n.md");
        std::fs::write(&note, "x").expect("note");
        let small = "small body";
        let small_hash = mica_core::hash_content_impl(small);
        write_object(&note, &small_hash, small).expect("small write");
        assert!(object_path(&note, &small_hash).is_file(), "small stays .md");
        let large = "L".repeat(COMPRESS_MIN_BYTES + 100);
        let large_hash = mica_core::hash_content_impl(&large);
        write_object(&note, &large_hash, &large).expect("large write");
        assert!(
            object_path_gz(&note, &large_hash).is_file(),
            "large becomes .gz"
        );
        assert!(!object_path(&note, &large_hash).exists());
        assert_eq!(
            read_object(&note, &small_hash).expect("r1"),
            Some(small.to_string())
        );
        assert_eq!(read_object(&note, &large_hash).expect("r2"), Some(large));
        let missing_hash = mica_core::hash_content_impl("absent");
        assert_eq!(read_object(&note, &missing_hash).expect("r3"), None);
    }

    #[test]
    fn corrupt_object_and_invalid_hash_are_rejected() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = dir.path().join("n.md");
        let hash = mica_core::hash_content_impl("expected");
        std::fs::create_dir_all(objects_dir(&note)).expect("objects directory");
        std::fs::write(object_path(&note, &hash), "CORRUPT").expect("corrupt object");

        assert!(matches!(
            read_object(&note, &hash),
            Err(CliError::Corrupt(_))
        ));
        assert!(matches!(
            read_object(&note, "../escape"),
            Err(CliError::Corrupt(_))
        ));

        std::fs::remove_file(object_path(&note, &hash)).expect("remove plaintext");
        std::fs::write(object_path_gz(&note, &hash), b"not gzip").expect("malformed gzip");
        assert!(matches!(
            read_object(&note, &hash),
            Err(CliError::Corrupt(_))
        ));
    }

    #[test]
    fn decompression_is_bounded() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = dir.path().join("n.md");
        const TEST_LIMIT: usize = 1024;
        let oversized = "x".repeat(TEST_LIMIT + 1);
        let hash = mica_core::hash_content_impl(&oversized);
        std::fs::create_dir_all(objects_dir(&note)).expect("objects directory");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(oversized.as_bytes())
            .expect("compress oversized object");
        let bytes = encoder.finish().expect("finish gzip");
        std::fs::write(object_path_gz(&note, &hash), bytes).expect("write gzip");

        assert!(matches!(
            read_object_with_limit(&note, &hash, TEST_LIMIT),
            Err(CliError::Corrupt(_))
        ));
    }

    #[test]
    fn oversized_object_write_is_rejected_before_persistence() {
        const TEST_LIMIT: usize = 1024;
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = dir.path().join("n.md");
        let oversized = "x".repeat(TEST_LIMIT + 1);
        let hash = mica_core::hash_content_impl(&oversized);

        assert!(matches!(
            write_object_with_limit(&note, &hash, &oversized, TEST_LIMIT),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[cfg(unix)]
    #[test]
    fn object_reads_reject_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temporary directory");
        let note = dir.path().join("n.md");
        let content = "outside";
        let hash = mica_core::hash_content_impl(content);
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, content).expect("outside file");
        std::fs::create_dir_all(objects_dir(&note)).expect("objects directory");
        symlink(&outside, object_path(&note, &hash)).expect("object symlink");

        assert!(matches!(
            read_object(&note, &hash),
            Err(CliError::Corrupt(_))
        ));
    }
}

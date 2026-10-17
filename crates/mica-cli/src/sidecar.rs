//! Central vault storage — byte-compatible with the Obsidian plugin's layout.
//!
//! `mica-data/` holds immutable full-hash objects shared by identity-addressed
//! note records. Each note owns its append-only ledger, current manifest and
//! retained transaction journals; the live note path is only metadata.

use crate::error::{io_ctx, CliError, Result};
use crate::fsutil;
use mica_core::Event;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// One explicitly selected vault root. Opening never creates persistent state.
#[derive(Debug, Clone)]
pub struct StoreRoot {
    /// Canonical filesystem root selected independently of Git.
    pub vault: PathBuf,
    /// Fixed paths resolved from the authoritative vault locator.
    pub layout: mica_core::StorageLayout,
    marker: Arc<Mutex<Option<mica_core::StoreMarker>>>,
    location: Arc<Mutex<Option<LocationGeneration>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocationGeneration {
    value: mica_core::StoreLocation,
    bytes: Vec<u8>,
}

static STORE_INITIALIZATION: Mutex<()> = Mutex::new(());

#[derive(Debug, Default)]
struct NoteReadCache {
    aliases: Option<Arc<BTreeMap<String, String>>>,
    referenced: Option<Arc<BTreeSet<String>>>,
}

/// An identity-bound operation context; the source path is only a current hint.
#[derive(Debug, Clone)]
pub struct NoteStore {
    /// Shared object pool and store identity.
    pub root: StoreRoot,
    /// Current live-note hint; this file may be absent for orphan inspection.
    pub note: PathBuf,
    /// Original validated anchor, never interpolated directly into a path.
    pub note_id: String,
    paths: mica_core::NotePaths,
    cache: Arc<Mutex<NoteReadCache>>,
}

const MAX_ALIAS_BYTES: usize = 1024 * 1024;
const MAX_ALIAS_ENTRIES: usize = 16_384;
const MAX_MARKER_BYTES: usize = 4096;

impl StoreRoot {
    /// Resolve the authoritative vault locator without creating persistent state.
    pub fn open(vault: &Path) -> Result<Self> {
        Self::open_at(vault, None)
    }

    /// An explicit first-use folder is only a candidate until claim_location wins.
    /// An existing locator must agree; native commands never resume folder moves.
    pub fn open_at(vault: &Path, folder: Option<&str>) -> Result<Self> {
        let vault = fs::canonicalize(vault).map_err(io_ctx(vault.display().to_string()))?;
        if !vault.is_dir() {
            return Err(CliError::BadArgs("Mica root must be an existing directory".to_string()));
        }
        let requested = folder.map(mica_core::validate_store_folder_impl).transpose().map_err(store_error)?;
        let location = read_location(&vault)?;
        let selected = match location.as_ref() {
            Some(generation) => {
                if requested.as_ref().is_some_and(|value| value != &generation.value.folder) {
                    return Err(CliError::BadArgs("--store-dir disagrees with mica.json; use the configured store folder".to_string()));
                }
                generation.value.folder.clone()
            }
            None => requested.unwrap_or_else(|| mica_core::storage_layout_impl().root),
        };
        let layout = mica_core::storage_layout_at_impl(Some(&selected)).map_err(store_error)?;
        reject_competing_default(&vault, &layout)?;
        let marker = read_routed_marker(&vault, &layout, location.as_ref().map(|generation| &generation.value))?;
        if marker.is_none() && !crate::vault::legacy_sidecars_in(&vault, Some(&layout.root))?.is_empty() {
            return Err(CliError::Corrupt("legacy Mica sidecars require an explicit offline cutover before using the central store".to_string()));
        }
        Ok(Self {
            vault,
            layout,
            marker: Arc::new(Mutex::new(marker)),
            location: Arc::new(Mutex::new(location)),
        })
    }

    fn observed_marker(&self) -> Result<Option<mica_core::StoreMarker>> {
        self.marker.lock().map(|marker| marker.clone())
            .map_err(|_| CliError::Corrupt("Mica store identity lock failed".to_string()))
    }

    fn observed_location(&self) -> Result<Option<LocationGeneration>> {
        self.location.lock().map(|location| location.clone())
            .map_err(|_| CliError::Corrupt("Mica store location lock failed".to_string()))
    }

    fn observe_marker(&self, marker: mica_core::StoreMarker) -> Result<()> {
        let mut observed = self.marker.lock()
            .map_err(|_| CliError::Corrupt("Mica store identity lock failed".to_string()))?;
        if observed.as_ref().is_some_and(|expected| expected.store_id != marker.store_id) {
            return Err(CliError::Corrupt("Mica store identity changed during the operation".to_string()));
        }
        *observed = Some(marker);
        Ok(())
    }

    /// Revalidate the fixed route and store generation without creating state.
    pub(crate) fn revalidate(&self) -> Result<()> {
        let current = read_location(&self.vault)?;
        if current != self.observed_location()? {
            return Err(CliError::Corrupt("Mica storage location changed during the operation; retry against mica.json".to_string()));
        }
        reject_competing_default(&self.vault, &self.layout)?;
        let marker = read_routed_marker(&self.vault, &self.layout, current.as_ref().map(|generation| &generation.value))?;
        match marker {
            Some(marker) => self.observe_marker(marker),
            None if self.observed_marker()?.is_some() => Err(CliError::Corrupt("Mica store disappeared during the operation".to_string())),
            None => Ok(()),
        }
    }

    /// Ordinary reads refuse an unfinished initialization; write preflight stays noncreating.
    pub fn require_ready(&self) -> Result<()> {
        self.revalidate()?;
        if self.observed_location()?.as_ref().is_some_and(|generation| generation.value.initializing) {
            return Err(CliError::Corrupt("Mica store initialization is pending; rerun a writing command to complete the recorded initialization".to_string()));
        }
        Ok(())
    }

    /// Claim routing after full preflight and finish its recorded initialization.
    /// No note, object, ledger, or journal is published by this operation.
    pub fn claim_location(&self) -> Result<()> {
        let _initialization = STORE_INITIALIZATION.lock()
            .map_err(|_| CliError::Corrupt("Mica root initialization lock failed".to_string()))?;
        self.claim_location_locked()
    }

    fn claim_location_locked(&self) -> Result<()> {
        self.revalidate()?;
        match self.observed_location()? {
            None => {
                let existing = self.observed_marker()?;
                let value = mica_core::StoreLocation {
                    format: self.layout.format,
                    folder: self.layout.root.clone(),
                    store_id: Some(existing.as_ref().map(|marker| marker.store_id.clone()).unwrap_or_else(mica_core::new_id_impl)),
                    previous_folder: None,
                    initializing: existing.is_none(),
                };
                let bytes = location_bytes(&value)?;
                publish_immutable(&self.vault.join(&self.layout.location), &bytes)?;
                let winner = read_location(&self.vault)?.ok_or_else(|| CliError::Corrupt("Mica locator disappeared during its claim".to_string()))?;
                if winner.value != value {
                    return Err(CliError::Corrupt("another client claimed a different Mica storage location; no store was initialized".to_string()));
                }
                self.set_location(winner)?;
            }
            Some(generation) if generation.value.store_id.is_none() => {
                let mut value = generation.value;
                value.store_id = Some(mica_core::new_id_impl());
                value.initializing = true;
                self.publish_location(&generation.bytes, value)?;
            }
            Some(_) => {}
        }
        self.finish_initialization_locked()?;
        self.revalidate()
    }

    fn set_location(&self, generation: LocationGeneration) -> Result<()> {
        *self.location.lock().map_err(|_| CliError::Corrupt("Mica store location lock failed".to_string()))? = Some(generation);
        Ok(())
    }

    fn publish_location(&self, expected: &[u8], value: mica_core::StoreLocation) -> Result<()> {
        self.revalidate()?;
        let bytes = location_bytes(&value)?;
        fsutil::atomic_write_if_unchanged(&self.vault.join(&self.layout.location), expected, &bytes)?;
        let published = read_location(&self.vault)?.ok_or_else(|| CliError::Corrupt("Mica locator disappeared after publication".to_string()))?;
        if published.value != value || published.bytes != bytes {
            return Err(CliError::Corrupt("Mica locator changed during publication".to_string()));
        }
        self.set_location(published)
    }

    fn finish_initialization_locked(&self) -> Result<()> {
        let generation = self.observed_location()?.ok_or_else(|| CliError::Corrupt("Mica locator is missing during initialization".to_string()))?;
        if !generation.value.initializing {
            return Ok(());
        }
        self.revalidate()?;
        let id = generation.value.store_id.clone().ok_or_else(|| CliError::Corrupt("recorded Mica initialization has no identity".to_string()))?;
        let marker = mica_core::StoreMarker { format: self.layout.format, store_id: id };
        let mut component_path = self.vault.clone();
        for component in Path::new(&self.layout.root).components() {
            component_path.push(component.as_os_str());
            ensure_safe_dir(&component_path)?;
        }
        if read_initializing_marker(&self.vault, &self.layout, &marker.store_id)?.is_none() {
            let mut bytes = serde_json::to_vec_pretty(&marker).map_err(|error| CliError::Corrupt(error.to_string()))?;
            bytes.push(b'\n');
            publish_immutable(&self.vault.join(&self.layout.marker), &bytes)?;
        }
        let winner = read_initializing_marker(&self.vault, &self.layout, &marker.store_id)?.ok_or_else(|| CliError::Corrupt("Mica store marker disappeared during recorded initialization".to_string()))?;
        self.observe_marker(winner)?;
        let mut value = generation.value;
        value.initializing = false;
        self.publish_location(&generation.bytes, value)
    }

    fn ensure(&self) -> Result<()> {
        let _initialization = STORE_INITIALIZATION.lock()
            .map_err(|_| CliError::Corrupt("Mica root initialization lock failed".to_string()))?;
        self.claim_location_locked()?;
        self.revalidate()?;
        for relative in [&self.layout.objects, &self.layout.notes, &self.layout.orphaned] {
            ensure_safe_dir(&self.vault.join(relative))?;
        }
        let inbox = self.vault.join(&self.layout.bridge_inbox);
        let bridge = inbox.parent().ok_or_else(|| CliError::Corrupt("invalid bridge layout".to_string()))?;
        ensure_safe_dir(bridge)?;
        ensure_safe_dir(&inbox)?;
        ensure_safe_dir(&self.vault.join(&self.layout.bridge_outbox))
    }
}

fn read_routed_marker(vault: &Path, layout: &mica_core::StorageLayout, location: Option<&mica_core::StoreLocation>) -> Result<Option<mica_core::StoreMarker>> {
    if let Some(value) = location.filter(|value| value.initializing) {
        let id = value.store_id.as_deref().ok_or_else(|| CliError::Corrupt("recorded Mica initialization has no identity".to_string()))?;
        return read_initializing_marker(vault, layout, id);
    }
    let marker = read_store_marker(vault, layout)?;
    if let Some(value) = location {
        match value.store_id.as_deref() {
            Some(expected) if marker.as_ref().map(|marker| marker.store_id.as_str()) != Some(expected) => {
                return Err(CliError::Corrupt("mica.json store identity does not match its configured store marker".to_string()));
            }
            None if marker.is_some() => {
                return Err(CliError::Corrupt("an uninitialized Mica locator points to an existing store; resolve mica.json before using it".to_string()));
            }
            _ => {}
        }
    }
    Ok(marker)
}

/// A recorded initialization owns only an empty leaf or its exact UUID marker.
fn read_initializing_marker(vault: &Path, layout: &mica_core::StorageLayout, id: &str) -> Result<Option<mica_core::StoreMarker>> {
    validate_managed_directory(vault, &layout.root)?;
    let dir = vault.join(&layout.root);
    if !dir.exists() { return Ok(None); }
    let mut has_marker = false;
    for entry in fs::read_dir(&dir).map_err(io_ctx(dir.display().to_string()))? {
        let entry = entry.map_err(io_ctx(dir.display().to_string()))?;
        if entry.file_name().as_os_str() != std::ffi::OsStr::new("root.json") {
            return Err(CliError::Corrupt("recorded Mica initialization contains unexpected state; current files were preserved".to_string()));
        }
        has_marker = true;
    }
    if !has_marker { return Ok(None); }
    let marker = read_store_marker(vault, layout)?.ok_or_else(|| CliError::Corrupt("recorded Mica initialization marker disappeared".to_string()))?;
    if marker.store_id != id {
        return Err(CliError::Corrupt("recorded Mica initialization marker has a different identity; current files were preserved".to_string()));
    }
    Ok(Some(marker))
}

fn read_location(vault: &Path) -> Result<Option<LocationGeneration>> {
    let path = vault.join(mica_core::storage_layout_impl().location);
    let Some(bytes) = read_bounded_file(&path, mica_core::MAX_STORE_LOCATION_BYTES, "store locator")? else { return Ok(None); };
    let decoded: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| CliError::Corrupt(format!("invalid Mica store locator: {error}")))?;
    let value: mica_core::StoreLocation = serde_json::from_value(decoded).map_err(|error| CliError::Corrupt(format!("invalid Mica store locator: {error}")))?;
    let value = mica_core::validate_store_location_impl(value).map_err(store_error)?;
    if value.previous_folder.is_some() {
        return Err(CliError::Corrupt("Mica store relocation is pending; reopen the vault in Obsidian to finish it before using the CLI".to_string()));
    }
    Ok(Some(LocationGeneration { value, bytes }))
}

fn location_bytes(value: &mica_core::StoreLocation) -> Result<Vec<u8>> {
    mica_core::validate_store_location_impl(value.clone()).map_err(store_error)?;
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > mica_core::MAX_STORE_LOCATION_BYTES {
        return Err(CliError::Corrupt("Mica store locator exceeds its safety limit".to_string()));
    }
    Ok(bytes)
}

fn reject_competing_default(vault: &Path, layout: &mica_core::StorageLayout) -> Result<()> {
    let default = mica_core::storage_layout_impl();
    if layout.root != default.root {
        let path = vault.join(default.root);
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(CliError::Corrupt("the reserved default Mica store folder also exists; resolve the conflicting store before using the configured location".to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_ctx(path.display().to_string())(error)),
        }
    }
    Ok(())
}

fn validate_managed_directory(vault: &Path, relative: &str) -> Result<()> {
    let mut path = vault.to_path_buf();
    for component in Path::new(relative).components() {
        path.push(component.as_os_str());
        validate_directory_or_missing(&path, "managed directory")?;
    }
    Ok(())
}

fn read_store_marker(vault: &Path, layout: &mica_core::StorageLayout) -> Result<Option<mica_core::StoreMarker>> {
    validate_managed_directory(vault, &layout.root)?;
    let dir = vault.join(&layout.root);
    if !dir.exists() { return Ok(None); }
    let path = vault.join(&layout.marker);
    let bytes = read_bounded_file(&path, MAX_MARKER_BYTES, "store marker")?.ok_or_else(|| CliError::Corrupt(format!("Mica store exists without its root marker: {}", dir.display())))?;
    let decoded: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| CliError::Corrupt(format!("invalid Mica store marker: {error}")))?;
    let value: mica_core::StoreMarker = serde_json::from_value(decoded).map_err(|error| CliError::Corrupt(format!("invalid Mica store marker: {error}")))?;
    mica_core::validate_store_marker_impl(value).map(Some).map_err(store_error)
}

impl NoteStore {
    /// Bind the already-read source anchor without stamping or creating state.
    pub fn from_document(note: &crate::vault::NoteRef, doc: &str) -> Result<Option<Self>> {
        let root = note.store_root()?;
        Self::from_document_in(&root, note, doc)
    }

    /// Reuse a command-owned root while binding one source generation.
    pub fn from_document_in(
        root: &StoreRoot,
        note: &crate::vault::NoteRef,
        doc: &str,
    ) -> Result<Option<Self>> {
        let Some(id) = mica_core::note_id_impl(doc).map_err(store_error)? else {
            return Ok(None);
        };
        Self::bind(root.clone(), &note.abs, &id).map(Some)
    }

    /// Bind a validated identity for staged writes or retained orphan inspection.
    /// Writable callers must separately guard the live source and ID uniqueness.
    pub fn for_id(vault: &Path, note: &Path, id: &str) -> Result<Self> {
        Self::for_id_in(&StoreRoot::open(vault)?, note, id)
    }

    /// Reuse the selected routing generation for staged or orphaned records.
    pub fn for_id_in(root: &StoreRoot, note: &Path, id: &str) -> Result<Self> {
        Self::bind(root.clone(), note, id)
    }

    fn bind(root: StoreRoot, note: &Path, id: &str) -> Result<Self> {
        let paths = mica_core::note_paths_at_impl(id, Some(&root.layout.root)).map_err(store_error)?;
        let note = contained_note_path(&root, note)?;
        validate_directory_or_missing(&root.vault.join(&paths.dir), "note store")?;
        Ok(Self {
            root,
            note,
            note_id: id.to_string(),
            paths,
            cache: Arc::new(Mutex::new(NoteReadCache::default())),
        })
    }

    fn invalidate_references(&self) -> Result<()> {
        self.cache
            .lock()
            .map_err(|_| CliError::Corrupt("Mica note cache lock failed".to_string()))?
            .referenced = None;
        Ok(())
    }
}

fn store_error(error: mica_core::StoreError) -> CliError {
    CliError::Corrupt(error.to_string())
}

fn validate_note_hint(root: &StoreRoot, path: &str) -> Result<()> {
    let bytes = path.as_bytes();
    let drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        || mica_core::is_managed_path_at_impl(path, Some(&root.layout.root)).map_err(store_error)?
        || path.contains('\\')
        || drive
    {
        return Err(CliError::Corrupt(
            "note path hint must be vault-relative with forward separators".to_string(),
        ));
    }
    Ok(())
}

fn contained_note_path(root: &StoreRoot, note: &Path) -> Result<PathBuf> {
    let vault = &root.vault;
    let path = if note.is_absolute() {
        note.to_path_buf()
    } else {
        vault.join(note)
    };
    let relative = path
        .strip_prefix(vault)
        .map_err(|_| CliError::BadArgs("note is outside the selected root".to_string()))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(CliError::BadArgs(
            "note path must be a contained relative file path".to_string(),
        ));
    }
    let relative_text = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if mica_core::is_managed_path_at_impl(&relative_text, Some(&root.layout.root)).map_err(store_error)? {
        return Err(CliError::BadArgs(
            "Mica managed state is not a live note".to_string(),
        ));
    }
    let mut current = vault.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CliError::Corrupt(format!(
                    "note path follows a symlink: {}",
                    current.display()
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(io_ctx(current.display().to_string())(error)),
        }
    }
    Ok(path)
}

fn validate_regular_directory_or_missing(path: &Path, kind: &str) -> Result<bool> {
    validate_directory_or_missing(path, kind)?;
    Ok(path.exists())
}

fn read_bounded_file(path: &Path, limit: usize, kind: &str) -> Result<Option<Vec<u8>>> {
    let Some(file) = open_regular_for_read(path, kind)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_ctx(path.display().to_string()))?;
    if bytes.len() > limit {
        return Err(CliError::Corrupt(format!(
            "{kind} exceeds {limit} bytes: {}",
            path.display()
        )));
    }
    Ok(Some(bytes))
}

/// Publish immutable data without replacing a racing writer's winning file.
fn publish_immutable(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| CliError::Corrupt("immutable file has no parent".to_string()))?;
    let mut staged =
        tempfile::NamedTempFile::new_in(parent).map_err(io_ctx(parent.display().to_string()))?;
    staged
        .write_all(bytes)
        .map_err(io_ctx(path.display().to_string()))?;
    staged
        .as_file()
        .sync_all()
        .map_err(io_ctx(path.display().to_string()))?;
    match staged.persist_noclobber(path) {
        Ok(_) => fsutil::sync_parent(path),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(io_ctx(path.display().to_string())(error.error)),
    }
}

#[derive(serde::Deserialize)]
struct OrderedStringPairs(
    #[serde(deserialize_with = "ordered_string_pairs")] Vec<(String, String)>,
);

fn ordered_string_pairs<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<(String, String)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct PairsVisitor;
    impl<'de> serde::de::Visitor<'de> for PairsVisitor {
        type Value = Vec<(String, String)>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an object with unique string keys and string values")
        }
        fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
        where
            M: serde::de::MapAccess<'de>,
        {
            let mut seen = BTreeSet::new();
            let mut pairs = Vec::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if !seen.insert(key.clone()) {
                    return Err(serde::de::Error::custom("duplicate string-map key"));
                }
                pairs.push((key, value));
            }
            Ok(pairs)
        }
    }
    deserializer.deserialize_map(PairsVisitor)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredManifest<Identity = String> {
    note_id: Identity,
    path: String,
    #[serde(deserialize_with = "ordered_string_pairs")]
    blocks: Vec<(String, String)>,
    updated: u64,
}

/// Validate the record before an operation can publish an anchor or user bytes.
pub(crate) fn preflight_note_record(note: &NoteStore) -> Result<()> {
    validate_sidecar_layout_for_write(note)?;
    let path = note.root.vault.join(&note.paths.manifest);
    if let Some(bytes) = read_bounded_file(&path, MAX_LEDGER_BYTES, "note manifest")? {
        validate_manifest_bytes(note, &bytes)?;
    }
    Ok(())
}

/// Validate a current manifest before it can become a mutable write target.
/// Historical null identities are accepted only by journal comparison below.
pub(crate) fn validate_manifest_bytes(note: &NoteStore, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(
            "note manifest exceeds its safety limit".to_string(),
        ));
    }
    let manifest: StoredManifest = serde_json::from_slice(bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid note manifest: {error}")))?;
    if manifest.note_id != note.note_id {
        return Err(CliError::Corrupt(
            "note manifest identity mismatch".to_string(),
        ));
    }
    validate_note_hint(&note.root, &manifest.path)?;
    contained_note_path(&note.root, Path::new(&manifest.path))?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum HistoricalNoteId {
    Present(String),
    Absent(()),
}

/// Check the current summary after migration's final snapshot/manifest work.
pub(crate) fn verify_manifest_contents(
    note: &NoteStore,
    path: &str,
    blocks: &[(String, String)],
) -> Result<()> {
    preflight_note_record(note)?;
    let bytes = read_bounded_file(&note.root.vault.join(&note.paths.manifest), MAX_LEDGER_BYTES, "note manifest")?
        .ok_or_else(|| CliError::Corrupt("completed migration manifest is missing".to_string()))?;
    let manifest: StoredManifest = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid note manifest: {error}")))?;
    if manifest.note_id != note.note_id || manifest.path != path || manifest.blocks.as_slice() != blocks {
        return Err(CliError::Corrupt(
            "migration manifest does not describe the completed source; the pending journal was preserved".to_string(),
        ));
    }
    Ok(())
}

/// Compare journaled metadata while allowing a moved path and a previously absent anchor.
/// Only a null historical anchor may bind to this store's now-established identity.
pub(crate) fn manifest_matches_except_hint(
    note: &NoteStore,
    current: &[u8],
    expected: &[u8],
) -> Result<bool> {
    if current.len() > MAX_LEDGER_BYTES || expected.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(
            "note manifest exceeds its safety limit".to_string(),
        ));
    }
    let current: StoredManifest = serde_json::from_slice(current)
        .map_err(|error| CliError::Corrupt(format!("invalid current note manifest: {error}")))?;
    let expected: StoredManifest<HistoricalNoteId> = serde_json::from_slice(expected)
        .map_err(|error| CliError::Corrupt(format!("invalid expected note manifest: {error}")))?;
    if current.note_id != note.note_id {
        return Ok(false);
    }
    if let HistoricalNoteId::Present(id) = expected.note_id {
        mica_core::note_paths_impl(&id).map_err(store_error)?;
        if id != note.note_id {
            return Ok(false);
        }
    }
    validate_note_hint(&note.root, &current.path)?;
    validate_note_hint(&note.root, &expected.path)?;
    Ok(current.blocks == expected.blocks && current.updated == expected.updated)
}

/// Enumerate central records independently of whether their live note exists.
pub fn enumerate_note_stores(vault: &Path) -> Result<Vec<NoteStore>> {
    enumerate_note_stores_in(&StoreRoot::open(vault)?)
}

/// Enumerate records using one retained locator and store generation.
pub fn enumerate_note_stores_in(root: &StoreRoot) -> Result<Vec<NoteStore>> {
    root.revalidate()?;
    let notes = root.vault.join(&root.layout.notes);
    if !validate_regular_directory_or_missing(&notes, "notes directory")? {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(&notes).map_err(io_ctx(notes.display().to_string()))? {
        let entry = entry.map_err(io_ctx(notes.display().to_string()))?;
        if !entry
            .file_type()
            .map_err(io_ctx(entry.path().display().to_string()))?
            .is_dir()
        {
            return Err(CliError::Corrupt(format!(
                "note record is not a real directory: {}",
                entry.path().display()
            )));
        }
        let path = entry.path().join("manifest.json");
        let bytes =
            read_bounded_file(&path, MAX_LEDGER_BYTES, "note manifest")?.ok_or_else(|| {
                CliError::Corrupt(format!(
                    "note record has no manifest: {}",
                    entry.path().display()
                ))
            })?;
        let manifest: StoredManifest = serde_json::from_slice(&bytes).map_err(|error| {
            CliError::Corrupt(format!(
                "invalid note manifest at {}: {error}",
                path.display()
            ))
        })?;
        validate_note_hint(root, &manifest.path)?;
        let store = NoteStore::bind(root.clone(), Path::new(&manifest.path), &manifest.note_id)?;
        if sidecar_dir(&store) != entry.path() {
            return Err(CliError::Corrupt(format!(
                "note record key disagrees with its identity: {}",
                entry.path().display()
            )));
        }
        records.push(store);
    }
    records.sort_by(|left, right| left.paths.key.cmp(&right.paths.key));
    Ok(records)
}

/// Update a rename hint without moving history or changing version identity.
pub fn update_note_hint(note: &NoteStore) -> Result<()> {
    preflight_note_record(note)?;
    let path = note.root.vault.join(&note.paths.manifest);
    let Some(bytes) = read_bounded_file(&path, MAX_LEDGER_BYTES, "note manifest")? else {
        return Ok(());
    };
    let manifest: StoredManifest = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid note manifest: {error}")))?;
    if manifest.note_id != note.note_id {
        return Err(CliError::Corrupt(
            "note manifest identity mismatch".to_string(),
        ));
    }
    let relative = note
        .note
        .strip_prefix(&note.root.vault)
        .map_err(|_| CliError::BadArgs("note is outside its root".to_string()))?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if manifest.path == relative {
        return Ok(());
    }
    let next = manifest_bytes(
        Some(&manifest.note_id),
        &relative,
        &manifest.blocks,
        manifest.updated,
    );
    validate_manifest_bytes(note, &next)?;
    note.root.claim_location()?;
    preflight_note_record(note)?;
    fsutil::atomic_write_if_unchanged(&path, &bytes, &next)
}

/// Identity-bound central note directory.
pub fn sidecar_dir(note: &NoteStore) -> PathBuf {
    note.root.vault.join(&note.paths.dir)
}

/// The sidecar's `objects/` directory.
pub fn objects_dir(note: &NoteStore) -> PathBuf {
    note.root
        .vault
        .join(&note.root.layout.objects)
}

/// The sidecar's append-only ledger path.
pub fn ledger_path(note: &NoteStore) -> PathBuf {
    note.root.vault.join(&note.paths.ledger)
}

/// Durable migration transaction record. It deliberately remains after a
/// successful migration so the whole-note pre-image has a named reference.
pub fn migration_journal_path(note: &NoteStore) -> PathBuf {
    note.root.vault.join(&note.paths.migration)
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

/// Recoverable transaction record for one logical-section normalization.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionNormalizationJournal {
    /// Journal schema version.
    pub format: u8,
    /// `pending` until note publication, replacement append, and verification finish.
    pub status: String,
    /// Vault-relative note path at the time of normalization.
    pub note: String,
    /// Object hash of the exact whole-note preimage.
    pub original: String,
    /// Object hash of the exact normalized whole-note result.
    pub normalized: String,
    /// Whether this transaction includes historical version bodies.
    pub history: bool,
    /// Stable ReplaceVersion events to replay after an interrupted publication.
    pub events: Vec<Event>,
}

/// Recoverable transaction record for consolidating legacy prompt blocks as tabs.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabConsolidationJournal {
    /// Journal schema version.
    pub format: u8,
    /// `pending` until note, ledger, manifest, and verification publication finish.
    pub status: String,
    /// Vault-relative note path at the time of consolidation.
    pub note: String,
    /// Object hash of the exact whole-note preimage.
    pub original: String,
    /// Object hash of the exact consolidated whole-note result.
    pub consolidated: String,
    /// Whether this transaction preserves historical version events.
    pub history: bool,
    /// Block that owns the consolidated tabs and resulting history.
    pub target_block: String,
    /// Source-block to tab-title mappings used by the consolidation.
    pub tabs: Vec<TabConsolidationTab>,
    /// Source-version to target-version mappings used by the consolidation.
    pub versions: Vec<TabConsolidationVersion>,
    /// Stable ledger events to replay after an interrupted publication.
    pub events: Vec<Event>,
    /// Exact original manifest bytes, when a manifest existed.
    pub manifest_original: Option<String>,
    /// Exact consolidated manifest bytes.
    pub manifest_consolidated: String,
}

/// One source block represented as a tab in a consolidated Mica block.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabConsolidationTab {
    /// Stable block identity from the source note.
    pub source_block: String,
    /// Display title assigned to the resulting tab.
    pub title: String,
}

/// One historical source event mapped to its consolidated target event.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabConsolidationVersion {
    /// Existing source `add-version` event identity.
    pub source_event: String,
    /// Newly planned target `add-version` event identity.
    pub target_event: String,
    /// Stable block identity that owned the source version.
    pub source_block: String,
    /// Object hash stored by the source version.
    pub source_hash: String,
    /// Object hash stored by the consolidated target version.
    pub target_hash: String,
}

/// Return the identity-bound logical-section normalization journal path.
///
/// # Arguments
/// * `note` - Markdown note path
///
/// # Returns
/// `<Note>.mica/section-normalization.json`.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let path = mica_cli::sidecar::section_normalization_journal_path(
///     &note,
/// );
/// assert!(path.ends_with("section-normalization.json"));
/// ```
pub fn section_normalization_journal_path(note: &NoteStore) -> PathBuf {
    note.root.vault.join(&note.paths.section_normalization)
}

/// Return the identity-bound tab-consolidation transaction journal path.
///
/// # Arguments
/// * `note` - Markdown note path
///
/// # Returns
/// `<Note>.mica/tab-consolidation.json`.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let path = mica_cli::sidecar::tab_consolidation_journal_path(
///     &note,
/// );
/// assert!(path.ends_with("tab-consolidation.json"));
/// ```
pub fn tab_consolidation_journal_path(note: &NoteStore) -> PathBuf {
    note.root.vault.join(&note.paths.tab_consolidation)
}

/// Read and validate a bounded tab-consolidation transaction journal.
///
/// # Arguments
/// * `note` - Markdown note whose sidecar contains the journal
///
/// # Returns
/// The journal, or `None` when no transaction has started.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let journal = mica_cli::sidecar::read_tab_consolidation_journal(
///     &note,
/// )?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn read_tab_consolidation_journal(note: &NoteStore) -> Result<Option<TabConsolidationJournal>> {
    validate_sidecar_layout_for_write(note)?;
    let path = tab_consolidation_journal_path(note);
    let Some(file) = open_regular_for_read(&path, "tab-consolidation journal")? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take((MAX_LEDGER_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(io_ctx(path.display().to_string()))?;
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(format!(
            "tab-consolidation journal exceeds the {MAX_LEDGER_BYTES} byte safety limit: {}",
            path.display()
        )));
    }
    let journal: TabConsolidationJournal = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::Corrupt(format!(
            "tab-consolidation journal is invalid at {}: {error}",
            path.display()
        ))
    })?;
    validate_tab_consolidation_journal(&journal)?;
    Ok(Some(journal))
}

/// Atomically write a validated tab-consolidation transaction journal.
///
/// # Arguments
/// * `note` - Markdown note whose sidecar owns the journal
/// * `journal` - Pending or complete transaction record
///
/// # Returns
/// `()` after durable publication.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// # let journal: mica_cli::sidecar::TabConsolidationJournal = todo!();
/// mica_cli::sidecar::write_tab_consolidation_journal(&note, &journal)?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn write_tab_consolidation_journal(
    note: &NoteStore,
    journal: &TabConsolidationJournal,
) -> Result<()> {
    persist_tab_consolidation_journal(note, journal, JournalPublication::Owned)
}

/// Claim one pending transaction against the exact journal observed during planning.
pub(crate) fn claim_tab_consolidation_journal(
    note: &NoteStore,
    journal: &TabConsolidationJournal,
    expected: Option<&[u8]>,
) -> Result<()> {
    persist_tab_consolidation_journal(note, journal, JournalPublication::Claim(expected))
}

fn persist_tab_consolidation_journal(
    note: &NoteStore,
    journal: &TabConsolidationJournal,
    publication: JournalPublication<'_>,
) -> Result<()> {
    note.invalidate_references()?;
    validate_tab_consolidation_journal_encoding(journal, MAX_LEDGER_BYTES)?;
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    let path = tab_consolidation_journal_path(note);
    publish_journal(note, &path, &bytes, publication, |current| {
        let previous: TabConsolidationJournal = serde_json::from_slice(current)
            .map_err(|error| CliError::Corrupt(format!("invalid transaction journal: {error}")))?;
        validate_tab_consolidation_journal(&previous)
    }, || {
        verify_journal_completion(note, &journal.consolidated, &journal.events)?;
        crate::consolidate::inspect_completed_journal(note, journal)
    })
}

fn validate_tab_consolidation_journal(journal: &TabConsolidationJournal) -> Result<()> {
    if journal.format != 1 || !matches!(journal.status.as_str(), "pending" | "complete") {
        return Err(CliError::Corrupt(
            "unsupported tab-consolidation journal format or status".to_string(),
        ));
    }
    if journal.note.is_empty() || journal.target_block.is_empty() {
        return Err(CliError::Corrupt(
            "tab-consolidation journal note and target block must not be empty".to_string(),
        ));
    }
    validate_hash(&journal.original)?;
    validate_hash(&journal.consolidated)?;
    if journal.events.len() > MAX_LEDGER_EVENTS {
        return Err(CliError::Corrupt(format!(
            "tab-consolidation journal has more than {MAX_LEDGER_EVENTS} events"
        )));
    }

    let mut tab_blocks = HashMap::with_capacity(journal.tabs.len());
    for tab in &journal.tabs {
        if tab.source_block.is_empty() || tab.title.is_empty() {
            return Err(CliError::Corrupt(
                "tab-consolidation journal tab identities and titles must not be empty".to_string(),
            ));
        }
        if tab_blocks.insert(tab.source_block.as_str(), ()).is_some() {
            return Err(CliError::Corrupt(format!(
                "tab-consolidation journal repeats source block {:?}",
                tab.source_block
            )));
        }
    }

    let mut event_by_eid = HashMap::with_capacity(journal.events.len());
    for event in &journal.events {
        let eid = event_eid(event);
        if eid.is_empty() {
            return Err(CliError::Corrupt(
                "tab-consolidation journal event identities must not be empty".to_string(),
            ));
        }
        if event_by_eid.insert(eid, event).is_some() {
            return Err(CliError::Corrupt(format!(
                "tab-consolidation journal reuses event id {eid:?}"
            )));
        }
        let block = match event {
            Event::AddVersion { block, .. }
            | Event::ReplaceVersion { block, .. }
            | Event::SetHead { block, .. }
            | Event::Label { block, .. }
            | Event::Checkpoint { block, .. }
            | Event::MoveHead { block, .. }
            | Event::VersionLabel { block, .. }
            | Event::VersionVisibility { block, .. } => block,
        };
        if block.is_empty() || block != &journal.target_block {
            return Err(CliError::Corrupt(
                "tab-consolidation journal events must identify the target block".to_string(),
            ));
        }
        if !journal.history
            && matches!(
                event,
                Event::AddVersion { .. } | Event::ReplaceVersion { .. } | Event::Label { .. }
            )
        {
            return Err(CliError::Corrupt(
                "tab-consolidation journal contains history events without history".to_string(),
            ));
        }
        validate_event(event)?;
        let encoded =
            serde_json::to_vec(event).map_err(|error| CliError::Corrupt(error.to_string()))?;
        if encoded.len() > MAX_LEDGER_LINE_BYTES {
            return Err(CliError::Corrupt(format!(
                "tab-consolidation journal event is {} bytes (limit {MAX_LEDGER_LINE_BYTES})",
                encoded.len()
            )));
        }
    }

    if !journal.history && !journal.versions.is_empty() {
        return Err(CliError::Corrupt(
            "tab-consolidation journal contains version mappings without history".to_string(),
        ));
    }
    let mut source_events = HashMap::with_capacity(journal.versions.len());
    let mut target_events = HashMap::with_capacity(journal.versions.len());
    for version in &journal.versions {
        if version.source_event.is_empty()
            || version.target_event.is_empty()
            || version.source_block.is_empty()
        {
            return Err(CliError::Corrupt(
                "tab-consolidation journal version identities must not be empty".to_string(),
            ));
        }
        validate_hash(&version.source_hash)?;
        validate_hash(&version.target_hash)?;
        if !tab_blocks.contains_key(version.source_block.as_str()) {
            return Err(CliError::Corrupt(format!(
                "tab-consolidation journal version references unknown source block {:?}",
                version.source_block
            )));
        }
        if source_events
            .insert(version.source_event.as_str(), ())
            .is_some()
            || target_events
                .insert(version.target_event.as_str(), ())
                .is_some()
        {
            return Err(CliError::Corrupt(
                "tab-consolidation journal repeats a version event mapping".to_string(),
            ));
        }
        let Some(target_event) = event_by_eid.get(version.target_event.as_str()).copied() else {
            return Err(CliError::Corrupt(format!(
                "tab-consolidation journal target event {:?} is not included",
                version.target_event
            )));
        };
        let (eid, block, hash) = match target_event {
            Event::AddVersion {
                block, hash, eid, ..
            }
            | Event::Checkpoint {
                block, hash, eid, ..
            } => (eid, block, hash),
            _ => {
                return Err(CliError::Corrupt(format!(
                    "tab-consolidation journal target event {:?} is not a version checkpoint",
                    version.target_event
                )));
            }
        };
        if eid != &version.target_event
            || block != &journal.target_block
            || hash != &version.target_hash
        {
            return Err(CliError::Corrupt(format!(
                "tab-consolidation journal target event {:?} disagrees with its version mapping",
                version.target_event
            )));
        }
    }
    Ok(())
}

/// Read and validate a bounded logical-section normalization journal.
///
/// # Arguments
/// * `note` - Markdown note whose sidecar contains the journal
///
/// # Returns
/// The journal, or `None` when no transaction has started.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let journal = mica_cli::sidecar::read_section_normalization_journal(
///     &note,
/// )?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn read_section_normalization_journal(
    note: &NoteStore,
) -> Result<Option<SectionNormalizationJournal>> {
    read_section_normalization_journal_record(note)
        .map(|record| record.map(|(journal, _)| journal))
}

/// Read a validated journal together with its exact planning preimage.
pub(crate) fn read_section_normalization_journal_record(
    note: &NoteStore,
) -> Result<Option<(SectionNormalizationJournal, Vec<u8>)>> {
    validate_sidecar_layout_for_write(note)?;
    let path = section_normalization_journal_path(note);
    let Some(file) = open_regular_for_read(&path, "section-normalization journal")? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take((MAX_LEDGER_BYTES as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(io_ctx(path.display().to_string()))?;
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(format!(
            "section-normalization journal exceeds the {MAX_LEDGER_BYTES} byte safety limit: {}",
            path.display()
        )));
    }
    let journal: SectionNormalizationJournal = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::Corrupt(format!(
            "section-normalization journal is invalid at {}: {error}",
            path.display()
        ))
    })?;
    validate_section_normalization_journal(&journal)?;
    Ok(Some((journal, bytes)))
}

/// Atomically write a validated logical-section normalization journal.
///
/// # Arguments
/// * `note` - Markdown note whose sidecar owns the journal
/// * `journal` - pending or complete transaction record
///
/// # Returns
/// `()` after durable publication.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// # let journal: mica_cli::sidecar::SectionNormalizationJournal = todo!();
/// mica_cli::sidecar::write_section_normalization_journal(
///     &note,
///     &journal,
/// )?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn write_section_normalization_journal(
    note: &NoteStore,
    journal: &SectionNormalizationJournal,
) -> Result<()> {
    persist_section_normalization_journal(note, journal, JournalPublication::Owned)
}

/// Claim one pending transaction against the exact journal observed during planning.
pub(crate) fn claim_section_normalization_journal(
    note: &NoteStore,
    journal: &SectionNormalizationJournal,
    expected: Option<&[u8]>,
) -> Result<()> {
    persist_section_normalization_journal(note, journal, JournalPublication::Claim(expected))
}

fn persist_section_normalization_journal(
    note: &NoteStore,
    journal: &SectionNormalizationJournal,
    publication: JournalPublication<'_>,
) -> Result<()> {
    note.invalidate_references()?;
    validate_section_normalization_journal_encoding(journal, MAX_LEDGER_BYTES)?;
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    let path = section_normalization_journal_path(note);
    publish_journal(note, &path, &bytes, publication, |current| {
        let previous: SectionNormalizationJournal = serde_json::from_slice(current)
            .map_err(|error| CliError::Corrupt(format!("invalid transaction journal: {error}")))?;
        validate_section_normalization_journal(&previous)
    }, || {
        let (doc, ledger) = verify_journal_completion(note, &journal.normalized, &journal.events)?;
        crate::normalize::verify_journal_completion(note, journal, &doc, &ledger)
    })
}

fn validate_section_normalization_journal(journal: &SectionNormalizationJournal) -> Result<()> {
    if journal.format != 1 || !matches!(journal.status.as_str(), "pending" | "complete") {
        return Err(CliError::Corrupt(
            "unsupported section-normalization journal format or status".to_string(),
        ));
    }
    validate_hash(&journal.original)?;
    validate_hash(&journal.normalized)?;
    if !journal.history && !journal.events.is_empty() {
        return Err(CliError::Corrupt(
            "section-normalization journal contains replacement events without history".to_string(),
        ));
    }
    if journal.events.len() > MAX_LEDGER_EVENTS {
        return Err(CliError::Corrupt(format!(
            "section-normalization journal has more than {MAX_LEDGER_EVENTS} events"
        )));
    }
    let mut eids = HashMap::with_capacity(journal.events.len());
    for event in &journal.events {
        let Event::ReplaceVersion {
            eid, block, target, ..
        } = event
        else {
            return Err(CliError::Corrupt(
                "section-normalization journal contains a non-replacement event".to_string(),
            ));
        };
        if eid.is_empty() || block.is_empty() || target.is_empty() {
            return Err(CliError::Corrupt(
                "section-normalization journal replacement identities must not be empty"
                    .to_string(),
            ));
        }
        if eids.insert(eid.as_str(), ()).is_some() {
            return Err(CliError::Corrupt(format!(
                "section-normalization journal reuses event id {eid:?}"
            )));
        }
        validate_event(event)?;
        let encoded =
            serde_json::to_vec(event).map_err(|error| CliError::Corrupt(error.to_string()))?;
        if encoded.len() > MAX_LEDGER_LINE_BYTES {
            return Err(CliError::Corrupt(format!(
                "section-normalization journal event is {} bytes (limit {MAX_LEDGER_LINE_BYTES})",
                encoded.len()
            )));
        }
    }
    Ok(())
}

/// Compressed-object variant path (large objects). Hash is over PLAINTEXT.
pub fn object_path_gz(note: &NoteStore, hash: &str) -> Result<PathBuf> {
    let paths = mica_core::object_paths_at_impl(hash, Some(&note.root.layout.root)).map_err(store_error)?;
    Ok(note.root.vault.join(paths.gzip))
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
pub fn object_path(note: &NoteStore, hash: &str) -> Result<PathBuf> {
    let paths = mica_core::object_paths_at_impl(hash, Some(&note.root.layout.root)).map_err(store_error)?;
    Ok(note.root.vault.join(paths.plain))
}

/// Read the ledger; malformed or untyped lines are skipped (never lose the
/// whole history to one torn line), while unknown typed events fail closed.
/// Missing ledger = empty.
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
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let events = mica_cli::sidecar::read_ledger(&note).unwrap();
/// ```
pub fn read_ledger(note: &NoteStore) -> Result<Vec<Event>> {
    read_ledger_report(note).map(|report| report.events)
}

/// [`read_ledger`] against an explicit ledger path (repair/doctor sweeps).
pub fn read_ledger_at(path: &Path) -> Result<Vec<Event>> {
    read_ledger_report_at(path).map(|report| report.events)
}

/// One bounded ledger read and parse, including recoverable-line diagnostics.
pub(crate) struct LedgerRead {
    pub(crate) events: Vec<Event>,
    pub(crate) bad_lines: usize,
}

pub(crate) fn read_ledger_report(note: &NoteStore) -> Result<LedgerRead> {
    validate_sidecar_layout_for_write(note)?;
    read_ledger_report_at(&ledger_path(note))
}

pub(crate) fn read_ledger_report_at(path: &Path) -> Result<LedgerRead> {
    let Some(text) = read_ledger_text(path)? else {
        return Ok(LedgerRead {
            events: Vec::new(),
            bad_lines: 0,
        });
    };
    // Per ledger: O(bytes + events) time and O(bytes + events) space. Keeping
    // events and diagnostics together prevents callers from repeating both the
    // bounded file read and the JSON parse.
    parse_ledger(&text).map(|(events, bad_lines)| LedgerRead { events, bad_lines })
}

/// Count of unparseable ledger lines (doctor's corruption signal).
pub fn ledger_bad_lines(path: &Path) -> Result<usize> {
    read_ledger_report_at(path).map(|report| report.bad_lines)
}

/// Read the bounded migration journal, if one exists.
pub fn read_migration_journal(note: &NoteStore) -> Result<Option<MigrationJournal>> {
    read_migration_journal_record(note)
        .map(|record| record.map(|(journal, _)| journal))
}

/// Read a validated journal together with its exact planning preimage.
pub(crate) fn read_migration_journal_record(
    note: &NoteStore,
) -> Result<Option<(MigrationJournal, Vec<u8>)>> {
    validate_sidecar_layout_for_write(note)?;
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
    Ok(Some((journal, bytes)))
}

/// Atomically and durably write a validated migration journal.
pub fn write_migration_journal(note: &NoteStore, journal: &MigrationJournal) -> Result<()> {
    persist_migration_journal(note, journal, JournalPublication::Owned)
}

/// Claim one pending transaction against the exact journal observed during planning.
pub(crate) fn claim_migration_journal(
    note: &NoteStore,
    journal: &MigrationJournal,
    expected: Option<&[u8]>,
) -> Result<()> {
    persist_migration_journal(note, journal, JournalPublication::Claim(expected))
}

fn persist_migration_journal(
    note: &NoteStore,
    journal: &MigrationJournal,
    publication: JournalPublication<'_>,
) -> Result<()> {
    note.invalidate_references()?;
    let bytes = encode_migration_journal(journal)?;
    let path = migration_journal_path(note);
    publish_journal(note, &path, &bytes, publication, |current| {
        let previous: MigrationJournal = serde_json::from_slice(current)
            .map_err(|error| CliError::Corrupt(format!("invalid transaction journal: {error}")))?;
        validate_migration_journal(&previous)
    }, || {
        let (doc, ledger) = verify_journal_completion(note, &journal.migrated, &journal.events)?;
        crate::engine::verify_migration_completion(note, journal, &doc, &ledger)
    })
}

fn encode_migration_journal(journal: &MigrationJournal) -> Result<Vec<u8>> {
    validate_migration_journal(journal)?;
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(format!(
            "migration journal exceeds the {MAX_LEDGER_BYTES} byte safety limit"
        )));
    }
    Ok(bytes)
}

/// Validate a prospective migration journal before any source anchor is published.
pub(crate) fn preflight_migration_journal(
    note: &NoteStore,
    journal: &MigrationJournal,
) -> Result<()> {
    encode_migration_journal(journal)?;
    preflight_note_record(note)?;
    validate_regular_file_or_missing(&migration_journal_path(note), "migration journal")?;
    Ok(())
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
        if matches!(event, Event::ReplaceVersion { .. }) {
            return Err(CliError::Corrupt(
                "migration journal contains a section-normalization replacement event".to_string(),
            ));
        }
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
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// mica_cli::sidecar::append_events(&note, &[]).unwrap();
/// ```
pub fn append_events(note: &NoteStore, events: &[Event]) -> Result<()> {
    note.invalidate_references()?;
    if events.is_empty() {
        return Ok(());
    }
    let lines = encode_event_batch(events)?;
    append_encoded_events(note, &lines)
}

fn encode_event_batch(events: &[Event]) -> Result<String> {
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
    Ok(lines)
}

fn append_encoded_events(note: &NoteStore, lines: &str) -> Result<()> {
    with_locked_ledger(note, |file, path| {
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
        fsutil::sync_parent(path)
    })
}

/// Native appenders and journal publishers share the existing append-only ledger lock.
/// Other hosts must honor the documented writer-quiescence requirement; portable
/// guarded replacement cannot exclude a non-cooperating compare-to-rename race.
fn with_locked_ledger(
    note: &NoteStore,
    write: impl FnOnce(&mut fs::File, &Path) -> Result<()>,
) -> Result<()> {
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
        // The file lock may block while another host changes the store route.
        preflight_note_record(note)?;
        write(&mut file, &path)
    })();
    let unlock_result = file.unlock().map_err(io_ctx(path.display().to_string()));
    write_result.and(unlock_result)
}

#[derive(Clone, Copy)]
enum JournalPublication<'a> {
    Claim(Option<&'a [u8]>),
    Owned,
}

/// Recheck the exact bytes observed while planning before the producer's first effect.
pub(crate) fn preflight_journal_claim(
    note: &NoteStore,
    path: &Path,
    expected: Option<&[u8]>,
) -> Result<()> {
    preflight_note_record(note)?;
    let current = read_bounded_file(path, MAX_LEDGER_BYTES, "transaction journal")?;
    validate_journal_claim(current.as_deref(), expected)
}

/// Publish a claimed pending payload, or complete a matching pending payload
/// after verifying its effects. Same-state replay preserves the existing bytes,
/// including event and embedded manifest representations.
fn publish_journal(
    note: &NoteStore,
    path: &Path,
    bytes: &[u8],
    publication: JournalPublication<'_>,
    validate_current: impl Fn(&[u8]) -> Result<()>,
    verify_complete: impl Fn() -> Result<()>,
) -> Result<()> {
    let next: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid journal publication: {error}")))?;
    preflight_note_record(note)?;
    let current = read_bounded_file(path, MAX_LEDGER_BYTES, "transaction journal")?;
    if let Some(bytes) = current.as_deref() { validate_current(bytes)?; }
    if !journal_publication_needed(current.as_deref(), &next, publication)? {
        return Ok(());
    }
    with_locked_ledger(note, |_, _| {
        let current = read_bounded_file(path, MAX_LEDGER_BYTES, "transaction journal")?;
        if let Some(bytes) = current.as_deref() { validate_current(bytes)?; }
        if !journal_publication_needed(current.as_deref(), &next, publication)? {
            return Ok(());
        }
        if matches!(publication, JournalPublication::Owned) && journal_status(&next)? == "complete" {
            verify_complete()?;
        }
        match current {
            Some(expected) => fsutil::atomic_write_if_unchanged(path, &expected, bytes)?,
            None => publish_immutable(path, bytes)?,
        }
        if read_bounded_file(path, MAX_LEDGER_BYTES, "transaction journal")?.as_deref()
            != Some(bytes)
        {
            return Err(CliError::Corrupt(
                "transaction journal changed during publication; current bytes were preserved".to_string(),
            ));
        }
        Ok(())
    })
}

/// Completion postconditions are observed only while the caller owns the ledger lock.
/// No writer, append, snapshot, or nested ledger-lock acquisition is allowed here.
fn verify_journal_completion(
    note: &NoteStore,
    postimage: &str,
    events: &[Event],
) -> Result<(String, LedgerRead)> {
    let expected = read_object(note, postimage)?.ok_or_else(|| {
        CliError::Corrupt("journal completion postimage is missing".to_string())
    })?;
    let current = read_bounded_file(&note.note, MAX_OBJECT_BYTES, "live note")?.ok_or_else(|| {
        CliError::Corrupt("journal completion live note is missing".to_string())
    })?;
    if current.as_slice() != expected.as_bytes()
        || mica_core::note_id_impl(&expected).map_err(store_error)?.as_deref()
            != Some(note.note_id.as_str())
    {
        return Err(CliError::Corrupt(
            "journal completion source is not the bound postimage; the pending journal was preserved".to_string(),
        ));
    }
    crate::engine::validate_unique_ids(&expected)?;
    let ledger = read_ledger_report(note)?;
    if ledger.bad_lines != 0 || !classify_event_batch_in(&ledger.events, events)?.missing.is_empty() {
        return Err(CliError::Corrupt(
            "journal completion events are not fully present in a valid ledger; the pending journal was preserved".to_string(),
        ));
    }
    Ok((expected, ledger))
}

fn journal_publication_needed(
    current: Option<&[u8]>,
    next: &serde_json::Value,
    publication: JournalPublication<'_>,
) -> Result<bool> {
    let next_status = journal_status(next)?;
    if let JournalPublication::Claim(expected) = publication {
        if next_status != "pending" {
            return Err(CliError::Corrupt("a transaction claim must be pending".to_string()));
        }
        validate_journal_claim(current, expected)?;
        return Ok(true);
    }
    let Some(bytes) = current else {
        if next_status == "pending" { return Ok(true); }
        return Err(CliError::Corrupt(
            "cannot complete a transaction without its pending journal".to_string(),
        ));
    };
    let mut previous: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid transaction journal: {error}")))?;
    let previous_status = journal_status(&previous)?.to_string();
    previous.as_object_mut().ok_or_else(|| CliError::Corrupt("transaction journal must be an object".to_string()))?
        .insert("status".to_string(), serde_json::Value::String(next_status.to_string()));
    if previous != *next {
        return Err(CliError::Corrupt(
            "journal publication belongs to a different transaction; the existing journal was preserved".to_string(),
        ));
    }
    match (previous_status.as_str(), next_status) {
        ("pending", "complete") => Ok(true),
        ("pending", "pending") | ("complete", "complete") => Ok(false),
        _ => Err(CliError::Corrupt(
            "a completed transaction cannot be reopened; its journal was preserved".to_string(),
        )),
    }
}

fn validate_journal_claim(
    current: Option<&[u8]>,
    expected: Option<&[u8]>,
) -> Result<()> {
    if current != expected {
        return Err(CliError::Corrupt(
            "transaction journal changed after planning; the existing transaction was preserved".to_string(),
        ));
    }
    let Some(bytes) = current else { return Ok(()); };
    let previous: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid transaction journal: {error}")))?;
    if journal_status(&previous)? != "complete" {
        return Err(CliError::Corrupt(
            "a pending transaction already owns this journal; resume it before starting another".to_string(),
        ));
    }
    Ok(())
}

fn journal_status(value: &serde_json::Value) -> Result<&str> {
    match value.get("status").and_then(serde_json::Value::as_str) {
        Some(status @ ("pending" | "complete")) => Ok(status),
        _ => Err(CliError::Corrupt("invalid transaction journal status".to_string())),
    }
}

pub(crate) fn preflight_object_write(note: &NoteStore, hash: &str, content: &str) -> Result<bool> {
    preflight_object_write_with_limit(note, hash, content, MAX_OBJECT_BYTES)
}

fn preflight_object_write_with_limit(
    note: &NoteStore,
    hash: &str,
    content: &str,
    max_bytes: usize,
) -> Result<bool> {
    mica_core::object_paths_impl(hash).map_err(store_error)?;
    verify_hash(hash, content)?;
    if content.len() > max_bytes {
        return Err(object_too_large(hash, max_bytes));
    }
    validate_sidecar_layout_for_write(note)?;
    match read_pooled_object(&note.root, hash, max_bytes)? {
        Some(existing) if existing == content => Ok(false),
        Some(_) => Err(CliError::Corrupt(format!(
            "existing object {hash} differs from the planned content"
        ))),
        None => Ok(true),
    }
}

pub(crate) fn preflight_section_normalization_journal(
    note: &NoteStore,
    journal: &SectionNormalizationJournal,
) -> Result<()> {
    validate_section_normalization_journal_encoding(journal, MAX_LEDGER_BYTES)?;
    validate_sidecar_layout_for_write(note)?;
    validate_regular_file_or_missing(
        &section_normalization_journal_path(note),
        "section-normalization journal",
    )?;
    Ok(())
}

pub(crate) fn preflight_tab_consolidation_journal(
    note: &NoteStore,
    journal: &TabConsolidationJournal,
) -> Result<()> {
    validate_tab_consolidation_journal_encoding(journal, MAX_LEDGER_BYTES)?;
    validate_sidecar_layout_for_write(note)?;
    validate_regular_file_or_missing(
        &tab_consolidation_journal_path(note),
        "tab-consolidation journal",
    )?;
    Ok(())
}

fn validate_section_normalization_journal_encoding(
    journal: &SectionNormalizationJournal,
    max_bytes: usize,
) -> Result<()> {
    validate_section_normalization_journal(journal)?;
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > max_bytes {
        return Err(CliError::Corrupt(format!(
            "section-normalization journal exceeds the {max_bytes} byte safety limit"
        )));
    }
    Ok(())
}

fn validate_tab_consolidation_journal_encoding(
    journal: &TabConsolidationJournal,
    max_bytes: usize,
) -> Result<()> {
    validate_tab_consolidation_journal(journal)?;
    let mut bytes =
        serde_json::to_vec_pretty(journal).map_err(|error| CliError::Corrupt(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > max_bytes {
        return Err(CliError::Corrupt(format!(
            "tab-consolidation journal exceeds the {max_bytes} byte safety limit"
        )));
    }
    Ok(())
}

pub(crate) fn preflight_event_append(note: &NoteStore, events: &[Event]) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let lines = encode_event_batch(events)?;
    preflight_encoded_event_append(note, &lines, MAX_LEDGER_BYTES)
}

fn preflight_encoded_event_append(note: &NoteStore, lines: &str, max_bytes: usize) -> Result<()> {
    validate_sidecar_layout_for_write(note)?;
    let path = ledger_path(note);
    validate_regular_file_or_missing(&path, "ledger")?;
    let existing = read_ledger_text(&path)?.unwrap_or_default();
    let separator = !existing.is_empty() && !existing.ends_with('\n');
    if existing
        .len()
        .checked_add(lines.len() + usize::from(separator))
        .is_none_or(|total| total > max_bytes)
    {
        return Err(CliError::Corrupt(format!(
            "ledger would exceed the {max_bytes} byte safety limit: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_sidecar_layout_for_write(note: &NoteStore) -> Result<()> {
    note.root.revalidate()?;
    validate_managed_directory(&note.root.vault, &note.root.layout.root)?;
    validate_directory_or_missing(
        &note.root.vault.join(&note.root.layout.notes),
        "notes directory",
    )?;
    validate_directory_or_missing(&sidecar_dir(note), "note store")?;
    validate_directory_or_missing(&objects_dir(note), "objects directory")
}

fn validate_directory_or_missing(path: &Path, kind: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(CliError::Corrupt(format!(
            "{kind} path is not a real directory: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_ctx(path.display().to_string())(error)),
    }
}

/// Verified logical status of an append batch after an adapter/filesystem
/// failure. Event ids are immutable identities: exact replays are present,
/// while an eid reused for different data is corruption.
pub(crate) struct EventBatchStatus {
    pub(crate) present: usize,
    pub(crate) missing: Vec<Event>,
}

pub(crate) fn classify_event_batch(
    note: &NoteStore,
    intended: &[Event],
) -> Result<EventBatchStatus> {
    let existing = read_ledger(note)?;
    classify_event_batch_in(&existing, intended)
}

pub(crate) fn classify_event_batch_in(
    existing: &[Event],
    intended: &[Event],
) -> Result<EventBatchStatus> {
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
pub(crate) fn initial_manifest_bytes(note: &NoteStore) -> Result<Vec<u8>> {
    let relative = note
        .note
        .strip_prefix(&note.root.vault)
        .map_err(|_| CliError::BadArgs("note is outside its root".to_string()))?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    Ok(manifest_bytes(Some(&note.note_id), &relative, &[], 0))
}

pub(crate) fn ensure_note_record(note: &NoteStore) -> Result<()> {
    ensure_sidecar(note)
}

fn ensure_sidecar(note: &NoteStore) -> Result<()> {
    static RECORD_INITIALIZATION: Mutex<()> = Mutex::new(());
    let _initialization = RECORD_INITIALIZATION
        .lock()
        .map_err(|_| CliError::Corrupt("Mica record initialization lock failed".to_string()))?;
    preflight_note_record(note)?;
    note.root.ensure()?;
    ensure_safe_dir(&sidecar_dir(note))?;
    let path = note.root.vault.join(&note.paths.manifest);
    if !validate_regular_file_or_missing(&path, "note manifest")? {
        publish_immutable(&path, &initial_manifest_bytes(note)?)?;
    }
    let bytes = read_bounded_file(&path, MAX_LEDGER_BYTES, "note manifest")?.ok_or_else(|| {
        CliError::Corrupt("note manifest disappeared during initialization".to_string())
    })?;
    let manifest: StoredManifest = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::Corrupt(format!("invalid note manifest: {error}")))?;
    if manifest.note_id != note.note_id {
        return Err(CliError::Corrupt(
            "note manifest identity mismatch".to_string(),
        ));
    }
    Ok(())
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
    // the final file does not stop an intermediate managed-directory symlink.
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
            Ok(event) => {
                validate_event_at(&event, now)?;
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
            Err(_) => {
                let Ok(serde_json::Value::Object(object)) =
                    serde_json::from_str::<serde_json::Value>(line)
                else {
                    bad += 1;
                    continue;
                };
                let Some(kind) = object.get("type").and_then(serde_json::Value::as_str) else {
                    bad += 1;
                    continue;
                };
                validate_known_event_record(kind, &object, now)?;
                bad += 1;
            }
        }
    }
    Ok((events, bad))
}

fn is_known_event_type(kind: &str) -> bool {
    matches!(
        kind,
        "add-version"
            | "replace-version"
            | "set-head"
            | "label"
            | "checkpoint"
            | "move-head"
            | "version-label"
            | "version-visibility"
    )
}

fn validate_known_event_record(
    kind: &str,
    object: &serde_json::Map<String, serde_json::Value>,
    now: u64,
) -> Result<()> {
    if !is_known_event_type(kind) {
        return Err(CliError::Corrupt(format!(
            "ledger contains unknown event type {kind:?} — upgrade Mica or repair the ledger before retrying"
        )));
    }
    let eid = object.get("eid").and_then(serde_json::Value::as_str);
    if eid.is_none_or(str::is_empty) {
        return Err(invalid_typed_event(kind, "eid must be a non-empty string"));
    }
    let ts = object.get("ts").and_then(serde_json::Value::as_u64);
    if ts.is_none_or(|timestamp| {
        timestamp > MAX_EVENT_TIMESTAMP_MS
            || timestamp > now.saturating_add(MAX_FUTURE_EVENT_SKEW_MS)
    }) {
        return Err(invalid_typed_event(
            kind,
            "ts must be an accepted non-negative integer timestamp",
        ));
    }
    let block = object.get("block").and_then(serde_json::Value::as_str);
    if block.is_none_or(str::is_empty) {
        return Err(invalid_typed_event(
            kind,
            "block must be a non-empty string",
        ));
    }

    let valid_hash = |field: &str| {
        object
            .get(field)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|hash| validate_hash(hash).is_ok())
    };
    let valid_optional_hash = |field: &str| {
        object.get(field).is_none_or(|value| {
            value.is_null()
                || value
                    .as_str()
                    .is_some_and(|hash| validate_hash(hash).is_ok())
        })
    };
    let valid_optional_id = |field: &str| {
        object.get(field).is_none_or(|value| {
            value.is_null() || value.as_str().is_some_and(|identity| !identity.is_empty())
        })
    };
    let valid_optional_string = |field: &str| {
        object
            .get(field)
            .is_none_or(|value| value.is_null() || value.as_str().is_some())
    };
    let valid_target = || {
        object
            .get("target")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|target| !target.is_empty())
    };

    let invalid = match kind {
        "add-version" if !valid_hash("hash") => Some("hash must be a valid object hash"),
        "add-version" if !valid_optional_hash("parent") => {
            Some("parent must be a valid object hash when present")
        }
        "replace-version" | "set-head" | "label" if !valid_hash("hash") => {
            Some("hash must be a valid object hash")
        }
        "replace-version" if !valid_target() => Some("target must be a non-empty string"),
        "checkpoint" if !valid_hash("hash") => Some("hash must be a valid object hash"),
        "checkpoint" if !valid_optional_id("parent") => {
            Some("parent must be a non-empty string when present")
        }
        "checkpoint" if !valid_optional_id("source") => {
            Some("source must be a non-empty string when present")
        }
        "checkpoint" if !valid_optional_string("cause") => {
            Some("cause must be a string when present")
        }
        "move-head" if !valid_optional_id("target") => {
            Some("target must be a non-empty string when present")
        }
        "version-label" if !valid_target() => Some("target must be a non-empty string"),
        "version-visibility" if !valid_target() => Some("target must be a non-empty string"),
        "version-visibility"
            if object
                .get("visible")
                .and_then(serde_json::Value::as_bool)
                .is_none() =>
        {
            Some("visible must be a boolean")
        }
        "add-version" | "replace-version" | "set-head" | "label" | "checkpoint" | "move-head"
        | "version-label" | "version-visibility" => None,
        _ => Some("type has no semantic validator"),
    };
    if let Some(detail) = invalid {
        return Err(invalid_typed_event(kind, detail));
    }
    Ok(())
}

fn invalid_typed_event(kind: &str, detail: &str) -> CliError {
    CliError::Corrupt(format!(
        "invalid {kind} event: {detail} — repair the ledger before retrying"
    ))
}

fn event_eid(event: &Event) -> &str {
    match event {
        Event::AddVersion { eid, .. }
        | Event::ReplaceVersion { eid, .. }
        | Event::SetHead { eid, .. }
        | Event::Label { eid, .. }
        | Event::Checkpoint { eid, .. }
        | Event::MoveHead { eid, .. }
        | Event::VersionLabel { eid, .. }
        | Event::VersionVisibility { eid, .. } => eid,
    }
}

fn validate_event(event: &Event) -> Result<()> {
    validate_event_at(event, current_time_ms())
}

fn validate_event_at(event: &Event, now: u64) -> Result<()> {
    let eid = event_eid(event);
    let block = match event {
        Event::AddVersion { block, .. }
        | Event::ReplaceVersion { block, .. }
        | Event::SetHead { block, .. }
        | Event::Label { block, .. }
        | Event::Checkpoint { block, .. }
        | Event::MoveHead { block, .. }
        | Event::VersionLabel { block, .. }
        | Event::VersionVisibility { block, .. } => block,
    };
    if eid.is_empty() || block.is_empty() {
        return Err(CliError::Corrupt(
            "ledger event eid and block must be non-empty strings".to_string(),
        ));
    }
    if let Event::ReplaceVersion {
        eid, block, target, ..
    } = event
    {
        if eid.is_empty() || block.is_empty() || target.is_empty() {
            return Err(CliError::Corrupt(
                "invalid replace-version event: eid, block, and target must be non-empty strings"
                    .to_string(),
            ));
        }
    }
    match event {
        Event::Checkpoint { parent, source, .. } => {
            if parent.as_deref().is_some_and(str::is_empty)
                || source.as_deref().is_some_and(str::is_empty)
            {
                return Err(CliError::Corrupt(
                    "checkpoint parent and source identities must be non-empty when present"
                        .to_string(),
                ));
            }
        }
        Event::MoveHead {
            target: Some(target),
            ..
        }
        | Event::VersionLabel { target, .. }
        | Event::VersionVisibility { target, .. }
            if target.is_empty() =>
        {
            return Err(CliError::Corrupt(
                "checkpoint target identity must be non-empty".to_string(),
            ));
        }
        _ => {}
    }
    let (ts, hash, parent) = match event {
        Event::AddVersion {
            ts, hash, parent, ..
        } => (*ts, Some(hash.as_str()), parent.as_deref()),
        Event::ReplaceVersion { ts, hash, .. }
        | Event::SetHead { ts, hash, .. }
        | Event::Label { ts, hash, .. }
        | Event::Checkpoint { ts, hash, .. } => (*ts, Some(hash.as_str()), None),
        Event::MoveHead { ts, .. }
        | Event::VersionLabel { ts, .. }
        | Event::VersionVisibility { ts, .. } => (*ts, None, None),
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
    if let Some(hash) = hash {
        validate_hash(hash)?;
    }
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
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let content = "x";
/// let hash = mica_core::hash_content_impl(content);
/// mica_cli::sidecar::write_object(&note, &hash, content).unwrap();
/// ```
pub fn write_object(note: &NoteStore, hash: &str, content: &str) -> Result<()> {
    write_object_with_limit(note, hash, content, MAX_OBJECT_BYTES)
}

fn write_object_with_limit(
    note: &NoteStore,
    hash: &str,
    content: &str,
    max_bytes: usize,
) -> Result<()> {
    static OBJECT_WRITES: Mutex<()> = Mutex::new(());
    let _write = OBJECT_WRITES
        .lock()
        .map_err(|_| CliError::Corrupt("Mica object write lock failed".to_string()))?;
    mica_core::object_paths_impl(hash).map_err(store_error)?;
    verify_hash(hash, content)?;
    if content.len() > max_bytes {
        return Err(object_too_large(hash, max_bytes));
    }
    validate_sidecar_layout_for_write(note)?;
    if let Some(stored) = read_pooled_object(&note.root, hash, max_bytes)? {
        if stored != content {
            return Err(CliError::Corrupt(format!(
                "existing object {hash} differs from the planned content"
            )));
        }
        return Ok(());
    }
    ensure_sidecar(note)?;
    let path = if content.len() <= COMPRESS_MIN_BYTES {
        object_path(note, hash)?
    } else {
        object_path_gz(note, hash)?
    };
    if content.len() <= COMPRESS_MIN_BYTES {
        publish_immutable(&path, content.as_bytes())?;
    } else {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(content.as_bytes())
            .map_err(io_ctx(path.display().to_string()))?;
        let compressed = encoder
            .finish()
            .map_err(io_ctx(path.display().to_string()))?;
        publish_immutable(&path, &compressed)?;
    }
    verify_written_object(note, hash, content)
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
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// let hash = mica_core::hash_content_impl("x");
/// let c = mica_cli::sidecar::read_object(&note, &hash).unwrap();
/// ```
pub fn read_object(note: &NoteStore, hash: &str) -> Result<Option<String>> {
    read_object_with_limit(note, hash, MAX_OBJECT_BYTES)
}

/// Canonicalize a validated note-scoped history reference without rewriting it.
pub(crate) fn resolve_note_hash(note: &NoteStore, hash: &str) -> Result<String> {
    let aliases = read_aliases(note)?;
    mica_core::resolve_object_hash_impl(hash, &aliases).map_err(store_error)
}

fn read_object_with_limit(
    note: &NoteStore,
    hash: &str,
    max_bytes: usize,
) -> Result<Option<String>> {
    let full = resolve_note_hash(note, hash)?;
    if !referenced_hashes(note)?.contains(&full) {
        return Err(CliError::Corrupt(format!(
            "object {hash} is not referenced by this note's history"
        )));
    }
    read_pooled_object(&note.root, &full, max_bytes)
}

fn read_aliases(note: &NoteStore) -> Result<Arc<BTreeMap<String, String>>> {
    validate_sidecar_layout_for_write(note)?;
    if let Some(aliases) = &note
        .cache
        .lock()
        .map_err(|_| CliError::Corrupt("Mica note cache lock failed".to_string()))?
        .aliases
    {
        return Ok(Arc::clone(aliases));
    }
    let path = note.root.vault.join(&note.paths.aliases);
    let mut aliases = BTreeMap::new();
    if let Some(bytes) = read_bounded_file(&path, MAX_ALIAS_BYTES, "object aliases")? {
        let pairs: OrderedStringPairs = serde_json::from_slice(&bytes)
            .map_err(|error| CliError::Corrupt(format!("invalid object aliases: {error}")))?;
        if pairs.0.len() > MAX_ALIAS_ENTRIES {
            return Err(CliError::Corrupt(format!(
                "object aliases exceed {MAX_ALIAS_ENTRIES} entries"
            )));
        }
        for (short, full) in pairs.0 {
            if short.len() != 19 {
                return Err(CliError::Corrupt(
                    "object aliases may contain only legacy short-hash keys".to_string(),
                ));
            }
            let pair = BTreeMap::from([(short.clone(), full.clone())]);
            if mica_core::resolve_object_hash_impl(&short, &pair).map_err(store_error)? != full {
                return Err(CliError::Corrupt(
                    "object alias does not match its full address".to_string(),
                ));
            }
            aliases.insert(short, full);
        }
    }
    let aliases = Arc::new(aliases);
    note.cache
        .lock()
        .map_err(|_| CliError::Corrupt("Mica note cache lock failed".to_string()))?
        .aliases = Some(Arc::clone(&aliases));
    Ok(aliases)
}

fn event_hashes(events: &[Event], hashes: &mut BTreeSet<String>) {
    for event in events {
        match event {
            Event::AddVersion { hash, parent, .. } => {
                hashes.insert(hash.clone());
                if let Some(parent) = parent {
                    hashes.insert(parent.clone());
                }
            }
            Event::ReplaceVersion { hash, .. }
            | Event::SetHead { hash, .. }
            | Event::Label { hash, .. }
            | Event::Checkpoint { hash, .. } => {
                hashes.insert(hash.clone());
            }
            Event::MoveHead { .. }
            | Event::VersionLabel { .. }
            | Event::VersionVisibility { .. } => {}
        }
    }
}

fn referenced_hashes(note: &NoteStore) -> Result<Arc<BTreeSet<String>>> {
    if let Some(referenced) = &note
        .cache
        .lock()
        .map_err(|_| CliError::Corrupt("Mica note cache lock failed".to_string()))?
        .referenced
    {
        return Ok(Arc::clone(referenced));
    }
    let mut raw = BTreeSet::new();
    event_hashes(&read_ledger(note)?, &mut raw);
    if let Some(journal) = read_migration_journal(note)? {
        raw.extend([journal.original, journal.migrated]);
        event_hashes(&journal.events, &mut raw);
    }
    if let Some(journal) = read_section_normalization_journal(note)? {
        raw.extend([journal.original, journal.normalized]);
        event_hashes(&journal.events, &mut raw);
    }
    if let Some(journal) = read_tab_consolidation_journal(note)? {
        raw.extend([journal.original, journal.consolidated]);
        event_hashes(&journal.events, &mut raw);
        for version in journal.versions {
            raw.extend([version.source_hash, version.target_hash]);
        }
    }
    let aliases = read_aliases(note)?;
    let referenced = raw
        .iter()
        .map(|hash| mica_core::resolve_object_hash_impl(hash, &aliases).map_err(store_error))
        .collect::<Result<BTreeSet<_>>>()?;
    let referenced = Arc::new(referenced);
    note.cache
        .lock()
        .map_err(|_| CliError::Corrupt("Mica note cache lock failed".to_string()))?
        .referenced = Some(Arc::clone(&referenced));
    Ok(referenced)
}

/// Verify objects staged by this operation before their journal or ledger publication.
pub(crate) fn verify_written_object(note: &NoteStore, hash: &str, content: &str) -> Result<()> {
    match read_pooled_object(&note.root, hash, MAX_OBJECT_BYTES)? {
        Some(stored) if stored == content => Ok(()),
        Some(_) => Err(CliError::Corrupt(format!(
            "written object {hash} differs from its preimage"
        ))),
        None => Err(CliError::Corrupt(format!(
            "written object {hash} is missing"
        ))),
    }
}

fn read_pooled_object(root: &StoreRoot, hash: &str, max_bytes: usize) -> Result<Option<String>> {
    root.revalidate()?;
    let paths = mica_core::object_paths_at_impl(hash, Some(&root.layout.root)).map_err(store_error)?;
    validate_managed_directory(&root.vault, &root.layout.root)?;
    validate_directory_or_missing(&root.vault.join(&root.layout.objects), "objects directory")?;
    let plain = root.vault.join(paths.plain);
    let gz = root.vault.join(paths.gzip);
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
    if fs::metadata(&gz)
        .map_err(io_ctx(gz.display().to_string()))?
        .len()
        > (MAX_OBJECT_BYTES + 1024 * 1024) as u64
    {
        return Err(CliError::Corrupt(format!(
            "compressed object {hash} exceeds its safety limit"
        )));
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
/// # let note: mica_cli::sidecar::NoteStore = todo!();
/// mica_cli::sidecar::write_manifest(&note, Some(&note.note_id), "Note.md", &[], 0).unwrap();
/// ```
pub fn write_manifest(
    note: &NoteStore,
    note_id: Option<&str>,
    path: &str,
    blocks: &[(String, String)],
    updated: u64,
) -> Result<()> {
    if note_id != Some(note.note_id.as_str()) {
        return Err(CliError::Corrupt(
            "manifest identity does not match its note store".to_string(),
        ));
    }
    validate_note_hint(&note.root, path)?;
    contained_note_path(&note.root, Path::new(path))?;
    let out = manifest_bytes(note_id, path, blocks, updated);
    if out.len() > MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(
            "note manifest exceeds its safety limit".to_string(),
        ));
    }
    ensure_sidecar(note)?;
    let p = note.root.vault.join(&note.paths.manifest);
    if let Some(previous) = read_bounded_file(&p, MAX_LEDGER_BYTES, "note manifest")? {
        let record: StoredManifest = serde_json::from_slice(&previous)
            .map_err(|error| CliError::Corrupt(format!("invalid note manifest: {error}")))?;
        if record.note_id != note.note_id {
            return Err(CliError::Corrupt(
                "note manifest identity mismatch".to_string(),
            ));
        }
        if record.path == path && record.blocks.as_slice() == blocks {
            return Ok(());
        }
        ensure_sidecar(note)?;
        return fsutil::atomic_write_if_unchanged(&p, &previous, &out);
    }
    ensure_sidecar(note)?;
    publish_immutable(&p, &out)?;
    let actual = read_bounded_file(&p, MAX_LEDGER_BYTES, "note manifest")?;
    if actual.as_deref() != Some(out.as_slice()) {
        return Err(CliError::Corrupt(
            "note manifest appeared concurrently; retry the operation".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn manifest_bytes(
    note_id: Option<&str>,
    path: &str,
    blocks: &[(String, String)],
    updated: u64,
) -> Vec<u8> {
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
    out.into_bytes()
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

    fn fixture_store(path: PathBuf) -> NoteStore {
        let vault = path.parent().expect("fixture parent").to_path_buf();
        NoteStore {
            root: StoreRoot {
                vault,
                layout: mica_core::storage_layout_impl(),
                marker: Arc::new(Mutex::new(None)),
                location: Arc::new(Mutex::new(None)),
            },
            note: path,
            note_id: "nid".to_string(),
            paths: mica_core::note_paths_impl("nid").expect("fixture identity"),
            cache: Arc::new(Mutex::new(NoteReadCache::default())),
        }
    }

    impl AsRef<Path> for NoteStore {
        fn as_ref(&self) -> &Path {
            &self.note
        }
    }

    #[test]
    fn paths_match_plugin_layout() {
        let note = fixture_store(PathBuf::from("/v/Note.md"));
        let key = mica_core::note_paths_impl("nid").expect("identity").key;
        assert_eq!(
            sidecar_dir(&note),
            Path::new("/v/mica-data/notes").join(key)
        );
        assert_eq!(ledger_path(&note), sidecar_dir(&note).join("ledger.jsonl"));
        let hash = mica_core::hash_content_impl("content");
        assert_eq!(
            object_path(&note, &hash).expect("object path").parent(),
            Some(objects_dir(&note).as_path())
        );
        assert!(object_path(&note, "../escape").is_err());
    }

    #[test]
    fn section_normalization_journal_roundtrips() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "note").expect("seed note");
        let original = mica_core::hash_content_impl("before");
        let normalized = mica_core::hash_content_impl("after");
        let journal = SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original,
            normalized,
            history: true,
            events: vec![Event::ReplaceVersion {
                eid: "replacement-event".to_string(),
                ts: 0,
                block: "block".to_string(),
                target: "add-event".to_string(),
                hash: mica_core::hash_content_impl("replacement"),
            }],
        };

        write_section_normalization_journal(&note, &journal).expect("write journal");

        assert_eq!(
            read_section_normalization_journal(&note).expect("read journal"),
            Some(journal)
        );
        assert!(section_normalization_journal_path(&note).is_file());
    }

    #[test]
    fn tab_consolidation_journal_roundtrips() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "before").expect("seed note");
        let original = mica_core::hash_content_impl("before");
        let consolidated = mica_core::hash_content_impl("after");
        let target_hash = mica_core::hash_content_impl("target version");
        let journal = TabConsolidationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original,
            consolidated,
            history: true,
            target_block: "target-block".to_string(),
            tabs: vec![TabConsolidationTab {
                source_block: "source-block".to_string(),
                title: "First".to_string(),
            }],
            versions: vec![TabConsolidationVersion {
                source_event: "source-event".to_string(),
                target_event: "target-event".to_string(),
                source_block: "source-block".to_string(),
                source_hash: mica_core::hash_content_impl("source version"),
                target_hash: target_hash.clone(),
            }],
            events: vec![
                Event::AddVersion {
                    eid: "target-event".to_string(),
                    ts: 0,
                    block: "target-block".to_string(),
                    hash: target_hash.clone(),
                    label: Some("V1".to_string()),
                    origin: Some("tab-consolidation".to_string()),
                    parent: None,
                },
                Event::SetHead {
                    eid: "head-event".to_string(),
                    ts: 0,
                    block: "target-block".to_string(),
                    hash: target_hash,
                },
            ],
            manifest_original: Some("{\"before\":true}\n".to_string()),
            manifest_consolidated: "{\"after\":true}\n".to_string(),
        };

        write_tab_consolidation_journal(&note, &journal).expect("write journal");

        assert_eq!(
            read_tab_consolidation_journal(&note).expect("read journal"),
            Some(journal)
        );
        assert!(tab_consolidation_journal_path(&note).is_file());
    }

    #[test]
    fn tab_consolidation_journal_rejects_invalid_mappings_and_history_events() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "before").expect("seed note");
        let hash = mica_core::hash_content_impl("body");
        let mut journal = TabConsolidationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original: hash.clone(),
            consolidated: hash.clone(),
            history: true,
            target_block: "target-block".to_string(),
            tabs: vec![TabConsolidationTab {
                source_block: "source-block".to_string(),
                title: "First".to_string(),
            }],
            versions: vec![TabConsolidationVersion {
                source_event: "source-event".to_string(),
                target_event: "missing-target-event".to_string(),
                source_block: "source-block".to_string(),
                source_hash: hash.clone(),
                target_hash: hash.clone(),
            }],
            events: vec![Event::SetHead {
                eid: "head-event".to_string(),
                ts: 0,
                block: "target-block".to_string(),
                hash: hash.clone(),
            }],
            manifest_original: None,
            manifest_consolidated: "{}\n".to_string(),
        };

        assert!(matches!(
            write_tab_consolidation_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));

        journal.versions[0].target_event = "target-event".to_string();
        journal.versions[0].source_hash = "not-a-hash".to_string();
        journal.events[0] = Event::AddVersion {
            eid: "target-event".to_string(),
            ts: 0,
            block: "target-block".to_string(),
            hash: hash.clone(),
            label: None,
            origin: None,
            parent: None,
        };
        assert!(matches!(
            write_tab_consolidation_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));

        journal.versions.clear();
        journal.history = false;
        assert!(matches!(
            write_tab_consolidation_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn tab_consolidation_journal_rejects_empty_identity_and_duplicate_event_ids() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "before").expect("seed note");
        let hash = mica_core::hash_content_impl("body");
        let event = Event::SetHead {
            eid: "duplicate-event".to_string(),
            ts: 0,
            block: "target-block".to_string(),
            hash: hash.clone(),
        };
        let mut journal = TabConsolidationJournal {
            format: 1,
            status: "pending".to_string(),
            note: String::new(),
            original: hash.clone(),
            consolidated: hash,
            history: false,
            target_block: "target-block".to_string(),
            tabs: vec![TabConsolidationTab {
                source_block: "source-block".to_string(),
                title: "First".to_string(),
            }],
            versions: Vec::new(),
            events: vec![event.clone()],
            manifest_original: None,
            manifest_consolidated: "{}\n".to_string(),
        };

        assert!(matches!(
            write_tab_consolidation_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));
        journal.note = "Note.md".to_string();
        journal.events.push(event);
        assert!(matches!(
            write_tab_consolidation_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn tab_consolidation_preflight_allows_head_without_history_and_enforces_bounds() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "before").expect("seed note");
        let hash = mica_core::hash_content_impl("body");
        let journal = TabConsolidationJournal {
            format: 1,
            status: "complete".to_string(),
            note: "Note.md".to_string(),
            original: hash.clone(),
            consolidated: hash.clone(),
            history: false,
            target_block: "target-block".to_string(),
            tabs: vec![TabConsolidationTab {
                source_block: "source-block".to_string(),
                title: "First".to_string(),
            }],
            versions: Vec::new(),
            events: vec![Event::SetHead {
                eid: "head-event".to_string(),
                ts: 0,
                block: "target-block".to_string(),
                hash,
            }],
            manifest_original: None,
            manifest_consolidated: "{}\n".to_string(),
        };

        preflight_tab_consolidation_journal(&note, &journal).expect("preflight journal");
        assert!(matches!(
            validate_tab_consolidation_journal_encoding(&journal, 1),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn journals_reject_wrong_event_kinds_before_writes() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "note").expect("seed note");
        let hash = mica_core::hash_content_impl("body");
        let add = Event::AddVersion {
            eid: "add-event".to_string(),
            ts: 0,
            block: "block".to_string(),
            hash: hash.clone(),
            label: None,
            origin: None,
            parent: None,
        };
        let replacement = Event::ReplaceVersion {
            eid: "replacement-event".to_string(),
            ts: 0,
            block: "block".to_string(),
            target: "add-event".to_string(),
            hash: hash.clone(),
        };
        let normalization = SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original: hash.clone(),
            normalized: hash.clone(),
            history: true,
            events: vec![add],
        };
        let migration = MigrationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original: hash.clone(),
            migrated: hash,
            events: vec![replacement],
        };

        assert!(matches!(
            write_section_normalization_journal(&note, &normalization),
            Err(CliError::Corrupt(_))
        ));
        assert!(matches!(
            write_migration_journal(&note, &migration),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn section_normalization_journal_rejects_empty_event_identity() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "note").expect("seed note");
        let hash = mica_core::hash_content_impl("body");

        for (eid, block, target) in [
            ("", "block", "add-event"),
            ("replacement-event", "", "add-event"),
            ("replacement-event", "block", ""),
        ] {
            let journal = SectionNormalizationJournal {
                format: 1,
                status: "pending".to_string(),
                note: "Note.md".to_string(),
                original: hash.clone(),
                normalized: hash.clone(),
                history: true,
                events: vec![Event::ReplaceVersion {
                    eid: eid.to_string(),
                    ts: 0,
                    block: block.to_string(),
                    target: target.to_string(),
                    hash: hash.clone(),
                }],
            };
            assert!(matches!(
                write_section_normalization_journal(&note, &journal),
                Err(CliError::Corrupt(_))
            ));
        }
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn section_normalization_journal_rejects_invalid_state_and_duplicate_eids() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        std::fs::write(&note, "note").expect("seed note");
        let hash = mica_core::hash_content_impl("body");
        let event = Event::ReplaceVersion {
            eid: "replacement-event".to_string(),
            ts: 0,
            block: "block".to_string(),
            target: "add-event".to_string(),
            hash: hash.clone(),
        };
        let mut journal = SectionNormalizationJournal {
            format: 1,
            status: "unknown".to_string(),
            note: "Note.md".to_string(),
            original: hash.clone(),
            normalized: hash,
            history: true,
            events: vec![event.clone()],
        };

        assert!(matches!(
            write_section_normalization_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));
        journal.status = "pending".to_string();
        journal.events.push(event);
        assert!(matches!(
            write_section_normalization_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[cfg(unix)]
    #[test]
    fn section_normalization_journal_rejects_symlink_files() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("Note.md"));
        let outside = tmp.path().join("outside.json");
        std::fs::write(&note, "note").expect("seed note");
        std::fs::write(&outside, "outside").expect("seed outside file");
        std::fs::create_dir_all(sidecar_dir(&note)).expect("sidecar directory");
        symlink(&outside, section_normalization_journal_path(&note)).expect("journal symlink");
        let hash = mica_core::hash_content_impl("body");
        let journal = SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original: hash.clone(),
            normalized: hash.clone(),
            history: false,
            events: Vec::new(),
        };

        assert!(matches!(
            read_section_normalization_journal(&note),
            Err(CliError::Corrupt(_))
        ));
        assert!(matches!(
            write_section_normalization_journal(&note, &journal),
            Err(CliError::Corrupt(_))
        ));
        assert_eq!(
            std::fs::read_to_string(&outside).expect("outside unchanged"),
            "outside"
        );
    }

    #[test]
    fn manifest_matches_plugin_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let note = fixture_store(tmp.path().join("N.md"));
        write_manifest(
            &note,
            Some("nid"),
            "N.md",
            &[("b1".into(), "First".into()), ("b2".into(), String::new())],
            42,
        )
        .unwrap();
        let got = fs::read_to_string(sidecar_dir(&note).join("manifest.json")).unwrap();
        // Exactly what JSON.stringify({...}, null, "\t") + "\n" produces.
        let want = "{\n\t\"noteId\": \"nid\",\n\t\"path\": \"N.md\",\n\t\"blocks\": {\n\t\t\"b1\": \"First\",\n\t\t\"b2\": \"\"\n\t},\n\t\"updated\": 42\n}\n";
        assert_eq!(got, want);
    }

    #[test]
    fn ledger_roundtrip_and_bad_line_tolerance() {
        let tmp = tempfile::tempdir().unwrap();
        let note = fixture_store(tmp.path().join("N.md"));
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
        let report = read_ledger_report(&note).unwrap();
        assert_eq!(
            report.events,
            vec![ev],
            "exact eid replays are logically deduplicated"
        );
        assert_eq!(report.bad_lines, 1);
    }

    #[test]
    fn unknown_typed_ledger_events_fail_closed_while_untyped_json_is_skipped() {
        assert!(matches!(
            parse_ledger(r#"{"type":"future-event","eid":"e1"}"#),
            Err(CliError::Corrupt(message)) if message.contains("future-event")
        ));

        let (events, bad) = parse_ledger("{\"unexpected\":true}\n{torn").expect("recover lines");
        assert!(events.is_empty());
        assert_eq!(bad, 2);
    }

    #[test]
    fn known_typed_invalid_replacements_fail_closed_like_typescript() {
        let hash = mica_core::hash_content_impl("replacement");
        let empty_target = serde_json::json!({
            "type": "replace-version",
            "eid": "replace",
            "ts": 1,
            "block": "demo",
            "target": "",
            "hash": hash,
        });
        let typed_target = serde_json::json!({
            "type": "replace-version",
            "eid": "replace",
            "ts": 1,
            "block": "demo",
            "target": 7,
            "hash": mica_core::hash_content_impl("replacement"),
        });

        for line in [empty_target.to_string(), typed_target.to_string()] {
            assert!(matches!(
                parse_ledger(&line),
                Err(CliError::Corrupt(message)) if message.contains("invalid replace-version")
            ));
        }
    }

    #[test]
    fn known_typed_invalid_events_fail_closed_like_typescript() {
        let hash = mica_core::hash_content_impl("typed event");
        let cases = [
            (
                "add-version invalid hash",
                serde_json::json!({
                    "type": "add-version",
                    "eid": "add",
                    "ts": 1,
                    "block": "demo",
                    "hash": "not-a-hash",
                }),
            ),
            (
                "set-head empty eid",
                serde_json::json!({
                    "type": "set-head",
                    "eid": "",
                    "ts": 1,
                    "block": "demo",
                    "hash": hash.clone(),
                }),
            ),
            (
                "label empty block",
                serde_json::json!({
                    "type": "label",
                    "eid": "label",
                    "ts": 1,
                    "block": "",
                    "hash": hash.clone(),
                }),
            ),
            (
                "checkpoint empty parent",
                serde_json::json!({
                    "type": "checkpoint",
                    "eid": "checkpoint",
                    "ts": 1,
                    "block": "demo",
                    "hash": hash.clone(),
                    "parent": "",
                }),
            ),
            (
                "move-head empty target",
                serde_json::json!({
                    "type": "move-head",
                    "eid": "move",
                    "ts": 1,
                    "block": "demo",
                    "target": "",
                }),
            ),
            (
                "version-label empty target",
                serde_json::json!({
                    "type": "version-label",
                    "eid": "version-label",
                    "ts": 1,
                    "block": "demo",
                    "target": "",
                }),
            ),
            (
                "version-visibility empty target",
                serde_json::json!({
                    "type": "version-visibility",
                    "eid": "visibility",
                    "ts": 1,
                    "block": "demo",
                    "target": "",
                    "visible": true,
                }),
            ),
            (
                "add-version typed hash",
                serde_json::json!({
                    "type": "add-version",
                    "eid": "add",
                    "ts": 1,
                    "block": "demo",
                    "hash": 7,
                }),
            ),
            (
                "set-head typed hash",
                serde_json::json!({
                    "type": "set-head",
                    "eid": "head",
                    "ts": 1,
                    "block": "demo",
                    "hash": 7,
                }),
            ),
            (
                "label typed hash",
                serde_json::json!({
                    "type": "label",
                    "eid": "label",
                    "ts": 1,
                    "block": "demo",
                    "hash": 7,
                }),
            ),
            (
                "checkpoint typed parent",
                serde_json::json!({
                    "type": "checkpoint",
                    "eid": "checkpoint",
                    "ts": 1,
                    "block": "demo",
                    "hash": hash,
                    "parent": 7,
                }),
            ),
            (
                "move-head typed target",
                serde_json::json!({
                    "type": "move-head",
                    "eid": "move",
                    "ts": 1,
                    "block": "demo",
                    "target": 7,
                }),
            ),
            (
                "version-label typed target",
                serde_json::json!({
                    "type": "version-label",
                    "eid": "version-label",
                    "ts": 1,
                    "block": "demo",
                    "target": 7,
                }),
            ),
            (
                "version-visibility typed visible",
                serde_json::json!({
                    "type": "version-visibility",
                    "eid": "visibility",
                    "ts": 1,
                    "block": "demo",
                    "target": "checkpoint",
                    "visible": "yes",
                }),
            ),
        ];

        for (case, value) in cases {
            let line = value.to_string();
            assert!(
                matches!(parse_ledger(&line), Err(CliError::Corrupt(_))),
                "{case} was accepted as recoverable ledger damage"
            );
        }
    }

    #[test]
    fn conflicting_ledger_eids_and_duplicate_append_batches_are_rejected() {
        let tmp = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(tmp.path().join("N.md"));
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
        let note = fixture_store(tmp.path().join("N.md"));
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
        let note = fixture_store(tmp.path().join("N.md"));
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
        assert!(matches!(
            ledger_bad_lines(&ledger_path(&note)),
            Err(CliError::Corrupt(message)) if message.contains("ledger timestamp")
        ));

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
        let note = Arc::new(fixture_store(tmp.path().join("N.md")));
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
        let note = fixture_store(tmp.path().join("N.md"));
        let content = "legacy body";
        let full = mica_core::hash_content_impl(content);
        let legacy = &full[..19];
        ensure_sidecar(&note).expect("sidecar");
        std::fs::write(object_path(&note, &full).expect("object path"), content)
            .expect("full object");
        std::fs::write(
            note.root.vault.join(&note.paths.aliases),
            serde_json::to_vec(&BTreeMap::from([(legacy, full.as_str())])).expect("aliases"),
        )
        .expect("alias file");
        append_events(
            &note,
            &[Event::SetHead {
                eid: "legacy-ref".to_string(),
                ts: 0,
                block: "block".to_string(),
                hash: legacy.to_string(),
            }],
        )
        .expect("note reference");
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
        let note = fixture_store(tmp.path().join("N.md"));
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
        let note = fixture_store(tmp.path().join("N.md"));
        let hash = mica_core::hash_content_impl("first");
        write_object(&note, &hash, "first").unwrap();
        let error = write_object(&note, &hash, "SECOND WRITE MUST NOT REPLACE").unwrap_err();
        assert!(matches!(error, CliError::Corrupt(_)));
        assert_eq!(
            read_pooled_object(&note.root, &hash, MAX_OBJECT_BYTES)
                .unwrap()
                .as_deref(),
            Some("first")
        );
        let missing_hash = mica_core::hash_content_impl("missing");
        assert_eq!(
            read_pooled_object(&note.root, &missing_hash, MAX_OBJECT_BYTES).unwrap(),
            None
        );
    }

    #[test]
    fn large_objects_compress_small_stay_plaintext_and_both_read_back() {
        let dir = tempfile::tempdir().expect("tmp");
        let note = fixture_store(dir.path().join("n.md"));
        std::fs::write(&note, "x").expect("note");
        let small = "small body";
        let small_hash = mica_core::hash_content_impl(small);
        write_object(&note, &small_hash, small).expect("small write");
        assert!(
            object_path(&note, &small_hash)
                .expect("object path")
                .is_file(),
            "small stays .md"
        );
        let large = "L".repeat(COMPRESS_MIN_BYTES + 100);
        let large_hash = mica_core::hash_content_impl(&large);
        write_object(&note, &large_hash, &large).expect("large write");
        assert!(
            object_path_gz(&note, &large_hash)
                .expect("object path")
                .is_file(),
            "large becomes .gz"
        );
        assert!(!object_path(&note, &large_hash)
            .expect("object path")
            .exists());
        assert_eq!(
            read_pooled_object(&note.root, &small_hash, MAX_OBJECT_BYTES).expect("r1"),
            Some(small.to_string())
        );
        assert_eq!(
            read_pooled_object(&note.root, &large_hash, MAX_OBJECT_BYTES).expect("r2"),
            Some(large)
        );
        let missing_hash = mica_core::hash_content_impl("absent");
        assert_eq!(
            read_pooled_object(&note.root, &missing_hash, MAX_OBJECT_BYTES).expect("r3"),
            None
        );
    }

    #[test]
    fn corrupt_object_and_invalid_hash_are_rejected() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(dir.path().join("n.md"));
        let hash = mica_core::hash_content_impl("expected");
        std::fs::create_dir_all(objects_dir(&note)).expect("objects directory");
        std::fs::write(object_path(&note, &hash).expect("object path"), "CORRUPT")
            .expect("corrupt object");

        assert!(matches!(
            read_pooled_object(&note.root, &hash, MAX_OBJECT_BYTES),
            Err(CliError::Corrupt(_))
        ));
        assert!(matches!(
            read_pooled_object(&note.root, "../escape", MAX_OBJECT_BYTES),
            Err(CliError::Corrupt(_))
        ));

        std::fs::remove_file(object_path(&note, &hash).expect("object path"))
            .expect("remove plaintext");
        std::fs::write(
            object_path_gz(&note, &hash).expect("object path"),
            b"not gzip",
        )
        .expect("malformed gzip");
        assert!(matches!(
            read_pooled_object(&note.root, &hash, MAX_OBJECT_BYTES),
            Err(CliError::Corrupt(_))
        ));
    }

    #[test]
    fn decompression_is_bounded() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(dir.path().join("n.md"));
        const TEST_LIMIT: usize = 1024;
        let oversized = "x".repeat(TEST_LIMIT + 1);
        let hash = mica_core::hash_content_impl(&oversized);
        std::fs::create_dir_all(objects_dir(&note)).expect("objects directory");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(oversized.as_bytes())
            .expect("compress oversized object");
        let bytes = encoder.finish().expect("finish gzip");
        std::fs::write(object_path_gz(&note, &hash).expect("object path"), bytes)
            .expect("write gzip");

        assert!(matches!(
            read_pooled_object(&note.root, &hash, TEST_LIMIT),
            Err(CliError::Corrupt(_))
        ));
    }

    #[test]
    fn oversized_object_write_is_rejected_before_persistence() {
        const TEST_LIMIT: usize = 1024;
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(dir.path().join("n.md"));
        let oversized = "x".repeat(TEST_LIMIT + 1);
        let hash = mica_core::hash_content_impl(&oversized);

        assert!(matches!(
            write_object_with_limit(&note, &hash, &oversized, TEST_LIMIT),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn object_preflight_rejects_capacity_without_persistence() {
        const TEST_LIMIT: usize = 8;
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(dir.path().join("n.md"));
        let content = "too many bytes";
        let hash = mica_core::hash_content_impl(content);

        assert!(matches!(
            preflight_object_write_with_limit(&note, &hash, content, TEST_LIMIT),
            Err(CliError::Corrupt(_))
        ));
        assert!(!sidecar_dir(&note).exists());
    }

    #[test]
    fn normalization_journal_preflight_rejects_capacity() {
        let hash = mica_core::hash_content_impl("body");
        let journal = SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "n.md".to_string(),
            original: hash.clone(),
            normalized: hash,
            history: false,
            events: Vec::new(),
        };

        assert!(matches!(
            validate_section_normalization_journal_encoding(&journal, 8),
            Err(CliError::Corrupt(_))
        ));
    }

    #[test]
    fn event_preflight_rejects_capacity_without_mutating_ledger() {
        const TEST_LIMIT: usize = 16;
        let dir = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(dir.path().join("n.md"));
        let ledger = ledger_path(&note);
        std::fs::create_dir_all(sidecar_dir(&note)).expect("sidecar directory");
        std::fs::write(&ledger, "existing-ledger").expect("seed ledger");
        let before = std::fs::read(&ledger).expect("read preimage");

        assert!(matches!(
            preflight_encoded_event_append(&note, "new-event\n", TEST_LIMIT),
            Err(CliError::Corrupt(_))
        ));
        assert_eq!(std::fs::read(&ledger).expect("read postimage"), before);
    }

    #[cfg(unix)]
    #[test]
    fn object_reads_reject_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("temporary directory");
        let note = fixture_store(dir.path().join("n.md"));
        let content = "outside";
        let hash = mica_core::hash_content_impl(content);
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, content).expect("outside file");
        std::fs::create_dir_all(objects_dir(&note)).expect("objects directory");
        symlink(&outside, object_path(&note, &hash).expect("object path")).expect("object symlink");

        assert!(matches!(
            read_pooled_object(&note.root, &hash, MAX_OBJECT_BYTES),
            Err(CliError::Corrupt(_))
        ));
    }
}

//! Pure identity, naming, and validation policy for the vault-wide store.

use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Serialize};

const STORE_ROOT: &str = "mica-data";
const STORE_FORMAT: u32 = 1;
const STORE_LOCATION_PATH: &str = "mica.json";
const MAX_STORE_FOLDER_BYTES: usize = 4096;

/// Maximum encoded location-document size enforced by both host JSON boundaries.
pub const MAX_STORE_LOCATION_BYTES: usize = 16 * 1024;

/// Paths shared by both hosts, relative to the vault root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLayout {
    /// Current store format.
    pub format: u32,
    /// Visible managed directory.
    pub root: String,
    /// Fixed vault-root routing document, independent of the managed directory.
    pub location: String,
    /// Store identity marker.
    pub marker: String,
    /// Shared full-hash object pool.
    pub objects: String,
    /// Identity-addressed note histories.
    pub notes: String,
    /// Incoming bridge requests.
    pub bridge_inbox: String,
    /// Bridge responses.
    pub bridge_outbox: String,
    /// Recoverable orphaned state.
    pub orphaned: String,
}

/// One note's paths, relative to the vault root, never to its current filename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePaths {
    /// Safe opaque directory key derived from the original note identity.
    pub key: String,
    /// Note history directory.
    pub dir: String,
    /// Append-only event ledger.
    pub ledger: String,
    /// Current note identity and path metadata.
    pub manifest: String,
    /// Note-scoped compatibility aliases for immutable legacy events.
    pub aliases: String,
    /// Legacy-content migration journal.
    pub migration: String,
    /// Logical-section normalization journal.
    pub section_normalization: String,
    /// Tab-consolidation journal.
    pub tab_consolidation: String,
}

/// Alternative representations of one full-hash object, vault-relative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectPaths {
    /// Plain UTF-8 representation.
    pub plain: String,
    /// Gzip representation of the same plaintext.
    pub gzip: String,
}

/// Store marker decoded by the host's standard JSON boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreMarker {
    /// Store format version; unknown versions fail closed.
    pub format: u32,
    /// Stable UUID identifying this store independently of its machine path.
    pub store_id: String,
}

/// Portable routing authority decoded from the vault-root `mica.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreLocation {
    /// Location schema version; only format 1 is supported.
    pub format: u32,
    /// Selected visible directory relative to the vault root.
    pub folder: String,
    /// Store UUID, absent only for an active location that is not initialized.
    #[serde(default)]
    pub store_id: Option<String>,
    /// Original directory while a move is pending; ordinary hosts must refuse it.
    #[serde(default)]
    pub previous_folder: Option<String>,
    /// Recorded ownership of an incomplete first initialization.
    #[serde(default)]
    pub initializing: bool,
}

/// Invalid or ambiguous input at the shared store-policy boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// A managed folder is not a bounded, visible, canonical relative path.
    InvalidStoreFolder,
    /// A location has an unknown format or invalid initialization/move state.
    InvalidStoreLocation,
    /// A note identity is empty, oversized, whitespace-only, or contains controls.
    InvalidNoteId,
    /// A full object address is not `b3:` followed by 64 lowercase hex digits.
    InvalidObjectHash,
    /// A legacy short address has no note-scoped alias.
    MissingObjectAlias,
    /// A short-address alias is malformed or does not share the requested prefix.
    InvalidObjectAlias,
    /// The marker does not use a supported format and valid UUID.
    InvalidStoreMarker,
    /// Frontmatter cannot be interpreted as an unambiguous top-level mapping.
    InvalidFrontmatter,
    /// Multiple top-level identity keys or merged identity sources are ambiguous.
    AmbiguousNoteId,
    /// The identity value is not a supported single-line YAML string scalar.
    InvalidNoteIdAnchor,
    /// The live identity differs from the caller's exact expected identity.
    NoteIdMismatch,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidStoreFolder => "store folder must be a visible vault-relative path of 1–4096 UTF-8 bytes without absolute paths, hidden or empty components, traversal, backslashes, controls, or nonportable filename characters",
            Self::InvalidStoreLocation => "store location requires format 1, a valid optional UUID, distinct nonoverlapping folders for a pending move, and a UUID without a pending move for initialization",
            Self::InvalidNoteId => "note ID must contain 1–4096 UTF-8 bytes, non-whitespace text, and no control characters",
            Self::InvalidObjectHash => "object address must be b3: followed by 64 lowercase hexadecimal digits",
            Self::MissingObjectAlias => "legacy object address requires a matching note-scoped alias",
            Self::InvalidObjectAlias => "legacy object alias must name a full BLAKE3 address with the same prefix",
            Self::InvalidStoreMarker => "store marker requires format 1 and a valid storeId UUID",
            Self::InvalidFrontmatter => "note identity requires an unambiguous top-level YAML block mapping; unsupported or unterminated frontmatter",
            Self::AmbiguousNoteId => "duplicate or merged top-level mica-id properties are ambiguous",
            Self::InvalidNoteIdAnchor => "mica-id must be one plain, single-quoted, or double-quoted single-line YAML string scalar",
            Self::NoteIdMismatch => "note identity changed from the expected value",
        })
    }
}

impl Error for StoreError {}

/// Validate a canonical visible folder without filesystem access or normalization.
pub fn validate_store_folder_impl(folder: &str) -> Result<String, StoreError> {
    validate_store_folder(folder)?;
    Ok(folder.to_string())
}

fn validate_store_folder(folder: &str) -> Result<(), StoreError> {
    if folder.is_empty()
        || folder.len() > MAX_STORE_FOLDER_BYTES
        || folder.chars().any(|ch| {
            ch.is_control() || matches!(ch, '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*')
        })
        || folder.split('/').any(|component| {
            component.is_empty()
                || component.starts_with('.')
                || component.trim().is_empty()
                || component.ends_with([' ', '.'])
        })
        || folder
            .split('/')
            .next()
            .is_some_and(|component| component.eq_ignore_ascii_case(STORE_LOCATION_PATH))
        || folder
            .split_once('/')
            .is_some_and(|(first, _)| first.eq_ignore_ascii_case(STORE_ROOT))
    {
        return Err(StoreError::InvalidStoreFolder);
    }
    Ok(())
}

fn selected_folder(folder: Option<&str>) -> Result<&str, StoreError> {
    let folder = folder.unwrap_or(STORE_ROOT);
    validate_store_folder(folder)?;
    Ok(folder)
}

/// Return the default vault-wide layout without touching storage.
pub fn storage_layout_impl() -> StorageLayout {
    layout_for_folder(STORE_ROOT)
}

/// Return a validated layout; `None` retains the default `mica-data` directory.
pub fn storage_layout_at_impl(folder: Option<&str>) -> Result<StorageLayout, StoreError> {
    Ok(layout_for_folder(selected_folder(folder)?))
}

fn layout_for_folder(folder: &str) -> StorageLayout {
    StorageLayout {
        format: STORE_FORMAT,
        root: folder.into(),
        location: STORE_LOCATION_PATH.into(),
        marker: format!("{folder}/root.json"),
        objects: format!("{folder}/objects"),
        notes: format!("{folder}/notes"),
        bridge_inbox: format!("{folder}/bridge/inbox"),
        bridge_outbox: format!("{folder}/bridge/outbox"),
        orphaned: format!("{folder}/orphaned"),
    }
}

/// Derive default history paths without interpolating the authored note ID.
pub fn note_paths_impl(note_id: &str) -> Result<NotePaths, StoreError> {
    note_paths_at_impl(note_id, None)
}

/// Derive identity-bound paths below a validated optional managed directory.
pub fn note_paths_at_impl(note_id: &str, folder: Option<&str>) -> Result<NotePaths, StoreError> {
    let folder = selected_folder(folder)?;
    validate_note_id(note_id)?;
    let mut hash = blake3::Hasher::new();
    hash.update(b"mica.note-id\0");
    hash.update(note_id.as_bytes());
    let key = format!("n-{}", hash.finalize().to_hex());
    let dir = format!("{folder}/notes/{key}");
    Ok(NotePaths {
        key,
        ledger: format!("{dir}/ledger.jsonl"),
        manifest: format!("{dir}/manifest.json"),
        aliases: format!("{dir}/object-aliases.json"),
        migration: format!("{dir}/migration.json"),
        section_normalization: format!("{dir}/section-normalization.json"),
        tab_consolidation: format!("{dir}/tab-consolidation.json"),
        dir,
    })
}

/// Derive default object paths only from a complete canonical BLAKE3 address.
pub fn object_paths_impl(full_hash: &str) -> Result<ObjectPaths, StoreError> {
    object_paths_at_impl(full_hash, None)
}

/// Derive shared object paths below a validated optional managed directory.
pub fn object_paths_at_impl(
    full_hash: &str,
    folder: Option<&str>,
) -> Result<ObjectPaths, StoreError> {
    let folder = selected_folder(folder)?;
    if !is_hash(full_hash, 64) {
        return Err(StoreError::InvalidObjectHash);
    }
    let digest = &full_hash[3..];
    Ok(ObjectPaths {
        plain: format!("{folder}/objects/b3-{digest}.mica.md"),
        gzip: format!("{folder}/objects/b3-{digest}.mica.gz"),
    })
}

/// Test an already-normalized vault-relative path against the default namespace.
pub fn is_managed_path_impl(vault_relative: &str) -> bool {
    is_path_under(vault_relative, STORE_ROOT)
}

/// Reserve the locator, default namespace, and a validated optional managed directory.
pub fn is_managed_path_at_impl(
    vault_relative: &str,
    folder: Option<&str>,
) -> Result<bool, StoreError> {
    let folder = selected_folder(folder)?;
    Ok(vault_relative == STORE_LOCATION_PATH
        || is_managed_path_impl(vault_relative)
        || is_path_under(vault_relative, folder))
}

fn is_path_under(path: &str, folder: &str) -> bool {
    path.strip_prefix(folder)
        .is_some_and(|tail| tail.is_empty() || tail.starts_with('/'))
}

/// Validate a standard-JSON-decoded marker; decoding rejects unknown fields.
pub fn validate_store_marker_impl(marker: StoreMarker) -> Result<StoreMarker, StoreError> {
    if marker.format != STORE_FORMAT || uuid::Uuid::parse_str(&marker.store_id).is_err() {
        return Err(StoreError::InvalidStoreMarker);
    }
    Ok(marker)
}

/// Validate the shared location schema without resolving or moving any files.
/// Pending initialization or relocation is valid data; hosts resume only the recorded intent.
pub fn validate_store_location_impl(location: StoreLocation) -> Result<StoreLocation, StoreError> {
    if location.format != STORE_FORMAT
        || validate_store_folder(&location.folder).is_err()
        || location
            .store_id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        || (location.initializing
            && (location.store_id.is_none() || location.previous_folder.is_some()))
    {
        return Err(StoreError::InvalidStoreLocation);
    }
    if let Some(previous) = location.previous_folder.as_deref() {
        if location.store_id.is_none() || validate_store_folder(previous).is_err() {
            return Err(StoreError::InvalidStoreLocation);
        }
        // Keep authored casing, but reject moves that alias or overlap on
        // case-insensitive hosts. Hosts additionally check real containment.
        let previous = previous.to_lowercase();
        let folder = location.folder.to_lowercase();
        if is_path_under(&folder, &previous) || is_path_under(&previous, &folder) {
            return Err(StoreError::InvalidStoreLocation);
        }
    }
    Ok(location)
}

/// Resolve a legacy hash only through a matching note-scoped full-hash alias.
pub fn resolve_object_hash_impl(
    hash: &str,
    aliases: &BTreeMap<String, String>,
) -> Result<String, StoreError> {
    if is_hash(hash, 64) {
        return Ok(hash.to_string());
    }
    if !is_hash(hash, 16) {
        return Err(StoreError::InvalidObjectHash);
    }
    let full = aliases.get(hash).ok_or(StoreError::MissingObjectAlias)?;
    if !is_hash(full, 64) || !full.starts_with(hash) {
        return Err(StoreError::InvalidObjectAlias);
    }
    Ok(full.clone())
}

fn is_hash(hash: &str, digits: usize) -> bool {
    hash.strip_prefix("b3:").is_some_and(|digest| {
        digest.len() == digits
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn validate_note_id(id: &str) -> Result<(), StoreError> {
    if id.is_empty() || id.len() > 4096 || id.trim().is_empty() || id.chars().any(char::is_control)
    {
        return Err(StoreError::InvalidNoteId);
    }
    Ok(())
}

struct Anchor {
    id: String,
    start: usize,
    end: usize,
}

struct NoteIdentity {
    anchor: Option<Anchor>,
    closing: Option<usize>,
    bom_len: usize,
    eol: &'static str,
}

/// Read the source-backed top-level `mica-id` without stamping or normalizing.
pub fn note_id_impl(source: &str) -> Result<Option<String>, StoreError> {
    Ok(inspect_identity(source)?.anchor.map(|anchor| anchor.id))
}

/// Set one identity under an exact expected-value guard, preserving other bytes.
/// `None` requires absence; `Some` requires the exact decoded current string.
pub fn set_note_id_impl(
    source: &str,
    expected: Option<&str>,
    id: &str,
) -> Result<String, StoreError> {
    validate_note_id(id)?;
    let identity = inspect_identity(source)?;
    if identity.anchor.as_ref().map(|anchor| anchor.id.as_str()) != expected {
        return Err(StoreError::NoteIdMismatch);
    }
    if expected == Some(id) {
        return Ok(source.to_string());
    }
    let quoted = quote_id(id);
    if let Some(anchor) = identity.anchor {
        return Ok(format!(
            "{}{}{}",
            &source[..anchor.start],
            quoted,
            &source[anchor.end..]
        ));
    }
    if let Some(closing) = identity.closing {
        return Ok(format!(
            "{}mica-id: {}{}{}",
            &source[..closing],
            quoted,
            identity.eol,
            &source[closing..]
        ));
    }
    Ok(format!(
        "{}---{}mica-id: {}{}---{}{}{}",
        &source[..identity.bom_len],
        identity.eol,
        quoted,
        identity.eol,
        identity.eol,
        identity.eol,
        &source[identity.bom_len..]
    ))
}

// Only a single-line, zero-indent root block mapping is writable. Complex keys,
// merges, root flow collections, tags, anchors, and multiline quoted values can
// change where a YAML identity comes from; reject them instead of guessing.
// The scan stops at the frontmatter closer and borrows all unrelated source.
fn inspect_identity(source: &str) -> Result<NoteIdentity, StoreError> {
    let bom_len = if source.starts_with('\u{feff}') { 3 } else { 0 };
    let body = &source[bom_len..];
    let mut lines = body.split_inclusive('\n');
    let first = lines.next().unwrap_or("");
    let eol = if first.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut identity = NoteIdentity {
        anchor: None,
        closing: None,
        bom_len,
        eol,
    };
    if line_text(first).trim_end_matches([' ', '\t']) != "---" {
        return Ok(identity);
    }
    let mut offset = bom_len + first.len();
    let mut has_property = false;
    let mut identity_value = false;
    for raw in lines {
        let line = line_text(raw);
        if line
            .chars()
            .any(|ch| (ch.is_control() && ch != '\t') || matches!(ch, '\u{2028}' | '\u{2029}'))
        {
            return Err(StoreError::InvalidFrontmatter);
        }
        let trimmed = line.trim_start_matches([' ', '\t']);
        if matches!(line.trim_end_matches([' ', '\t']), "---" | "...") {
            identity.closing = Some(offset);
            return Ok(identity);
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            offset += raw.len();
            continue;
        }
        if line.starts_with([' ', '\t']) {
            if !has_property || line[..line.len() - trimmed.len()].contains('\t') {
                return Err(StoreError::InvalidFrontmatter);
            }
            if identity_value {
                return Err(StoreError::InvalidNoteIdAnchor);
            }
            offset += raw.len();
            continue;
        }
        let (key, value_start) = mapping_entry(line)?;
        if key == "<<" {
            return Err(StoreError::AmbiguousNoteId);
        }
        has_property = true;
        identity_value = key == "mica-id";
        let value = &line[value_start..];
        if identity_value {
            if identity.anchor.is_some() {
                return Err(StoreError::AmbiguousNoteId);
            }
            let (id, consumed) = identity_scalar(value)?;
            validate_note_id(&id).map_err(|_| StoreError::InvalidNoteIdAnchor)?;
            identity.anchor = Some(Anchor {
                id,
                start: offset + value_start,
                end: offset + value_start + consumed,
            });
        } else {
            validate_other_value(value)?;
        }
        offset += raw.len();
    }
    Err(StoreError::InvalidFrontmatter)
}

fn line_text(raw: &str) -> &str {
    let line = raw.strip_suffix('\n').unwrap_or(raw);
    line.strip_suffix('\r').unwrap_or(line)
}

fn mapping_entry(line: &str) -> Result<(String, usize), StoreError> {
    let (key, colon) = if line.starts_with(['\'', '"']) {
        let (key, end) = quoted_scalar(line).map_err(|_| StoreError::InvalidFrontmatter)?;
        let tail = &line[end..];
        let colon = end + tail.len() - tail.trim_start_matches([' ', '\t']).len();
        (key, colon)
    } else {
        let colon = line
            .char_indices()
            .find_map(|(index, ch)| (ch == ':' && separated(&line[index + 1..])).then_some(index))
            .ok_or(StoreError::InvalidFrontmatter)?;
        let key = line[..colon].trim_end_matches([' ', '\t']);
        if key.is_empty()
            || key.starts_with([
                '?', ':', '-', '&', '*', '!', '{', '[', '}', ']', '|', '>', '%', '@', '`',
            ])
            || key.contains(['#', '\'', '"'])
        {
            return Err(StoreError::InvalidFrontmatter);
        }
        (key.to_string(), colon)
    };
    if line.as_bytes().get(colon) != Some(&b':') || !separated(&line[colon + 1..]) {
        return Err(StoreError::InvalidFrontmatter);
    }
    let after = colon + 1;
    let start = after + line[after..].len() - line[after..].trim_start_matches([' ', '\t']).len();
    Ok((key, start))
}

fn separated(value: &str) -> bool {
    value.is_empty() || value.starts_with([' ', '\t'])
}

fn valid_tail(tail: &str) -> bool {
    tail.is_empty()
        || (tail.starts_with([' ', '\t']) && {
            let rest = tail.trim_start_matches([' ', '\t']);
            rest.is_empty() || rest.starts_with('#')
        })
}

fn identity_scalar(value: &str) -> Result<(String, usize), StoreError> {
    if value.starts_with(['\'', '"']) {
        let (id, end) = quoted_scalar(value)?;
        if !valid_tail(&value[end..]) {
            return Err(StoreError::InvalidNoteIdAnchor);
        }
        return Ok((id, end));
    }
    let mut end = value.len();
    for (index, ch) in value.char_indices() {
        if ch == '#' && (index == 0 || value[..index].ends_with([' ', '\t'])) {
            end = index;
            break;
        }
    }
    let scalar = value[..end].trim_end_matches([' ', '\t']);
    if scalar.is_empty()
        || scalar.starts_with([
            '[', '{', ']', '}', '|', '>', '&', '*', '!', '%', '@', '`', '#',
        ])
        || (scalar.starts_with(['-', '?', ':']) && separated(&scalar[1..]))
        || scalar
            .char_indices()
            .any(|(index, ch)| ch == ':' && separated(&scalar[index + 1..]))
        || non_string_plain(scalar)
    {
        return Err(StoreError::InvalidNoteIdAnchor);
    }
    Ok((scalar.to_string(), scalar.len()))
}

fn non_string_plain(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "~" | "null"
            | "true"
            | "false"
            | "yes"
            | "no"
            | "on"
            | "off"
            | "y"
            | "n"
            | ".inf"
            | "+.inf"
            | "-.inf"
            | ".nan"
    ) {
        return true;
    }
    let numeric = lower.replace('_', "");
    let numeric_start = lower.trim_start_matches(['+', '-']);
    if numeric_start.starts_with(|ch: char| ch.is_ascii_digit() || ch == '.')
        && numeric.parse::<f64>().is_ok()
    {
        return true;
    }
    let unsigned = numeric.strip_prefix(['+', '-']).unwrap_or(&numeric);
    if [("0x", 16), ("0o", 8), ("0b", 2)]
        .iter()
        .any(|(prefix, radix)| {
            unsigned.strip_prefix(*prefix).is_some_and(|digits| {
                !digits.is_empty() && digits.chars().all(|ch| ch.is_digit(*radix))
            })
        })
    {
        return true;
    }
    // YAML 1.1 readers additionally type dates and sexagesimal numbers.
    let bytes = value.as_bytes();
    (bytes.len() >= 10
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && (bytes.len() == 10 || matches!(bytes[10], b'T' | b't' | b' ')))
        || (value.contains(':')
            && value.bytes().all(|byte| {
                byte.is_ascii_digit() || matches!(byte, b':' | b'.' | b'+' | b'-' | b'_')
            }))
}

fn quoted_scalar(value: &str) -> Result<(String, usize), StoreError> {
    let quote = value
        .as_bytes()
        .first()
        .copied()
        .ok_or(StoreError::InvalidNoteIdAnchor)?;
    if !matches!(quote, b'\'' | b'"') {
        return Err(StoreError::InvalidNoteIdAnchor);
    }
    let mut chars = value[1..].char_indices().peekable();
    let mut out = String::new();
    while let Some((offset, ch)) = chars.next() {
        if ch == char::from(quote) {
            if quote == b'\'' && chars.peek().is_some_and(|(_, next)| *next == '\'') {
                chars.next();
                out.push('\'');
                continue;
            }
            return Ok((out, offset + 2));
        }
        if quote != b'"' || ch != '\\' {
            out.push(ch);
            continue;
        }
        let (_, escaped) = chars.next().ok_or(StoreError::InvalidNoteIdAnchor)?;
        let decoded = match escaped {
            '0' => '\0',
            'a' => '\u{7}',
            'b' => '\u{8}',
            't' | '\t' => '\t',
            'n' => '\n',
            'v' => '\u{b}',
            'f' => '\u{c}',
            'r' => '\r',
            'e' => '\u{1b}',
            ' ' => ' ',
            '"' => '"',
            '/' => '/',
            '\\' => '\\',
            'N' => '\u{85}',
            '_' => '\u{a0}',
            'L' => '\u{2028}',
            'P' => '\u{2029}',
            'x' | 'u' | 'U' => {
                let count = match escaped {
                    'x' => 2,
                    'u' => 4,
                    _ => 8,
                };
                let mut code = 0_u32;
                for _ in 0..count {
                    let (_, digit) = chars.next().ok_or(StoreError::InvalidNoteIdAnchor)?;
                    code = code
                        .checked_mul(16)
                        .and_then(|code| digit.to_digit(16).map(|digit| code + digit))
                        .ok_or(StoreError::InvalidNoteIdAnchor)?;
                }
                char::from_u32(code).ok_or(StoreError::InvalidNoteIdAnchor)?
            }
            _ => return Err(StoreError::InvalidNoteIdAnchor),
        };
        out.push(decoded);
    }
    Err(StoreError::InvalidNoteIdAnchor)
}

fn validate_other_value(value: &str) -> Result<(), StoreError> {
    if value.starts_with(['&', '*', '!']) {
        return Err(StoreError::InvalidFrontmatter);
    }
    if value.starts_with(['\'', '"']) {
        let (_, end) = quoted_scalar(value).map_err(|_| StoreError::InvalidFrontmatter)?;
        return if valid_tail(&value[end..]) {
            Ok(())
        } else {
            Err(StoreError::InvalidFrontmatter)
        };
    }
    if !value.starts_with(['[', '{']) {
        return Ok(());
    }
    let mut stack = Vec::new();
    let mut offset = 0;
    while offset < value.len() {
        let byte = value.as_bytes()[offset];
        if matches!(byte, b'\'' | b'"') {
            let (_, length) =
                quoted_scalar(&value[offset..]).map_err(|_| StoreError::InvalidFrontmatter)?;
            offset += length;
            continue;
        }
        match byte {
            b'[' => stack.push(b']'),
            b'{' => stack.push(b'}'),
            b']' | b'}' => {
                if stack.pop() != Some(byte) {
                    return Err(StoreError::InvalidFrontmatter);
                }
                if stack.is_empty() {
                    return if valid_tail(&value[offset + 1..]) {
                        Ok(())
                    } else {
                        Err(StoreError::InvalidFrontmatter)
                    };
                }
            }
            b'#' if offset == 0 || matches!(value.as_bytes()[offset - 1], b' ' | b'\t') => break,
            _ => {}
        }
        offset += 1;
    }
    Err(StoreError::InvalidFrontmatter)
}

fn quote_id(id: &str) -> String {
    let mut quoted = String::with_capacity(id.len() + 2);
    quoted.push('"');
    for ch in id.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\u{2028}' => quoted.push_str("\\u2028"),
            '\u{2029}' => quoted.push_str("\\u2029"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions

    use super::*;

    #[test]
    fn paths_hash_opaque_ids_instead_of_interpolating_them() {
        let paths = note_paths_impl("../../opaque note").unwrap();
        assert_eq!(paths.key.len(), 66);
        assert!(paths.key.starts_with("n-"));
        assert!(!paths.dir.contains(".."));
        assert_eq!(paths.dir, format!("mica-data/notes/{}", paths.key));
        assert_ne!(
            paths.key,
            note_paths_impl("../../opaque note ").unwrap().key
        );
        assert!(note_paths_impl("\nunsafe").is_err());
        assert!(note_paths_impl(&"é".repeat(2049)).is_err());
    }

    #[test]
    fn object_pool_requires_full_addresses_and_note_scoped_aliases() {
        let full = crate::hash_content_impl("body");
        let short = &full[..19];
        assert!(object_paths_impl(&full)
            .unwrap()
            .plain
            .ends_with(".mica.md"));
        assert!(object_paths_impl(short).is_err());
        assert_eq!(
            resolve_object_hash_impl(short, &BTreeMap::new()),
            Err(StoreError::MissingObjectAlias)
        );
        let aliases = BTreeMap::from([(short.to_string(), full.clone())]);
        assert_eq!(resolve_object_hash_impl(short, &aliases).unwrap(), full);
        assert!(is_managed_path_impl("mica-data/notes/file.md"));
        assert!(is_managed_path_impl("mica-data"));
        assert!(!is_managed_path_impl("mica-database/file.md"));
        assert!(!is_managed_path_impl("notes/mica-data/file.md"));
    }

    #[test]
    fn identity_replacement_preserves_bom_crlf_comments_and_other_bytes() {
        let source = "\u{feff}---\r\ntitle: 'untouched'\r\n\"mica-id\": 'old''id'  # keep\r\nnested:\r\n  mica-id: unrelated\r\n...\r\nBody without newline";
        assert_eq!(note_id_impl(source).unwrap().as_deref(), Some("old'id"));
        let changed = set_note_id_impl(source, Some("old'id"), "new\\\"id").unwrap();
        assert_eq!(changed, source.replace("'old''id'", r#""new\\\"id""#));
        assert_eq!(
            note_id_impl(&changed).unwrap().as_deref(),
            Some("new\\\"id")
        );
        assert_eq!(
            set_note_id_impl(source, Some("old'id"), "old'id").unwrap(),
            source
        );
        assert_eq!(
            set_note_id_impl(source, None, "new"),
            Err(StoreError::NoteIdMismatch)
        );
    }

    #[test]
    fn insertion_preserves_existing_frontmatter_and_body_exactly() {
        let source = "---\r\ntags: [one, 'two']\r\n---\r\nbody";
        let changed = set_note_id_impl(source, None, "123").unwrap();
        assert_eq!(
            changed,
            "---\r\ntags: [one, 'two']\r\nmica-id: \"123\"\r\n---\r\nbody"
        );
        assert_eq!(note_id_impl(&changed).unwrap().as_deref(), Some("123"));
        assert_eq!(
            set_note_id_impl("\u{feff}body\r\n", None, "id").unwrap(),
            "\u{feff}---\r\nmica-id: \"id\"\r\n---\r\n\r\nbody\r\n"
        );
    }

    #[test]
    fn identity_rejects_ambiguous_or_non_string_yaml() {
        for properties in [
            "mica-id: a\nmica-id: b\n",
            "mica-id: 123\n",
            "mica-id: null\n",
            "mica-id: true\n",
            "mica-id: |\n  text\n",
            "mica-id: a\n  continuation\n",
            "mica-id: *alias\n",
            "<<: *defaults\n",
            "{mica-id: hidden}\n",
            "mica-id: \"unterminated\n",
            "title: [\nmica-id: hidden\n]\n",
            "title: value\u{85}mica-id: hidden\n",
        ] {
            let source = format!("---\n{properties}---\nbody");
            assert!(note_id_impl(&source).is_err(), "{properties}");
            assert!(
                set_note_id_impl(&source, None, "new").is_err(),
                "{properties}"
            );
        }
        assert!(note_id_impl("---\nmica-id: id\n").is_err());
        assert_eq!(note_id_impl("body\nmica-id: ignored\n").unwrap(), None);
        assert_eq!(
            note_id_impl("---\nnested:\n  mica-id: ignored\n---\n").unwrap(),
            None
        );
    }

    #[test]
    fn double_quoted_identity_decodes_yaml_escapes_and_guards_exact_value() {
        let source = "---\nmica-id: \"a\\u002fb\\\"c\" # unchanged\n---\n";
        assert_eq!(note_id_impl(source).unwrap().as_deref(), Some("a/b\"c"));
        assert_eq!(
            set_note_id_impl(source, Some("wrong"), "new"),
            Err(StoreError::NoteIdMismatch)
        );
        assert!(note_id_impl("---\nmica-id: \"line\\nbreak\"\n---\n").is_err());
    }

    #[test]
    fn marker_requires_known_format_and_uuid() {
        let valid = StoreMarker {
            format: 1,
            store_id: "01990df6-03de-7abc-8000-000000000001".into(),
        };
        assert_eq!(validate_store_marker_impl(valid.clone()).unwrap(), valid);
        assert!(validate_store_marker_impl(StoreMarker {
            format: 2,
            ..valid.clone()
        })
        .is_err());
        assert!(validate_store_marker_impl(StoreMarker {
            store_id: "not-a-uuid".into(),
            ..valid
        })
        .is_err());
    }
}

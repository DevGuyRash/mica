//! Sidecar storage — byte-compatible with the Obsidian plugin's layout.
//!
//! Next to `Note.md` lives `Note.mica/` holding `objects/<b3-hash>.mica.md`
//! (immutable, content-addressed), `ledger.jsonl` (append-only), and
//! `manifest.json` (human/tool summary; tab-indented like the plugin writes).

use crate::error::{io_ctx, Result};
use mica_core::Event;
use std::fs;
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

/// Object path for `hash` (`b3:abcd` → `objects/b3-abcd.mica.md`).
/// Compressed-object variant path (large objects). Hash is over PLAINTEXT.
pub fn object_path_gz(note: &Path, hash: &str) -> PathBuf {
    objects_dir(note).join(format!("{}.mica.gz", hash.replace(':', "-")))
}

/// Objects at or under this size stay human-readable plaintext `.md`.
/// Shared rule with the plugin — both sides read either form.
pub const COMPRESS_MIN_BYTES: usize = 4096;

pub fn object_path(note: &Path, hash: &str) -> PathBuf {
    objects_dir(note).join(format!("{}.mica.md", hash.replace(':', "-")))
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
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(io_ctx(path.display().to_string()))?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Event>(l).ok())
        .collect())
}

/// Count of unparseable ledger lines (doctor's corruption signal).
pub fn ledger_bad_lines(path: &Path) -> Result<usize> {
    if !path.is_file() {
        return Ok(0);
    }
    let text = fs::read_to_string(path).map_err(io_ctx(path.display().to_string()))?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter(|l| serde_json::from_str::<Event>(l).is_err())
        .count())
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
    ensure_sidecar(note)?;
    let path = ledger_path(note);
    let mut lines = String::new();
    for e in events {
        // serde_json cannot fail on these plain structs; a failure would be a
        // programming error surfaced in tests, not a runtime state.
        let line =
            serde_json::to_string(e).map_err(|e| crate::error::CliError::Corrupt(e.to_string()))?;
        lines.push_str(&line);
        lines.push('\n');
    }
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(io_ctx(path.display().to_string()))?;
    f.write_all(lines.as_bytes())
        .map_err(io_ctx(path.display().to_string()))
}

/// Create the sidecar + objects directories when missing.
fn ensure_sidecar(note: &Path) -> Result<()> {
    let dir = objects_dir(note);
    fs::create_dir_all(&dir).map_err(io_ctx(dir.display().to_string()))
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
/// mica_cli::sidecar::write_object(std::path::Path::new("Note.md"), "b3:00", "x").unwrap();
/// ```
pub fn write_object(note: &Path, hash: &str, content: &str) -> Result<()> {
    ensure_sidecar(note)?;
    let plain = object_path(note, hash);
    let gz = object_path_gz(note, hash);
    if plain.exists() || gz.exists() {
        return Ok(()); // immutable: same hash = same bytes
    }
    if content.len() <= COMPRESS_MIN_BYTES {
        return fs::write(&plain, content).map_err(io_ctx(plain.display().to_string()));
    }
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut enc, content.as_bytes())
        .and_then(|()| enc.finish())
        .map_err(io_ctx(gz.display().to_string()))
        .and_then(|bytes| fs::write(&gz, bytes).map_err(io_ctx(gz.display().to_string())))
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
/// let c = mica_cli::sidecar::read_object(std::path::Path::new("Note.md"), "b3:00").unwrap();
/// ```
pub fn read_object(note: &Path, hash: &str) -> Result<Option<String>> {
    let plain = object_path(note, hash);
    if plain.is_file() {
        return fs::read_to_string(&plain)
            .map(Some)
            .map_err(io_ctx(plain.display().to_string()));
    }
    let gz = object_path_gz(note, hash);
    if !gz.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&gz).map_err(io_ctx(gz.display().to_string()))?;
    let mut out = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&bytes[..]), &mut out)
        .map_err(io_ctx(gz.display().to_string()))?;
    Ok(Some(out))
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
    fs::write(&p, out).map_err(io_ctx(p.display().to_string()))
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
        let ev = Event::SetHead {
            eid: "e1".into(),
            ts: 1,
            block: "b".into(),
            hash: "b3:aa".into(),
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
        assert_eq!(events.len(), 2);
        assert_eq!(ledger_bad_lines(&ledger_path(&note)).unwrap(), 1);
    }

    #[test]
    fn objects_are_immutable() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("N.md");
        write_object(&note, "b3:aa", "first").unwrap();
        write_object(&note, "b3:aa", "SECOND WRITE MUST NOT REPLACE").unwrap();
        assert_eq!(
            read_object(&note, "b3:aa").unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(read_object(&note, "b3:bb").unwrap(), None);
    }

    #[test]
    fn large_objects_compress_small_stay_plaintext_and_both_read_back() {
        let dir = tempfile::tempdir().expect("tmp");
        let note = dir.path().join("n.md");
        std::fs::write(&note, "x").expect("note");
        let small = "small body";
        write_object(&note, "b3:aaaa", small).expect("small write");
        assert!(object_path(&note, "b3:aaaa").is_file(), "small stays .md");
        let large = "L".repeat(COMPRESS_MIN_BYTES + 100);
        write_object(&note, "b3:bbbb", &large).expect("large write");
        assert!(object_path_gz(&note, "b3:bbbb").is_file(), "large becomes .gz");
        assert!(!object_path(&note, "b3:bbbb").exists());
        assert_eq!(read_object(&note, "b3:aaaa").expect("r1"), Some(small.to_string()));
        assert_eq!(read_object(&note, "b3:bbbb").expect("r2"), Some(large));
        assert_eq!(read_object(&note, "b3:none").expect("r3"), None);
    }
}

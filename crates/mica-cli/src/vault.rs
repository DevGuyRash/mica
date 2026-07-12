//! Vault discovery and note-path resolution.
//!
//! A "vault" is any directory containing `.obsidian/`. Notes may be addressed
//! by a path relative to the current directory OR relative to the vault root;
//! resolution tries as-given first, then vault-relative.

use crate::error::{io_ctx, CliError, Result};
use std::path::{Path, PathBuf};

/// A resolved note inside a resolved vault.
#[derive(Debug, Clone)]
pub struct NoteRef {
    /// Absolute path of the note file.
    pub abs: PathBuf,
    /// Absolute path of the vault root.
    pub vault: PathBuf,
}

impl NoteRef {
    /// The note's path relative to the vault root, with `/` separators
    /// (the form Obsidian and the sidecar manifest use).
    pub fn vault_rel(&self) -> String {
        let rel = self.abs.strip_prefix(&self.vault).unwrap_or(&self.abs);
        rel.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    }
}

/// Find the vault root: `explicit` if given, else walk up from `start`
/// looking for a directory containing `.obsidian`.
///
/// Purpose: every command needs the vault root for sidecar-wide operations.
///
/// # Arguments
/// * `explicit` - the `--vault` flag, if provided
/// * `start` - directory to walk up from (usually the note's parent or cwd)
///
/// # Returns
/// Absolute vault root.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let root = mica_cli::vault::find_vault(None, std::path::Path::new(".")).unwrap();
/// ```
pub fn find_vault(explicit: Option<&Path>, start: &Path) -> Result<PathBuf> {
    if let Some(v) = explicit {
        let abs = absolutize(v)?;
        if !abs.is_dir() {
            return Err(CliError::NotFound(format!(
                "vault directory not found: {} — pass an existing directory to --vault",
                abs.display()
            )));
        }
        return Ok(abs);
    }
    let mut cur = absolutize(start)?;
    loop {
        if cur.join(".obsidian").is_dir() {
            return Ok(cur);
        }
        if !cur.pop() {
            return Err(CliError::NotFound(
                "no vault found: no `.obsidian` folder in this directory or any parent — run inside a vault or pass --vault".to_string(),
            ));
        }
    }
}

/// Resolve a note argument to an absolute path inside a vault.
///
/// Purpose: accept `mica ls Notes/foo.md` from anywhere (cwd-relative or
/// vault-relative), with `.md` appended when omitted.
///
/// # Arguments
/// * `note` - the note argument as typed
/// * `vault` - the `--vault` flag, if provided
///
/// # Returns
/// A [`NoteRef`] whose file exists.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let n = mica_cli::vault::resolve_note("test.md", None).unwrap();
/// ```
pub fn resolve_note(note: &str, vault: Option<&Path>) -> Result<NoteRef> {
    let with_md = |s: &str| -> String {
        if s.to_ascii_lowercase().ends_with(".md") {
            s.to_string()
        } else {
            format!("{s}.md")
        }
    };
    let typed = PathBuf::from(with_md(note));

    // 1. As given (relative to cwd or absolute).
    if typed.is_file() {
        let abs = absolutize(&typed)?;
        let vault = find_vault(vault, abs.parent().unwrap_or(Path::new(".")))?;
        return Ok(NoteRef { abs, vault });
    }
    // 2. Vault-relative.
    let root = find_vault(vault, Path::new("."))?;
    let cand = root.join(&typed);
    if cand.is_file() {
        return Ok(NoteRef {
            abs: cand,
            vault: root,
        });
    }
    Err(CliError::NotFound(format!(
        "note not found: {note} — looked at {} and {} (vault-relative)",
        typed.display(),
        cand.display()
    )))
}

/// All markdown notes under `vault`, skipping `.obsidian/`, dotfiles, and
/// `.mica` sidecar folders.
///
/// Purpose: vault-wide commands (repair, migrate, watch, doctor).
///
/// # Arguments
/// * `vault` - vault root
///
/// # Returns
/// Note paths in stable (sorted) order.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let notes = mica_cli::vault::vault_notes(std::path::Path::new(".")).unwrap();
/// ```
pub fn vault_notes(vault: &Path) -> Result<Vec<PathBuf>> {
    let mut notes = Vec::new();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(io_ctx(dir.display().to_string()))?;
        for entry in entries {
            let entry = entry.map_err(io_ctx(dir.display().to_string()))?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if name.starts_with('.') || name.ends_with(".mica") {
                    continue; // .obsidian, hidden dirs, sidecars
                }
                stack.push(path);
            } else if name.to_ascii_lowercase().ends_with(".md") && !name.starts_with('.') {
                notes.push(path);
            }
        }
    }
    notes.sort();
    Ok(notes)
}

/// Sidecar directories under `vault` (folders ending in `.mica`).
///
/// Purpose: repair/doctor sweep sidecars even when their note is gone.
///
/// # Arguments
/// * `vault` - vault root
///
/// # Returns
/// Sidecar directory paths in stable (sorted) order.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let sidecars = mica_cli::vault::vault_sidecars(std::path::Path::new(".")).unwrap();
/// ```
pub fn vault_sidecars(vault: &Path) -> Result<Vec<PathBuf>> {
    let mut sidecars = Vec::new();
    let mut stack = vec![vault.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(io_ctx(dir.display().to_string()))?;
        for entry in entries {
            let entry = entry.map_err(io_ctx(dir.display().to_string()))?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !path.is_dir() || name.starts_with('.') {
                continue;
            }
            if name.ends_with(".mica") {
                sidecars.push(path);
            } else {
                stack.push(path);
            }
        }
    }
    sidecars.sort();
    Ok(sidecars)
}

/// Make `p` absolute without requiring it to exist (unlike `canonicalize`).
fn absolutize(p: &Path) -> Result<PathBuf> {
    if p.is_absolute() {
        return Ok(normalize(p));
    }
    let cwd = std::env::current_dir().map_err(io_ctx("current directory"))?;
    Ok(normalize(&cwd.join(p)))
}

/// Resolve `.` / `..` components lexically.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    #[test]
    fn vault_rel_uses_forward_slashes() {
        let n = NoteRef {
            abs: PathBuf::from("/v/sub/Note.md"),
            vault: PathBuf::from("/v"),
        };
        assert_eq!(n.vault_rel(), "sub/Note.md");
    }

    #[test]
    fn find_vault_rejects_missing_explicit_dir() {
        let err = find_vault(Some(Path::new("/definitely/not/here")), Path::new(".")).unwrap_err();
        assert_eq!(err.exit_code(), 3);
    }

    #[test]
    fn normalize_resolves_dots() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }
}

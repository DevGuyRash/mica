//! Vault discovery and note-path resolution.
//!
//! A root is explicit, or discovered through `mica.json`, `.obsidian/`, or the default marker.
//! Notes may be addressed
//! by a path relative to the current directory OR relative to the vault root;
//! resolution tries as-given first, then vault-relative.

use crate::error::{io_ctx, CliError, Result};
use crate::sidecar::StoreRoot;
use std::path::{Path, PathBuf};

/// A resolved note inside a resolved vault.
#[derive(Debug, Clone)]
pub struct NoteRef {
    /// Absolute path of the note file.
    pub abs: PathBuf,
    /// Absolute path of the vault root.
    pub vault: PathBuf,
    /// Retained locator/store generation; None is for source-only fixture callers.
    pub store: Option<StoreRoot>,
}

/// Resolved note-or-directory scope for a bulk CLI operation.
#[derive(Debug, Clone)]
pub struct NoteScope {
    /// Canonical vault root shared by every selected note.
    pub vault: PathBuf,
    /// Markdown notes beneath the selected path in stable path order.
    pub notes: Vec<NoteRef>,
    /// Routing generation shared by all selected notes.
    pub store: StoreRoot,
}

/// Resolve a note or directory path without following paths outside its vault.
///
/// Existing paths are tried exactly as entered before the note-only `.md`
/// fallback, so a directory named `Prompts` cannot be mistaken for
/// `Prompts.md`.
///
/// # Arguments
/// * `path` - cwd-relative, absolute, or vault-relative note/directory path
/// * `vault` - explicit vault root, when supplied
///
/// # Returns
/// Canonical vault root and stable Markdown-note enumeration.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let scope = mica_cli::vault::resolve_note_scope("Prompts", None)?;
/// assert!(!scope.notes.is_empty());
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn resolve_note_scope(path: &str, vault: Option<&Path>) -> Result<NoteScope> {
    resolve_note_scope_at(path, vault, None)
}

/// Resolve a scope while retaining an optional first-use store selection.
pub fn resolve_note_scope_at(
    path: &str,
    vault: Option<&Path>,
    folder: Option<&str>,
) -> Result<NoteScope> {
    let typed = PathBuf::from(path);
    let typed_md = with_markdown_extension(&typed);

    let (candidate, root) = if path_exists(&typed)? {
        let root = find_vault(vault, scope_start(&typed))?;
        (typed, root)
    } else {
        let root_from_cwd = match find_vault(vault, Path::new(".")) {
            Ok(root) => Some(root),
            Err(CliError::NotFound(_)) if vault.is_none() => None,
            Err(error) => return Err(error),
        };
        if let Some(root) = root_from_cwd {
            let vault_exact = root.join(&typed);
            if path_exists(&vault_exact)? {
                (vault_exact, root)
            } else if path_exists(&typed_md)? {
                let root = find_vault(vault, scope_start(&typed_md))?;
                (typed_md, root)
            } else {
                let vault_markdown = root.join(&typed_md);
                if path_exists(&vault_markdown)? {
                    (vault_markdown, root)
                } else {
                    return Err(scope_not_found(path));
                }
            }
        } else if path_exists(&typed_md)? {
            let root = find_vault(None, scope_start(&typed_md))?;
            (typed_md, root)
        } else {
            return Err(scope_not_found(path));
        }
    };

    let target =
        std::fs::canonicalize(&candidate).map_err(io_ctx(candidate.display().to_string()))?;
    let root = std::fs::canonicalize(&root).map_err(io_ctx(root.display().to_string()))?;
    if !target.starts_with(&root) {
        return Err(CliError::BadArgs(format!(
            "scope resolves outside the vault: {} — choose a note or directory contained by {}",
            target.display(),
            root.display()
        )));
    }
    let store = StoreRoot::open_at(&root, folder)?;
    validate_visible_scope(&target, &store)?;

    let metadata = std::fs::metadata(&target).map_err(io_ctx(target.display().to_string()))?;
    let paths = if metadata.is_dir() {
        walk_vault_from(&target, &root, Some(&store.layout.root), true, false)?.notes
    } else if metadata.is_file() && is_markdown_path(&target) {
        vec![target]
    } else {
        return Err(CliError::BadArgs(format!(
            "scope is not a Markdown note or directory: {} — choose a `.md` file or directory",
            target.display()
        )));
    };
    let notes = paths
        .into_iter()
        .map(|abs| NoteRef {
            abs,
            vault: root.clone(),
            store: Some(store.clone()),
        })
        .collect();
    Ok(NoteScope {
        vault: root,
        notes,
        store,
    })
}

fn with_markdown_extension(path: &Path) -> PathBuf {
    if is_markdown_path(path) {
        return path.to_path_buf();
    }
    let mut value = path.as_os_str().to_os_string();
    value.push(".md");
    PathBuf::from(value)
}

fn scope_not_found(path: &str) -> CliError {
    CliError::NotFound(format!(
        "note or directory not found: {path} — looked for the exact path and its `.md` fallback"
    ))
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("md"))
}

fn path_exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_ctx(path.display().to_string())(error)),
    }
}

fn scope_start(path: &Path) -> &Path {
    if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(Path::new("."))
    }
}

fn validate_visible_scope(target: &Path, store: &StoreRoot) -> Result<()> {
    let root = &store.vault;
    let relative = target.strip_prefix(root).map_err(|_| {
        CliError::BadArgs(format!(
            "scope resolves outside the vault: {} — choose a contained path",
            target.display()
        ))
    })?;
    let relative_text = relative
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if mica_core::is_managed_path_at_impl(&relative_text, Some(&store.layout.root))
        .map_err(|error| CliError::Corrupt(error.to_string()))?
    {
        return Err(CliError::BadArgs(
            "Mica managed storage is not a live note scope".to_string(),
        ));
    }
    // O(d), where d is the number of path components beneath the vault root.
    let hidden = relative.components().any(|component| {
        let std::path::Component::Normal(name) = component else {
            return false;
        };
        let name = name.to_string_lossy();
        name.starts_with('.') || name.ends_with(".mica")
    });
    if hidden {
        return Err(CliError::BadArgs(format!(
            "scope is hidden or inside a Mica sidecar: {} — choose a visible vault note or directory",
            target.display()
        )));
    }
    Ok(())
}

impl NoteRef {
    /// Resolve once for legacy callers, or reuse the operation's retained route.
    pub fn store_root(&self) -> Result<StoreRoot> {
        match &self.store {
            Some(root) => Ok(root.clone()),
            None => StoreRoot::open(&self.vault),
        }
    }

    /// The note's path relative to the vault root, with `/` separators
    /// (the form Obsidian and the sidecar manifest use).
    pub fn vault_rel(&self) -> String {
        let rel = self.abs.strip_prefix(&self.vault).unwrap_or(&self.abs);
        rel.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
    }
}

/// Find the vault root: `explicit` if given, else walk up from `start`
/// looking for a directory containing `mica-data/root.json` or `.obsidian`.
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
        let selected = std::fs::canonicalize(&abs).map_err(io_ctx(abs.display().to_string()))?;
        validate_root_selection(&selected)?;
        return Ok(selected);
    }
    let mut cur = absolutize(start)?;
    let layout = mica_core::storage_layout_impl();
    loop {
        let store_dir = cur.join(&layout.root);
        if path_exists(&cur.join(&layout.location))? || path_exists(&store_dir)? {
            let selected = StoreRoot::open(&cur)?;
            validate_root_selection(&selected.vault)?;
            return Ok(selected.vault);
        }
        if cur.join(".obsidian").is_dir() {
            let selected =
                std::fs::canonicalize(&cur).map_err(io_ctx(cur.display().to_string()))?;
            validate_root_selection(&selected)?;
            return Ok(selected);
        }
        if !cur.pop() {
            return Err(CliError::NotFound(
                "no Mica root found: no `mica.json`, `mica-data/root.json`, or `.obsidian` directory in this path or its parents — pass --vault with an existing directory".to_string(),
            ));
        }
    }
}

/// Fixed locator checks walk ancestors only; Git and whole-vault scans are irrelevant.
fn validate_root_selection(selected: &Path) -> Result<()> {
    let layout = mica_core::storage_layout_impl();
    for ancestor in selected.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == std::ffi::OsStr::new(&layout.root))
        {
            return Err(CliError::BadArgs("Mica managed storage cannot be selected as a live root — select the containing root instead".to_string()));
        }
        if path_exists(&ancestor.join(&layout.location))? {
            let store = StoreRoot::open(ancestor)?;
            let relative = selected
                .strip_prefix(ancestor)
                .map_err(|_| CliError::BadArgs("invalid root ancestry".to_string()))?;
            let text = relative
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            if mica_core::is_managed_path_at_impl(&text, Some(&store.layout.root))
                .map_err(|error| CliError::Corrupt(error.to_string()))?
            {
                return Err(CliError::BadArgs("Mica configured storage cannot be selected as a live root — select the containing root instead".to_string()));
            }
        }
    }
    Ok(())
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
    resolve_note_at(note, vault, None)
}

/// Resolve a live note and retain the selected store generation.
pub fn resolve_note_at(note: &str, vault: Option<&Path>, folder: Option<&str>) -> Result<NoteRef> {
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
        let abs = std::fs::canonicalize(&typed).map_err(io_ctx(typed.display().to_string()))?;
        let root = find_vault(vault, abs.parent().unwrap_or(Path::new(".")))?;
        return contained_note(abs, StoreRoot::open_at(&root, folder)?);
    }
    // 2. Vault-relative.
    let root = find_vault(vault, Path::new("."))?;
    let cand = root.join(&typed);
    if cand.is_file() {
        let abs = std::fs::canonicalize(&cand).map_err(io_ctx(cand.display().to_string()))?;
        return contained_note(abs, StoreRoot::open_at(&root, folder)?);
    }
    Err(CliError::NotFound(format!(
        "note not found: {note} — looked at {} and {} (vault-relative)",
        typed.display(),
        cand.display()
    )))
}

/// All markdown notes under `vault`, skipping `.obsidian/`, dotfiles, and
/// the managed `mica-data/` root and legacy `.mica` sidecar folders.
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
    vault_notes_in(&StoreRoot::open(vault)?)
}

/// Enumerate live notes without rerouting a retained command context.
pub fn vault_notes_in(store: &StoreRoot) -> Result<Vec<PathBuf>> {
    store.revalidate()?;
    walk_vault_from(
        &store.vault,
        &store.vault,
        Some(&store.layout.root),
        true,
        false,
    )
    .map(|inventory| inventory.notes)
}

pub(crate) struct VaultInventory {
    pub(crate) notes: Vec<PathBuf>,
    pub(crate) sidecars: Vec<PathBuf>,
}

#[cfg(test)]
pub(crate) fn vault_inventory(vault: &Path) -> Result<VaultInventory> {
    let store = StoreRoot::open(vault)?;
    Ok(VaultInventory {
        notes: vault_notes_in(&store)?,
        sidecars: vault_sidecars_in(&store)?,
    })
}

pub(crate) fn legacy_sidecars_in(vault: &Path, folder: Option<&str>) -> Result<Vec<PathBuf>> {
    walk_vault_from(vault, vault, folder, false, true).map(|inventory| inventory.sidecars)
}

fn walk_vault_from(
    scope: &Path,
    vault: &Path,
    folder: Option<&str>,
    include_notes: bool,
    include_sidecars: bool,
) -> Result<VaultInventory> {
    let mut result = VaultInventory {
        notes: Vec::new(),
        sidecars: Vec::new(),
    };
    // Per vault command: one O(entries) traversal plus stable O(n log n)
    // output ordering; stack and results occupy O(directories + matches).
    let vault_root = std::fs::canonicalize(vault).map_err(io_ctx(vault.display().to_string()))?;
    let root = if scope == vault {
        vault_root.clone()
    } else {
        std::fs::canonicalize(scope).map_err(io_ctx(scope.display().to_string()))?
    };
    let managed = vault_root.join(mica_core::storage_layout_impl().root);
    let configured = folder.map(|value| vault_root.join(value));
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).map_err(io_ctx(dir.display().to_string()))?;
        for entry in entries {
            let entry = entry.map_err(io_ctx(dir.display().to_string()))?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = entry
                .file_type()
                .map_err(io_ctx(path.display().to_string()))?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if path == managed || configured.as_ref() == Some(&path) {
                    continue;
                }
                if name.starts_with('.') {
                    continue;
                }
                if name.ends_with(".mica") {
                    if include_sidecars {
                        result.sidecars.push(path);
                    }
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file()
                && include_notes
                && name.to_ascii_lowercase().ends_with(".md")
                && !name.starts_with('.')
            {
                result.notes.push(path);
            }
        }
    }
    result.notes.sort();
    result.sidecars.sort();
    Ok(result)
}

/// Identity-bound central note directories, including orphaned live-note hints.
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
    vault_sidecars_in(&StoreRoot::open(vault)?)
}

/// Enumerate history directories without rerouting the selected store.
pub fn vault_sidecars_in(store: &StoreRoot) -> Result<Vec<PathBuf>> {
    crate::sidecar::enumerate_note_stores_in(store)
        .map(|records| records.iter().map(crate::sidecar::sidecar_dir).collect())
}

fn contained_note(abs: PathBuf, store: StoreRoot) -> Result<NoteRef> {
    let vault = store.vault.clone();
    if !abs.starts_with(&vault) {
        return Err(CliError::BadArgs(format!(
            "note resolves outside the vault: {} — choose a note contained by {}",
            abs.display(),
            vault.display()
        )));
    }
    validate_visible_scope(&abs, &store)?;
    Ok(NoteRef {
        abs,
        vault,
        store: Some(store),
    })
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
            store: None,
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

    #[test]
    fn note_scope_prefers_exact_directory_and_returns_filtered_sorted_notes() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let vault = temp.path().join("vault");
        let scope_dir = vault.join("Prompts");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault marker");
        std::fs::create_dir_all(scope_dir.join("nested")).expect("nested directory");
        std::fs::create_dir_all(scope_dir.join("Ignored.mica")).expect("sidecar directory");
        std::fs::create_dir_all(vault.join("mica-data")).expect("central store directory");
        std::fs::write(
            vault.join("mica-data/root.json"),
            r#"{"format":1,"storeId":"00000000-0000-4000-8000-000000000001"}"#,
        )
        .expect("central store marker");
        std::fs::create_dir_all(scope_dir.join(".hidden")).expect("hidden directory");
        std::fs::write(vault.join("Prompts.md"), "same-name note").expect("fallback note");
        std::fs::write(scope_dir.join("B.md"), "b").expect("B note");
        std::fs::write(scope_dir.join("nested/A.md"), "a").expect("A note");
        std::fs::write(scope_dir.join("Ignored.mica/object.md"), "object").expect("sidecar file");
        std::fs::write(scope_dir.join(".hidden/Hidden.md"), "hidden").expect("hidden note");

        let scope = resolve_note_scope(scope_dir.to_str().expect("UTF-8 scope path"), Some(&vault))
            .expect("resolve directory scope");
        let paths: Vec<String> = scope.notes.iter().map(NoteRef::vault_rel).collect();

        assert_eq!(
            scope.vault,
            std::fs::canonicalize(&vault).expect("canonical vault")
        );
        assert_eq!(
            paths,
            vec![
                "Prompts/B.md".to_string(),
                "Prompts/nested/A.md".to_string()
            ]
        );
    }

    #[test]
    fn note_scope_resolves_vault_relative_markdown_fallback() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let vault = temp.path().join("vault");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault marker");
        std::fs::create_dir_all(vault.join("Folder")).expect("note folder");
        std::fs::write(vault.join("Folder/Only.md"), "note").expect("seed note");

        let scope = resolve_note_scope("Folder/Only", Some(&vault)).expect("resolve note fallback");

        assert_eq!(scope.notes.len(), 1);
        assert_eq!(scope.notes[0].vault_rel(), "Folder/Only.md");
    }

    #[test]
    fn note_scope_resolves_absolute_markdown_fallback_outside_the_vault_cwd() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let vault = temp.path().join("vault");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault marker");
        std::fs::write(vault.join("Only.md"), "note").expect("seed note");

        let scope = resolve_note_scope(
            vault
                .join("Only")
                .to_str()
                .expect("UTF-8 absolute note path"),
            None,
        )
        .expect("resolve absolute note fallback");

        assert_eq!(scope.notes.len(), 1);
        assert_eq!(scope.notes[0].vault_rel(), "Only.md");
    }

    #[cfg(unix)]
    #[test]
    fn note_scope_rejects_escape_and_skips_recursive_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temporary directory");
        let vault = temp.path().join("vault");
        let folder = vault.join("Folder");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault marker");
        std::fs::create_dir_all(&folder).expect("scope folder");
        std::fs::create_dir_all(&outside).expect("outside folder");
        std::fs::write(folder.join("Inside.md"), "inside").expect("inside note");
        std::fs::write(outside.join("Outside.md"), "outside").expect("outside note");
        symlink(&outside, folder.join("linked")).expect("recursive symlink");
        symlink(outside.join("Outside.md"), vault.join("escape.md")).expect("file symlink");

        let scope = resolve_note_scope("Folder", Some(&vault)).expect("resolve safe folder");
        assert_eq!(
            scope
                .notes
                .iter()
                .map(NoteRef::vault_rel)
                .collect::<Vec<_>>(),
            vec!["Folder/Inside.md".to_string()]
        );
        assert!(matches!(
            resolve_note_scope("escape.md", Some(&vault)),
            Err(CliError::BadArgs(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn vault_walks_do_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temporary directory");
        let vault = temp.path().join("vault");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault marker");
        std::fs::create_dir_all(outside.join("Outside.mica")).expect("outside sidecar");
        std::fs::write(outside.join("Outside.md"), "outside").expect("outside note");
        symlink(&outside, vault.join("linked")).expect("directory symlink");
        symlink(outside.join("Outside.md"), vault.join("escape.md")).expect("file symlink");

        assert!(vault_notes(&vault).expect("walk notes").is_empty());
        assert!(vault_sidecars(&vault).expect("walk sidecars").is_empty());
        let inventory = vault_inventory(&vault).expect("walk combined inventory");
        assert!(inventory.notes.is_empty());
        assert!(inventory.sidecars.is_empty());
        assert!(matches!(
            resolve_note(
                vault.join("escape.md").to_str().expect("UTF-8 path"),
                Some(&vault)
            ),
            Err(CliError::BadArgs(_))
        ));
    }

    #[test]
    fn combined_inventory_matches_individual_sorted_walks() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let vault = temp.path().join("vault");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault marker");
        std::fs::create_dir_all(vault.join("Folder")).expect("note folder");
        std::fs::write(vault.join("Folder/B.md"), "b").expect("note");
        std::fs::write(vault.join("A.md"), "a").expect("note");
        for (path, id) in [("Folder/B.md", "note-b"), ("A.md", "note-a")] {
            let store =
                crate::sidecar::NoteStore::for_id(&vault, &vault.join(path), id).expect("store");
            crate::sidecar::write_manifest(&store, Some(id), path, &[], 0).expect("manifest");
        }

        let inventory = vault_inventory(&vault).expect("combined inventory");

        assert_eq!(inventory.notes, vault_notes(&vault).expect("notes"));
        assert_eq!(
            inventory.sidecars,
            vault_sidecars(&vault).expect("sidecars")
        );
    }
}

//! Crash-resistant filesystem writes shared by note and sidecar persistence.

use crate::error::{io_ctx, CliError, Result};
use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::io::Write;
use std::path::Path;

struct StagedFile {
    file: tempfile::NamedTempFile,
}

/// Atomically replace `path` with `bytes` while preserving existing permissions.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let staged = stage(path, bytes)?;
    publish(staged, path, bytes)
}

/// Best-effort guarded replacement when current bytes equal `expected`.
///
/// The replacement rename is atomic, but ordinary portable filesystems have no
/// compare-and-swap primitive for path contents. A non-cooperating writer can
/// therefore still race after the comparison and before the rename. Callers
/// must durably preserve the exact pre-image before invoking this helper.
pub(crate) fn atomic_write_if_unchanged(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
) -> Result<()> {
    let staged = stage(path, replacement)?;
    let current = fs::read(path).map_err(io_ctx(path.display().to_string()))?;
    if current != expected {
        return Err(CliError::BadArgs(format!(
            "note changed while the command was running: {} — retry against the latest contents",
            path.display()
        )));
    }
    publish(staged, path, replacement)
}

fn stage(path: &Path, bytes: &[u8]) -> Result<StagedFile> {
    let parent = path.parent().ok_or_else(|| {
        CliError::BadArgs(format!(
            "cannot write {}: it has no parent directory — use a normal filesystem path",
            path.display()
        ))
    })?;
    path.file_name().ok_or_else(|| {
        CliError::BadArgs(format!(
            "cannot write {}: it has no filename — use a file path",
            path.display()
        ))
    })?;
    let permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut file = tempfile::Builder::new()
        .prefix(".mica-tmp-")
        .tempfile_in(parent)
        .map_err(io_ctx(parent.display().to_string()))?;
    file.write_all(bytes)
        .map_err(io_ctx(file.path().display().to_string()))?;
    if let Some(permissions) = permissions {
        file.as_file()
            .set_permissions(permissions)
            .map_err(io_ctx(file.path().display().to_string()))?;
    }
    file.as_file()
        .sync_all()
        .map_err(io_ctx(file.path().display().to_string()))?;
    Ok(StagedFile { file })
}

fn publish(staged: StagedFile, path: &Path, expected: &[u8]) -> Result<()> {
    staged
        .file
        .persist(path)
        .map_err(|error| io_ctx(path.display().to_string())(error.error))?;
    sync_parent(path)?;
    let published = fs::read(path).map_err(io_ctx(path.display().to_string()))?;
    if published == expected {
        return Ok(());
    }
    Err(CliError::Io(
        format!(
            "could not verify the bytes written to {} — inspect the file before retrying",
            path.display()
        ),
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "write verification mismatch",
        ),
    ))
}

#[cfg(unix)]
pub(crate) fn sync_parent(path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(io_ctx(parent.display().to_string()))
}

#[cfg(not(unix))]
pub(crate) fn sync_parent(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions

    use super::*;

    #[test]
    fn atomic_write_replaces_bytes() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"before\r\n").expect("seed note");

        atomic_write(&path, b"after\r\n").expect("atomic replacement");

        assert_eq!(std::fs::read(&path).expect("read note"), b"after\r\n");
        assert_eq!(
            std::fs::read_dir(dir.path())
                .expect("list directory")
                .count(),
            1,
            "temporary file is cleaned up"
        );
    }

    #[test]
    fn guarded_write_rejects_a_changed_source() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"newer edit").expect("seed note");

        let error = atomic_write_if_unchanged(&path, b"stale read", b"replacement")
            .expect_err("stale source must be rejected");

        assert!(matches!(error, CliError::BadArgs(_)));
        assert_eq!(
            std::fs::read(&path).expect("read note"),
            b"newer edit",
            "conflicting bytes survive"
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"before").expect("seed note");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("set permissions");

        atomic_write(&path, b"after").expect("atomic replacement");

        assert_eq!(
            std::fs::metadata(&path)
                .expect("note metadata")
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}

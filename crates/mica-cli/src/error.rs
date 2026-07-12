//! CLI error type and exit-code mapping.

use std::fmt;

/// Everything that can go wrong running a `mica` command.
#[derive(Debug)]
pub enum CliError {
    /// Filesystem failure (path + source), e.g. unreadable note or sidecar.
    Io(String, std::io::Error),
    /// The note, block, tab, version, or vault was not found.
    NotFound(String),
    /// Arguments were structurally valid but semantically unusable.
    BadArgs(String),
    /// A sidecar or note is damaged in a way that needs human attention.
    Corrupt(String),
}

impl CliError {
    /// Process exit code for this error class: 1 = I/O, 2 = bad args,
    /// 3 = not found, 4 = corrupt state.
    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Io(..) => 1,
            CliError::BadArgs(_) => 2,
            CliError::NotFound(_) => 3,
            CliError::Corrupt(_) => 4,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Io(what, e) => write!(f, "{what}: {e}"),
            CliError::NotFound(what) => write!(f, "{what}"),
            CliError::BadArgs(what) => write!(f, "{what}"),
            CliError::Corrupt(what) => write!(f, "{what}"),
        }
    }
}

impl std::error::Error for CliError {}

/// Shorthand result for CLI operations.
pub type Result<T> = std::result::Result<T, CliError>;

/// Attach a path/context string to an `io::Error`.
pub fn io_ctx(what: impl Into<String>) -> impl FnOnce(std::io::Error) -> CliError {
    move |e| CliError::Io(what.into(), e)
}

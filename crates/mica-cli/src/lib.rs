//! `mica` CLI library — everything the thin binary wires together.
//!
//! Structure:
//! - [`cli`] — clap surface;
//! - [`vault`] — vault/note resolution;
//! - [`blocks`] — block addressing on a live scan;
//! - [`sidecar`] — plugin-byte-compatible version storage;
//! - [`engine`] — snapshot/restore/label with the plugin's gating semantics;
//! - [`commands`] — one function per subcommand;
//! - [`output`] — human/JSON printing.

pub mod blocks;
pub mod cli;
pub mod commands;
pub mod engine;
pub mod error;
mod fsutil;
pub mod normalize;
pub mod output;
pub mod sidecar;
pub mod vault;

pub use error::CliError;

use clap::Parser;

/// Parse argv and run the selected command.
///
/// Purpose: single entry point for the binary (and for integration tests).
///
/// # Arguments
/// None (reads `std::env::args`).
///
/// # Returns
/// `()` on success; a [`CliError`] the binary maps to an exit code.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// let _ = mica_cli::run();
/// ```
pub fn run() -> error::Result<()> {
    let cli = cli::Cli::parse();
    commands::dispatch(cli)
}

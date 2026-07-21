//! Command-line surface (clap) and dispatch.

use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

/// Top-level CLI: `mica [--vault DIR] [--json] <command>`.
#[derive(Parser, Debug)]
#[command(
    name = "mica",
    version,
    about = "Versioned, structured content blocks in your Obsidian vault — from the shell.",
    after_help = "Works directly on vault files; Obsidian does not need to be running.\n\
                  Block addressing (-b): a block id, a block name, or a 1-based index.\n\
                  Version addressing: a hash (b3:… or unique prefix) or vN (v1 = oldest)."
)]
pub struct Cli {
    /// Vault root (default: walk up from the note / cwd to a `.obsidian` folder)
    #[arg(long, global = true, value_name = "DIR")]
    pub vault: Option<PathBuf>,
    /// Machine-readable JSON output
    #[arg(long, global = true)]
    pub json: bool,
    /// The selected subcommand.
    #[command(subcommand)]
    pub cmd: Cmd,
}

/// Common `<note> -b <block>` pair.
#[derive(Args, Debug)]
pub struct NoteBlock {
    /// Note path (cwd-relative or vault-relative; `.md` optional)
    pub note: String,
    /// Block id, name, or 1-based index (optional when the note has one block)
    #[arg(short, long)]
    pub block: Option<String>,
}

/// All `mica` subcommands.
#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// List a note's blocks and their structure (tabs, grids, versions)
    Ls {
        /// Note path
        note: String,
        /// Show the full nested tree with child paths
        #[arg(long)]
        tree: bool,
    },
    /// Print a block's content (or a single tab's body)
    Cat {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Print only the tab with this title
        #[arg(long)]
        tab: Option<String>,
    },
    /// Replace a block's content from a file or stdin (snapshots before & after)
    Set {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Read the new content from this file (default: stdin)
        #[arg(short, long)]
        file: Option<PathBuf>,
    },
    /// Add, remove, rename, or move tabs
    Tab {
        /// The tab operation.
        #[command(subcommand)]
        cmd: TabCmd,
    },
    /// Add, remove, or move grid cells
    Cell {
        /// The cell operation.
        #[command(subcommand)]
        cmd: CellCmd,
    },
    /// Grid settings (columns)
    Grid {
        /// The grid operation.
        #[command(subcommand)]
        cmd: GridCmd,
    },
    /// Move any node (tab, cell, or whole group) to a new parent/index
    Mv {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Path of the node to move (dot indices, e.g. 0.2)
        #[arg(long)]
        from: String,
        /// Destination container path ("" or "root" = block root)
        #[arg(long)]
        to_parent: String,
        /// Insertion index in the destination
        #[arg(long)]
        to_index: usize,
    },
    /// List a block's stored versions
    Versions {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
    },
    /// Print a stored version's content
    Show {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Version: hash (b3:… / unique prefix) or vN
        version: String,
    },
    /// Diff two versions (or a version against the current content)
    Diff {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Base version (default: the previous version)
        #[arg(long)]
        base: Option<String>,
        /// Compare version (default: current content)
        #[arg(long)]
        to: Option<String>,
        /// line | word | char
        #[arg(long, default_value = "line")]
        granularity: String,
        /// Print a unified patch instead of a colored diff
        #[arg(long)]
        patch: bool,
    },
    /// Restore a block to a stored version (snapshots current state first)
    Restore {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Version: hash or vN
        version: String,
    },
    /// Label a stored version (empty label clears)
    Label {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Version: hash or vN
        version: String,
        /// The label text
        label: String,
    },
    /// Snapshot a note's blocks now (change-gated; --force to bypass)
    Snapshot {
        /// Note path
        note: String,
        /// Snapshot even when only structure changed
        #[arg(long)]
        force: bool,
    },
    /// Watch the vault and auto-snapshot notes as they change
    Watch {
        /// Seconds a file must be quiet before snapshotting
        #[arg(long, default_value_t = 5)]
        debounce: u64,
        /// Poll interval in seconds
        #[arg(long, default_value_t = 2)]
        interval: u64,
    },
    /// Convert legacy ```tabs blocks to mica (archives become history)
    Migrate {
        /// Note path (default: whole vault)
        note: Option<String>,
        /// Report what would change without writing
        #[arg(long)]
        dry_run: bool,
        /// Comma-separated callout types imported as versions (empty = any)
        #[arg(long)]
        callouts: Option<String>,
    },
    /// Normalize Mica bodies into one logical section
    NormalizeSections {
        /// Note or directory path (cwd-relative or vault-relative)
        path: String,
        /// Normalize stored version history as well as live block bodies
        #[arg(long)]
        history: bool,
        /// Report what would change without writing
        #[arg(long)]
        dry_run: bool,
    },
    /// Stamp ids: frontmatter `mica-id` + block ids
    Prepare {
        /// Note path
        note: String,
    },
    /// Reconcile sidecars ↔ notes across the vault (rehome renamed notes)
    Repair,
    /// Vault/sidecar health report (missing objects, orphans, parse errors)
    Doctor,
}

/// Tab subcommands.
#[derive(Subcommand, Debug)]
pub enum TabCmd {
    /// Add a tab
    Add {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// New tab title
        #[arg(long, default_value = "New tab")]
        title: String,
        /// Tabs-group path (default: first tabs group)
        #[arg(long)]
        path: Option<String>,
        /// Insertion index (default: end)
        #[arg(long)]
        at: Option<usize>,
    },
    /// Remove a tab by index (0-based within the group)
    Rm {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Tab index within the group
        index: usize,
        /// Tabs-group path (default: first tabs group)
        #[arg(long)]
        path: Option<String>,
    },
    /// Rename a tab
    Rename {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Tab index within the group
        index: usize,
        /// New title
        title: String,
        /// Tabs-group path (default: first tabs group)
        #[arg(long)]
        path: Option<String>,
    },
    /// Move a tab within its group
    Mv {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Current tab index
        from: usize,
        /// New tab index
        to: usize,
        /// Tabs-group path (default: first tabs group)
        #[arg(long)]
        path: Option<String>,
    },
}

/// Cell subcommands.
#[derive(Subcommand, Debug)]
pub enum CellCmd {
    /// Add a cell
    Add {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Grid path (default: first grid)
        #[arg(long)]
        path: Option<String>,
        /// Insertion index (default: end)
        #[arg(long)]
        at: Option<usize>,
    },
    /// Remove a cell by index
    Rm {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Cell index within the grid
        index: usize,
        /// Grid path (default: first grid)
        #[arg(long)]
        path: Option<String>,
    },
    /// Move a cell within its grid
    Mv {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// Current cell index
        from: usize,
        /// New cell index
        to: usize,
        /// Grid path (default: first grid)
        #[arg(long)]
        path: Option<String>,
    },
}

/// Grid subcommands.
#[derive(Subcommand, Debug)]
pub enum GridCmd {
    /// Set the column count
    Cols {
        /// Target note and block
        #[command(flatten)]
        target: NoteBlock,
        /// New column count (>= 1)
        cols: usize,
        /// Grid path (default: first grid)
        #[arg(long)]
        path: Option<String>,
    },
}

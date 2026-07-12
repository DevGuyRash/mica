//! Integration tests: a throwaway vault on disk, driven through the real
//! binary (`CARGO_BIN_EXE_mica`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A minimal vault with one mica note, dropped in a tempdir.
struct Fixture {
    _tmp: tempfile::TempDir,
    vault: PathBuf,
    note: PathBuf,
}

fn fixture(note_body: &str) -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let vault = tmp.path().join("vault");
    fs::create_dir_all(vault.join(".obsidian")).expect("mk .obsidian");
    let note = vault.join("Test note.md");
    fs::write(&note, note_body).expect("write note");
    Fixture {
        _tmp: tmp,
        vault,
        note,
    }
}

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_mica"))
}

fn run_ok(args: &[&str], cwd: &Path) -> String {
    let out = bin()
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn mica");
    assert!(
        out.status.success(),
        "mica {:?} failed: {}\n{}",
        args,
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

const SIMPLE: &str = "```mica id=demo\ntab: One\nhello world\ntab: Two\nsecond body\n```\n";

#[test]
fn ls_lists_blocks_and_tabs() {
    let f = fixture(SIMPLE);
    let out = run_ok(&["ls", "Test note.md"], &f.vault);
    assert!(out.contains("demo"), "shows the block id: {out}");
    assert!(
        out.contains("One") && out.contains("Two"),
        "shows tab titles: {out}"
    );

    let json = run_ok(&["--json", "ls", "Test note.md"], &f.vault);
    let v: serde_json::Value = serde_json::from_str(&json).expect("valid json");
    assert_eq!(v[0]["id"], "demo");
}

#[test]
fn cat_prints_block_and_single_tab() {
    let f = fixture(SIMPLE);
    let all = run_ok(&["cat", "Test note.md"], &f.vault);
    assert!(all.contains("hello world") && all.contains("second body"));

    let one = run_ok(&["cat", "Test note.md", "--tab", "Two"], &f.vault);
    assert!(one.contains("second body") && !one.contains("hello world"));
}

#[test]
fn set_updates_content_and_snapshots_before_and_after() {
    let f = fixture(SIMPLE);
    let newc = f.vault.join("new.md");
    fs::write(&newc, "tab: One\nreplaced!\n").unwrap();
    run_ok(
        &[
            "set",
            "Test note.md",
            "-b",
            "demo",
            "-f",
            newc.to_str().unwrap(),
        ],
        &f.vault,
    );
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(doc.contains("replaced!") && !doc.contains("hello world"));

    // Both the pre-image and the new content must be stored versions.
    let versions = run_ok(
        &["--json", "versions", "Test note.md", "-b", "demo"],
        &f.vault,
    );
    let v: serde_json::Value = serde_json::from_str(&versions).unwrap();
    assert_eq!(
        v.as_array().unwrap().len(),
        2,
        "pre-image + new content: {versions}"
    );
}

#[test]
fn tab_add_rename_rm_roundtrip() {
    let f = fixture(SIMPLE);
    run_ok(
        &["tab", "add", "Test note.md", "--title", "Three"],
        &f.vault,
    );
    assert!(fs::read_to_string(&f.note).unwrap().contains("tab: Three"));

    run_ok(&["tab", "rename", "Test note.md", "2", "Drei"], &f.vault);
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(doc.contains("tab: Drei") && !doc.contains("tab: Three"));

    run_ok(&["tab", "rm", "Test note.md", "2"], &f.vault);
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(!doc.contains("tab: Drei"));
    assert!(doc.contains("tab: One"), "other tabs survive");
}

#[test]
fn snapshot_is_change_gated_and_restore_works() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    // Second snapshot with no change: still one version.
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let versions = run_ok(
        &["--json", "versions", "Test note.md", "-b", "demo"],
        &f.vault,
    );
    let v: serde_json::Value = serde_json::from_str(&versions).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1, "change-gated: {versions}");

    // Rename-only churn must NOT snapshot.
    run_ok(&["tab", "rename", "Test note.md", "0", "Uno"], &f.vault);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let versions = run_ok(
        &["--json", "versions", "Test note.md", "-b", "demo"],
        &f.vault,
    );
    let v: serde_json::Value = serde_json::from_str(&versions).unwrap();
    assert_eq!(
        v.as_array().unwrap().len(),
        1,
        "structural churn gated: {versions}"
    );

    // Real edit → second version; restore v1 brings old prose back.
    let newc = f.vault.join("new.md");
    fs::write(&newc, "tab: Uno\nEDITED\n").unwrap();
    run_ok(
        &["set", "Test note.md", "-f", newc.to_str().unwrap()],
        &f.vault,
    );
    run_ok(&["restore", "Test note.md", "v1"], &f.vault);
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(doc.contains("hello world"), "v1 content restored: {doc}");
}

#[test]
fn diff_prints_patch_between_versions() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let newc = f.vault.join("new.md");
    fs::write(
        &newc,
        "tab: One\nhello brave world\ntab: Two\nsecond body\n",
    )
    .unwrap();
    run_ok(
        &["set", "Test note.md", "-f", newc.to_str().unwrap()],
        &f.vault,
    );

    let patch = run_ok(
        &[
            "diff",
            "Test note.md",
            "--base",
            "v1",
            "--to",
            "v2",
            "--patch",
        ],
        &f.vault,
    );
    assert!(
        patch.contains("-hello world"),
        "patch shows deletion: {patch}"
    );
    assert!(
        patch.contains("+hello brave world"),
        "patch shows insertion: {patch}"
    );

    // Default: colored human diff, base = previous version, to = current.
    let human = run_ok(&["diff", "Test note.md"], &f.vault);
    assert!(human.contains("hello"), "human diff renders: {human}");
}

#[test]
fn label_shows_up_in_versions_list() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    run_ok(&["label", "Test note.md", "v1", "Golden"], &f.vault);
    let versions = run_ok(&["--json", "versions", "Test note.md"], &f.vault);
    assert!(
        versions.contains("Golden"),
        "label folded into list: {versions}"
    );
}

#[test]
fn migrate_converts_legacy_tabs_with_archives() {
    let legacy = "````tabs\ntab: Kernel\ncurrent kernel\n\n> [!success]- Review Kernel (V1.0)\n> old kernel\n````\n";
    let f = fixture(legacy);
    let report = run_ok(&["migrate", "Test note.md"], &f.vault);
    assert!(report.contains("1"), "one block converted: {report}");
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(doc.contains("```mica"), "converted to mica: {doc}");
    assert!(!doc.contains("````tabs"), "legacy fence gone");

    // The archived callout became a stored, labeled version ("V1.0" from the
    // callout title), and the migrated head is a second version.
    let versions = run_ok(&["--json", "versions", "Test note.md"], &f.vault);
    let v: serde_json::Value = serde_json::from_str(&versions).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 2, "archive + head: {versions}");
    assert_eq!(v[0]["label"], "V1.0", "archive labeled: {versions}");
    assert_eq!(v[1]["head"], true, "migrated content is head: {versions}");
}

#[test]
fn prepare_stamps_frontmatter_and_block_ids() {
    let f = fixture("---\ntitle: X\n---\n\n```mica\ntab: A\nbody\n```\n");
    run_ok(&["prepare", "Test note.md"], &f.vault);
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(doc.contains("mica-id:"), "frontmatter stamped: {doc}");
    assert!(doc.contains("```mica id="), "block id stamped: {doc}");
    assert!(doc.contains("title: X"), "existing frontmatter preserved");

    // A note with NO frontmatter gets one created.
    let bare = f.vault.join("bare.md");
    fs::write(&bare, "```mica\ntab: A\nx\n```\n").unwrap();
    run_ok(&["prepare", "bare.md"], &f.vault);
    let doc = fs::read_to_string(&bare).unwrap();
    assert!(
        doc.starts_with("---\nmica-id:"),
        "frontmatter created: {doc}"
    );
}

#[test]
fn unknown_block_exits_3() {
    let f = fixture(SIMPLE);
    let out = bin()
        .args(["cat", "Test note.md", "-b", "nope"])
        .current_dir(&f.vault)
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(3), "not-found exit code");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("nope"), "names the missing block: {err}");
}

#[test]
fn doctor_reports_missing_objects() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    // Damage the sidecar: remove the object file the ledger references.
    let objects = f.vault.join("Test note.mica/objects");
    for entry in fs::read_dir(&objects).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    let report = run_ok(&["doctor"], &f.vault);
    assert!(
        report.contains("missing"),
        "reports the missing object: {report}"
    );
}

#[test]
fn repair_rehomes_renamed_note_sidecar() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    // Simulate a rename that left the sidecar behind.
    fs::rename(&f.note, f.vault.join("Renamed.md")).unwrap();
    let report = run_ok(&["repair"], &f.vault);
    assert!(
        f.vault.join("Renamed.mica").is_dir(),
        "sidecar followed the note: {report}"
    );
}

#[test]
fn watch_flag_parses() {
    // Not a daemon test — just prove the arg surface stays stable.
    let out = bin().args(["watch", "--help"]).output().expect("spawn");
    assert!(out.status.success());
    let help = String::from_utf8_lossy(&out.stdout);
    assert!(help.contains("--debounce") && help.contains("--interval"));
}

#[test]
fn mv_moves_a_whole_group_into_a_cell() {
    let src = "```mica id=demo\n:::tabs\n:::tab A\na\n:::\n:::\n:::grid {cols=2}\n:::cell\nc\n:::\n:::\n```\n";
    let f = fixture(src);
    run_ok(
        &[
            "mv",
            "Test note.md",
            "--from",
            "0",
            "--to-parent",
            "1.0",
            "--to-index",
            "1",
        ],
        &f.vault,
    );
    let doc = fs::read_to_string(&f.note).unwrap();
    assert!(
        doc.contains(":::cell\nc\n:::tabs"),
        "group landed inside the cell: {doc}"
    );
}

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

/// Bind only an already-prepared fixture note through its shared identity policy.
fn note_store(vault: &Path, note: &Path) -> mica_cli::sidecar::NoteStore {
    let source = fs::read_to_string(note).expect("fixture note");
    let id = mica_core::note_id_impl(&source)
        .expect("valid fixture identity")
        .expect("prepared fixture identity");
    mica_cli::sidecar::NoteStore::for_id(vault, note, &id).expect("selected fixture store")
}

/// Explicit history setup for doctor fixtures; ordinary fixtures remain unprepared.
fn seed_note_store(vault: &Path, note: &Path, id: &str) -> mica_cli::sidecar::NoteStore {
    let source = fs::read_to_string(note).expect("fixture note");
    let prepared = mica_core::set_note_id_impl(&source, None, id).expect("fixture anchor");
    fs::write(note, prepared).expect("prepared fixture note");
    note_store(vault, note)
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
fn tab_add_with_invalid_title_is_one_transaction() {
    let f = fixture(SIMPLE);
    let before = fs::read(&f.note).expect("read original note");
    let out = bin()
        .args(["tab", "add", "Test note.md", "--title", "bad\ntitle"])
        .current_dir(&f.vault)
        .output()
        .expect("spawn mica");

    assert_eq!(out.status.code(), Some(2), "invalid title is rejected");
    assert_eq!(
        fs::read(&f.note).expect("read note after rejection"),
        before,
        "the inserted default tab must not be committed separately"
    );
}

#[test]
fn tab_add_title_survives_intermediate_path_normalization() {
    let source = "```mica id=demo\n\n:::tabs\n:::tab One\nbody\n:::\n:::\n```\n";
    let f = fixture(source);

    run_ok(
        &[
            "tab",
            "add",
            "Test note.md",
            "--path",
            "1",
            "--title",
            "Two",
        ],
        &f.vault,
    );

    let doc = fs::read_to_string(&f.note).expect("updated note");
    assert!(
        doc.contains(":::tab Two"),
        "requested title is committed: {doc}"
    );
    assert!(
        !doc.contains(":::tab New tab"),
        "default title never leaks: {doc}"
    );
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
fn checkpoint_restore_removal_and_reset_are_identity_safe() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let newc = f.vault.join("new.md");
    fs::write(&newc, "tab: One\nchanged\ntab: Two\nsecond body\n").unwrap();
    run_ok(
        &["set", "Test note.md", "-f", newc.to_str().unwrap()],
        &f.vault,
    );
    let initial: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    let v1_id = initial[0]["versionId"].as_str().unwrap().to_string();
    let v2_id = initial[1]["versionId"].as_str().unwrap().to_string();

    run_ok(&["restore", "Test note.md", "v1"], &f.vault);
    let restored: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    assert_eq!(restored.as_array().unwrap().len(), 3);
    assert_eq!(restored[0]["hash"], restored[2]["hash"]);
    assert_ne!(restored[0]["versionId"], restored[2]["versionId"]);

    run_ok(&["remove-versions", "Test note.md", &v2_id], &f.vault);
    let spliced: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    assert_eq!(spliced.as_array().unwrap().len(), 2);
    assert_eq!(spliced[0]["n"], 1);
    assert_eq!(spliced[1]["n"], 2);

    run_ok(&["restore-versions", "Test note.md", &v2_id], &f.vault);
    let visible: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    assert_eq!(visible.as_array().unwrap().len(), 3);
    assert_eq!(visible[1]["versionId"], v2_id);

    run_ok(&["reset-head", "Test note.md", &v1_id], &f.vault);
    let reset: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    assert_eq!(reset[0]["head"], true);
    assert!(fs::read_to_string(&f.note).unwrap().contains("hello world"));
}

#[test]
fn removed_checkpoint_ids_remain_history_targets_but_visibility_stays_subset_scoped() {
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
    let initial: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    let removed_id = initial[0]["versionId"].as_str().unwrap().to_string();
    let visible_id = initial[1]["versionId"].as_str().unwrap().to_string();
    run_ok(&["remove-versions", "Test note.md", &removed_id], &f.vault);

    let repeated_remove = bin()
        .args(["remove-versions", "Test note.md", &removed_id])
        .current_dir(&f.vault)
        .output()
        .expect("spawn mica");
    assert!(
        !repeated_remove.status.success(),
        "an already removed checkpoint is outside remove-versions' visible subset"
    );
    assert!(
        run_ok(&["show", "Test note.md", &removed_id], &f.vault).contains("hello world"),
        "show resolves an exact removed checkpoint id"
    );
    let patch = run_ok(
        &[
            "diff",
            "Test note.md",
            "--base",
            &removed_id,
            "--to",
            &visible_id,
            "--patch",
        ],
        &f.vault,
    );
    assert!(
        patch.contains("-hello world") && patch.contains("+hello brave world"),
        "diff resolves an exact removed checkpoint id: {patch}"
    );

    run_ok(
        &["label", "Test note.md", &removed_id, "Removed golden"],
        &f.vault,
    );
    run_ok(&["restore", "Test note.md", &removed_id], &f.vault);
    run_ok(&["reset-head", "Test note.md", &removed_id], &f.vault);
    run_ok(&["restore-versions", "Test note.md", &removed_id], &f.vault);

    let final_versions: serde_json::Value =
        serde_json::from_str(&run_ok(&["--json", "versions", "Test note.md"], &f.vault)).unwrap();
    let restored = final_versions
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["versionId"] == removed_id)
        .expect("restored checkpoint");
    assert_eq!(restored["label"], "Removed golden");
    assert_eq!(restored["head"], true);
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
fn prepare_preserves_bom_and_crlf_frontmatter() {
    let source = "\u{feff}---\r\ntitle: X\r\n---\r\n\r\n```mica\r\ntab: A\r\nbody\r\n```\r\n";
    let f = fixture(source);

    run_ok(&["prepare", "Test note.md"], &f.vault);

    let doc = fs::read_to_string(&f.note).expect("prepared note");
    assert!(
        doc.starts_with("\u{feff}---\r\n"),
        "BOM remains first: {doc:?}"
    );
    assert!(
        doc.contains("title: X\r\nmica-id:"),
        "id joins existing YAML"
    );
    assert!(doc.contains("```mica id="), "block id is stamped");
    assert_eq!(doc.matches("---\r\n").count(), 2, "one frontmatter block");
    assert!(
        !doc.replace("\r\n", "").contains('\n'),
        "no lone LF was introduced: {doc:?}"
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
    // Damage the shared pool: remove the object file the ledger references.
    let store = note_store(&f.vault, &f.note);
    let objects = mica_cli::sidecar::objects_dir(&store);
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
fn doctor_reports_corrupt_objects() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let store = note_store(&f.vault, &f.note);
    let objects = mica_cli::sidecar::objects_dir(&store);
    let object = fs::read_dir(&objects)
        .unwrap()
        .next()
        .expect("one object")
        .unwrap()
        .path();
    fs::write(&object, "CORRUPT").unwrap();

    let report = run_ok(&["doctor"], &f.vault);
    assert!(
        report.contains("corrupt"),
        "reports the corrupt object instead of trusting its filename: {report}"
    );
}

#[test]
fn doctor_reports_missing_raw_objects_and_pending_normalization() {
    let f = fixture("plain note\n");
    let store = seed_note_store(&f.vault, &f.note, "fixture-note");
    let raw = "alpha\n\nbeta\n";
    let replacement = ":::section\nalpha\n\nbeta\n:::\n";
    let raw_hash = mica_core::hash_content_impl(raw);
    let replacement_hash = mica_core::hash_content_impl(replacement);
    mica_cli::sidecar::write_object(&store, &replacement_hash, replacement)
        .expect("replacement object");
    let add = mica_core::Event::AddVersion {
        eid: "add-raw".to_string(),
        ts: 1,
        block: "demo".to_string(),
        hash: raw_hash.clone(),
        label: None,
        origin: None,
        parent: None,
    };
    let replace = mica_core::Event::ReplaceVersion {
        eid: "replace-raw".to_string(),
        ts: 2,
        block: "demo".to_string(),
        target: "add-raw".to_string(),
        hash: replacement_hash,
    };
    mica_cli::sidecar::append_events(&store, &[add, replace.clone()]).expect("seed ledger");
    let note_body = fs::read_to_string(&f.note).expect("note body");
    let note_hash = mica_core::hash_content_impl(&note_body);
    mica_cli::sidecar::write_object(&store, &note_hash, &note_body).expect("whole note object");
    mica_cli::sidecar::write_section_normalization_journal(
        &store,
        &mica_cli::sidecar::SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Test note.md".to_string(),
            original: note_hash.clone(),
            normalized: note_hash,
            history: true,
            events: vec![replace],
        },
    )
    .expect("pending journal");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    let kinds: Vec<_> = parsed["findings"]
        .as_array()
        .expect("findings")
        .iter()
        .filter_map(|finding| finding["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"missing-raw-object"), "{report}");
    assert!(kinds.contains(&"pending-normalization"), "{report}");
}

#[test]
fn doctor_reports_missing_and_corrupt_pending_tab_consolidation_objects() {
    let original = "```mica id=demo\nalpha\n```\n";
    let consolidated = "```mica id=demo\n:::tabs\n:::tab Alpha\nalpha\n:::\n:::\n```\n";
    let original =
        mica_core::set_note_id_impl(original, None, "fixture-note").expect("original anchor");
    let consolidated = mica_core::set_note_id_impl(consolidated, None, "fixture-note")
        .expect("consolidated anchor");
    let f = fixture(&original);
    let store = note_store(&f.vault, &f.note);
    let original_hash = mica_core::hash_content_impl(&original);
    let consolidated_hash = mica_core::hash_content_impl(&consolidated);
    mica_cli::sidecar::write_object(&store, &consolidated_hash, &consolidated)
        .expect("consolidated object");
    fs::write(
        mica_cli::sidecar::object_path(&store, &consolidated_hash).expect("consolidated path"),
        "CORRUPT",
    )
    .expect("corrupt consolidated object");
    mica_cli::sidecar::write_tab_consolidation_journal(
        &store,
        &mica_cli::sidecar::TabConsolidationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Test note.md".to_string(),
            original: original_hash.clone(),
            consolidated: consolidated_hash.clone(),
            history: false,
            target_block: "demo".to_string(),
            tabs: Vec::new(),
            versions: Vec::new(),
            events: Vec::new(),
            manifest_original: None,
            manifest_consolidated: "{}\n".to_string(),
        },
    )
    .expect("pending tab-consolidation journal");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    let findings = parsed["findings"].as_array().expect("findings");
    assert!(
        findings.iter().any(|finding| {
            finding["kind"] == "missing-tab-consolidation-object"
                && finding["role"] == "original"
                && finding["hash"] == original_hash
        }),
        "{report}"
    );
    assert!(
        findings.iter().any(|finding| {
            finding["kind"] == "corrupt-tab-consolidation-object"
                && finding["role"] == "consolidated"
                && finding["hash"] == consolidated_hash
        }),
        "{report}"
    );
}

#[test]
fn doctor_reports_replacement_signature_mismatch() {
    let f = fixture("plain note\n");
    let store = seed_note_store(&f.vault, &f.note, "fixture-note");
    let raw = "alpha\n";
    let replacement = ":::section\nDIFFERENT\n:::\n";
    let raw_hash = mica_core::hash_content_impl(raw);
    let replacement_hash = mica_core::hash_content_impl(replacement);
    mica_cli::sidecar::write_object(&store, &raw_hash, raw).expect("raw object");
    mica_cli::sidecar::write_object(&store, &replacement_hash, replacement)
        .expect("replacement object");
    mica_cli::sidecar::append_events(
        &store,
        &[
            mica_core::Event::AddVersion {
                eid: "add-source".to_string(),
                ts: 1,
                block: "demo".to_string(),
                hash: raw_hash,
                label: None,
                origin: None,
                parent: None,
            },
            mica_core::Event::ReplaceVersion {
                eid: "replace-source".to_string(),
                ts: 2,
                block: "demo".to_string(),
                target: "add-source".to_string(),
                hash: replacement_hash,
            },
        ],
    )
    .expect("seed ledger");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    assert!(
        parsed["findings"]
            .as_array()
            .expect("findings")
            .iter()
            .any(|finding| finding["kind"] == "replacement-signature-mismatch"),
        "{report}"
    );
}

#[test]
fn doctor_reports_corrupt_typed_ledger_and_continues_the_sweep() {
    let f = fixture("plain note\n");
    let store = seed_note_store(&f.vault, &f.note, "fixture-note");
    mica_cli::sidecar::write_manifest(&store, Some(&store.note_id), "Test note.md", &[], 0)
        .expect("first central record");
    fs::write(
        mica_cli::sidecar::ledger_path(&store),
        r#"{"type":"future-event","eid":"future"}
"#,
    )
    .expect("corrupt typed ledger");
    let other = f.vault.join("Other.md");
    fs::write(&other, "other\n").expect("second note");
    let other_store = seed_note_store(&f.vault, &other, "fixture-other-note");
    mica_cli::sidecar::write_manifest(&other_store, Some(&other_store.note_id), "Other.md", &[], 0)
        .expect("second central record");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    assert!(
        parsed["findings"]
            .as_array()
            .expect("findings")
            .iter()
            .any(|finding| finding["kind"] == "corrupt-ledger"),
        "{report}"
    );
}

#[test]
fn doctor_reports_pending_normalization_note_divergence() {
    let original = "```mica id=demo\nalpha\n```\n";
    let normalized = "```mica id=demo\n:::section\nalpha\n:::\n```\n";
    let original =
        mica_core::set_note_id_impl(original, None, "fixture-note").expect("original anchor");
    let normalized =
        mica_core::set_note_id_impl(normalized, None, "fixture-note").expect("normalized anchor");
    let later = mica_core::set_note_id_impl("later unrelated edit\n", None, "fixture-note")
        .expect("later anchor");
    let f = fixture(&later);
    let store = note_store(&f.vault, &f.note);
    let original_hash = mica_core::hash_content_impl(&original);
    let normalized_hash = mica_core::hash_content_impl(&normalized);
    mica_cli::sidecar::write_object(&store, &original_hash, &original).expect("original object");
    mica_cli::sidecar::write_object(&store, &normalized_hash, &normalized)
        .expect("normalized object");
    mica_cli::sidecar::write_section_normalization_journal(
        &store,
        &mica_cli::sidecar::SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Test note.md".to_string(),
            original: original_hash,
            normalized: normalized_hash,
            history: false,
            events: Vec::new(),
        },
    )
    .expect("pending journal");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    assert!(
        parsed["findings"]
            .as_array()
            .expect("findings")
            .iter()
            .any(|finding| finding["kind"] == "pending-note-diverged"),
        "{report}"
    );
}

#[test]
fn doctor_allows_later_live_edits_after_completed_normalization() {
    let original = "```mica id=demo\nalpha\n```\n";
    let normalized = "```mica id=demo\n:::section\nalpha\n:::\n```\n";
    let original =
        mica_core::set_note_id_impl(original, None, "fixture-note").expect("original anchor");
    let normalized =
        mica_core::set_note_id_impl(normalized, None, "fixture-note").expect("normalized anchor");
    let f = fixture(&normalized);
    let store = mica_cli::sidecar::NoteStore::for_id(&f.vault, &f.note, "fixture-note")
        .expect("fixture store");
    let original_hash = mica_core::hash_content_impl(&original);
    let normalized_hash = mica_core::hash_content_impl(&normalized);
    mica_cli::sidecar::write_object(&store, &original_hash, &original).expect("original object");
    mica_cli::sidecar::write_object(&store, &normalized_hash, &normalized)
        .expect("normalized object");
    let mut journal = mica_cli::sidecar::SectionNormalizationJournal {
        format: 1,
        status: "pending".to_string(),
        note: "Test note.md".to_string(),
        original: original_hash,
        normalized: normalized_hash,
        history: false,
        events: Vec::new(),
    };
    mica_cli::sidecar::write_section_normalization_journal(&store, &journal)
        .expect("pending journal");
    journal.status = "complete".to_string();
    mica_cli::sidecar::write_section_normalization_journal(&store, &journal)
        .expect("complete journal");
    let later = mica_core::set_note_id_impl("later unrelated edit\n", None, "fixture-note")
        .expect("later anchor");
    fs::write(&f.note, later).expect("later live edit");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    let semantic_conflicts: Vec<_> = parsed["findings"]
        .as_array()
        .expect("findings")
        .iter()
        .filter(|finding| {
            matches!(
                finding["kind"].as_str(),
                Some("pending-note-diverged" | "journal-postimage-invalid")
            )
        })
        .collect();
    assert!(semantic_conflicts.is_empty(), "{report}");
}

#[test]
fn doctor_reports_forged_completed_normalization_postimage() {
    let original = "```mica id=demo\nalpha\n```\n";
    let forged = "```mica id=demo\n:::section\nforged\n:::\n```\n";
    let original =
        mica_core::set_note_id_impl(original, None, "fixture-note").expect("original anchor");
    let forged = mica_core::set_note_id_impl(forged, None, "fixture-note").expect("forged anchor");
    let f = fixture(&forged);
    let store = mica_cli::sidecar::NoteStore::for_id(&f.vault, &f.note, "fixture-note")
        .expect("fixture store");
    let original_hash = mica_core::hash_content_impl(&original);
    let forged_hash = mica_core::hash_content_impl(&forged);
    mica_cli::sidecar::write_object(&store, &original_hash, &original).expect("original object");
    mica_cli::sidecar::write_object(&store, &forged_hash, &forged).expect("forged object");
    let mut journal = mica_cli::sidecar::SectionNormalizationJournal {
        format: 1,
        status: "pending".to_string(),
        note: "Test note.md".to_string(),
        original: original_hash,
        normalized: forged_hash,
        history: false,
        events: Vec::new(),
    };
    mica_cli::sidecar::write_section_normalization_journal(&store, &journal)
        .expect("pending journal");
    // Deliberately corrupt persisted input: the guarded completion API rejects
    // this forged postimage, while doctor must still diagnose external damage.
    journal.status = "complete".to_string();
    let encoded = serde_json::to_string_pretty(&journal).expect("fixture journal");
    fs::write(
        mica_cli::sidecar::section_normalization_journal_path(&store),
        format!("{encoded}\n"),
    )
    .expect("forged completed fixture");

    let report = run_ok(&["--json", "doctor"], &f.vault);
    let parsed: serde_json::Value = serde_json::from_str(&report).expect("doctor JSON");
    assert!(
        parsed["findings"]
            .as_array()
            .expect("findings")
            .iter()
            .any(|finding| finding["kind"] == "journal-postimage-invalid"),
        "{report}"
    );
}

#[test]
fn corrupt_object_cannot_be_restored() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let store = note_store(&f.vault, &f.note);
    let objects = mica_cli::sidecar::objects_dir(&store);
    let object = fs::read_dir(&objects)
        .unwrap()
        .next()
        .expect("one object")
        .unwrap()
        .path();
    fs::write(&object, "CORRUPT").unwrap();
    let before = fs::read(&f.note).expect("live note");

    let out = bin()
        .args(["restore", "Test note.md", "v1"])
        .current_dir(&f.vault)
        .output()
        .expect("spawn");

    assert_eq!(out.status.code(), Some(4), "corruption exit code");
    assert_eq!(fs::read(&f.note).expect("live note"), before);
}

#[test]
fn repair_updates_renamed_note_hint_without_moving_history() {
    let f = fixture(SIMPLE);
    run_ok(&["snapshot", "Test note.md"], &f.vault);
    let store = note_store(&f.vault, &f.note);
    let record = mica_cli::sidecar::sidecar_dir(&store);
    let manifest = record.join("manifest.json");
    let before_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).expect("original manifest"))
            .expect("manifest JSON");
    let ledger = mica_cli::sidecar::ledger_path(&store);
    let before_ledger = fs::read(&ledger).expect("original ledger");
    let renamed = f.vault.join("Renamed.md");
    fs::rename(&f.note, &renamed).expect("rename note");

    let report = run_ok(&["repair"], &f.vault);
    let current = note_store(&f.vault, &renamed);
    assert_eq!(
        mica_cli::sidecar::sidecar_dir(&current),
        record,
        "history remains identity-addressed: {report}"
    );
    assert_eq!(fs::read(&ledger).expect("retained ledger"), before_ledger);
    let mut expected_manifest = before_manifest;
    expected_manifest["path"] = serde_json::Value::String("Renamed.md".to_string());
    let after_manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).expect("updated manifest"))
            .expect("manifest JSON");
    assert_eq!(
        after_manifest, expected_manifest,
        "only the path hint changes: {report}"
    );
}

#[test]
fn repair_preserves_history_for_an_ambiguous_duplicate_id() {
    let f = fixture(SIMPLE);
    let first = f.vault.join("A.md");
    fs::rename(&f.note, &first).expect("rename note");
    run_ok(&["snapshot", "A.md"], &f.vault);
    let store = note_store(&f.vault, &first);
    let record = mica_cli::sidecar::sidecar_dir(&store);
    let manifest = record.join("manifest.json");
    let before_manifest = fs::read(&manifest).expect("original manifest");
    let ledger = mica_cli::sidecar::ledger_path(&store);
    let before_ledger = fs::read(&ledger).expect("original ledger");
    fs::copy(&first, f.vault.join("B.md")).expect("copy note");

    let out = bin()
        .args(["repair"])
        .current_dir(&f.vault)
        .output()
        .expect("spawn repair");
    assert_eq!(
        out.status.code(),
        Some(2),
        "duplicate identity is an argument conflict"
    );
    let error = String::from_utf8_lossy(&out.stderr);
    assert!(
        error.contains("duplicate mica note id"),
        "names the identity conflict: {error}"
    );
    assert!(
        record.is_dir(),
        "history stays at its identity-addressed source"
    );
    assert_eq!(
        fs::read(&manifest).expect("retained manifest"),
        before_manifest
    );
    assert_eq!(fs::read(&ledger).expect("retained ledger"), before_ledger);
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
fn watch_rejects_zero_poll_interval() {
    let f = fixture(SIMPLE);
    let out = bin()
        .args(["watch", "--interval", "0"])
        .current_dir(&f.vault)
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("at least one second"));
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

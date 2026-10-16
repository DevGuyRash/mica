//! One-section normalization planning and recoverable publication.
//!
//! Planning validates every note and immutable object before the first write;
//! publication is journaled so an interrupted note/ledger transaction resumes
//! from exact content-addressed generations.

use crate::commands::Ctx;
use crate::error::{CliError, Result};
use crate::{engine, fsutil, sidecar, vault};
use crate::sidecar::NoteStore;
use mica_core::ops::{normalize_section_impl, SectionNormalization};
use mica_core::{
    content_signature_impl, hash_content_impl, new_id_impl, resolve_ledger_impl, scan_impl, Event,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

struct NotePlan {
    note: vault::NoteRef,
    store: NoteStore,
    source_preimage: String,
    original: String,
    normalized: String,
    ledger_preimage: Option<Vec<Event>>,
    objects: BTreeMap<String, String>,
    journal: sidecar::SectionNormalizationJournal,
    report_index: usize,
}

struct RecoveryPlan {
    note: vault::NoteRef,
    store: NoteStore,
    original: String,
    normalized: String,
    journal: sidecar::SectionNormalizationJournal,
    report_index: usize,
}

/// One validation conflict discovered while planning normalization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationConflict {
    /// Vault-relative note path.
    pub path: String,
    /// Block id, when the conflict belongs to one block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// Replacement target event id, when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Stable machine-readable conflict kind.
    pub kind: String,
    /// Human-readable explanation and recovery direction.
    pub detail: String,
}

/// Per-note normalization counts and status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteNormalizationReport {
    /// Vault-relative note path.
    pub path: String,
    /// Stable planning, publication, recovery, or unchanged status.
    pub status: String,
    /// Closed live Mica blocks in the note.
    pub blocks: usize,
    /// Live block bodies inspected.
    pub live_bodies: usize,
    /// Original AddVersion events retained in the ledger.
    pub add_events: usize,
    /// Folded visible content versions before normalization.
    pub unique_versions: usize,
    /// Live bodies that need a wrapper.
    pub planned_live_updates: usize,
    /// Append-only ReplaceVersion events planned.
    pub planned_replacements: usize,
    /// Live bodies already represented by one logical section.
    pub already_normalized_live_bodies: usize,
    /// Historical AddVersion bodies already represented by one logical section.
    pub already_normalized_history_bodies: usize,
    /// Validation conflicts for this note.
    pub conflicts: Vec<NormalizationConflict>,
}

/// Aggregate JSON report for one normalization invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeReport {
    /// Input path exactly as supplied by the caller.
    pub path: String,
    /// Whether stored history was selected.
    pub history: bool,
    /// Whether this invocation was read-only.
    pub dry_run: bool,
    /// Markdown notes scanned beneath the selected scope.
    pub scanned_notes: usize,
    /// Notes containing live Mica blocks or selected history.
    pub selected_notes: usize,
    /// Closed live Mica blocks inspected.
    pub blocks: usize,
    /// Live bodies inspected.
    pub live_bodies: usize,
    /// Original AddVersion events retained.
    pub add_events: usize,
    /// Folded visible versions before normalization.
    pub unique_versions: usize,
    /// Live bodies that need publication.
    pub planned_live_updates: usize,
    /// Replacement events that need appending.
    pub planned_replacements: usize,
    /// Live and historical bodies already normalized.
    pub already_normalized_bodies: usize,
    /// Distinct immutable objects that need writing.
    pub objects_to_write: usize,
    /// All validation conflicts in stable note order.
    pub conflicts: Vec<NormalizationConflict>,
    /// Per-note details in stable vault-path order.
    pub notes: Vec<NoteNormalizationReport>,
}

/// Plan or execute one-section normalization for a note or directory.
///
/// # Arguments
/// * `ctx` - resolved CLI context, including vault and output mode
/// * `path` - note or directory path
/// * `history` - include stored AddVersion bodies
/// * `dry_run` - validate and report without persistent writes
///
/// # Returns
/// A complete machine-readable report.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # use mica_cli::commands::Ctx;
/// # let ctx: Ctx = todo!();
/// let report = mica_cli::normalize::normalize_sections(&ctx, "Prompts", true, true)?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn normalize_sections(
    ctx: &Ctx,
    path: &str,
    history: bool,
    dry_run: bool,
) -> Result<NormalizeReport> {
    let scope = vault::resolve_note_scope(path, ctx.vault.as_deref())?;
    let mut report = NormalizeReport {
        path: path.to_string(),
        history,
        dry_run,
        scanned_notes: scope.notes.len(),
        selected_notes: 0,
        blocks: 0,
        live_bodies: 0,
        add_events: 0,
        unique_versions: 0,
        planned_live_updates: 0,
        planned_replacements: 0,
        already_normalized_bodies: 0,
        objects_to_write: 0,
        conflicts: Vec::new(),
        notes: Vec::new(),
    };
    let mut plans = Vec::new();
    let mut recoveries = Vec::new();

    for note in &scope.notes {
        let source_preimage = engine::read_doc(&note.abs)?;
        let (doc, store) = engine::plan_history_store(note, &source_preimage, dry_run)?;
        // Per note: partition the scanner output in one O(blocks) pass without
        // cloning spans; the two result vectors together remain O(blocks).
        let (spans, unclosed_spans): (Vec<_>, Vec<_>) =
            scan_impl(&doc).into_iter().partition(|span| span.closed);
        let (pending_journal, journal_error) =
            match sidecar::read_section_normalization_journal(&store) {
                Ok(journal) => (journal.filter(|journal| journal.status == "pending"), None),
                Err(error) => (None, Some(error)),
            };
        if spans.is_empty()
            && unclosed_spans.is_empty()
            && !history
            && pending_journal.is_none()
            && journal_error.is_none()
        {
            continue;
        }
        let mut replacements = Vec::new();
        let mut objects = BTreeMap::new();
        let mut note_report = NoteNormalizationReport {
            path: note.vault_rel(),
            status: "unchanged".to_string(),
            blocks: spans.len(),
            live_bodies: spans.len(),
            add_events: 0,
            unique_versions: 0,
            planned_live_updates: 0,
            planned_replacements: 0,
            already_normalized_live_bodies: 0,
            already_normalized_history_bodies: 0,
            conflicts: Vec::new(),
        };

        if let Some(error) = journal_error {
            note_report.status = "recovery-blocked".to_string();
            note_report.conflicts.push(NormalizationConflict {
                path: note_report.path.clone(),
                block: None,
                target: None,
                kind: "corrupt-normalization-journal".to_string(),
                detail: error.to_string(),
            });
            report.selected_notes += 1;
            report.blocks += note_report.blocks;
            report.live_bodies += note_report.live_bodies;
            report
                .conflicts
                .extend(note_report.conflicts.iter().cloned());
            report.notes.push(note_report);
            continue;
        }

        for span in &unclosed_spans {
            note_report.conflicts.push(NormalizationConflict {
                path: note_report.path.clone(),
                block: span.id().map(str::to_string),
                target: None,
                kind: "unclosed-live-block".to_string(),
                detail: "a Mica block reaches end-of-file without a closing fence; close it before normalization"
                    .to_string(),
            });
        }
        let mut live_ids = BTreeSet::new();
        let mut duplicate_ids = BTreeSet::new();
        for id in spans.iter().filter_map(|span| span.id()) {
            if !live_ids.insert(id) {
                duplicate_ids.insert(id);
            }
        }
        for id in duplicate_ids {
            note_report.conflicts.push(NormalizationConflict {
                path: note_report.path.clone(),
                block: Some(id.to_string()),
                target: None,
                kind: "duplicate-live-block-id".to_string(),
                detail: format!(
                    "block id {id:?} occurs more than once in the live note; repair identity before normalization"
                ),
            });
        }

        if let Some(journal) = pending_journal {
            let recovery = match preflight_recovery(note, &store, &doc, journal, &mut note_report) {
                Ok(recovery) => recovery,
                Err(error) => {
                    note_report.conflicts.push(NormalizationConflict {
                        path: note_report.path.clone(),
                        block: None,
                        target: None,
                        kind: "pending-journal-validation-error".to_string(),
                        detail: error.to_string(),
                    });
                    None
                }
            };
            note_report.status = if recovery.is_some() {
                if dry_run {
                    "would-resume".to_string()
                } else {
                    "resumption-pending".to_string()
                }
            } else {
                "recovery-blocked".to_string()
            };
            report.selected_notes += 1;
            report.blocks += note_report.blocks;
            report.live_bodies += note_report.live_bodies;
            report
                .conflicts
                .extend(note_report.conflicts.iter().cloned());
            let report_index = report.notes.len();
            report.notes.push(note_report);
            if let Some((original, normalized, journal)) = recovery {
                recoveries.push(RecoveryPlan {
                    note: note.clone(),
                    store: store.clone(),
                    original,
                    normalized,
                    journal,
                    report_index,
                });
            }
            continue;
        }

        let mut planned_events = Vec::new();
        let mut ledger_preimage = None;
        if history {
            match sidecar::read_ledger_report(&store) {
                Ok(ledger_read) => {
                    match plan_history(
                        &store,
                        &ledger_read.events,
                        ledger_read.bad_lines,
                        &mut objects,
                        &mut note_report,
                    ) {
                        Ok(events) => planned_events = events,
                        Err(error) => note_report.conflicts.push(NormalizationConflict {
                            path: note_report.path.clone(),
                            block: None,
                            target: None,
                            kind: "history-ledger-validation-error".to_string(),
                            detail: error.to_string(),
                        }),
                    }
                    ledger_preimage = Some(ledger_read.events);
                }
                Err(error) => note_report.conflicts.push(NormalizationConflict {
                    path: note_report.path.clone(),
                    block: None,
                    target: None,
                    kind: "corrupt-history-ledger".to_string(),
                    detail: error.to_string(),
                }),
            }
        }
        if spans.is_empty() && note_report.add_events == 0 && note_report.conflicts.is_empty() {
            continue;
        }

        // O(n) in live Mica source bytes; each closed body is normalized once.
        for span in &spans {
            let body = &doc[span.content_start..span.content_end];
            match normalize_section_impl(body) {
                Ok(SectionNormalization::AlreadyNormalized) => {
                    note_report.already_normalized_live_bodies += 1;
                }
                Ok(SectionNormalization::Wrapped(wrapped)) => {
                    if content_signature_impl(body) != content_signature_impl(&wrapped) {
                        note_report.conflicts.push(NormalizationConflict {
                            path: note_report.path.clone(),
                            block: span.id().map(str::to_string),
                            target: None,
                            kind: "signature-mismatch".to_string(),
                            detail: "live wrapping changed the content signature; the note was preserved and needs manual inspection".to_string(),
                        });
                        continue;
                    }
                    objects.insert(hash_content_impl(&wrapped), wrapped.clone());
                    replacements.push((span.content_start, span.content_end, wrapped));
                    note_report.planned_live_updates += 1;
                }
                Err(error) => note_report.conflicts.push(NormalizationConflict {
                    path: note_report.path.clone(),
                    block: span.id().map(str::to_string),
                    target: None,
                    kind: "live-body-invalid".to_string(),
                    detail: error.to_string(),
                }),
            }
        }

        let mut normalized = doc.clone();
        for (start, end, wrapped) in replacements.into_iter().rev() {
            normalized.replace_range(start..end, &wrapped);
        }
        if normalized != doc {
            objects.insert(hash_content_impl(&doc), doc.clone());
            objects.insert(hash_content_impl(&normalized), normalized.clone());
            note_report.status = if dry_run {
                "would-normalize".to_string()
            } else {
                "normalization-pending".to_string()
            };
        }
        note_report.planned_replacements = planned_events.len();
        if normalized == doc && !planned_events.is_empty() {
            objects.insert(hash_content_impl(&doc), doc.clone());
            note_report.status = if dry_run {
                "would-normalize".to_string()
            } else {
                "normalization-pending".to_string()
            };
        }
        let has_work = normalized != doc || !planned_events.is_empty();
        let journal = has_work.then(|| sidecar::SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: note.vault_rel(),
            original: hash_content_impl(&doc),
            normalized: hash_content_impl(&normalized),
            history,
            events: planned_events.clone(),
        });
        if let Some(journal) = &journal {
            report.objects_to_write += preflight_transaction_storage(
                &store,
                &objects,
                journal,
                &note_report.path,
                &mut note_report.conflicts,
            );
        }
        report.selected_notes += 1;
        report.blocks += note_report.blocks;
        report.live_bodies += note_report.live_bodies;
        report.add_events += note_report.add_events;
        report.unique_versions += note_report.unique_versions;
        report.planned_live_updates += note_report.planned_live_updates;
        report.planned_replacements += note_report.planned_replacements;
        report.already_normalized_bodies += note_report.already_normalized_live_bodies
            + note_report.already_normalized_history_bodies;
        report
            .conflicts
            .extend(note_report.conflicts.iter().cloned());
        let report_index = report.notes.len();
        report.notes.push(note_report);
        if let Some(journal) = journal.filter(|_| report.notes[report_index].conflicts.is_empty()) {
            plans.push(NotePlan {
                note: note.clone(),
                store,
                source_preimage,
                original: doc,
                normalized,
                ledger_preimage,
                objects,
                journal,
                report_index,
            });
        }
    }
    if !dry_run && report.conflicts.is_empty() {
        for recovery in &recoveries {
            publish_recovery(recovery)?;
            report.notes[recovery.report_index].status = "resumed".to_string();
        }
        for plan in &plans {
            publish_plan(plan)?;
            report.notes[plan.report_index].status = "normalized".to_string();
        }
    }
    Ok(report)
}

fn preflight_recovery(
    _note: &vault::NoteRef,
    store: &NoteStore,
    current: &str,
    journal: sidecar::SectionNormalizationJournal,
    report: &mut NoteNormalizationReport,
) -> Result<Option<(String, String, sidecar::SectionNormalizationJournal)>> {
    let inspection = inspect_normalization_journal(store, Some(current), &journal)?;
    report.conflicts.extend(inspection.conflicts);
    match (inspection.original, inspection.normalized) {
        (Some(original), Some(normalized)) if report.conflicts.is_empty() => {
            Ok(Some((original, normalized, journal)))
        }
        _ => Ok(None),
    }
}

pub(crate) struct NormalizationJournalInspection {
    pub(crate) conflicts: Vec<NormalizationConflict>,
    pub(crate) original: Option<String>,
    pub(crate) normalized: Option<String>,
}

pub(crate) fn inspect_normalization_journal(
    store: &NoteStore,
    current: Option<&str>,
    journal: &sidecar::SectionNormalizationJournal,
) -> Result<NormalizationJournalInspection> {
    inspect_normalization_journal_with_ledger(store, current, journal, None)
}

pub(crate) fn inspect_normalization_journal_with_ledger(
    store: &NoteStore,
    current: Option<&str>,
    journal: &sidecar::SectionNormalizationJournal,
    ledger_read: Option<&sidecar::LedgerRead>,
) -> Result<NormalizationJournalInspection> {
    let note = vault::NoteRef { abs: store.note.clone(), vault: store.root.vault.clone() };
    let report_path = note.vault_rel();
    let mut conflicts = Vec::new();
    if !journal.history && !journal.events.is_empty() {
        conflicts.push(NormalizationConflict {
            path: report_path.clone(),
            block: None,
            target: None,
            kind: "journal-history-mismatch".to_string(),
            detail: "normalization journal contains replacements but does not declare history"
                .to_string(),
        });
    }
    let original = read_recovery_object(
        store,
        &journal.original,
        "original",
        &report_path,
        &mut conflicts,
    );
    let normalized = read_recovery_object(
        store,
        &journal.normalized,
        "normalized",
        &report_path,
        &mut conflicts,
    );
    if let (Some(original), Some(normalized)) = (&original, &normalized) {
        if let Err(detail) = validate_exact_postimage(original, normalized) {
            conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: if journal.status == "pending" {
                    "pending-postimage-invalid"
                } else {
                    "journal-postimage-invalid"
                }
                .to_string(),
                detail,
            });
        }
        if journal.status == "pending"
            && current.is_some_and(|current| current != original && current != normalized)
        {
            conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: "pending-note-diverged".to_string(),
                detail: "the live note matches neither pending transaction object; preserve the journal and reconcile the note manually".to_string(),
            });
        }
        if journal.status == "pending" && current.is_none() {
            conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: "pending-note-unavailable".to_string(),
                detail: "the pending normalization journal cannot be compared with its live note"
                    .to_string(),
            });
        }
    }

    if !journal.events.is_empty() {
        let owned_ledger;
        let ledger_read = if let Some(ledger_read) = ledger_read {
            ledger_read
        } else {
            owned_ledger = sidecar::read_ledger_report(store)?;
            &owned_ledger
        };
        if ledger_read.bad_lines > 0 {
            conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: "bad-ledger-lines".to_string(),
                detail: format!(
                    "the history ledger has {} invalid line(s); repair them before resuming",
                    ledger_read.bad_lines
                ),
            });
        }
        let missing = match sidecar::classify_event_batch_in(&ledger_read.events, &journal.events) {
            Ok(status) => status.missing,
            Err(error) => {
                conflicts.push(NormalizationConflict {
                    path: report_path.clone(),
                    block: None,
                    target: None,
                    kind: "pending-event-conflict".to_string(),
                    detail: error.to_string(),
                });
                Vec::new()
            }
        };
        if journal.status == "complete" && !missing.is_empty() {
            conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: "missing-normalization-events".to_string(),
                detail: format!(
                    "completed normalization journal is missing {} ledger event(s)",
                    missing.len()
                ),
            });
        }
        if let Err(error) = sidecar::preflight_event_append(store, &missing) {
            conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: "pending-events-unpublishable".to_string(),
                detail: error.to_string(),
            });
        }
        let ledger = &ledger_read.events;
        let mut prospective = ledger.clone();
        prospective.extend(missing);
        match resolve_ledger_impl(&prospective) {
            Ok(resolution) => {
                if journal.status == "pending" {
                    validate_recovery_replacements(
                        store,
                        journal,
                        ledger,
                        &resolution.replacements,
                        &report_path,
                        &mut conflicts,
                    );
                } else {
                    validate_completed_replacements(
                        store,
                        journal,
                        ledger,
                        &resolution.replacements,
                        &report_path,
                        &mut conflicts,
                    );
                }
            }
            Err(error) => conflicts.push(NormalizationConflict {
                path: report_path.clone(),
                block: None,
                target: None,
                kind: "invalid-pending-ledger".to_string(),
                detail: error.to_string(),
            }),
        }
    }
    Ok(NormalizationJournalInspection {
        conflicts,
        original,
        normalized,
    })
}

pub(crate) fn validate_exact_postimage(
    original: &str,
    normalized: &str,
) -> std::result::Result<(), String> {
    let spans = scan_impl(original);
    if spans.iter().any(|span| !span.closed) {
        return Err(
            "the journal pre-image contains an unclosed Mica block and cannot produce a trusted normalized post-image"
                .to_string(),
        );
    }
    let mut ids = BTreeSet::new();
    if spans
        .iter()
        .filter_map(|span| span.id())
        .any(|id| !ids.insert(id))
    {
        return Err(
            "the journal pre-image contains duplicate live Mica block ids and cannot produce a trusted normalized post-image"
                .to_string(),
        );
    }
    let mut replacements = Vec::new();
    for span in spans {
        let body = &original[span.content_start..span.content_end];
        match normalize_section_impl(body) {
            Ok(SectionNormalization::AlreadyNormalized) => {}
            Ok(SectionNormalization::Wrapped(wrapped)) => {
                if content_signature_impl(body) != content_signature_impl(&wrapped) {
                    return Err(
                        "the core normalizer changed a live body content signature while validating the journal"
                            .to_string(),
                    );
                }
                replacements.push((span.content_start, span.content_end, wrapped));
            }
            Err(error) => {
                return Err(format!(
                    "the journal pre-image cannot be normalized exactly: {error}"
                ));
            }
        }
    }
    let mut derived = original.to_string();
    for (start, end, wrapped) in replacements.into_iter().rev() {
        derived.replace_range(start..end, &wrapped);
    }
    if derived == normalized {
        Ok(())
    } else {
        Err(
            "the journal post-image is not the exact result of core logical-section normalization"
                .to_string(),
        )
    }
}

fn read_recovery_object(
    note: &NoteStore,
    hash: &str,
    role: &str,
    report_path: &str,
    conflicts: &mut Vec<NormalizationConflict>,
) -> Option<String> {
    match sidecar::read_object(note, hash) {
        Ok(Some(content)) => Some(content),
        Ok(None) => {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: None,
                target: None,
                kind: "missing-recovery-object".to_string(),
                detail: format!("pending {role} object {hash} is missing"),
            });
            None
        }
        Err(error) => {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: None,
                target: None,
                kind: "corrupt-recovery-object".to_string(),
                detail: format!("pending {role} object {hash} is corrupt: {error}"),
            });
            None
        }
    }
}

fn validate_completed_replacements(
    note: &NoteStore,
    journal: &sidecar::SectionNormalizationJournal,
    ledger: &[Event],
    resolved: &[mica_core::ResolvedReplacement],
    report_path: &str,
    conflicts: &mut Vec<NormalizationConflict>,
) {
    let by_event: BTreeMap<&str, &mica_core::ResolvedReplacement> = resolved
        .iter()
        .map(|replacement| (replacement.event.as_str(), replacement))
        .collect();
    let add_by_eid: BTreeMap<&str, (&str, &str)> = ledger
        .iter()
        .filter_map(|event| {
            if let Event::AddVersion {
                eid, block, hash, ..
            } = event
            {
                Some((eid.as_str(), (block.as_str(), hash.as_str())))
            } else {
                None
            }
        })
        .collect();
    let mut cache = BTreeMap::new();
    for intended in &journal.events {
        let Event::ReplaceVersion {
            eid,
            block,
            target,
            hash,
            ..
        } = intended
        else {
            continue;
        };
        let Some(replacement) = by_event.get(eid.as_str()) else {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: Some(block.clone()),
                target: Some(target.clone()),
                kind: "normalization-replacement-unresolved".to_string(),
                detail: format!("completed normalization event {eid} is not resolvable"),
            });
            continue;
        };
        if replacement.replacement != *hash {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: Some(block.clone()),
                target: Some(target.clone()),
                kind: "normalization-replacement-mismatch".to_string(),
                detail: format!("completed normalization event {eid} resolves to another object"),
            });
            continue;
        }
        let Some((target_block, original_hash)) = add_by_eid.get(target.as_str()) else {
            continue;
        };
        if *target_block != block {
            continue;
        }
        let predecessor = ledger
            .iter()
            .filter(|event| event_order_key(event) < event_order_key(intended))
            .filter_map(|event| {
                if let Event::ReplaceVersion {
                    target: candidate_target,
                    hash,
                    ..
                } = event
                {
                    (candidate_target == target).then_some((event_order_key(event), hash.as_str()))
                } else {
                    None
                }
            })
            .max_by(|left, right| left.0.cmp(&right.0))
            .map_or(*original_hash, |(_, hash)| hash)
            .to_string();
        let predecessor_content = load_history_object(
            note,
            &predecessor,
            Some(block),
            Some(target),
            &mut cache,
            conflicts,
            report_path,
        );
        let intended_content = load_history_object(
            note,
            hash,
            Some(block),
            Some(target),
            &mut cache,
            conflicts,
            report_path,
        );
        if let (Some(predecessor_content), Some(intended_content)) =
            (predecessor_content, intended_content)
        {
            let exact = matches!(
                normalize_section_impl(&predecessor_content),
                Ok(SectionNormalization::Wrapped(expected)) if expected == intended_content
            );
            if !exact {
                conflicts.push(NormalizationConflict {
                    path: report_path.to_string(),
                    block: Some(block.clone()),
                    target: Some(target.clone()),
                    kind: "normalization-replacement-invalid".to_string(),
                    detail: format!(
                        "completed normalization event {eid} is not the exact normalized predecessor object"
                    ),
                });
            }
        }
    }
}

fn event_order_key(event: &Event) -> (u64, &str) {
    (event_timestamp(event), event_identity_ref(event))
}

fn validate_recovery_replacements(
    note: &NoteStore,
    journal: &sidecar::SectionNormalizationJournal,
    ledger: &[Event],
    resolved: &[mica_core::ResolvedReplacement],
    report_path: &str,
    conflicts: &mut Vec<NormalizationConflict>,
) {
    let by_event: BTreeMap<&str, &mica_core::ResolvedReplacement> = resolved
        .iter()
        .map(|replacement| (replacement.event.as_str(), replacement))
        .collect();
    let mut cache = BTreeMap::new();
    let intended_eids: BTreeSet<&str> = journal.events.iter().map(event_identity_ref).collect();
    let predecessor_events: Vec<_> = ledger
        .iter()
        .filter(|event| !intended_eids.contains(event_identity_ref(event)))
        .cloned()
        .collect();
    let predecessor = match resolve_ledger_impl(&predecessor_events) {
        Ok(resolution) => Some(resolution),
        Err(error) => {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: None,
                target: None,
                kind: "invalid-pending-predecessor-ledger".to_string(),
                detail: error.to_string(),
            });
            None
        }
    };
    let active_predecessors: BTreeMap<&str, &str> = predecessor
        .as_ref()
        .into_iter()
        .flat_map(|resolution| &resolution.replacements)
        .filter(|replacement| replacement.active)
        .map(|replacement| {
            (
                replacement.target.as_str(),
                replacement.replacement.as_str(),
            )
        })
        .collect();
    let add_by_eid: BTreeMap<&str, (&str, &str)> = predecessor_events
        .iter()
        .filter_map(|event| {
            if let Event::AddVersion {
                eid, block, hash, ..
            } = event
            {
                Some((eid.as_str(), (block.as_str(), hash.as_str())))
            } else {
                None
            }
        })
        .collect();
    for event in &journal.events {
        let Event::ReplaceVersion {
            eid, target, hash, ..
        } = event
        else {
            continue;
        };
        let Some(replacement) = by_event.get(eid.as_str()) else {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: None,
                target: Some(target.clone()),
                kind: "pending-replacement-unresolved".to_string(),
                detail: format!("pending replacement event {eid} was not resolved"),
            });
            continue;
        };
        if !replacement.active || replacement.replacement != *hash {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: Some(replacement.block.clone()),
                target: Some(target.clone()),
                kind: "pending-replacement-not-effective".to_string(),
                detail: format!(
                    "normalization replacement event {eid} is not the active intended result"
                ),
            });
        }
        let raw = load_history_object(
            note,
            &replacement.original,
            Some(&replacement.block),
            Some(target),
            &mut cache,
            conflicts,
            report_path,
        );
        let normalized = load_history_object(
            note,
            &replacement.replacement,
            Some(&replacement.block),
            Some(target),
            &mut cache,
            conflicts,
            report_path,
        );
        if let (Some(raw), Some(normalized)) = (raw, normalized) {
            if content_signature_impl(&raw) != content_signature_impl(&normalized) {
                conflicts.push(NormalizationConflict {
                    path: report_path.to_string(),
                    block: Some(replacement.block.clone()),
                    target: Some(target.clone()),
                    kind: "replacement-signature-mismatch".to_string(),
                    detail: format!(
                        "pending replacement event {eid} changes the original version's content signature"
                    ),
                });
            }
        }
        let Some((_, original_hash)) = add_by_eid.get(target.as_str()) else {
            continue;
        };
        let effective_hash = active_predecessors
            .get(target.as_str())
            .copied()
            .unwrap_or(original_hash);
        let predecessor_content = load_history_object(
            note,
            effective_hash,
            Some(&replacement.block),
            Some(target),
            &mut cache,
            conflicts,
            report_path,
        );
        let intended_content = load_history_object(
            note,
            hash,
            Some(&replacement.block),
            Some(target),
            &mut cache,
            conflicts,
            report_path,
        );
        if let (Some(predecessor_content), Some(intended_content)) =
            (predecessor_content, intended_content)
        {
            let exact = matches!(
                normalize_section_impl(&predecessor_content),
                Ok(SectionNormalization::Wrapped(expected)) if expected == intended_content
            );
            if !exact {
                conflicts.push(NormalizationConflict {
                    path: report_path.to_string(),
                    block: Some(replacement.block.clone()),
                    target: Some(target.clone()),
                    kind: "pending-replacement-invalid".to_string(),
                    detail: format!(
                        "pending replacement event {eid} is not the exact core-normalized predecessor object"
                    ),
                });
            }
        }
    }
}

fn plan_history(
    note: &NoteStore,
    ledger: &[Event],
    bad_lines: usize,
    objects: &mut BTreeMap<String, String>,
    report: &mut NoteNormalizationReport,
) -> Result<Vec<Event>> {
    if bad_lines > 0 {
        report.conflicts.push(NormalizationConflict {
            path: report.path.clone(),
            block: None,
            target: None,
            kind: "bad-ledger-lines".to_string(),
            detail: format!(
                "the history ledger has {bad_lines} invalid line(s); repair them before normalization"
            ),
        });
    }

    let mut seen_adds = BTreeSet::new();
    let adds: Vec<_> = ledger
        .iter()
        .filter_map(|event| {
            let Event::AddVersion {
                eid, block, hash, ..
            } = event
            else {
                return None;
            };
            seen_adds
                .insert(eid.as_str())
                .then_some((eid.as_str(), block.as_str(), hash.as_str()))
        })
        .collect();
    report.add_events = adds.len();

    let resolution = match resolve_ledger_impl(ledger) {
        Ok(resolution) => {
            report.unique_versions = resolution
                .blocks
                .values()
                .map(|block| block.versions.len())
                .sum();
            Some(resolution)
        }
        Err(error) => {
            report.conflicts.push(NormalizationConflict {
                path: report.path.clone(),
                block: None,
                target: None,
                kind: "invalid-ledger-resolution".to_string(),
                detail: error.to_string(),
            });
            None
        }
    };

    let mut content_by_hash = BTreeMap::new();
    for (_, block, hash) in &adds {
        load_history_object(
            note,
            hash,
            Some(block),
            None,
            &mut content_by_hash,
            &mut report.conflicts,
            &report.path,
        );
    }

    if let Some(resolution) = &resolution {
        for replacement in &resolution.replacements {
            let raw = load_history_object(
                note,
                &replacement.original,
                Some(&replacement.block),
                Some(&replacement.target),
                &mut content_by_hash,
                &mut report.conflicts,
                &report.path,
            );
            let replaced = load_history_object(
                note,
                &replacement.replacement,
                Some(&replacement.block),
                Some(&replacement.target),
                &mut content_by_hash,
                &mut report.conflicts,
                &report.path,
            );
            if let (Some(raw), Some(replaced)) = (raw, replaced) {
                if content_signature_impl(&raw) != content_signature_impl(&replaced) {
                    report.conflicts.push(NormalizationConflict {
                        path: report.path.clone(),
                        block: Some(replacement.block.clone()),
                        target: Some(replacement.target.clone()),
                        kind: "replacement-signature-mismatch".to_string(),
                        detail: format!(
                            "replacement event {} changes the original version's content signature",
                            replacement.event
                        ),
                    });
                }
            }
        }
    }

    let Some(resolution) = resolution else {
        return Ok(Vec::new());
    };
    if !report.conflicts.is_empty() {
        return Ok(Vec::new());
    }

    let active_by_target: BTreeMap<&str, &str> = resolution
        .replacements
        .iter()
        .filter(|replacement| replacement.active)
        .map(|replacement| {
            (
                replacement.target.as_str(),
                replacement.replacement.as_str(),
            )
        })
        .collect();
    let mut normalized_by_original = BTreeMap::new();
    let mut candidates = Vec::new();
    for (eid, block, original) in adds {
        let effective = active_by_target.get(eid).copied().unwrap_or(original);
        let Some(content) = content_by_hash.get(effective) else {
            continue;
        };
        match normalize_section_impl(content) {
            Ok(SectionNormalization::AlreadyNormalized) => {
                report.already_normalized_history_bodies += 1;
            }
            Ok(SectionNormalization::Wrapped(wrapped)) => {
                if content_signature_impl(content) != content_signature_impl(&wrapped) {
                    report.conflicts.push(NormalizationConflict {
                        path: report.path.clone(),
                        block: Some(block.to_string()),
                        target: Some(eid.to_string()),
                        kind: "signature-mismatch".to_string(),
                        detail: "historical wrapping changed the content signature".to_string(),
                    });
                    continue;
                }
                let wrapped_hash = hash_content_impl(&wrapped);
                if let Some(previous) =
                    normalized_by_original.insert(original, wrapped_hash.clone())
                {
                    if previous != wrapped_hash {
                        report.conflicts.push(NormalizationConflict {
                            path: report.path.clone(),
                            block: Some(block.to_string()),
                            target: Some(eid.to_string()),
                            kind: "inconsistent-duplicate-history".to_string(),
                            detail: format!(
                                "duplicate raw object {original} produced inconsistent normalized hashes"
                            ),
                        });
                        continue;
                    }
                }
                objects.insert(wrapped_hash.clone(), wrapped);
                candidates.push((eid.to_string(), block.to_string(), wrapped_hash));
            }
            Err(error) => report.conflicts.push(NormalizationConflict {
                path: report.path.clone(),
                block: Some(block.to_string()),
                target: Some(eid.to_string()),
                kind: "history-body-invalid".to_string(),
                detail: error.to_string(),
            }),
        }
    }
    if !report.conflicts.is_empty() || candidates.is_empty() {
        return Ok(Vec::new());
    }

    let now = engine::now_ms();
    let max_existing = ledger.iter().map(event_timestamp).max().unwrap_or(0);
    let Some(after_existing) = max_existing.checked_add(1) else {
        report.conflicts.push(timestamp_conflict(&report.path));
        return Ok(Vec::new());
    };
    let timestamp = now.max(after_existing);
    if timestamp > sidecar::MAX_EVENT_TIMESTAMP_MS
        || timestamp > now.saturating_add(sidecar::MAX_FUTURE_EVENT_SKEW_MS)
    {
        report.conflicts.push(timestamp_conflict(&report.path));
        return Ok(Vec::new());
    }

    let mut identities: BTreeSet<String> = ledger.iter().map(event_identity).collect();
    let mut events = Vec::with_capacity(candidates.len());
    for (target, block, hash) in candidates {
        let Some(eid) = fresh_event_identity(&mut identities) else {
            report.conflicts.push(NormalizationConflict {
                path: report.path.clone(),
                block: Some(block),
                target: Some(target),
                kind: "event-identity-exhausted".to_string(),
                detail: "could not mint a unique replacement event id after 64 attempts"
                    .to_string(),
            });
            return Ok(Vec::new());
        };
        events.push(Event::ReplaceVersion {
            eid,
            ts: timestamp,
            block,
            target,
            hash,
        });
    }
    let mut prospective = ledger.to_vec();
    prospective.extend(events.iter().cloned());
    match resolve_ledger_impl(&prospective) {
        Ok(after) => {
            let before_count: usize = resolution
                .blocks
                .values()
                .map(|block| block.versions.len())
                .sum();
            let after_count: usize = after
                .blocks
                .values()
                .map(|block| block.versions.len())
                .sum();
            if before_count != after_count {
                report.conflicts.push(NormalizationConflict {
                    path: report.path.clone(),
                    block: None,
                    target: None,
                    kind: "history-cardinality-changed".to_string(),
                    detail: format!(
                        "normalization would change visible history from {before_count} to {after_count} versions"
                    ),
                });
                Ok(Vec::new())
            } else {
                Ok(events)
            }
        }
        Err(error) => {
            report.conflicts.push(NormalizationConflict {
                path: report.path.clone(),
                block: None,
                target: None,
                kind: "invalid-prospective-ledger".to_string(),
                detail: error.to_string(),
            });
            Ok(Vec::new())
        }
    }
}

fn load_history_object(
    note: &NoteStore,
    hash: &str,
    block: Option<&str>,
    target: Option<&str>,
    cache: &mut BTreeMap<String, String>,
    conflicts: &mut Vec<NormalizationConflict>,
    report_path: &str,
) -> Option<String> {
    if let Some(content) = cache.get(hash) {
        return Some(content.clone());
    }
    match sidecar::read_object(note, hash) {
        Ok(Some(content)) => {
            cache.insert(hash.to_string(), content.clone());
            Some(content)
        }
        Ok(None) => {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: block.map(str::to_string),
                target: target.map(str::to_string),
                kind: "missing-history-object".to_string(),
                detail: format!(
                    "history object {hash} is missing; restore it before normalizing history"
                ),
            });
            None
        }
        Err(error) => {
            conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: block.map(str::to_string),
                target: target.map(str::to_string),
                kind: "corrupt-history-object".to_string(),
                detail: error.to_string(),
            });
            None
        }
    }
}

fn preflight_transaction_storage(
    note: &NoteStore,
    objects: &BTreeMap<String, String>,
    journal: &sidecar::SectionNormalizationJournal,
    report_path: &str,
    conflicts: &mut Vec<NormalizationConflict>,
) -> usize {
    if let Err(error) = sidecar::preflight_note_record(note) {
        conflicts.push(NormalizationConflict {
            path: report_path.to_string(), block: None, target: None,
            kind: "note-record-unpublishable".to_string(), detail: error.to_string(),
        });
    }
    let mut missing = 0;
    for (hash, intended) in objects {
        match sidecar::preflight_object_write(note, hash, intended) {
            Ok(true) => missing += 1,
            Ok(false) => {}
            Err(error) => conflicts.push(NormalizationConflict {
                path: report_path.to_string(),
                block: None,
                target: None,
                kind: "planned-object-unpublishable".to_string(),
                detail: error.to_string(),
            }),
        }
    }
    if let Err(error) = sidecar::preflight_section_normalization_journal(note, journal) {
        conflicts.push(NormalizationConflict {
            path: report_path.to_string(),
            block: None,
            target: None,
            kind: "normalization-journal-unpublishable".to_string(),
            detail: error.to_string(),
        });
    }
    if let Err(error) = sidecar::preflight_event_append(note, &journal.events) {
        conflicts.push(NormalizationConflict {
            path: report_path.to_string(),
            block: None,
            target: None,
            kind: "replacement-events-unpublishable".to_string(),
            detail: error.to_string(),
        });
    }
    missing
}

fn event_identity(event: &Event) -> String {
    event_identity_ref(event).to_string()
}

fn event_identity_ref(event: &Event) -> &str {
    match event {
        Event::AddVersion { eid, .. }
        | Event::ReplaceVersion { eid, .. }
        | Event::SetHead { eid, .. }
        | Event::Label { eid, .. }
        | Event::Checkpoint { eid, .. }
        | Event::MoveHead { eid, .. }
        | Event::VersionLabel { eid, .. }
        | Event::VersionVisibility { eid, .. } => eid,
    }
}

fn event_timestamp(event: &Event) -> u64 {
    match event {
        Event::AddVersion { ts, .. }
        | Event::ReplaceVersion { ts, .. }
        | Event::SetHead { ts, .. }
        | Event::Label { ts, .. }
        | Event::Checkpoint { ts, .. }
        | Event::MoveHead { ts, .. }
        | Event::VersionLabel { ts, .. }
        | Event::VersionVisibility { ts, .. } => *ts,
    }
}

fn fresh_event_identity(existing: &mut BTreeSet<String>) -> Option<String> {
    (0..64).find_map(|_| {
        let candidate = new_id_impl();
        existing.insert(candidate.clone()).then_some(candidate)
    })
}

fn timestamp_conflict(path: &str) -> NormalizationConflict {
    NormalizationConflict {
        path: path.to_string(),
        block: None,
        target: None,
        kind: "replacement-timestamp-unavailable".to_string(),
        detail: "no collision-safe replacement timestamp is available within the accepted cross-host clock window".to_string(),
    }
}

fn publish_recovery(plan: &RecoveryPlan) -> Result<()> {
    engine::validate_journal_generations(&plan.store, &plan.original, &plan.normalized)?;
    engine::preflight_journal_events(&plan.store, &plan.journal.events)?;
    let current = engine::read_doc(&plan.note.abs)?;
    engine::guard_note_store(&plan.note, &plan.store, &current)?;
    if current == plan.original && plan.original != plan.normalized {
        fsutil::atomic_write_if_unchanged(
            &plan.note.abs,
            plan.original.as_bytes(),
            plan.normalized.as_bytes(),
        )?;
    } else if current != plan.normalized {
        return Err(CliError::Corrupt(format!(
            "pending normalization note diverged for {}; the journal was preserved for manual recovery",
            plan.note.abs.display()
        )));
    }
    let published = engine::read_doc(&plan.note.abs)?;
    if published != plan.normalized {
        return Err(CliError::Corrupt(format!(
            "resumed normalized note verification failed for {}; the pending journal was preserved",
            plan.note.abs.display()
        )));
    }
    append_missing_events(&plan.store, &plan.journal.events)?;
    verify_published_replacements(&plan.store, &plan.journal)?;
    let mut completed = plan.journal.clone();
    completed.status = "complete".to_string();
    sidecar::write_section_normalization_journal(&plan.store, &completed)
}

fn publish_plan(plan: &NotePlan) -> Result<()> {
    let current_note = engine::read_doc(&plan.note.abs)?;
    if current_note != plan.source_preimage {
        return Err(CliError::Corrupt(format!(
            "normalization plan is stale because the live note changed: {}; no transaction writes were performed",
            plan.note.abs.display()
        )));
    }
    if let Some(expected) = &plan.ledger_preimage {
        let current = sidecar::read_ledger(&plan.store)?;
        if current != *expected {
            return Err(CliError::Corrupt(format!(
                "normalization plan is stale because the ledger changed: {}; no transaction writes were performed",
                sidecar::ledger_path(&plan.store).display()
            )));
        }
    }
    engine::validate_journal_generations(&plan.store, &plan.original, &plan.normalized)?;
    engine::preflight_journal_events(&plan.store, &plan.journal.events)?;
    engine::validate_note_identity(&plan.note, &plan.original)?;
    sidecar::preflight_note_record(&plan.store)?;
    if plan.source_preimage != plan.original {
        fsutil::atomic_write_if_unchanged(&plan.note.abs, plan.source_preimage.as_bytes(), plan.original.as_bytes())?;
    }
    engine::guard_note_store(&plan.note, &plan.store, &plan.original)?;
    for (hash, content) in &plan.objects {
        sidecar::write_object(&plan.store, hash, content)?;
        sidecar::verify_written_object(&plan.store, hash, content)?;
    }
    let mut journal = plan.journal.clone();
    sidecar::write_section_normalization_journal(&plan.store, &journal)?;
    if plan.original != plan.normalized {
        engine::guard_note_store(&plan.note, &plan.store, &plan.original)?;
        fsutil::atomic_write_if_unchanged(
            &plan.note.abs,
            plan.original.as_bytes(),
            plan.normalized.as_bytes(),
        )?;
    }
    let published = engine::read_doc(&plan.note.abs)?;
    if published != plan.normalized {
        return Err(CliError::Corrupt(format!(
            "normalized note verification failed for {}; the pending journal was preserved for recovery",
            plan.note.abs.display()
        )));
    }
    append_missing_events(&plan.store, &journal.events)?;
    verify_published_replacements(&plan.store, &journal)?;
    journal.status = "complete".to_string();
    sidecar::write_section_normalization_journal(&plan.store, &journal)
}

fn verify_published_replacements(
    note: &NoteStore,
    journal: &sidecar::SectionNormalizationJournal,
) -> Result<()> {
    if journal.events.is_empty() {
        return Ok(());
    }
    let events = sidecar::read_ledger(note)?;
    let resolution = resolve_ledger_impl(&events).map_err(|error| {
        CliError::Corrupt(format!(
            "normalized ledger verification failed for {}: {error}; the pending journal was preserved",
            note.note.display()
        ))
    })?;
    let by_event: BTreeMap<&str, &mica_core::ResolvedReplacement> = resolution
        .replacements
        .iter()
        .map(|replacement| (replacement.event.as_str(), replacement))
        .collect();
    for event in &journal.events {
        let Event::ReplaceVersion { eid, hash, .. } = event else {
            continue;
        };
        let replacement = by_event.get(eid.as_str()).ok_or_else(|| {
            CliError::Corrupt(format!(
                "normalization replacement event {eid} is absent from the checked ledger; the pending journal was preserved"
            ))
        })?;
        if !replacement.active || replacement.replacement != *hash {
            return Err(CliError::Corrupt(format!(
                "normalization replacement event {eid} is not the active intended result; the pending journal was preserved"
            )));
        }
        let content = sidecar::read_object(note, hash)?.ok_or_else(|| {
            CliError::Corrupt(format!(
                "normalization replacement object {hash} is missing; the pending journal was preserved"
            ))
        })?;
        if !matches!(
            normalize_section_impl(&content),
            Ok(SectionNormalization::AlreadyNormalized)
        ) {
            return Err(CliError::Corrupt(format!(
                "normalization replacement object {hash} is not one exact logical section; the pending journal was preserved"
            )));
        }
    }
    Ok(())
}

fn append_missing_events(note: &NoteStore, events: &[Event]) -> Result<()> {
    engine::preflight_journal_events(note, events)?;
    let status = sidecar::classify_event_batch(note, events)?;
    sidecar::append_events(note, &status.missing)?;
    let verified = sidecar::classify_event_batch(note, events)?;
    if verified.missing.is_empty() {
        return Ok(());
    }
    Err(CliError::Corrupt(format!(
        "normalization ledger append could not be verified for {}; rerun the command to resume the pending journal",
        note.note.display()
    )))
}

/// Run the command and render either JSON or human-readable output.
///
/// # Arguments
/// * `ctx` - resolved CLI context
/// * `path` - note or directory path
/// * `history` - include stored history
/// * `dry_run` - suppress all writes
///
/// # Returns
/// `()` after printing the report, or a classified CLI error.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # use mica_cli::commands::Ctx;
/// # let ctx: Ctx = todo!();
/// mica_cli::normalize::run(&ctx, "Prompts", true, true)?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn run(ctx: &Ctx, path: &str, history: bool, dry_run: bool) -> Result<()> {
    let report = normalize_sections(ctx, path, history, dry_run)?;
    if ctx.json {
        let rendered = serde_json::to_string_pretty(&report).map_err(|error| {
            CliError::Corrupt(format!(
                "normalization report serialization failed: {error}"
            ))
        })?;
        println!("{rendered}");
    } else {
        let mode = if dry_run { "planned" } else { "completed" };
        println!(
            "{} normalization {mode}: {} note(s), {} live update(s), {} history replacement(s), {} object write(s)",
            if report.conflicts.is_empty() {
                ctx.style.green("✓")
            } else {
                ctx.style.red("✗")
            },
            report.selected_notes,
            report.planned_live_updates,
            report.planned_replacements,
            report.objects_to_write,
        );
        for note in &report.notes {
            println!(
                "  {} {} — {} live, {} history, {} already normalized",
                ctx.style.cyan(&note.path),
                note.status,
                note.planned_live_updates,
                note.planned_replacements,
                note.already_normalized_live_bodies + note.already_normalized_history_bodies,
            );
            for conflict in &note.conflicts {
                println!(
                    "    {} {}: {}",
                    ctx.style.red("•"),
                    conflict.kind,
                    conflict.detail
                );
            }
        }
    }
    if report.conflicts.is_empty() {
        Ok(())
    } else {
        Err(CliError::Corrupt(format!(
            "normalization was blocked by {} conflict(s); no normalization writes were performed",
            report.conflicts.len()
        )))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)] // Reason: test-only assertions

    use super::*;
    use crate::output::Style;
    use std::path::PathBuf;

    fn test_store(path: &std::path::Path) -> NoteStore {
        let note = vault::NoteRef { abs: path.to_path_buf(), vault: vault::find_vault(None, path.parent().expect("fixture parent")).expect("fixture vault") };
        let source = engine::read_doc(path).expect("fixture source");
        let prepared = mica_core::note_id_impl(&source).expect("fixture identity")
            .map(|_| source.clone()).unwrap_or_else(|| mica_core::set_note_id_impl(&source, None, &format!("fixture-{}", hash_content_impl(&path.to_string_lossy()))).expect("fixture anchor"));
        if prepared != source { std::fs::write(path, &prepared).expect("stamp fixture identity"); }
        engine::require_store(&note, &prepared).expect("fixture handle")
    }

    fn fixture(doc: &str) -> (tempfile::TempDir, Ctx, PathBuf) {
        let directory = tempfile::tempdir().expect("temporary directory");
        std::fs::create_dir(directory.path().join(".obsidian")).expect("vault marker");
        let note = directory.path().join("Note.md");
        std::fs::write(&note, doc).expect("seed note");
        let ctx = Ctx {
            vault: Some(directory.path().to_path_buf()),
            json: true,
            style: Style::forced(false),
        };
        (directory, ctx, note)
    }

    #[test]
    fn dry_run_reports_a_normalizable_note_without_writes() {
        let (_directory, ctx, note) =
            fixture("---\nmica-id: fixture-note\n---\n\nbefore\n```mica id=demo\nalpha\n\nbeta\n```\nafter\n");
        let before = std::fs::read(&note).expect("read original note");

        let report = normalize_sections(&ctx, "Note.md", false, true).expect("dry-run report");

        assert_eq!(report.scanned_notes, 1);
        assert_eq!(report.selected_notes, 1);
        assert_eq!(report.blocks, 1);
        assert_eq!(report.live_bodies, 1);
        assert_eq!(report.planned_live_updates, 1);
        assert_eq!(report.planned_replacements, 0);
        assert!(report.conflicts.is_empty());
        assert_eq!(std::fs::read(&note).expect("read unchanged note"), before);
        assert!(!crate::sidecar::sidecar_dir(&test_store(&note)).exists());
    }

    #[test]
    fn directory_normalization_accumulates_per_note_corruption() {
        let (directory, ctx, good_note) = fixture("---\nmica-id: fixture-note\n---\n\n```mica id=good\nalpha\n```\n");
        let bad_ledger_note = directory.path().join("Bad ledger.md");
        let bad_journal_note = directory.path().join("Bad journal.md");
        std::fs::write(&bad_ledger_note, "---\nmica-id: fixture-ledger\n---\n\n```mica id=ledger\nbeta\n```\n")
            .expect("seed bad ledger note");
        std::fs::write(&bad_journal_note, "---\nmica-id: fixture-journal\n---\n\n```mica id=journal\ngamma\n```\n")
            .expect("seed bad journal note");
        crate::sidecar::ensure_note_record(&test_store(&bad_ledger_note))
            .expect("bad ledger sidecar");
        std::fs::write(
            crate::sidecar::ledger_path(&test_store(&bad_ledger_note)),
            r#"{"type":"future-event","eid":"future"}
"#,
        )
        .expect("seed invalid typed ledger");
        crate::sidecar::ensure_note_record(&test_store(&bad_journal_note))
            .expect("bad journal sidecar");
        std::fs::write(
            crate::sidecar::section_normalization_journal_path(&test_store(&bad_journal_note)),
            b"not json\n",
        )
        .expect("seed invalid journal");
        let before = std::fs::read(&good_note).expect("good note preimage");

        let report = normalize_sections(
            &ctx,
            directory.path().to_str().expect("UTF-8 vault path"),
            true,
            true,
        )
        .expect("complete report");

        assert_eq!(report.scanned_notes, 3, "{report:?}");
        assert_eq!(report.selected_notes, 3, "{report:?}");
        let kinds: BTreeSet<_> = report
            .conflicts
            .iter()
            .map(|conflict| conflict.kind.as_str())
            .collect();
        assert!(kinds.contains("corrupt-history-ledger"), "{report:?}");
        assert!(
            kinds.contains("corrupt-normalization-journal"),
            "{report:?}"
        );
        assert!(
            report
                .notes
                .iter()
                .any(|note| note.path == "Note.md" && note.planned_live_updates == 1),
            "{report:?}"
        );
        assert_eq!(
            std::fs::read(&good_note).expect("good note postimage"),
            before
        );
    }

    #[test]
    fn conflicting_history_is_rejected_before_writes() {
        let (_directory, ctx, note) = fixture("---\nmica-id: fixture-note\n---\n\nplain note\n");
        let missing_hash = hash_content_impl("missing historical body\n");
        crate::sidecar::append_events(
            &test_store(&note),
            &[mica_core::Event::AddVersion {
                eid: "add-missing".to_string(),
                ts: 1,
                block: "archived".to_string(),
                hash: missing_hash,
                label: Some("v1".to_string()),
                origin: None,
                parent: None,
            }],
        )
        .expect("seed ledger");
        let before_note = std::fs::read(&note).expect("read original note");
        let before_ledger = std::fs::read(crate::sidecar::ledger_path(&test_store(&note))).expect("read ledger");

        let report = normalize_sections(&ctx, "Note.md", true, true).expect("conflict report");

        assert_eq!(report.selected_notes, 1);
        assert_eq!(report.add_events, 1);
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].kind, "missing-history-object");
        assert_eq!(std::fs::read(&note).expect("unchanged note"), before_note);
        assert_eq!(
            std::fs::read(crate::sidecar::ledger_path(&test_store(&note))).expect("unchanged ledger"),
            before_ledger
        );
        assert!(!crate::sidecar::section_normalization_journal_path(&test_store(&note)).exists());
    }

    #[test]
    fn execution_is_exact_recoverable_and_byte_idempotent() {
        let (_directory, ctx, note) =
            fixture("---\nmica-id: fixture-note\n---\n\nbefore\n```mica id=demo\nalpha\n\nbeta\n```\nafter\n");

        let first = normalize_sections(&ctx, "Note.md", false, false).expect("normalize note");

        assert_eq!(first.planned_live_updates, 1);
        assert_eq!(first.notes[0].status, "normalized");
        let normalized = "---\nmica-id: fixture-note\n---\n\nbefore\n```mica id=demo\n:::section\nalpha\n\nbeta\n:::\n```\nafter\n";
        assert_eq!(
            std::fs::read_to_string(&note).expect("normalized note"),
            normalized
        );
        let journal = crate::sidecar::read_section_normalization_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal exists");
        assert_eq!(journal.status, "complete");
        assert_eq!(
            crate::sidecar::read_object(&test_store(&note), &journal.normalized)
                .expect("read normalized object")
                .expect("normalized object exists"),
            normalized
        );
        let first_bytes = std::fs::read(&note).expect("first result bytes");

        let second = normalize_sections(&ctx, "Note.md", false, false).expect("rerun");

        assert_eq!(second.planned_live_updates, 0);
        assert_eq!(second.notes[0].status, "unchanged");
        assert_eq!(
            std::fs::read(&note).expect("second result bytes"),
            first_bytes
        );
    }

    #[test]
    fn history_replaces_each_add_eid_and_reuses_duplicate_wrapped_objects() {
        let (_directory, ctx, note) = fixture("---\nmica-id: fixture-note\n---\n\nplain note\n");
        let raw = "alpha\n\nbeta\n";
        let raw_hash = hash_content_impl(raw);
        crate::sidecar::write_object(&test_store(&note), &raw_hash, raw).expect("seed raw object");
        let adds = [
            mica_core::Event::AddVersion {
                eid: "add-a".to_string(),
                ts: 1,
                block: "archived".to_string(),
                hash: raw_hash.clone(),
                label: Some("v1".to_string()),
                origin: None,
                parent: None,
            },
            mica_core::Event::AddVersion {
                eid: "add-b".to_string(),
                ts: 2,
                block: "archived".to_string(),
                hash: raw_hash.clone(),
                label: Some("duplicate".to_string()),
                origin: None,
                parent: None,
            },
        ];
        crate::sidecar::append_events(&test_store(&note), &adds).expect("seed ledger");

        let first = normalize_sections(&ctx, "Note.md", true, false).expect("normalize history");

        assert_eq!(first.add_events, 2);
        assert_eq!(first.planned_replacements, 2);
        assert_eq!(first.notes[0].status, "normalized");
        let ledger = crate::sidecar::read_ledger(&test_store(&note)).expect("read normalized ledger");
        let replacements: Vec<_> = ledger
            .iter()
            .filter_map(|event| {
                if let mica_core::Event::ReplaceVersion {
                    eid,
                    ts,
                    target,
                    hash,
                    ..
                } = event
                {
                    Some((eid, ts, target, hash))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(replacements.len(), 2);
        assert_ne!(replacements[0].0, replacements[1].0);
        assert_eq!(replacements[0].1, replacements[1].1);
        assert!(*replacements[0].1 > 2);
        assert_ne!(replacements[0].2, replacements[1].2);
        assert_eq!(replacements[0].3, replacements[1].3);
        let wrapped = crate::sidecar::read_object(&test_store(&note), replacements[0].3)
            .expect("read replacement")
            .expect("replacement object exists");
        assert_eq!(
            content_signature_impl(raw),
            content_signature_impl(&wrapped)
        );
        assert!(matches!(
            normalize_section_impl(&wrapped).expect("valid replacement"),
            SectionNormalization::AlreadyNormalized
        ));
        let resolved = resolve_ledger_impl(&ledger).expect("checked normalized ledger");
        assert_eq!(resolved.blocks["archived"].versions.len(), 1);
        let journal = crate::sidecar::read_section_normalization_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal exists");
        assert_eq!(journal.status, "complete");
        assert_eq!(journal.events.len(), 2);
        let ledger_bytes = std::fs::read(crate::sidecar::ledger_path(&test_store(&note))).expect("ledger bytes");

        let second = normalize_sections(&ctx, "Note.md", true, false).expect("rerun history");

        assert_eq!(second.planned_replacements, 0);
        assert_eq!(second.notes[0].status, "unchanged");
        assert_eq!(
            std::fs::read(crate::sidecar::ledger_path(&test_store(&note))).expect("rerun ledger bytes"),
            ledger_bytes
        );
    }

    #[test]
    fn dry_run_reports_duplicate_ids_and_unclosed_live_blocks() {
        let source = "---\nmica-id: fixture-note\n---\n\n```mica id=duplicate\nalpha\n```\n```mica id=duplicate\nbeta\n```\n```mica id=unfinished\ngamma\n";
        let (_directory, ctx, note) = fixture(source);
        let before = std::fs::read(&note).expect("note preimage");

        let report = normalize_sections(&ctx, "Note.md", false, true).expect("conflict report");
        let kinds: BTreeSet<_> = report
            .conflicts
            .iter()
            .map(|conflict| conflict.kind.as_str())
            .collect();

        assert!(kinds.contains("duplicate-live-block-id"), "{report:?}");
        assert!(kinds.contains("unclosed-live-block"), "{report:?}");
        assert_eq!(std::fs::read(&note).expect("unchanged note"), before);
        assert!(!crate::sidecar::section_normalization_journal_path(&test_store(&note)).exists());
    }

    #[test]
    fn aggregate_already_normalized_count_includes_history() {
        let (_directory, ctx, note) = fixture("---\nmica-id: fixture-note\n---\n\nplain note\n");
        let normalized = ":::section\nalpha\n:::\n";
        let hash = hash_content_impl(normalized);
        crate::sidecar::write_object(&test_store(&note), &hash, normalized).expect("history object");
        crate::sidecar::append_events(
            &test_store(&note),
            &[Event::AddVersion {
                eid: "add-normalized".to_string(),
                ts: 1,
                block: "demo".to_string(),
                hash,
                label: None,
                origin: None,
                parent: None,
            }],
        )
        .expect("history event");

        let report = normalize_sections(&ctx, "Note.md", true, true).expect("dry run");

        assert_eq!(report.already_normalized_bodies, 1);
        assert_eq!(report.notes[0].already_normalized_history_bodies, 1);
    }

    #[test]
    fn publication_rejects_a_stale_history_plan_before_writes() {
        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\nalpha\n```\n";
        let normalized = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\n:::section\nalpha\n:::\n```\n";
        let (_directory, ctx, note) = fixture(original);
        let note_ref =
            crate::vault::resolve_note("Note.md", ctx.vault.as_deref()).expect("resolved note");
        let add = Event::AddVersion {
            eid: "add-before-plan".to_string(),
            ts: 1,
            block: "demo".to_string(),
            hash: hash_content_impl("alpha\n"),
            label: None,
            origin: None,
            parent: None,
        };
        crate::sidecar::append_events(&test_store(&note), std::slice::from_ref(&add)).expect("initial ledger");
        let plan = NotePlan {
            store: test_store(&note),
            source_preimage: engine::read_doc(&note).expect("fixture preimage"),
            note: note_ref,
            original: original.to_string(),
            normalized: normalized.to_string(),
            ledger_preimage: Some(vec![add]),
            objects: BTreeMap::new(),
            journal: sidecar::SectionNormalizationJournal {
                format: 1,
                status: "pending".to_string(),
                note: "Note.md".to_string(),
                original: hash_content_impl(original),
                normalized: hash_content_impl(normalized),
                history: true,
                events: Vec::new(),
            },
            report_index: 0,
        };
        crate::sidecar::append_events(
            &test_store(&note),
            &[Event::SetHead {
                eid: "concurrent-head".to_string(),
                ts: 2,
                block: "demo".to_string(),
                hash: hash_content_impl("alpha\n"),
            }],
        )
        .expect("concurrent ledger change");

        let error = publish_plan(&plan).expect_err("stale plan must fail closed");

        assert!(error.to_string().contains("ledger changed"), "{error}");
        assert_eq!(std::fs::read_to_string(&note).expect("live note"), original);
        assert!(!crate::sidecar::section_normalization_journal_path(&test_store(&note)).exists());
    }

    #[test]
    fn pending_journal_resumes_note_and_missing_history_event() {
        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\nalpha\n\nbeta\n```\n";
        let normalized = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\n:::section\nalpha\n\nbeta\n:::\n```\n";
        let (_directory, ctx, note) = fixture(original);
        let raw = "old\n\nversion\n";
        let wrapped = ":::section\nold\n\nversion\n:::\n";
        let raw_hash = hash_content_impl(raw);
        let wrapped_hash = hash_content_impl(wrapped);
        for (hash, content) in [
            (hash_content_impl(original), original),
            (hash_content_impl(normalized), normalized),
            (raw_hash.clone(), raw),
            (wrapped_hash.clone(), wrapped),
        ] {
            crate::sidecar::write_object(&test_store(&note), &hash, content).expect("seed recovery object");
        }
        crate::sidecar::append_events(
            &test_store(&note),
            &[Event::AddVersion {
                eid: "add-old".to_string(),
                ts: 1,
                block: "demo".to_string(),
                hash: raw_hash,
                label: None,
                origin: None,
                parent: None,
            }],
        )
        .expect("seed add event");
        let intended = Event::ReplaceVersion {
            eid: "replace-old".to_string(),
            ts: 2,
            block: "demo".to_string(),
            target: "add-old".to_string(),
            hash: wrapped_hash,
        };
        crate::sidecar::write_section_normalization_journal(
            &test_store(&note),
            &crate::sidecar::SectionNormalizationJournal {
                format: 1,
                status: "pending".to_string(),
                note: "Note.md".to_string(),
                original: hash_content_impl(original),
                normalized: hash_content_impl(normalized),
                history: true,
                events: vec![intended.clone()],
            },
        )
        .expect("seed pending journal");

        let report = normalize_sections(&ctx, "Note.md", false, false).expect("resume pending");

        assert_eq!(report.notes[0].status, "resumed");
        assert_eq!(
            std::fs::read_to_string(&note).expect("resumed note"),
            normalized
        );
        let journal = crate::sidecar::read_section_normalization_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal exists");
        assert_eq!(journal.status, "complete");
        let status = crate::sidecar::classify_event_batch(&test_store(&note), &[intended])
            .expect("classify intended event");
        assert_eq!(status.present, 1);
        assert!(status.missing.is_empty());
    }

    #[test]
    fn pending_journal_fails_closed_when_note_diverged() {
        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\noriginal\n```\n";
        let normalized = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\n:::section\noriginal\n:::\n```\n";
        let (_directory, ctx, note) = fixture("user changed this\n");
        for (hash, content) in [
            (hash_content_impl(original), original),
            (hash_content_impl(normalized), normalized),
        ] {
            crate::sidecar::write_object(&test_store(&note), &hash, content).expect("seed recovery object");
        }
        crate::sidecar::write_section_normalization_journal(
            &test_store(&note),
            &crate::sidecar::SectionNormalizationJournal {
                format: 1,
                status: "pending".to_string(),
                note: "Note.md".to_string(),
                original: hash_content_impl(original),
                normalized: hash_content_impl(normalized),
                history: false,
                events: Vec::new(),
            },
        )
        .expect("seed pending journal");
        let before = std::fs::read(&note).expect("diverged bytes");

        let report =
            normalize_sections(&ctx, "Note.md", false, false).expect("return fail-closed report");

        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].kind, "pending-note-diverged");
        assert_eq!(std::fs::read(&note).expect("preserved divergence"), before);
        let journal = crate::sidecar::read_section_normalization_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal exists");
        assert_eq!(journal.status, "pending");
    }

    #[test]
    fn pending_journal_rejects_a_forged_postimage() {
        let original = "---\nmica-id: fixture-note\n---\n\n```mica id=demo\nalpha\n```\n";
        let forged = "unrelated replacement\n";
        let (_directory, ctx, note) = fixture(original);
        for (hash, content) in [
            (hash_content_impl(original), original),
            (hash_content_impl(forged), forged),
        ] {
            crate::sidecar::write_object(&test_store(&note), &hash, content).expect("seed recovery object");
        }
        crate::sidecar::write_section_normalization_journal(
            &test_store(&note),
            &crate::sidecar::SectionNormalizationJournal {
                format: 1,
                status: "pending".to_string(),
                note: "Note.md".to_string(),
                original: hash_content_impl(original),
                normalized: hash_content_impl(forged),
                history: false,
                events: Vec::new(),
            },
        )
        .expect("seed forged journal");

        let report =
            normalize_sections(&ctx, "Note.md", false, false).expect("return a fail-closed report");

        assert_eq!(report.conflicts.len(), 1, "{report:?}");
        assert_eq!(report.conflicts[0].kind, "pending-postimage-invalid");
        assert_eq!(std::fs::read_to_string(&note).expect("live note"), original);
        let journal = crate::sidecar::read_section_normalization_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal exists");
        assert_eq!(journal.status, "pending");
    }

    #[test]
    fn pending_journal_rejects_a_non_normalized_history_replacement() {
        let note_body = "---\nmica-id: fixture-note\n---\n\nplain note\n";
        let raw = "old\n\nversion\n";
        let (_directory, ctx, note) = fixture(note_body);
        let note_hash = hash_content_impl(note_body);
        let raw_hash = hash_content_impl(raw);
        crate::sidecar::write_object(&test_store(&note), &note_hash, note_body).expect("whole note object");
        crate::sidecar::write_object(&test_store(&note), &raw_hash, raw).expect("raw object");
        crate::sidecar::append_events(
            &test_store(&note),
            &[Event::AddVersion {
                eid: "add-old".to_string(),
                ts: 1,
                block: "demo".to_string(),
                hash: raw_hash.clone(),
                label: None,
                origin: None,
                parent: None,
            }],
        )
        .expect("seed add event");
        crate::sidecar::write_section_normalization_journal(
            &test_store(&note),
            &crate::sidecar::SectionNormalizationJournal {
                format: 1,
                status: "pending".to_string(),
                note: "Note.md".to_string(),
                original: note_hash.clone(),
                normalized: note_hash,
                history: true,
                events: vec![Event::ReplaceVersion {
                    eid: "replace-old".to_string(),
                    ts: 2,
                    block: "demo".to_string(),
                    target: "add-old".to_string(),
                    hash: raw_hash,
                }],
            },
        )
        .expect("seed forged history journal");

        let report =
            normalize_sections(&ctx, "Note.md", false, false).expect("return a fail-closed report");

        assert!(
            report
                .conflicts
                .iter()
                .any(|conflict| conflict.kind == "pending-replacement-invalid"),
            "{report:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&note).expect("live note"),
            note_body
        );
        assert_eq!(
            crate::sidecar::read_ledger(&test_store(&note))
                .expect("unchanged ledger")
                .len(),
            1
        );
    }

    #[test]
    fn completion_requires_the_intended_replacement_to_be_active() {
        let (_directory, _ctx, note) = fixture("---\nmica-id: fixture-note\n---\n\nplain note\n");
        let raw_hash = hash_content_impl("raw\n");
        let intended_hash = hash_content_impl(":::section\nraw\n:::\n");
        let competing_hash = hash_content_impl(":::section\nother\n:::\n");
        for (hash, content) in [
            (raw_hash.clone(), "raw\n"),
            (intended_hash.clone(), ":::section\nraw\n:::\n"),
            (competing_hash.clone(), ":::section\nother\n:::\n"),
        ] {
            crate::sidecar::write_object(&test_store(&note), &hash, content).expect("seed object");
        }
        let intended = Event::ReplaceVersion {
            eid: "replace-intended".to_string(),
            ts: 2,
            block: "demo".to_string(),
            target: "add-raw".to_string(),
            hash: intended_hash,
        };
        crate::sidecar::append_events(
            &test_store(&note),
            &[
                Event::AddVersion {
                    eid: "add-raw".to_string(),
                    ts: 1,
                    block: "demo".to_string(),
                    hash: raw_hash,
                    label: None,
                    origin: None,
                    parent: None,
                },
                intended.clone(),
                Event::ReplaceVersion {
                    eid: "replace-competing".to_string(),
                    ts: 3,
                    block: "demo".to_string(),
                    target: "add-raw".to_string(),
                    hash: competing_hash,
                },
            ],
        )
        .expect("seed competing ledger");
        let note_hash = hash_content_impl("---\nmica-id: fixture-note\n---\n\nplain note\n");
        let journal = sidecar::SectionNormalizationJournal {
            format: 1,
            status: "pending".to_string(),
            note: "Note.md".to_string(),
            original: note_hash.clone(),
            normalized: note_hash,
            history: true,
            events: vec![intended],
        };

        let error = verify_published_replacements(&test_store(&note), &journal)
            .expect_err("inactive intended event cannot complete");

        assert!(error.to_string().contains("not the active intended result"));
    }

    #[test]
    fn completed_journal_allows_a_later_valid_replacement() {
        let (_directory, _ctx, note) = fixture("---\nmica-id: fixture-note\n---\n\nplain note\n");
        let raw = "raw\n";
        let normalized = ":::section\nraw\n:::\n";
        let later = ":::section\n:::section\nraw\n:::\n:::\n";
        let raw_hash = hash_content_impl(raw);
        let normalized_hash = hash_content_impl(normalized);
        let later_hash = hash_content_impl(later);
        for (hash, content) in [
            (raw_hash.clone(), raw),
            (normalized_hash.clone(), normalized),
            (later_hash.clone(), later),
        ] {
            crate::sidecar::write_object(&test_store(&note), &hash, content).expect("seed history object");
        }
        let intended = Event::ReplaceVersion {
            eid: "replace-intended".to_string(),
            ts: 2,
            block: "demo".to_string(),
            target: "add-raw".to_string(),
            hash: normalized_hash,
        };
        crate::sidecar::append_events(
            &test_store(&note),
            &[
                Event::AddVersion {
                    eid: "add-raw".to_string(),
                    ts: 1,
                    block: "demo".to_string(),
                    hash: raw_hash,
                    label: None,
                    origin: None,
                    parent: None,
                },
                intended.clone(),
                Event::ReplaceVersion {
                    eid: "replace-later".to_string(),
                    ts: 3,
                    block: "demo".to_string(),
                    target: "add-raw".to_string(),
                    hash: later_hash,
                },
            ],
        )
        .expect("seed superseding ledger");
        let note_hash = hash_content_impl("---\nmica-id: fixture-note\n---\n\nplain note\n");
        crate::sidecar::write_object(&test_store(&note), &note_hash, "---\nmica-id: fixture-note\n---\n\nplain note\n")
            .expect("seed whole note object");
        let journal = sidecar::SectionNormalizationJournal {
            format: 1,
            status: "complete".to_string(),
            note: "Note.md".to_string(),
            original: note_hash.clone(),
            normalized: note_hash,
            history: true,
            events: vec![intended],
        };
        let note_ref = vault::NoteRef {
            abs: note,
            vault: _directory.path().to_path_buf(),
        };

        let inspection =
            inspect_normalization_journal(&engine::require_store(&note_ref, &engine::read_doc(&note_ref.abs).expect("fixture source")).expect("fixture store"), None, &journal).expect("inspect journal");

        assert!(
            inspection.conflicts.is_empty(),
            "{:?}",
            inspection.conflicts
        );
    }
}

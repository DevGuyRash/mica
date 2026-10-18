//! Recoverable consolidation of one prompt collection into a tabbed Mica block.

use crate::commands::Ctx;
use crate::error::{io_ctx, CliError, Result};
use crate::{engine, fsutil, sidecar, vault};
use crate::sidecar::NoteStore;
use mica_core::ops::{normalize_section_impl, SectionNormalization};
use mica_core::{
    content_signature_impl, hash_content_impl, migrate_tabs_impl, new_id_impl, parse_block_impl,
    resolve_ledger_impl, scan_impl, serialize_impl, BlockSpan, Cst, Event, Node,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;

const PROMPTS_HEADING: &str = "## 🤖 Prompts";
const LEGACY_CALLOUTS: &str =
    "note,abstract,summary,tldr,info,todo,tip,hint,important,success,check,done,question,help,faq,warning,caution,attention,failure,fail,missing,danger,error,bug,example,quote,cite";
const MAX_SOURCE_OBJECT_CACHE_BYTES: usize = 16 * 1024 * 1024;

struct TabBody {
    source_block: String,
    title: String,
    live: String,
}

struct NotePlan {
    note: vault::NoteRef,
    store: NoteStore,
    source_preimage: String,
    original: String,
    consolidated: String,
    ledger_preimage: Vec<Event>,
    objects: BTreeMap<String, String>,
    journal: sidecar::TabConsolidationJournal,
    manifest_source_preimage: Option<Vec<u8>>,
    manifest_original: Option<Vec<u8>>,
    manifest_consolidated: Vec<u8>,
    source_blocks: usize,
    tabs: usize,
    source_add_events: usize,
    target_add_events: usize,
    callout_sections: usize,
    code_sections: usize,
    planned_writes: usize,
}

struct VersionCandidate {
    source_event: String,
    source_block: String,
    source_hash: String,
    source_effective_hash: String,
    target_hash: String,
    ts: u64,
    label: Option<String>,
    origin: Option<String>,
    parent_version_id: Option<String>,
    source_version_id: Option<String>,
    visible: bool,
    identity_checkpoint: bool,
}

type SemanticBody = (String, usize, usize);

/// Per-note cache keyed by effective object hash. Values are semantic bodies
/// plus section counts; semantic text is capped by `max_bytes`, unique bodies
/// bypass storage, and repeated bodies are evicted after their final use.
struct SourceObjectCache<'a> {
    entries: HashMap<&'a str, SemanticBody>,
    remaining: HashMap<&'a str, usize>,
    bytes: usize,
    max_bytes: usize,
}

impl<'a> SourceObjectCache<'a> {
    fn new(hashes: impl Iterator<Item = &'a str>, max_bytes: usize) -> Self {
        let mut remaining = HashMap::new();
        for hash in hashes {
            *remaining.entry(hash).or_insert(0) += 1;
        }
        Self {
            entries: HashMap::new(),
            remaining,
            bytes: 0,
            max_bytes,
        }
    }

    fn with_body<T>(
        &mut self,
        hash: &'a str,
        load: impl FnOnce() -> Result<SemanticBody>,
        consume: impl FnOnce(&SemanticBody) -> Result<T>,
    ) -> Result<T> {
        let remaining = self.remaining.get(hash).copied().ok_or_else(|| {
            CliError::Corrupt(
                "consolidation source-object cache received an unplanned hash".to_string(),
            )
        })?;
        if let Some(body) = self.entries.get(hash) {
            let result = consume(body);
            self.finish_use(hash);
            return result;
        }

        let body = load()?;
        let body_bytes = body.0.len();
        let should_cache = remaining > 1 && body_bytes <= self.max_bytes.saturating_sub(self.bytes);
        if should_cache {
            self.bytes += body_bytes;
            self.entries.insert(hash, body);
            let result = self
                .entries
                .get(hash)
                .ok_or_else(|| {
                    CliError::Corrupt(
                        "consolidation source-object cache lost a loaded object".to_string(),
                    )
                })
                .and_then(consume);
            self.finish_use(hash);
            result
        } else {
            let result = consume(&body);
            self.finish_use(hash);
            result
        }
    }

    fn finish_use(&mut self, hash: &str) {
        let last_use = self.remaining.get_mut(hash).is_some_and(|remaining| {
            *remaining = remaining.saturating_sub(1);
            *remaining == 0
        });
        if !last_use {
            return;
        }
        self.remaining.remove(hash);
        if let Some(body) = self.entries.remove(hash) {
            self.bytes = self.bytes.saturating_sub(body.0.len());
        }
    }
}

fn semanticize_body(body: &str) -> Result<(String, usize, usize)> {
    let parsed = parse_block_impl(body);
    let children = match parsed.children.as_slice() {
        [Node::Container {
            name,
            close_line,
            children,
            ..
        }] if name == "section" && !close_line.is_empty() => children,
        _ => {
            return Err(CliError::BadArgs(
                "prompt body is not one closed generated section — normalize it before consolidating tabs"
                    .to_string(),
            ));
        }
    };
    let mut output = String::with_capacity(body.len());
    let mut prose = String::new();
    let mut callouts = 0;
    let mut code = 0;
    for node in children {
        match node {
            Node::Leaf {
                text,
                is_code: true,
            } => {
                flush_prose(&mut output, &mut prose)?;
                output.push_str(text);
                code += 1;
            }
            Node::Leaf {
                text,
                is_code: false,
            } if is_callout(text) => {
                flush_prose(&mut output, &mut prose)?;
                output.push_str(text);
                callouts += 1;
            }
            Node::Leaf { text, .. } => prose.push_str(text),
            Node::Container { .. } => {
                flush_prose(&mut output, &mut prose)?;
                output.push_str(&serialize_impl(&Cst {
                    children: vec![node.clone()],
                }));
            }
        }
    }
    flush_prose(&mut output, &mut prose)?;
    if content_signature_impl(body) != content_signature_impl(&output) {
        return Err(CliError::Corrupt(
            "semantic section projection changed the prompt content signature — the source was preserved"
                .to_string(),
        ));
    }
    Ok((output, callouts, code))
}

fn flush_prose(output: &mut String, prose: &mut String) -> Result<()> {
    if prose.is_empty() {
        return Ok(());
    }
    if prose.trim().is_empty() {
        output.push_str(prose);
        prose.clear();
        return Ok(());
    }
    match normalize_section_impl(prose) {
        Ok(SectionNormalization::Wrapped(section)) => output.push_str(&section),
        Ok(SectionNormalization::AlreadyNormalized) => output.push_str(prose),
        Err(error) => return Err(CliError::BadArgs(error.to_string())),
    }
    prose.clear();
    Ok(())
}

fn is_callout(text: &str) -> bool {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| {
            line.trim_start()
                .strip_prefix('>')
                .is_some_and(|rest| rest.trim_start().starts_with("[!"))
        })
}

fn prompt_section(doc: &str) -> Option<(usize, usize)> {
    let spans = scan_impl(doc);
    prompt_section_from_spans(doc, &spans)
}

fn prompt_section_from_spans(doc: &str, spans: &[BlockSpan]) -> Option<(usize, usize)> {
    let mut offset = 0;
    let mut start = None;
    let mut block_index = 0;
    // Per note: scanner spans are in source order, so heading membership is
    // O(lines + blocks) time and O(1) auxiliary space rather than scanning all
    // blocks at every possible section heading.
    for line in doc.split_inclusive('\n') {
        let text = line
            .strip_suffix('\n')
            .unwrap_or(line)
            .strip_suffix('\r')
            .unwrap_or_else(|| line.strip_suffix('\n').unwrap_or(line));
        if start.is_none() && text == PROMPTS_HEADING {
            start = Some(offset + line.len());
        } else if let Some(section_start) = start {
            while spans
                .get(block_index)
                .is_some_and(|span| !span.closed || span.end <= offset)
            {
                block_index += 1;
            }
            let inside_mica = spans
                .get(block_index)
                .is_some_and(|span| span.closed && offset >= span.start && offset < span.end);
            if text.starts_with("## ") && !inside_mica {
                return Some((section_start, offset));
            }
        }
        offset += line.len();
    }
    start.map(|section_start| (section_start, doc.len()))
}

fn prompt_spans(doc: &str) -> Result<Vec<BlockSpan>> {
    let spans = scan_impl(doc);
    let Some((section_start, section_end)) = prompt_section_from_spans(doc, &spans) else {
        return Ok(Vec::new());
    };
    let mut selected = Vec::new();
    for span in spans {
        if span.start < section_start || span.start >= section_end {
            continue;
        }
        if !span.closed || span.end > section_end {
            return Err(CliError::BadArgs(
                "the prompt collection contains an unclosed Mica block — close it before consolidating tabs"
                    .to_string(),
            ));
        }
        selected.push(span);
    }
    Ok(selected)
}

fn block_body<'a>(doc: &'a str, span: &BlockSpan) -> &'a str {
    &doc[span.content_start..span.content_end]
}

fn compose_tabbed_body(
    tabs: &[TabBody],
    historical: Option<(usize, &str, &str)>,
) -> Result<String> {
    let capacity = tabs
        .iter()
        .map(|tab| tab.title.len() + tab.live.len() + 8)
        .sum();
    let mut out = String::with_capacity(capacity);
    for (index, tab) in tabs.iter().enumerate() {
        out.push_str("tab: ");
        out.push_str(&tab.title);
        if let Some((historical_index, source_event, _)) = historical {
            if historical_index == index {
                out.push_str(" {source-event=");
                out.push_str(
                    hash_content_impl(source_event)
                        .strip_prefix("b3:")
                        .unwrap_or_default(),
                );
                out.push('}');
            }
        }
        out.push('\n');
        let body = historical
            .filter(|(historical_index, _, _)| *historical_index == index)
            .map_or(tab.live.as_str(), |(_, _, body)| body);
        out.push_str(body);
        if !body.is_empty() && !body.ends_with('\n') {
            out.push('\n');
        }
    }
    validate_tabbed_body(&out, tabs, historical)?;
    Ok(out)
}

fn validate_tabbed_body(
    body: &str,
    tabs: &[TabBody],
    historical: Option<(usize, &str, &str)>,
) -> Result<()> {
    let parsed = parse_block_impl(body);
    let [Node::Container { name, children, .. }] = parsed.children.as_slice() else {
        return Err(CliError::Corrupt(
            "composed prompt body does not parse as one tabs group".to_string(),
        ));
    };
    if name != "tabs" || children.len() != tabs.len() {
        return Err(CliError::Corrupt(
            "composed prompt body changed the planned tab cardinality".to_string(),
        ));
    }
    for (index, (node, tab)) in children.iter().zip(tabs).enumerate() {
        let Node::Container {
            name,
            title,
            children,
            ..
        } = node
        else {
            return Err(CliError::Corrupt(
                "composed prompt body contains a non-tab child".to_string(),
            ));
        };
        let (display, _) = mica_core::ops::split_title_attrs(title);
        if name != "tab" || display != tab.title {
            return Err(CliError::Corrupt(
                "composed prompt body changed a tab title".to_string(),
            ));
        }
        let serialized = serialize_impl(&Cst {
            children: children.clone(),
        });
        let expected = historical
            .filter(|(historical_index, _, _)| *historical_index == index)
            .map_or(tab.live.as_str(), |(_, _, body)| body);
        if content_signature_impl(&serialized) != content_signature_impl(expected) {
            return Err(CliError::Corrupt(
                "composed prompt body changed a tab content signature".to_string(),
            ));
        }
    }
    Ok(())
}

fn block_source(id: &str, body: &str) -> String {
    let run = body
        .split('\n')
        .map(|line| {
            let indent = line.bytes().take_while(|byte| *byte == b' ').count();
            if indent > 3 {
                0
            } else {
                line[indent..]
                    .bytes()
                    .take_while(|byte| *byte == b'`')
                    .count()
            }
        })
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(run.saturating_add(1).max(3));
    let terminator = if body.is_empty() || body.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    format!("{fence}mica id={id}\n{body}{terminator}{fence}\n")
}

fn replace_prompt_collection(doc: &str, spans: &[BlockSpan], replacement: &str) -> Result<String> {
    let Some(first) = spans.first() else {
        return Err(CliError::BadArgs(
            "the note has no Mica blocks beneath the prompts heading".to_string(),
        ));
    };
    let Some(last) = spans.last() else {
        return Err(CliError::BadArgs(
            "the note has no Mica blocks beneath the prompts heading".to_string(),
        ));
    };
    for pair in spans.windows(2) {
        if !doc[pair[0].end..pair[1].start].trim().is_empty() {
            return Err(CliError::BadArgs(
                "non-whitespace content appears between prompt blocks — move it into a tab before consolidating"
                    .to_string(),
            ));
        }
    }
    let mut out = String::with_capacity(doc.len() - (last.end - first.start) + replacement.len());
    out.push_str(&doc[..first.start]);
    out.push_str(replacement);
    out.push_str(&doc[last.end..]);
    Ok(out)
}

fn current_titles(spans: &[BlockSpan], note_path: &str) -> Result<Vec<String>> {
    let mut titles = Vec::with_capacity(spans.len());
    for (index, span) in spans.iter().enumerate() {
        let title = span
            .get("name")
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("{note_path} · {}", index + 1));
        titles.push(title);
    }
    Ok(titles)
}

fn legacy_titles(note: &vault::NoteRef, store: &NoteStore, count: usize) -> Result<Option<Vec<String>>> {
    let Some(journal) = sidecar::read_migration_journal(store)? else {
        return Ok(None);
    };
    let Some(original) = sidecar::read_object(store, &journal.original)? else {
        return Err(CliError::Corrupt(format!(
            "legacy migration original object {} is missing for {}",
            journal.original,
            note.vault_rel()
        )));
    };
    let Some((prompt_start, _)) = prompt_section(&original) else {
        return Ok(None);
    };
    let migrated = migrate_tabs_impl(&original[prompt_start..], LEGACY_CALLOUTS);
    let mut titles: Vec<String> = migrated
        .blocks
        .into_iter()
        .flat_map(|block| block.tab_names)
        .collect();
    let mut seen = BTreeSet::new();
    titles.retain(|title| !title.is_empty() && seen.insert(title.clone()));
    if titles.len() != count {
        return Ok(None);
    }
    Ok(Some(titles))
}

fn plan_note(note: &vault::NoteRef, store: NoteStore, source_preimage: String, original: String, history: bool) -> Result<Option<NotePlan>> {
    if let Some(journal) = sidecar::read_section_normalization_journal(&store)? {
        if journal.status != "complete" {
            return Err(CliError::Corrupt(format!(
                "section normalization is still pending for {} — resume it before consolidating tabs",
                note.vault_rel()
            )));
        }
    }
    if let Some(journal) = sidecar::read_migration_journal(&store)? {
        if journal.status != "complete" {
            return Err(CliError::Corrupt(format!(
                "legacy migration is still pending for {} — resume it before consolidating tabs",
                note.vault_rel()
            )));
        }
    }
    if sidecar::read_tab_consolidation_journal(&store)?.is_some() {
        return Ok(None);
    }

    let spans = prompt_spans(&original)?;
    if spans.is_empty() {
        return Ok(None);
    }
    let mut source_ids = Vec::with_capacity(spans.len());
    let mut seen_ids = BTreeSet::new();
    for span in &spans {
        let id = span.id().ok_or_else(|| {
            CliError::BadArgs(format!(
                "a prompt block in {} has no id — run `mica prepare` first",
                note.vault_rel()
            ))
        })?;
        if !seen_ids.insert(id.to_string()) {
            return Err(CliError::BadArgs(format!(
                "prompt block id {id:?} occurs more than once in {} — repair identity before consolidating",
                note.vault_rel()
            )));
        }
        source_ids.push(id.to_string());
    }
    let titles =
        legacy_titles(note, &store, spans.len())?.unwrap_or(current_titles(&spans, &note.vault_rel())?);
    validate_titles(&titles, note)?;

    let mut tabs = Vec::with_capacity(spans.len());
    let mut callout_sections = 0;
    let mut code_sections = 0;
    for ((span, source_block), title) in spans.iter().zip(&source_ids).zip(titles) {
        let (live, callouts, code) = semanticize_body(block_body(&original, span))?;
        callout_sections += callouts;
        code_sections += code;
        tabs.push(TabBody {
            source_block: source_block.clone(),
            title,
            live,
        });
    }

    let target_block = if spans.len() == 1 {
        source_ids[0].clone()
    } else {
        new_id_impl()
    };
    let live_body = if spans.len() == 1 {
        tabs[0].live.clone()
    } else {
        compose_tabbed_body(&tabs, None)?
    };
    let consolidated = if spans.len() == 1 {
        replace_one_body(&original, &spans[0], &live_body)
    } else {
        replace_prompt_collection(&original, &spans, &block_source(&target_block, &live_body))?
    };
    engine::validate_unique_ids(&consolidated)?;

    let ledger_read = sidecar::read_ledger_report(&store)?;
    if ledger_read.bad_lines != 0 {
        return Err(CliError::Corrupt(format!(
            "the ledger for {} contains invalid lines — repair it before consolidating",
            note.vault_rel()
        )));
    }
    let ledger = ledger_read.events;
    let resolution = resolve_ledger_impl(&ledger).map_err(|error| {
        CliError::Corrupt(format!(
            "the ledger for {} cannot be resolved: {error}",
            note.vault_rel()
        ))
    })?;
    let mut candidates = Vec::new();
    let mut objects = BTreeMap::new();
    if history {
        let source_events: BTreeMap<&str, &Event> = ledger
            .iter()
            .filter_map(|event| match event {
                Event::AddVersion { eid, .. } | Event::Checkpoint { eid, .. } => {
                    Some((eid.as_str(), event))
                }
                _ => None,
            })
            .collect();
        // O(v) expected count/build/consume work for v source checkpoints.
        // Hash keys borrow the resolution, while retained semantic text is
        // bounded independently of total history size.
        let source_hashes = source_ids
            .iter()
            .filter_map(|block| resolution.blocks.get(block))
            .flat_map(|state| state.versions.iter().chain(&state.removed_versions))
            .map(|version| version.hash.as_str());
        let mut source_objects =
            SourceObjectCache::new(source_hashes, MAX_SOURCE_OBJECT_CACHE_BYTES);
        for (index, block) in source_ids.iter().enumerate() {
            let Some(state) = resolution.blocks.get(block) else {
                continue;
            };
            for version in state.versions.iter().chain(&state.removed_versions) {
                let (target_content, body_callouts, body_code) = source_objects.with_body(
                    &version.hash,
                    || {
                        let raw =
                            sidecar::read_object(&store, &version.hash)?.ok_or_else(|| {
                                CliError::Corrupt(format!(
                                    "effective source object {} for checkpoint {} is missing in {}",
                                    version.hash,
                                    version.version_id,
                                    note.vault_rel()
                                ))
                            })?;
                        semanticize_body(&raw)
                    },
                    |(semantic, callouts, code)| {
                        let target_content = if spans.len() == 1 {
                            semantic.clone()
                        } else {
                            let provenance = format!("{block}\0{}", version.hash);
                            compose_tabbed_body(&tabs, Some((index, &provenance, semantic)))?
                        };
                        Ok((target_content, *callouts, *code))
                    },
                )?;
                callout_sections += body_callouts;
                code_sections += body_code;
                let target_hash = hash_content_impl(&target_content);
                objects
                    .entry(target_hash.clone())
                    .or_insert_with(|| target_content.clone());
                let source_event = source_events.get(version.version_id.as_str()).copied();
                candidates.push(VersionCandidate {
                    source_event: version.version_id.clone(),
                    source_block: block.clone(),
                    source_hash: match source_event {
                        Some(Event::AddVersion { hash, .. })
                        | Some(Event::Checkpoint { hash, .. }) => hash.clone(),
                        _ => version.hash.clone(),
                    },
                    source_effective_hash: version.hash.clone(),
                    target_hash,
                    ts: version.ts,
                    label: version.label.clone(),
                    origin: match source_event {
                        Some(Event::AddVersion { origin, .. }) => origin.clone(),
                        _ => None,
                    },
                    parent_version_id: version.parent_version_id.clone(),
                    source_version_id: version.source_version_id.clone(),
                    visible: version.visible,
                    identity_checkpoint: matches!(source_event, Some(Event::Checkpoint { .. })),
                });
            }
        }
        candidates.sort_by(|left, right| {
            (left.ts, left.source_event.as_str()).cmp(&(right.ts, right.source_event.as_str()))
        });
    }

    let mut events = Vec::new();
    let mut versions = Vec::new();
    let identity_history = candidates
        .iter()
        .any(|candidate| candidate.identity_checkpoint);
    let mut remapped_head = None;
    if history && spans.len() == 1 && !identity_history {
        let mutation_ts = next_timestamp(&ledger)?;
        for candidate in &candidates {
            if sidecar::resolve_note_hash(&store, &candidate.source_effective_hash)? == candidate.target_hash {
                continue;
            }
            let target_event = consolidated_event_id("replace", &candidate.source_event);
            events.push(Event::ReplaceVersion {
                eid: target_event.clone(),
                ts: mutation_ts,
                block: target_block.clone(),
                target: candidate.source_event.clone(),
                hash: candidate.target_hash.clone(),
            });
        }
    } else if history {
        let aliases: BTreeMap<(&str, &str), String> = candidates
            .iter()
            .map(|candidate| {
                (
                    (
                        candidate.source_block.as_str(),
                        candidate.source_event.as_str(),
                    ),
                    consolidated_event_id("checkpoint", &candidate.source_event),
                )
            })
            .collect();
        for candidate in &candidates {
            let target_event = aliases
                .get(&(
                    candidate.source_block.as_str(),
                    candidate.source_event.as_str(),
                ))
                .cloned()
                .ok_or_else(|| {
                    CliError::Corrupt("consolidated checkpoint alias disappeared".to_string())
                })?;
            let parent = match candidate.parent_version_id.as_deref() {
                Some(parent) => aliases
                    .get(&(candidate.source_block.as_str(), parent))
                    .cloned(),
                None => None,
            };
            if candidate.parent_version_id.is_some() && parent.is_none() {
                return Err(CliError::Corrupt(format!(
                    "parent {} for source event {} cannot be mapped into the consolidated history",
                    candidate.parent_version_id.as_deref().unwrap_or_default(),
                    candidate.source_event
                )));
            }
            let source = candidate.source_version_id.as_deref().and_then(|source| {
                aliases
                    .get(&(candidate.source_block.as_str(), source))
                    .cloned()
            });
            events.push(Event::Checkpoint {
                eid: target_event.clone(),
                ts: candidate.ts,
                block: target_block.clone(),
                hash: candidate.target_hash.clone(),
                parent,
                source,
                cause: Some(if candidate.identity_checkpoint {
                    "tab-consolidation".to_string()
                } else {
                    candidate
                        .origin
                        .clone()
                        .unwrap_or_else(|| "legacy-history-import".to_string())
                }),
            });
            if let Some(label) = &candidate.label {
                events.push(Event::VersionLabel {
                    eid: consolidated_event_id("label", &candidate.source_event),
                    ts: candidate.ts,
                    block: target_block.clone(),
                    target: target_event.clone(),
                    label: Some(label.clone()),
                });
            }
            if !candidate.visible {
                events.push(Event::VersionVisibility {
                    eid: consolidated_event_id("visibility", &candidate.source_event),
                    ts: candidate.ts,
                    block: target_block.clone(),
                    target: target_event.clone(),
                    visible: false,
                });
            }
            if spans.len() == 1 {
                events.push(Event::VersionVisibility {
                    eid: consolidated_event_id("hide-source", &candidate.source_event),
                    ts: candidate.ts,
                    block: target_block.clone(),
                    target: candidate.source_event.clone(),
                    visible: false,
                });
            }
            versions.push(sidecar::TabConsolidationVersion {
                source_event: candidate.source_event.clone(),
                target_event,
                source_block: candidate.source_block.clone(),
                source_hash: candidate.source_hash.clone(),
                target_hash: candidate.target_hash.clone(),
            });
        }
        if spans.len() == 1 {
            remapped_head = resolution
                .blocks
                .get(&target_block)
                .and_then(|state| {
                    state
                        .raw_head_version_id
                        .as_deref()
                        .or(state.head_version_id.as_deref())
                })
                .and_then(|head| aliases.get(&(target_block.as_str(), head)))
                .cloned();
        }
    }

    let live_hash = hash_content_impl(&live_body);
    objects
        .entry(live_hash.clone())
        .or_insert_with(|| live_body.clone());
    let head_ts = next_timestamp_with(&ledger, events.iter())?;
    let live_version_id = consolidated_event_id("checkpoint", &target_block);
    let live_parent = if spans.len() == 1 && identity_history {
        remapped_head
    } else if spans.len() == 1 {
        resolution.blocks.get(&target_block).and_then(|state| {
            state
                .raw_head_version_id
                .clone()
                .or_else(|| state.head_version_id.clone())
        })
    } else {
        events
            .iter()
            .filter_map(|event| match event {
                Event::AddVersion { eid, ts, .. } | Event::Checkpoint { eid, ts, .. } => {
                    Some((*ts, eid))
                }
                _ => None,
            })
            .max()
            .map(|(_, eid)| eid)
            .cloned()
    };
    events.push(Event::Checkpoint {
        eid: live_version_id.clone(),
        ts: head_ts,
        block: target_block.clone(),
        hash: live_hash,
        parent: live_parent,
        source: None,
        cause: Some("tab-consolidation".to_string()),
    });
    events.push(Event::MoveHead {
        eid: consolidated_event_id("head", &target_block),
        ts: head_ts,
        block: target_block.clone(),
        target: Some(live_version_id),
    });
    validate_prospective_ledger(&ledger, &events, &target_block, candidates.len(), history)?;

    let original_hash = hash_content_impl(&original);
    let consolidated_hash = hash_content_impl(&consolidated);
    objects
        .entry(original_hash.clone())
        .or_insert_with(|| original.clone());
    objects
        .entry(consolidated_hash.clone())
        .or_insert_with(|| consolidated.clone());

    let manifest_path = sidecar::sidecar_dir(&store).join("manifest.json");
    let manifest_source_preimage = read_optional_regular(&manifest_path)?;
    let manifest_original = Some(match &manifest_source_preimage {
        Some(bytes) => bytes.clone(),
        None => sidecar::initial_manifest_bytes(&store)?,
    });
    let manifest_original_text = manifest_original
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| {
            CliError::Corrupt(format!(
                "manifest is not valid UTF-8 for {} — repair it before consolidating",
                note.vault_rel()
            ))
        })?
        .map(ToOwned::to_owned);
    let manifest_blocks: Vec<(String, String)> = scan_impl(&consolidated)
        .iter()
        .filter_map(|span| {
            span.id().map(|id| {
                (
                    id.to_string(),
                    span.get("name").unwrap_or_default().to_string(),
                )
            })
        })
        .collect();
    let manifest_consolidated = sidecar::manifest_bytes(
        Some(store.note_id.as_str()),
        &note.vault_rel(),
        &manifest_blocks,
        head_ts,
    );
    let manifest_consolidated_text = String::from_utf8(manifest_consolidated.clone())
        .map_err(|_| CliError::Corrupt("generated manifest was not valid UTF-8".to_string()))?;
    let tabs_journal = tabs
        .iter()
        .map(|tab| sidecar::TabConsolidationTab {
            source_block: tab.source_block.clone(),
            title: tab.title.clone(),
        })
        .collect();
    let journal = sidecar::TabConsolidationJournal {
        format: 1,
        status: "pending".to_string(),
        note: note.vault_rel(),
        original: original_hash,
        consolidated: consolidated_hash,
        history,
        target_block,
        tabs: tabs_journal,
        versions,
        events,
        manifest_original: manifest_original_text,
        manifest_consolidated: manifest_consolidated_text,
    };
    preflight_plan(
        note,
        &store,
        &source_preimage,
        &ledger,
        &objects,
        &journal,
        manifest_source_preimage.as_deref(),
        &manifest_consolidated,
    )?;
    let planned_writes = objects
        .iter()
        .filter_map(|(hash, content)| {
            sidecar::preflight_object_write(&store, hash, content)
                .ok()
                .filter(|needs_write| *needs_write)
        })
        .count();
    Ok(Some(NotePlan {
        note: note.clone(),
        store,
        source_preimage,
        original,
        consolidated,
        ledger_preimage: ledger,
        objects,
        journal,
        manifest_source_preimage,
        manifest_original,
        manifest_consolidated,
        source_blocks: spans.len(),
        tabs: tabs.len(),
        source_add_events: candidates.len(),
        target_add_events: if history && spans.len() > 1 {
            candidates.len()
        } else {
            0
        },
        callout_sections,
        code_sections,
        planned_writes,
    }))
}

fn validate_titles(titles: &[String], note: &vault::NoteRef) -> Result<()> {
    let mut seen = BTreeSet::new();
    for title in titles {
        if title.is_empty()
            || title.contains(['\r', '\n'])
            || title.contains('{')
            || title.contains('}')
        {
            return Err(CliError::BadArgs(format!(
                "tab title {title:?} in {} is not representable safely",
                note.vault_rel()
            )));
        }
        if !seen.insert(title) {
            return Err(CliError::BadArgs(format!(
                "tab title {title:?} occurs more than once in {}",
                note.vault_rel()
            )));
        }
    }
    Ok(())
}

fn replace_one_body(doc: &str, span: &BlockSpan, body: &str) -> String {
    let mut out =
        String::with_capacity(doc.len() - (span.content_end - span.content_start) + body.len());
    out.push_str(&doc[..span.content_start]);
    out.push_str(body);
    out.push_str(&doc[span.content_end..]);
    out
}

fn consolidated_event_id(kind: &str, source: &str) -> String {
    format!("tab-consolidation:{kind}:{source}")
}

fn next_timestamp(events: &[Event]) -> Result<u64> {
    next_timestamp_with(events, std::iter::empty())
}

fn next_timestamp_with<'a>(
    existing: &[Event],
    planned: impl Iterator<Item = &'a Event>,
) -> Result<u64> {
    let existing_max = existing.iter().map(event_timestamp).max().unwrap_or(0);
    let planned_max = planned.map(event_timestamp).max().unwrap_or(0);
    let max_ts = existing_max.max(planned_max);
    let next = engine::now_ms().max(max_ts.checked_add(1).ok_or_else(|| {
        CliError::Corrupt("no valid timestamp remains for tab consolidation".to_string())
    })?);
    if next > sidecar::MAX_EVENT_TIMESTAMP_MS
        || next > engine::now_ms().saturating_add(sidecar::MAX_FUTURE_EVENT_SKEW_MS)
    {
        return Err(CliError::Corrupt(
            "no collision-safe tab-consolidation timestamp is available within the accepted clock window"
                .to_string(),
        ));
    }
    Ok(next)
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

fn validate_prospective_ledger(
    existing: &[Event],
    planned: &[Event],
    target_block: &str,
    source_adds: usize,
    history: bool,
) -> Result<()> {
    let mut prospective = existing.to_vec();
    prospective.extend_from_slice(planned);
    let resolution = resolve_ledger_impl(&prospective).map_err(|error| {
        CliError::Corrupt(format!(
            "planned tab-consolidation ledger does not resolve: {error}"
        ))
    })?;
    let target = resolution.blocks.get(target_block).ok_or_else(|| {
        CliError::Corrupt("planned target block is absent from the folded ledger".to_string())
    })?;
    if history && target.versions.len() > source_adds.saturating_add(1) {
        return Err(CliError::Corrupt(
            "planned target history contains more visible versions than its source events"
                .to_string(),
        ));
    }
    if target.head.is_none() {
        return Err(CliError::Corrupt(
            "planned target block has no effective head".to_string(),
        ));
    }
    Ok(())
}

fn read_optional_regular(path: &std::path::Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => fs::read(path)
            .map(Some)
            .map_err(io_ctx(path.display().to_string())),
        Ok(_) => Err(CliError::Corrupt(format!(
            "manifest is not a regular file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_ctx(path.display().to_string())(error)),
    }
}

fn preflight_plan(
    note: &vault::NoteRef,
    store: &NoteStore,
    original: &str,
    ledger: &[Event],
    objects: &BTreeMap<String, String>,
    journal: &sidecar::TabConsolidationJournal,
    manifest_original: Option<&[u8]>,
    manifest_consolidated: &[u8],
) -> Result<()> {
    sidecar::preflight_note_record(store)?;
    if engine::read_doc(&note.abs)? != original {
        return Err(CliError::BadArgs(format!(
            "note changed during tab-consolidation planning: {}",
            note.vault_rel()
        )));
    }
    if sidecar::read_ledger(store)? != ledger {
        return Err(CliError::BadArgs(format!(
            "ledger changed during tab-consolidation planning: {}",
            note.vault_rel()
        )));
    }
    for (hash, content) in objects {
        sidecar::preflight_object_write(store, hash, content)?;
    }
    sidecar::preflight_tab_consolidation_journal(store, journal)?;
    sidecar::preflight_event_append(store, &journal.events)?;
    let manifest_path = sidecar::sidecar_dir(store).join("manifest.json");
    if read_optional_regular(&manifest_path)?.as_deref() != manifest_original {
        return Err(CliError::BadArgs(format!(
            "manifest changed during tab-consolidation planning: {}",
            note.vault_rel()
        )));
    }
    if manifest_consolidated.len() > sidecar::MAX_LEDGER_BYTES {
        return Err(CliError::Corrupt(
            "planned manifest exceeds the sidecar size limit".to_string(),
        ));
    }
    Ok(())
}

/// One validation conflict discovered while planning tab consolidation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationConflict {
    /// Vault-relative note path.
    pub path: String,
    /// Source block id, when the conflict belongs to one block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// Stable machine-readable conflict kind.
    pub kind: String,
    /// Human-readable explanation and recovery direction.
    pub detail: String,
}

/// Aggregate report for one tab-consolidation invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidateReport {
    /// Input path exactly as supplied by the caller.
    pub path: String,
    /// Whether stored history was selected.
    pub history: bool,
    /// Whether this invocation was read-only.
    pub dry_run: bool,
    /// Markdown notes scanned beneath the selected scope.
    pub scanned_notes: usize,
    /// Notes containing more than one prompt block.
    pub selected_notes: usize,
    /// Source prompt blocks selected.
    pub source_blocks: usize,
    /// Fresh target blocks planned or already published.
    pub target_blocks: usize,
    /// Logical prompt tabs planned or already published.
    pub tabs: usize,
    /// Source AddVersion events inspected.
    pub source_add_events: usize,
    /// Target AddVersion events planned or already published.
    pub target_add_events: usize,
    /// Native top-level callout sections found.
    pub callout_sections: usize,
    /// Native top-level fenced-code sections found.
    pub code_sections: usize,
    /// Immutable objects that need writing.
    pub planned_writes: usize,
    /// Notes whose completed journal already describes the live result.
    pub already_consolidated: usize,
    /// All validation conflicts in stable note order.
    pub conflicts: Vec<ConsolidationConflict>,
}

/// Plan or execute prompt-block consolidation for a note or directory.
///
/// # Arguments
/// * `ctx` - resolved CLI context, including vault and output mode
/// * `path` - note or directory path
/// * `history` - preserve source AddVersion histories in the target block
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
/// let report = mica_cli::consolidate::consolidate_tabs(&ctx, "Prompts", true, true)?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn consolidate_tabs(
    ctx: &Ctx,
    path: &str,
    history: bool,
    dry_run: bool,
) -> Result<ConsolidateReport> {
    let scope = vault::resolve_note_scope_at(path, ctx.vault.as_deref(), ctx.store_dir.as_deref())?;
    if dry_run { scope.store.require_ready()?; }
    let mut report = ConsolidateReport {
        path: path.to_string(),
        history,
        dry_run,
        scanned_notes: scope.notes.len(),
        selected_notes: 0,
        source_blocks: 0,
        target_blocks: 0,
        tabs: 0,
        source_add_events: 0,
        target_add_events: 0,
        callout_sections: 0,
        code_sections: 0,
        planned_writes: 0,
        already_consolidated: 0,
        conflicts: Vec::new(),
    };
    let mut plans = Vec::new();
    let mut pending = Vec::new();
    for note in &scope.notes {
        let source_preimage = engine::read_doc(&note.abs)?;
        let (original, store) = engine::plan_history_store(note, &source_preimage, dry_run)?;
        match sidecar::read_tab_consolidation_journal(&store) {
            Ok(Some(journal)) if journal.status == "complete" => {
                match verify_completed(&store, &journal) {
                    Ok(()) => {
                        accumulate_journal(&mut report, &journal);
                        report.already_consolidated += 1;
                    }
                    Err(error) => report.conflicts.push(ConsolidationConflict {
                        path: note.vault_rel(),
                        block: Some(journal.target_block),
                        kind: "completed-journal-diverged".to_string(),
                        detail: error.to_string(),
                    }),
                }
            }
            Ok(Some(journal)) => {
                accumulate_journal(&mut report, &journal);
                pending.push((store, journal));
            }
            Ok(None) => match plan_note(note, store, source_preimage, original, history) {
                Ok(Some(plan)) => {
                    accumulate_plan(&mut report, &plan);
                    plans.push(plan);
                }
                Ok(None) => {}
                Err(error) => report.conflicts.push(ConsolidationConflict {
                    path: note.vault_rel(),
                    block: None,
                    kind: "planning-conflict".to_string(),
                    detail: error.to_string(),
                }),
            },
            Err(error) => report.conflicts.push(ConsolidationConflict {
                path: note.vault_rel(),
                block: None,
                kind: "corrupt-consolidation-journal".to_string(),
                detail: error.to_string(),
            }),
        }
    }
    if !report.conflicts.is_empty() || dry_run {
        return Ok(report);
    }
    for (store, journal) in pending {
        resume_pending(&store, &journal)?;
    }
    for plan in &plans {
        publish_plan(plan)?;
    }
    Ok(report)
}

/// Run consolidation and print the selected human or JSON report.
///
/// # Arguments
/// * `ctx` - resolved CLI context
/// * `path` - note or directory path
/// * `history` - preserve source histories
/// * `dry_run` - perform no writes
///
/// # Returns
/// `()` after reporting the completed plan or publication.
///
/// # Panics
/// None.
///
/// # Examples
/// ```no_run
/// # use mica_cli::commands::Ctx;
/// # let ctx: Ctx = todo!();
/// mica_cli::consolidate::run(&ctx, "Prompts", true, true)?;
/// # Ok::<(), mica_cli::CliError>(())
/// ```
pub fn run(ctx: &Ctx, path: &str, history: bool, dry_run: bool) -> Result<()> {
    let report = consolidate_tabs(ctx, path, history, dry_run)?;
    if ctx.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|error| CliError::Corrupt(error.to_string()))?
        );
    } else {
        let mode = if dry_run { "planned" } else { "completed" };
        println!(
            "{} tab consolidation {mode}: {} note(s), {} source block(s), {} tab(s), {} source version event(s), {} target version event(s), {} callout section(s), {} code section(s)",
            if report.conflicts.is_empty() {
                ctx.style.green("✓")
            } else {
                ctx.style.red("✗")
            },
            report.selected_notes,
            report.source_blocks,
            report.tabs,
            report.source_add_events,
            report.target_add_events,
            report.callout_sections,
            report.code_sections,
        );
        for conflict in &report.conflicts {
            println!(
                "  {} {} — {}: {}",
                ctx.style.red("•"),
                conflict.path,
                conflict.kind,
                conflict.detail
            );
        }
    }
    if report.conflicts.is_empty() {
        Ok(())
    } else {
        Err(CliError::Corrupt(format!(
            "tab consolidation was blocked by {} conflict(s); no new consolidation writes were performed",
            report.conflicts.len()
        )))
    }
}

fn accumulate_plan(report: &mut ConsolidateReport, plan: &NotePlan) {
    report.selected_notes += 1;
    report.source_blocks += plan.source_blocks;
    report.target_blocks += 1;
    report.tabs += plan.tabs;
    report.source_add_events += plan.source_add_events;
    report.target_add_events += plan.target_add_events;
    report.callout_sections += plan.callout_sections;
    report.code_sections += plan.code_sections;
    report.planned_writes += plan.planned_writes;
}

fn accumulate_journal(report: &mut ConsolidateReport, journal: &sidecar::TabConsolidationJournal) {
    report.selected_notes += 1;
    report.source_blocks += journal.tabs.len();
    report.target_blocks += 1;
    report.tabs += journal.tabs.len();
    report.source_add_events += journal.versions.len();
    report.target_add_events += journal
        .events
        .iter()
        .filter(|event| matches!(event, Event::AddVersion { .. } | Event::Checkpoint { .. }))
        .count();
}

fn publish_plan(plan: &NotePlan) -> Result<()> {
    if engine::read_doc(&plan.note.abs)? != plan.source_preimage
        || sidecar::read_ledger(&plan.store)? != plan.ledger_preimage
    {
        return Err(CliError::BadArgs(format!(
            "tab-consolidation plan became stale for {} — rerun against the latest note and ledger",
            plan.note.vault_rel()
        )));
    }
    let manifest_path = sidecar::sidecar_dir(&plan.store).join("manifest.json");
    if read_optional_regular(&manifest_path)? != plan.manifest_source_preimage {
        return Err(CliError::BadArgs(format!(
            "tab-consolidation plan became stale because the manifest changed for {}",
            plan.note.vault_rel()
        )));
    }
    engine::validate_journal_generations(&plan.store, &plan.original, &plan.consolidated)?;
    engine::preflight_journal_events(&plan.store, &plan.journal.events)?;
    sidecar::validate_manifest_bytes(&plan.store, &plan.manifest_consolidated)?;
    engine::validate_note_identity(&plan.note, &plan.original)?;
    sidecar::preflight_journal_claim(
        &plan.store,
        &sidecar::tab_consolidation_journal_path(&plan.store),
        None,
    )?;
    plan.store.root.claim_location()?;
    sidecar::preflight_note_record(&plan.store)?;
    if plan.source_preimage != plan.original {
        fsutil::atomic_write_if_unchanged(&plan.note.abs, plan.source_preimage.as_bytes(), plan.original.as_bytes())?;
    }
    engine::guard_note_store(&plan.note, &plan.store, &plan.original)?;
    sidecar::ensure_note_record(&plan.store)?;
    if read_optional_regular(&manifest_path)? != plan.manifest_original {
        return Err(CliError::Corrupt("initialized manifest does not match the planned exact preimage".to_string()));
    }
    for (hash, content) in &plan.objects {
        sidecar::write_object(&plan.store, hash, content)?;
        sidecar::verify_written_object(&plan.store, hash, content)?;
    }
    sidecar::claim_tab_consolidation_journal(&plan.store, &plan.journal, None)?;
    if plan.original != plan.consolidated {
        engine::guard_note_store(&plan.note, &plan.store, &plan.original)?;
        fsutil::atomic_write_if_unchanged(
            &plan.note.abs,
            plan.original.as_bytes(),
            plan.consolidated.as_bytes(),
        )?;
    }
    append_missing_events(&plan.store, &plan.journal.events)?;
    publish_manifest(
        &plan.store,
        &manifest_path,
        plan.manifest_original.as_deref(),
        &plan.manifest_consolidated,
    )?;
    verify_pending_result(&plan.store, &plan.journal)?;
    let mut completed = plan.journal.clone();
    completed.status = "complete".to_string();
    sidecar::write_tab_consolidation_journal(&plan.store, &completed)
}

fn resume_pending(store: &NoteStore, journal: &sidecar::TabConsolidationJournal) -> Result<()> {
    let note = vault::NoteRef { abs: store.note.clone(), vault: store.root.vault.clone(), store: Some(store.root.clone()) };
    let original = sidecar::read_object(store, &journal.original)?.ok_or_else(|| {
        CliError::Corrupt(format!(
            "pending tab-consolidation preimage {} is missing",
            journal.original
        ))
    })?;
    let consolidated =
        sidecar::read_object(store, &journal.consolidated)?.ok_or_else(|| {
            CliError::Corrupt(format!(
                "pending tab-consolidation result {} is missing",
                journal.consolidated
            ))
        })?;
    engine::validate_journal_generations(store, &original, &consolidated)?;
    engine::preflight_journal_events(store, &journal.events)?;
    let manifest_path = sidecar::sidecar_dir(store).join("manifest.json");
    let _manifest_state = manifest_publication_state(
        store,
        &manifest_path,
        journal.manifest_original.as_deref().map(str::as_bytes),
        journal.manifest_consolidated.as_bytes(),
    )?;
    let current = engine::read_doc(&note.abs)?;
    if current != original && current != consolidated {
        return Err(CliError::Corrupt(format!(
            "pending tab-consolidation note diverged from both journaled generations: {}",
            note.vault_rel()
        )));
    }
    store.root.claim_location()?;
    engine::guard_note_store(&note, store, &current)?;
    if current == original && original != consolidated {
        fsutil::atomic_write_if_unchanged(&note.abs, original.as_bytes(), consolidated.as_bytes())?;
    }
    append_missing_events(store, &journal.events)?;
    let manifest_path = sidecar::sidecar_dir(store).join("manifest.json");
    publish_manifest(
        store,
        &manifest_path,
        journal.manifest_original.as_deref().map(str::as_bytes),
        journal.manifest_consolidated.as_bytes(),
    )?;
    verify_pending_result(store, journal)?;
    let mut completed = journal.clone();
    completed.status = "complete".to_string();
    sidecar::write_tab_consolidation_journal(store, &completed)
}

fn manifest_publication_state(
    store: &NoteStore,
    path: &std::path::Path,
    original: Option<&[u8]>,
    consolidated: &[u8],
) -> Result<(Option<Vec<u8>>, bool)> {
    sidecar::preflight_note_record(store)?;
    sidecar::validate_manifest_bytes(store, consolidated)?;
    let current = read_optional_regular(path)?;
    if let Some(bytes) = current.as_deref() {
        if bytes == consolidated || sidecar::manifest_matches_except_hint(store, bytes, consolidated)? {
            return Ok((current, true));
        }
    }
    let matches_original = match (current.as_deref(), original) {
        (Some(bytes), Some(expected)) => bytes == expected || sidecar::manifest_matches_except_hint(store, bytes, expected)?,
        (None, None) => true,
        _ => false,
    };
    if !matches_original {
        return Err(CliError::Corrupt(format!(
            "manifest diverged from both tab-consolidation generations: {}",
            path.display()
        )));
    }
    Ok((current, false))
}

fn publish_manifest(
    store: &NoteStore,
    path: &std::path::Path,
    original: Option<&[u8]>,
    consolidated: &[u8],
) -> Result<()> {
    let (current, already_published) = manifest_publication_state(store, path, original, consolidated)?;
    if already_published { return Ok(()); }
    store.root.claim_location()?;
    sidecar::preflight_note_record(store)?;
    match current.as_deref() {
        Some(bytes) => fsutil::atomic_write_if_unchanged(path, bytes, consolidated),
        None => fsutil::atomic_write(path, consolidated),
    }
}

fn append_missing_events(note: &NoteStore, events: &[Event]) -> Result<()> {
    engine::preflight_journal_events(note, events)?;
    let status = sidecar::classify_event_batch(note, events)?;
    sidecar::append_events(note, &status.missing)?;
    if sidecar::classify_event_batch(note, events)?
        .missing
        .is_empty()
    {
        Ok(())
    } else {
        Err(CliError::Corrupt(format!(
            "tab-consolidation events could not be verified for {} — rerun to resume",
            note.note.display()
        )))
    }
}

fn verify_pending_result(
    store: &NoteStore,
    journal: &sidecar::TabConsolidationJournal,
) -> Result<()> {
    let note = vault::NoteRef { abs: store.note.clone(), vault: store.root.vault.clone(), store: Some(store.root.clone()) };
    let consolidated =
        sidecar::read_object(store, &journal.consolidated)?.ok_or_else(|| {
            CliError::Corrupt(format!(
                "tab-consolidation result object {} is missing",
                journal.consolidated
            ))
        })?;
    // An offline cutover may have prepared a previously unanchored note.
    // Compare that one shared, guarded source insertion in memory; immutable
    // objects and historical journal bytes retain their original addresses.
    let expected_source = match mica_core::note_id_impl(&consolidated)
        .map_err(|error| CliError::Corrupt(error.to_string()))? {
        Some(id) if id == store.note_id => consolidated.clone(),
        None if journal.status == "complete" => mica_core::set_note_id_impl(&consolidated, None, &store.note_id)
            .map_err(|error| CliError::Corrupt(error.to_string()))?,
        _ => return Err(CliError::Corrupt("consolidated source identity conflicts with its note record".to_string())),
    };
    if engine::read_doc(&note.abs)? != expected_source {
        return Err(CliError::Corrupt(format!(
            "live note does not equal the journaled tab-consolidation result for {}",
            note.vault_rel()
        )));
    }
    let events = sidecar::read_ledger(store)?;
    let resolution = resolve_ledger_impl(&events).map_err(|error| {
        CliError::Corrupt(format!(
            "tab-consolidation ledger verification failed for {}: {error}",
            note.vault_rel()
        ))
    })?;
    let state = resolution
        .blocks
        .get(&journal.target_block)
        .ok_or_else(|| {
            CliError::Corrupt(
                "tab-consolidation target is absent from the folded ledger".to_string(),
            )
        })?;
    let doc = engine::read_doc(&note.abs)?;
    let target = scan_impl(&doc)
        .into_iter()
        .find(|span| span.id() == Some(journal.target_block.as_str()))
        .ok_or_else(|| {
            CliError::Corrupt(
                "tab-consolidation target block is absent from the live note".to_string(),
            )
        })?;
    let live_hash = hash_content_impl(block_body(&doc, &target));
    let head_hash = state.head.as_deref().map(|hash| sidecar::resolve_note_hash(store, hash)).transpose()?;
    if head_hash.as_deref() != Some(live_hash.as_str()) {
        return Err(CliError::Corrupt(format!(
            "target head does not equal the live tabbed body for {}",
            note.vault_rel()
        )));
    }
    let manifest_path = sidecar::sidecar_dir(store).join("manifest.json");
    let manifest = read_optional_regular(&manifest_path)?;
    let manifest_matches = match manifest.as_deref() {
        Some(bytes) => bytes == journal.manifest_consolidated.as_bytes()
            || sidecar::manifest_matches_except_hint(store, bytes, journal.manifest_consolidated.as_bytes())?,
        None => false,
    };
    if !manifest_matches {
        return Err(CliError::Corrupt(format!(
            "manifest does not equal the journaled tab-consolidation result for {}",
            note.vault_rel()
        )));
    }
    let status = sidecar::classify_event_batch_in(&events, &journal.events)?;
    if !status.missing.is_empty() {
        return Err(CliError::Corrupt(
            "one or more journaled tab-consolidation events are missing".to_string(),
        ));
    }
    for mapping in &journal.versions {
        if sidecar::read_object(store, &mapping.source_hash)?.is_none()
            || sidecar::read_object(store, &mapping.target_hash)?.is_none()
        {
            return Err(CliError::Corrupt(format!(
                "mapped source or target version object is missing for event {}",
                mapping.source_event
            )));
        }
    }
    Ok(())
}

fn verify_completed(store: &NoteStore, journal: &sidecar::TabConsolidationJournal) -> Result<()> {
    if journal.status != "complete" {
        return Err(CliError::Corrupt(
            "historical inspection requires a completed tab-consolidation journal".to_string(),
        ));
    }
    sidecar::preflight_tab_consolidation_journal(store, journal)?;
    let original = sidecar::read_object(store, &journal.original)?.ok_or_else(|| {
        CliError::Corrupt("tab-consolidation original object is missing".to_string())
    })?;
    let consolidated = sidecar::read_object(store, &journal.consolidated)?.ok_or_else(|| {
        CliError::Corrupt("tab-consolidation result object is missing".to_string())
    })?;
    // Offline identity binding may add this anchor to the live note while the
    // immutable historical object and its address retain their original bytes.
    let bound_result = match mica_core::note_id_impl(&consolidated)
        .map_err(|error| CliError::Corrupt(error.to_string()))?
    {
        Some(id) if id == store.note_id => consolidated.clone(),
        None => mica_core::set_note_id_impl(&consolidated, None, &store.note_id)
            .map_err(|error| CliError::Corrupt(error.to_string()))?,
        _ => {
            return Err(CliError::Corrupt(
                "consolidated source identity conflicts with its note record".to_string(),
            ));
        }
    };
    engine::validate_journal_generations(store, &original, &bound_result)?;
    if let Some(manifest) = &journal.manifest_original {
        sidecar::validate_historical_manifest(store, manifest.as_bytes())?;
    }

    let ledger = sidecar::read_ledger_report(store)?;
    if ledger.bad_lines != 0 {
        return Err(CliError::Corrupt(
            "completed tab-consolidation history contains invalid ledger lines".to_string(),
        ));
    }
    resolve_ledger_impl(&ledger.events).map_err(|error| {
        CliError::Corrupt(format!(
            "tab-consolidation ledger verification failed: {error}"
        ))
    })?;
    if !sidecar::classify_event_batch_in(&ledger.events, &journal.events)?
        .missing
        .is_empty()
    {
        return Err(CliError::Corrupt(
            "one or more journaled tab-consolidation events are missing".to_string(),
        ));
    }
    let mut remaining: HashSet<_> = journal.events.iter().map(sidecar::event_eid).collect();
    if remaining.is_empty() {
        return Err(CliError::Corrupt(
            "completed tab-consolidation journal has no completion events".to_string(),
        ));
    }
    // The first prefix containing every exact journal event describes its
    // completed transaction. Later checkpoints, metadata and identical replays
    // cannot move that historical boundary forward.
    let end = ledger
        .events
        .iter()
        .position(|event| {
            remaining.remove(sidecar::event_eid(event));
            remaining.is_empty()
        })
        .ok_or_else(|| CliError::Corrupt("journal completion prefix is missing".to_string()))?;
    let prefix = &ledger.events[..=end];
    let historical = resolve_ledger_impl(prefix).map_err(|error| {
        CliError::Corrupt(format!(
            "tab-consolidation completion graph is invalid: {error}"
        ))
    })?;
    let state = historical
        .blocks
        .get(&journal.target_block)
        .ok_or_else(|| {
            CliError::Corrupt(
                "tab-consolidation target is absent from its completion graph".to_string(),
            )
        })?;
    let spans = scan_impl(&consolidated);
    let target = spans
        .iter()
        .find(|span| span.id() == Some(journal.target_block.as_str()))
        .ok_or_else(|| {
            CliError::Corrupt(
                "tab-consolidation target is absent from its result object".to_string(),
            )
        })?;
    let result_hash = hash_content_impl(block_body(&consolidated, target));
    let recorded_head = state
        .head
        .as_deref()
        .map(|hash| sidecar::resolve_note_hash(store, hash))
        .transpose()?;
    if recorded_head.as_deref() != Some(result_hash.as_str()) {
        return Err(CliError::Corrupt(
            "journaled target head does not match the historical consolidated body".to_string(),
        ));
    }
    let blocks: Vec<_> = spans
        .iter()
        .filter_map(|span| {
            span.id().map(|id| {
                (
                    id.to_string(),
                    span.get("name").unwrap_or_default().to_string(),
                )
            })
        })
        .collect();
    let completed_at = journal
        .events
        .iter()
        .map(event_timestamp)
        .max()
        .ok_or_else(|| {
            CliError::Corrupt("tab-consolidation completion timestamp is missing".to_string())
        })?;
    let expected_manifest = sidecar::manifest_bytes(
        Some(store.note_id.as_str()),
        &journal.note,
        &blocks,
        completed_at,
    );
    if !sidecar::historical_manifests_match(
        store,
        &expected_manifest,
        journal.manifest_consolidated.as_bytes(),
    )? {
        return Err(CliError::Corrupt(
            "journaled manifest does not describe the historical consolidation result".to_string(),
        ));
    }
    let by_eid: HashMap<_, _> = prefix
        .iter()
        .map(|event| (sidecar::event_eid(event), event))
        .collect();
    for mapping in &journal.versions {
        match by_eid.get(mapping.source_event.as_str()).copied() {
            Some(Event::AddVersion { block, hash, .. } | Event::Checkpoint { block, hash, .. })
                if block == &mapping.source_block && hash == &mapping.source_hash => {}
            _ => {
                return Err(CliError::Corrupt(
                    "journaled source checkpoint disagrees with its historical mapping".to_string(),
                ));
            }
        }
        if sidecar::read_object(store, &mapping.source_hash)?.is_none()
            || sidecar::read_object(store, &mapping.target_hash)?.is_none()
        {
            return Err(CliError::Corrupt(
                "journaled source or target version object is missing".to_string(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn inspect_completed_journal(
    store: &NoteStore,
    journal: &sidecar::TabConsolidationJournal,
) -> Result<()> {
    verify_completed(store, journal)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;
    use crate::output::Style;

    fn test_store(path: &std::path::Path) -> NoteStore {
        let note = vault::NoteRef { abs: path.to_path_buf(), vault: vault::find_vault(None, path.parent().expect("fixture parent")).expect("fixture vault"), store: None };
        let source = engine::read_doc(path).expect("fixture source");
        let prepared = mica_core::note_id_impl(&source).expect("fixture identity")
            .map(|_| source.clone()).unwrap_or_else(|| mica_core::set_note_id_impl(&source, None, &format!("fixture-{}", hash_content_impl(&path.to_string_lossy()))).expect("fixture anchor"));
        if prepared != source { std::fs::write(path, &prepared).expect("stamp fixture identity"); }
        engine::require_store(&note, &prepared).expect("fixture handle")
    }

    fn fixture(doc: &str) -> (tempfile::TempDir, Ctx, std::path::PathBuf) {
        let directory = tempfile::tempdir().expect("temporary vault");
        std::fs::create_dir(directory.path().join(".obsidian")).expect("vault marker");
        let note = directory.path().join("Note.md");
        std::fs::write(&note, doc).expect("seed note");
        let ctx = Ctx {
            vault: Some(directory.path().to_path_buf()),
            store_dir: None,
            json: true,
            style: Style::forced(false),
        };
        (directory, ctx, note)
    }

    #[test]
    fn consolidates_two_prompt_blocks_into_two_tabs() {
        let body = concat!(
            ":::section\n",
            "Review this draft.\n",
            "> [!example]- Example Data\n",
            "> one\n",
            "```json\n",
            "{\"ok\":true}\n",
            "```\n",
            ":::\n",
        );
        let (semantic, callouts, code) =
            semanticize_body(body).expect("semantic section projection");
        assert_eq!(
            semantic,
            concat!(
                ":::section\n",
                "Review this draft.\n",
                ":::\n",
                "> [!example]- Example Data\n",
                "> one\n",
                "```json\n",
                "{\"ok\":true}\n",
                "```\n",
            )
        );
        assert_eq!(callouts, 1);
        assert_eq!(code, 1);
    }

    #[test]
    fn source_cache_skips_unique_bodies_and_evicts_reuse_after_last_use() {
        let hashes = ["once", "twice", "twice"];
        let mut cache = SourceObjectCache::new(hashes.into_iter(), usize::MAX);
        let mut loads = 0;

        let once = cache
            .with_body(
                "once",
                || {
                    loads += 1;
                    Ok(("one".to_string(), 0, 0))
                },
                |body| Ok(body.0.clone()),
            )
            .expect("consume unique body");
        assert_eq!(once, "one");
        assert!(!cache.entries.contains_key("once"));

        for _ in 0..2 {
            let twice = cache
                .with_body(
                    "twice",
                    || {
                        loads += 1;
                        Ok(("two".to_string(), 0, 0))
                    },
                    |body| Ok(body.0.clone()),
                )
                .expect("consume repeated body");
            assert_eq!(twice, "two");
        }

        assert_eq!(loads, 2, "the repeated body should load only once");
        assert!(cache.entries.is_empty());
        assert!(cache.remaining.is_empty());
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn source_cache_reloads_repeated_body_that_exceeds_its_byte_budget() {
        let hashes = ["large", "large"];
        let mut cache = SourceObjectCache::new(hashes.into_iter(), 2);
        let mut loads = 0;

        for _ in 0..2 {
            cache
                .with_body(
                    "large",
                    || {
                        loads += 1;
                        Ok(("three".to_string(), 0, 0))
                    },
                    |_| Ok(()),
                )
                .expect("consume oversized repeated body");
            assert!(cache.entries.is_empty());
            assert_eq!(cache.bytes, 0);
        }

        assert_eq!(loads, 2);
        assert!(cache.remaining.is_empty());
    }

    #[test]
    fn rejects_non_whitespace_between_selected_blocks() {
        let doc = concat!(
            "## 🤖 Prompts\n",
            "```mica id=a\n",
            ":::section\none\n:::\n",
            "```\n",
            "KEEP OUTSIDE\n",
            "```mica id=b\n",
            ":::section\ntwo\n:::\n",
            "```\n",
        );
        let spans = prompt_spans(doc).expect("prompt spans");
        let error = replace_prompt_collection(doc, &spans, "replacement")
            .expect_err("interstitial content must fail closed");
        assert!(error.to_string().contains("non-whitespace content"));
    }

    #[test]
    fn prompt_heading_scan_ignores_headings_inside_mica_blocks() {
        let doc = concat!(
            "## 🤖 Prompts\n",
            "```mica id=a\n",
            "## authored inside the block\n",
            "body\n",
            "```\n",
            "## Following section\n",
            "outside\n",
        );

        let spans = prompt_spans(doc).expect("prompt spans");

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].id(), Some("a"));
    }

    #[test]
    fn publishes_one_fresh_tabbed_block_and_completed_journal() {
        let doc = concat!(
            "# Note\n\n",
            "## 🤖 Prompts\n",
            "```mica id=a name=\"First\"\n",
            ":::section\none\n:::\n",
            "```\n\n",
            "```mica id=b name=\"Second\"\n",
            ":::section\ntwo\n:::\n",
            "```\n",
        );
        let (_directory, ctx, note) = fixture(doc);
        let report = consolidate_tabs(&ctx, "Note.md", true, false).expect("publish consolidation");
        assert_eq!(report.selected_notes, 1, "{report:?}");
        assert_eq!(report.source_blocks, 2);
        assert_eq!(report.tabs, 2);

        let published = std::fs::read_to_string(&note).expect("read published note");
        let spans = prompt_spans(&published).expect("published spans");
        assert_eq!(spans.len(), 1);
        let body = block_body(&published, &spans[0]);
        assert!(body.contains("tab: First\n"));
        assert!(body.contains("tab: Second\n"));
        let journal = sidecar::read_tab_consolidation_journal(&test_store(&note))
            .expect("read journal")
            .expect("journal exists");
        assert_eq!(journal.status, "complete");
        assert_eq!(journal.tabs.len(), 2);
    }

    fn completed_consolidation_fixture(
        relative: &str,
    ) -> (
        tempfile::TempDir,
        vault::NoteRef,
        NoteStore,
        sidecar::TabConsolidationJournal,
    ) {
        let doc = concat!(
            "---\nmica-id: fixture-note\n---\n",
            "# Note\n\n## 🤖 Prompts\n",
            "```mica id=a name=\"First\"\n:::section\none\n:::\n```\n\n",
            "```mica id=b name=\"Second\"\n:::section\ntwo\n:::\n```\n",
        );
        let (directory, ctx, initial) = fixture(doc);
        let path = directory.path().join(relative);
        if path != initial {
            fs::create_dir_all(path.parent().expect("fixture note parent"))
                .expect("fixture note directory");
            fs::rename(initial, &path).expect("move unconsolidated fixture note");
        }
        let note = vault::NoteRef {
            abs: path.clone(),
            vault: directory.path().to_path_buf(),
            store: None,
        };
        engine::snapshot_note(&note, false, false).expect("seed source checkpoints");
        consolidate_tabs(&ctx, relative, true, false).expect("complete consolidation");
        let store = test_store(&path);
        let journal = sidecar::read_tab_consolidation_journal(&store)
            .expect("read completed journal")
            .expect("completed journal exists");
        (directory, note, store, journal)
    }

    /// Synthetic evidence must be retained on disk so scoped object reads test
    /// its integrity rather than rejecting an unreferenced pool object first.
    fn retain_fixture_journal(
        store: &NoteStore,
        journal: &sidecar::TabConsolidationJournal,
    ) -> NoteStore {
        fs::write(
            sidecar::tab_consolidation_journal_path(store),
            serde_json::to_vec_pretty(journal).expect("synthetic retained journal"),
        )
        .expect("retain owned fixture evidence");
        test_store(&store.note)
    }

    #[test]
    fn completed_consolidation_allows_later_edits_heads_manifests_and_restore() {
        let (_directory, note, store, journal) = completed_consolidation_fixture("Note.md");
        let journal_path = sidecar::tab_consolidation_journal_path(&store);
        let journal_bytes = fs::read(&journal_path).expect("journal preimage");
        let ledger_path = sidecar::ledger_path(&store);
        let ledger_before = fs::read(&ledger_path).expect("ledger preimage");
        let completed = engine::read_doc(&note.abs).expect("completed source");
        let original_state = engine::state_from_store(&store).expect("completed history");
        let restore_version = original_state[&journal.target_block].versions[0].clone();

        fs::write(&note.abs, format!("{completed}\nLater prose.\n")).expect("later authored prose");
        verify_completed(&store, &journal).expect("completed evidence survives later prose");
        assert!(engine::guard_note_store(&note, &store, &completed).is_err());
        let mut pending = journal.clone();
        pending.status = "pending".to_string();
        assert!(verify_pending_result(&store, &pending).is_err());
        assert!(verify_completed(&store, &pending).is_err());

        engine::set_content(&note, &journal.target_block, "Later edited body.\n")
            .expect("new checkpoint and refreshed manifest");
        verify_completed(&store, &journal).expect("completed evidence survives a later head");
        engine::restore_as_checkpoint(
            &note,
            &journal.target_block,
            &restore_version.version_id,
            &restore_version.hash,
        )
        .expect("restore as a new forward checkpoint");
        verify_completed(&store, &journal).expect("completed evidence survives restore");
        assert_eq!(
            fs::read(&journal_path).expect("retained journal"),
            journal_bytes
        );
        assert!(fs::read(&ledger_path)
            .expect("append-only history")
            .starts_with(&ledger_before));

        // Replayed identical event IDs do not move the historical completion
        // boundary past later checkpoints.
        let mut replayed = sidecar::read_ledger(&store).expect("current history");
        replayed.extend(journal.events.clone());
        let encoded = replayed
            .iter()
            .map(|event| serde_json::to_string(event).expect("fixture event"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&ledger_path, format!("{encoded}\n")).expect("identical replay fixture");
        verify_completed(&store, &journal).expect("identical replays retain first completion");
    }

    #[test]
    fn completed_consolidation_rejects_missing_or_corrupt_historical_objects() {
        for original in [true, false] {
            for missing in [true, false] {
                let (_directory, _note, store, journal) =
                    completed_consolidation_fixture("Note.md");
                let hash = if original {
                    &journal.original
                } else {
                    &journal.consolidated
                };
                let path = sidecar::object_path(&store, hash).expect("small fixture object");
                if missing {
                    fs::remove_file(path).expect("remove owned fixture object");
                } else {
                    fs::write(path, "corrupt fixture bytes").expect("corrupt owned fixture object");
                }
                assert!(verify_completed(&store, &journal).is_err());
            }
        }
    }

    #[test]
    fn completed_consolidation_rejects_forged_result_manifest_and_missing_events() {
        let (_directory, _note, store, journal) = completed_consolidation_fixture("Note.md");
        let result = sidecar::read_object(&store, &journal.consolidated)
            .expect("historical result")
            .expect("result object");
        let forged = result.replace("one", "forged body");
        assert_ne!(forged, result);
        let forged_hash = hash_content_impl(&forged);
        sidecar::write_object(&store, &forged_hash, &forged).expect("address-valid forged object");
        let mut wrong_result = journal.clone();
        wrong_result.consolidated = forged_hash;
        let forged_store = retain_fixture_journal(&store, &wrong_result);
        let error = verify_completed(&forged_store, &wrong_result)
            .expect_err("an address-valid forged result must disagree with its historical head");
        assert!(error.to_string().contains("historical consolidated body"));

        let mut wrong_manifest = journal.clone();
        let mut manifest: serde_json::Value =
            serde_json::from_str(&wrong_manifest.manifest_consolidated).expect("journal manifest");
        manifest["blocks"] = serde_json::json!({"forged": "wrong block"});
        wrong_manifest.manifest_consolidated =
            serde_json::to_string(&manifest).expect("fixture JSON");
        let manifest_store = retain_fixture_journal(&store, &wrong_manifest);
        let error = verify_completed(&manifest_store, &wrong_manifest)
            .expect_err("forged historical manifest");
        assert!(error
            .to_string()
            .contains("historical consolidation result"));

        let mut wrong_mapping = journal.clone();
        wrong_mapping.versions[0].source_event = "missing-source-checkpoint".to_string();
        let mapping_store = retain_fixture_journal(&store, &wrong_mapping);
        let error = verify_completed(&mapping_store, &wrong_mapping)
            .expect_err("forged source event mapping");
        assert!(error.to_string().contains("historical mapping"));

        let store = retain_fixture_journal(&store, &journal);
        let mut ledger = sidecar::read_ledger(&store).expect("fixture history");
        let last = journal.events.last().expect("journaled completion event");
        ledger.retain(|event| event != last);
        let encoded = ledger
            .iter()
            .map(|event| serde_json::to_string(event).expect("fixture event"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(sidecar::ledger_path(&store), format!("{encoded}\n"))
            .expect("missing journaled event fixture");
        let error = verify_completed(&store, &journal).expect_err("missing completion event");
        assert!(error
            .to_string()
            .contains("journaled tab-consolidation events are missing"));
    }

    #[test]
    fn completed_consolidation_allows_historical_unanchored_result() {
        let (_directory, _note, store, mut journal) = completed_consolidation_fixture("Note.md");
        let result = sidecar::read_object(&store, &journal.consolidated)
            .expect("historical result")
            .expect("result object");
        let unanchored = result
            .strip_prefix("---\nmica-id: fixture-note\n---\n")
            .expect("known fixture frontmatter");
        let hash = hash_content_impl(unanchored);
        sidecar::write_object(&store, &hash, unanchored).expect("unanchored historical object");
        journal.consolidated = hash;
        let mut manifest: serde_json::Value =
            serde_json::from_str(&journal.manifest_consolidated).expect("historical manifest");
        manifest["noteId"] = serde_json::Value::Null;
        journal.manifest_consolidated = serde_json::to_string(&manifest).expect("fixture JSON");
        let store = retain_fixture_journal(&store, &journal);
        verify_completed(&store, &journal)
            .expect("offline identity binding preserves old evidence");
    }

    #[test]
    fn completed_consolidation_survives_store_relocation_into_old_note_folder() {
        let (directory, note, store, journal) = completed_consolidation_fixture("Archive/Note.md");
        let journal_bytes = fs::read(sidecar::tab_consolidation_journal_path(&store))
            .expect("retained journal preimage");
        let ledger_bytes =
            fs::read(sidecar::ledger_path(&store)).expect("retained ledger preimage");
        let moved = directory.path().join("Moved.md");
        fs::rename(&note.abs, &moved).expect("legitimate note move");
        fs::remove_dir(directory.path().join("Archive")).expect("vacated note directory");
        let moved_store = test_store(&moved);
        sidecar::write_manifest(
            &moved_store,
            Some(&moved_store.note_id),
            "Moved.md",
            &[(journal.target_block.clone(), "Prompts".to_string())],
            journal
                .events
                .iter()
                .map(event_timestamp)
                .max()
                .expect("completion timestamp")
                + 1,
        )
        .expect("refresh current note hint before relocating storage");

        // Model the supported whole-store move in this isolated fixture. Its
        // locator and current hint change, while historical records keep bytes.
        let locator_path = directory.path().join("mica.json");
        let mut locator: serde_json::Value =
            serde_json::from_slice(&fs::read(&locator_path).expect("fixture locator"))
                .expect("locator JSON");
        locator["folder"] = serde_json::json!("Archive");
        fs::rename(
            directory.path().join("mica-data"),
            directory.path().join("Archive"),
        )
        .expect("move owned store");
        fs::write(
            &locator_path,
            serde_json::to_vec(&locator).expect("moved locator"),
        )
        .expect("publish owned fixture route");
        let moved_store = test_store(&moved);
        verify_completed(&moved_store, &journal).expect("old path is immutable metadata");
        assert_eq!(
            fs::read(sidecar::tab_consolidation_journal_path(&moved_store))
                .expect("unchanged moved journal"),
            journal_bytes
        );
        assert_eq!(
            fs::read(sidecar::ledger_path(&moved_store)).expect("unchanged ledger"),
            ledger_bytes
        );
        assert!(
            sidecar::validate_manifest_bytes(
                &moved_store,
                journal.manifest_consolidated.as_bytes(),
            )
            .is_err(),
            "current writable metadata must still reject managed paths"
        );

        let mut unsafe_hint = journal.clone();
        let mut manifest: serde_json::Value =
            serde_json::from_str(&unsafe_hint.manifest_consolidated).expect("historical manifest");
        manifest["path"] = serde_json::json!("../outside.md");
        unsafe_hint.manifest_consolidated = serde_json::to_string(&manifest).expect("fixture JSON");
        assert!(verify_completed(&moved_store, &unsafe_hint).is_err());
    }

    #[test]
    fn completed_consolidation_fix_keeps_pending_publication_conflicts_read_only() {
        let (_directory, note, store, journal) = completed_consolidation_fixture("Note.md");
        let mut pending = journal.clone();
        pending.status = "pending".to_string();
        let journal_path = sidecar::tab_consolidation_journal_path(&store);
        let pending_bytes = serde_json::to_vec_pretty(&pending).expect("pending fixture JSON");
        fs::write(&journal_path, &pending_bytes).expect("interrupted publication fixture");
        let current = format!(
            "{}\nLater user edit.\n",
            engine::read_doc(&note.abs).expect("source")
        );
        fs::write(&note.abs, &current).expect("diverged live generation");
        let ledger_path = sidecar::ledger_path(&store);
        let ledger = fs::read(&ledger_path).expect("history preimage");

        assert!(sidecar::write_tab_consolidation_journal(&store, &journal).is_err());
        assert_eq!(
            engine::read_doc(&note.abs).expect("preserved note"),
            current
        );
        assert_eq!(
            fs::read(&journal_path).expect("preserved pending journal"),
            pending_bytes
        );
        assert_eq!(fs::read(&ledger_path).expect("preserved history"), ledger);
    }

    #[test]
    fn maps_each_source_add_event_into_the_target_history() {
        let doc = concat!(
            "## 🤖 Prompts\n",
            "```mica id=a name=\"First\"\n",
            ":::section\nlive one\n:::\n",
            "```\n\n",
            "```mica id=b name=\"Second\"\n",
            ":::section\nlive two\n:::\n",
            "```\n",
        );
        let (_directory, ctx, note) = fixture(doc);
        let first = ":::section\nold one\n:::\n";
        let second = ":::section\nold two\n:::\n";
        let first_hash = hash_content_impl(first);
        let second_hash = hash_content_impl(second);
        sidecar::write_object(&test_store(&note), &first_hash, first).expect("first object");
        sidecar::write_object(&test_store(&note), &second_hash, second).expect("second object");
        sidecar::append_events(
            &test_store(&note),
            &[
                Event::AddVersion {
                    eid: "source-a".to_string(),
                    ts: 10,
                    block: "a".to_string(),
                    hash: first_hash,
                    label: Some("V0.1".to_string()),
                    origin: Some("migrated:bug".to_string()),
                    parent: None,
                },
                Event::AddVersion {
                    eid: "source-b".to_string(),
                    ts: 20,
                    block: "b".to_string(),
                    hash: second_hash,
                    label: Some("V0.2".to_string()),
                    origin: Some("migrated:success".to_string()),
                    parent: None,
                },
            ],
        )
        .expect("source ledger");

        consolidate_tabs(&ctx, "Note.md", true, false).expect("history consolidation");
        let journal = sidecar::read_tab_consolidation_journal(&test_store(&note))
            .expect("journal read")
            .expect("journal exists");
        assert_eq!(journal.versions.len(), 2);
        let resolution =
            resolve_ledger_impl(&sidecar::read_ledger(&test_store(&note)).expect("ledger")).expect("fold");
        let target = resolution
            .blocks
            .get(&journal.target_block)
            .expect("target history");
        assert_eq!(
            target.versions.len(),
            3,
            "the two imported checkpoints are followed by the live consolidated checkpoint"
        );
        assert_eq!(target.versions[0].label.as_deref(), Some("V0.1"));
        assert_eq!(target.versions[1].label.as_deref(), Some("V0.2"));
    }

    #[test]
    fn maps_identity_checkpoints_without_losing_lineage_labels_or_visibility() {
        let doc = concat!(
            "## 🤖 Prompts\n",
            "```mica id=a name=\"First\"\n",
            ":::section\nlive one\n:::\n",
            "```\n\n",
            "```mica id=b name=\"Second\"\n",
            ":::section\nlive two\n:::\n",
            "```\n",
        );
        let (_directory, ctx, note) = fixture(doc);
        let old = ":::section\nold\n:::\n";
        let edited = ":::section\nedited\n:::\n";
        let old_hash = hash_content_impl(old);
        let edited_hash = hash_content_impl(edited);
        sidecar::write_object(&test_store(&note), &old_hash, old).expect("old object");
        sidecar::write_object(&test_store(&note), &edited_hash, edited).expect("edited object");
        sidecar::append_events(
            &test_store(&note),
            &[
                Event::Checkpoint {
                    eid: "a-v1".to_string(),
                    ts: 10,
                    block: "a".to_string(),
                    hash: old_hash,
                    parent: None,
                    source: None,
                    cause: Some("snapshot".to_string()),
                },
                Event::Checkpoint {
                    eid: "a-v2".to_string(),
                    ts: 20,
                    block: "a".to_string(),
                    hash: edited_hash,
                    parent: Some("a-v1".to_string()),
                    source: None,
                    cause: Some("snapshot".to_string()),
                },
                Event::VersionLabel {
                    eid: "label-a-v2".to_string(),
                    ts: 21,
                    block: "a".to_string(),
                    target: "a-v2".to_string(),
                    label: Some("Reviewed".to_string()),
                },
                Event::VersionVisibility {
                    eid: "hide-a-v1".to_string(),
                    ts: 22,
                    block: "a".to_string(),
                    target: "a-v1".to_string(),
                    visible: false,
                },
                Event::MoveHead {
                    eid: "head-a".to_string(),
                    ts: 23,
                    block: "a".to_string(),
                    target: Some("a-v2".to_string()),
                },
            ],
        )
        .expect("identity source ledger");

        consolidate_tabs(&ctx, "Note.md", true, false).expect("identity history consolidation");
        let journal = sidecar::read_tab_consolidation_journal(&test_store(&note))
            .expect("journal read")
            .expect("journal exists");
        assert_eq!(journal.versions.len(), 2);
        assert!(journal
            .events
            .iter()
            .all(|event| !matches!(event, Event::AddVersion { .. })));
        let resolution =
            resolve_ledger_impl(&sidecar::read_ledger(&test_store(&note)).expect("ledger")).expect("fold");
        let target = resolution
            .blocks
            .get(&journal.target_block)
            .expect("target history");
        assert_eq!(target.removed_versions.len(), 1);
        let reviewed = target
            .versions
            .iter()
            .find(|version| version.label.as_deref() == Some("Reviewed"))
            .expect("mapped label");
        assert!(reviewed.parent_version_id.is_some());
        assert_eq!(reviewed.cause.as_deref(), Some("tab-consolidation"));
    }

    #[test]
    fn semantically_splits_single_block_live_and_history_in_place() {
        let live = concat!(
            ":::section\n",
            "live prompt\n",
            "> [!example]- Live Example\n",
            "> data\n",
            ":::\n",
        );
        let doc = format!("## 🤖 Prompts\n```mica id=a name=\"Only\"\n{live}```\n");
        let (_directory, ctx, note) = fixture(&doc);
        let historical = concat!(
            ":::section\n",
            "old prompt\n",
            "```json\n",
            "{}\n",
            "```\n",
            ":::\n",
        );
        let historical_hash = hash_content_impl(historical);
        sidecar::write_object(&test_store(&note), &historical_hash, historical).expect("history object");
        sidecar::append_events(
            &test_store(&note),
            &[Event::AddVersion {
                eid: "source-only".to_string(),
                ts: 10,
                block: "a".to_string(),
                hash: historical_hash,
                label: Some("V0.1".to_string()),
                origin: Some("migrated:bug".to_string()),
                parent: None,
            }],
        )
        .expect("source ledger");

        consolidate_tabs(&ctx, "Note.md", true, false).expect("semantic consolidation");
        let published = std::fs::read_to_string(&note).expect("published note");
        assert_eq!(prompt_spans(&published).expect("spans").len(), 1);
        assert!(published.contains(":::\n> [!example]- Live Example"));
        let journal = sidecar::read_tab_consolidation_journal(&test_store(&note))
            .expect("journal read")
            .expect("journal exists");
        assert_eq!(journal.target_block, "a");
        assert!(journal.events.iter().any(
            |event| matches!(event, Event::ReplaceVersion { target, .. } if target == "source-only")
        ));
        let resolution =
            resolve_ledger_impl(&sidecar::read_ledger(&test_store(&note)).expect("ledger")).expect("fold");
        let historical_effective = &resolution.blocks["a"].versions[0].hash;
        let effective = sidecar::read_object(&test_store(&note), historical_effective)
            .expect("read effective")
            .expect("effective exists");
        assert!(effective.contains(":::\n```json"));
    }

    #[test]
    fn outer_block_fence_outgrows_indented_code() {
        let source = block_source("demo", "  ```bash\ntrue\n  ```\n");
        assert!(source.starts_with("````mica id=demo\n"));
        assert!(source.ends_with("````\n"));
    }
}

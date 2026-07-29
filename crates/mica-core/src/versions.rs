//! Append-only version ledger: events plus a pure fold to current per-block
//! state. `eid`/`ts` are minted by the plugin (JS) because wasm has no clock;
//! everything here is a deterministic, idempotent function of the event list.

use crate::checkpoints::{effective_visible_parents, inferred_linear_parents, CheckpointIdentity};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fmt;

/// One ledger event.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    /// A version object was stored for a block.
    AddVersion {
        /// Unique event id (UUIDv7) — tiebreaker in the `(ts, eid)` fold order.
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id the version belongs to.
        block: String,
        /// Content hash of the stored object.
        hash: String,
        /// Optional human label (e.g. migrated archive names).
        #[serde(default)]
        label: Option<String>,
        /// Where the version came from (e.g. `migrated:success`).
        #[serde(default)]
        origin: Option<String>,
        /// Lineage: the hash this version was derived from (branch/edit-previous).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
    },
    /// Replace the object interpreted for one existing `add-version` event.
    ReplaceVersion {
        /// Unique event id (UUIDv7).
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id; must equal the target add event's block.
        block: String,
        /// Event id of the original `add-version` event.
        target: String,
        /// Content hash of the replacement object.
        hash: String,
    },
    /// A block's current head moved to a stored version.
    SetHead {
        /// Unique event id (UUIDv7).
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id.
        block: String,
        /// The new head's content hash.
        hash: String,
    },
    /// Set (or clear) the label of an already-stored version.
    Label {
        /// Unique event id (UUIDv7).
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id.
        block: String,
        /// The labeled version's content hash.
        hash: String,
        /// New label; `None` clears.
        #[serde(default)]
        label: Option<String>,
    },
    /// Store one logical checkpoint, even when its content hash already exists.
    Checkpoint {
        /// Stable checkpoint and event identity.
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id.
        block: String,
        /// Immutable content object hash.
        hash: String,
        /// Logical parent checkpoint identity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        /// Older checkpoint whose content this checkpoint restored.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        /// Optional machine-readable reason the checkpoint was created.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cause: Option<String>,
    },
    /// Move a block's HEAD by stable checkpoint identity.
    MoveHead {
        /// Unique event id.
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id.
        block: String,
        /// Target checkpoint, or no HEAD.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
    },
    /// Set or clear a checkpoint label by stable identity.
    VersionLabel {
        /// Unique event id.
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id.
        block: String,
        /// Target checkpoint identity.
        target: String,
        /// New label.
        #[serde(default)]
        label: Option<String>,
    },
    /// Show or remove a checkpoint from the ordinary timeline.
    VersionVisibility {
        /// Unique event id.
        eid: String,
        /// Event time, unix milliseconds.
        ts: u64,
        /// Block id.
        block: String,
        /// Target checkpoint identity.
        target: String,
        /// Whether the checkpoint is visible.
        visible: bool,
    },
}

/// Metadata for one stored version.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VersionMeta {
    /// Stable logical checkpoint identity.
    #[serde(rename = "versionId")]
    pub version_id: String,
    /// Content hash (also the object filename).
    pub hash: String,
    /// First-seen time, unix milliseconds.
    pub ts: u64,
    /// Human label, when one was ever set.
    pub label: Option<String>,
    /// Effective lineage parent after replacement resolution.
    pub parent: Option<String>,
    /// Original logical parent identity, including hidden checkpoints.
    #[serde(rename = "parentVersionId")]
    pub parent_version_id: Option<String>,
    /// Nearest visible logical parent identity.
    #[serde(rename = "effectiveParentVersionId")]
    pub effective_parent_version_id: Option<String>,
    /// Whether the ledger explicitly establishes this checkpoint as a lineage root.
    #[serde(default, rename = "lineageRoot")]
    pub lineage_root: bool,
    /// Older checkpoint whose bytes were deliberately restored.
    #[serde(rename = "sourceVersionId")]
    pub source_version_id: Option<String>,
    /// Optional machine-readable reason the checkpoint was created.
    pub cause: Option<String>,
    /// Whether this checkpoint appears in the ordinary timeline.
    pub visible: bool,
}

/// One replacement relationship resolved from an append-only ledger.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResolvedReplacement {
    /// Event id of the `replace-version` event.
    pub event: String,
    /// Replacement event time, unix milliseconds.
    pub ts: u64,
    /// Event id of the targeted `add-version` event.
    pub target: String,
    /// Block that owns the target version.
    pub block: String,
    /// Original object hash named by the target add event.
    pub original: String,
    /// Object hash named by this replacement event.
    pub replacement: String,
    /// Whether this event is the winning `(ts, eid)` replacement for its target.
    pub active: bool,
}

/// Fully resolved ledger state plus replacement metadata needed by validators.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct LedgerResolution {
    /// Current per-block version state.
    pub blocks: BTreeMap<String, BlockState>,
    /// Every valid replacement relationship, including superseded events.
    pub replacements: Vec<ResolvedReplacement>,
}

/// Semantic corruption detected while resolving append-only ledger events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LedgerError {
    /// One event id was reused for different event data.
    ConflictingEventId {
        /// Reused event id.
        eid: String,
    },
    /// A replacement refers to an event id absent from the ledger.
    MissingReplacementTarget {
        /// Replacement event id.
        event: String,
        /// Missing target event id.
        target: String,
    },
    /// A replacement target exists but is not an `add-version` event.
    ReplacementTargetNotVersion {
        /// Replacement event id.
        event: String,
        /// Invalid target event id.
        target: String,
    },
    /// A replacement names a different block than its target add event.
    ReplacementBlockMismatch {
        /// Replacement event id.
        event: String,
        /// Target add event id.
        target: String,
        /// Block recorded by the target add event.
        expected: String,
        /// Block recorded by the replacement event.
        actual: String,
    },
    /// Add events sharing one original hash resolve to different hashes.
    InconsistentReplacement {
        /// Original hash shared by the add events.
        original: String,
        /// First effective hash encountered.
        first: String,
        /// Conflicting effective hash encountered later.
        second: String,
    },
    /// Two distinct original versions collapse to one effective version.
    EffectiveHashCollision {
        /// Block whose visible version cardinality would change.
        block: String,
        /// First original hash.
        first: String,
        /// Second original hash.
        second: String,
        /// Colliding effective hash.
        effective: String,
    },
    /// One original/replacement hash aliases two distinct versions in a block.
    AmbiguousHashAlias {
        /// Block whose hash reference cannot be resolved unambiguously.
        block: String,
        /// Original or replacement hash shared by the two version histories.
        alias: String,
        /// First original hash associated with the alias.
        first: String,
        /// Second original hash associated with the alias.
        second: String,
    },
    /// A checkpoint-state event targets an absent logical version.
    MissingVersionTarget {
        /// Event that contains the invalid reference.
        event: String,
        /// Missing checkpoint identity.
        target: String,
    },
    /// A checkpoint-state event names a different block than its target.
    VersionBlockMismatch {
        /// Event that contains the invalid reference.
        event: String,
        /// Target checkpoint identity.
        target: String,
        /// Block that owns the target.
        expected: String,
        /// Block named by the event.
        actual: String,
    },
}

impl fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConflictingEventId { eid } => write!(
                formatter,
                "ledger event id {eid} has conflicting data; repair the ledger before retrying"
            ),
            Self::MissingReplacementTarget { event, target } => write!(
                formatter,
                "replacement event {event} targets missing event {target}; restore the target add event before retrying"
            ),
            Self::ReplacementTargetNotVersion { event, target } => write!(
                formatter,
                "replacement event {event} targets non-version event {target}; target an add-version event instead"
            ),
            Self::ReplacementBlockMismatch {
                event,
                target,
                expected,
                actual,
            } => write!(
                formatter,
                "replacement event {event} targets {target} in block {expected} but names block {actual}; repair the block reference before retrying"
            ),
            Self::InconsistentReplacement {
                original,
                first,
                second,
            } => write!(
                formatter,
                "original version {original} resolves to both {first} and {second}; replace every duplicate consistently before retrying"
            ),
            Self::EffectiveHashCollision {
                block,
                first,
                second,
                effective,
            } => write!(
                formatter,
                "versions {first} and {second} in block {block} both resolve to {effective}; choose distinct replacement objects before retrying"
            ),
            Self::AmbiguousHashAlias {
                block,
                alias,
                first,
                second,
            } => write!(
                formatter,
                "hash {alias} in block {block} aliases both original versions {first} and {second}; repair the replacement histories before retrying"
            ),
            Self::MissingVersionTarget { event, target } => write!(
                formatter,
                "version event {event} targets missing checkpoint {target}; restore the checkpoint event before retrying"
            ),
            Self::VersionBlockMismatch {
                event,
                target,
                expected,
                actual,
            } => write!(
                formatter,
                "version event {event} targets checkpoint {target} in block {expected} but names block {actual}; repair the block reference before retrying"
            ),
        }
    }
}

impl std::error::Error for LedgerError {}

/// Current state of one block: its head hash and known versions (in add order).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BlockState {
    /// Hash of the current head version, when one exists.
    pub head: Option<String>,
    /// Stable identity of the effective visible HEAD.
    #[serde(rename = "headVersionId")]
    pub head_version_id: Option<String>,
    /// Hash of the ledger's actual HEAD, including a checkpoint hidden from
    /// the ordinary timeline.
    #[serde(rename = "rawHead")]
    pub raw_head: Option<String>,
    /// Stable identity of the ledger's actual HEAD, including a checkpoint
    /// hidden from the ordinary timeline.
    #[serde(rename = "rawHeadVersionId")]
    pub raw_head_version_id: Option<String>,
    /// Every stored version, in add order.
    pub versions: Vec<VersionMeta>,
    /// Checkpoints removed from the ordinary timeline.
    #[serde(rename = "removedVersions")]
    pub removed_versions: Vec<VersionMeta>,
}

/// Resolve replacement relationships and fold the append-only ledger.
///
/// Resolution is deliberately two-pass: replacements are selected and
/// validated first, then add/head/label events fold in `(ts, eid)` order with
/// every hash reference translated through the effective-hash map.
///
/// # Arguments
/// * `events` - parsed ledger events in arbitrary file order
///
/// # Returns
/// Folded blocks plus replacement metadata, or a structured semantic error.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let resolution = mica_core::resolve_ledger_impl(&[]).unwrap();
/// assert!(resolution.blocks.is_empty());
/// ```
pub fn resolve_ledger_impl(events: &[Event]) -> Result<LedgerResolution, LedgerError> {
    let mut by_eid: HashMap<&str, &Event> = HashMap::with_capacity(events.len());
    let mut unique = Vec::with_capacity(events.len());
    // O(n) where n = ledger events (bounded by host readers at 1,000,000).
    for event in events {
        let eid = event_eid(event);
        if let Some(previous) = by_eid.get(eid) {
            if *previous != event {
                return Err(LedgerError::ConflictingEventId {
                    eid: eid.to_string(),
                });
            }
            continue;
        }
        by_eid.insert(eid, event);
        unique.push(event);
    }

    let mut ordered = unique;
    ordered.sort_by(|left, right| event_key(left).cmp(&event_key(right)));
    let mut add_by_eid: HashMap<&str, &str> = HashMap::new();
    // O(n) where n = unique ledger events.
    for event in &ordered {
        if let Event::AddVersion { eid, hash, .. } = event {
            add_by_eid.insert(eid, hash);
        }
    }

    let mut latest_by_target: HashMap<&str, &Event> = HashMap::new();
    // O(n) where n = unique ledger events; target lookup is O(1) expected.
    for event in &ordered {
        let Event::ReplaceVersion {
            eid, block, target, ..
        } = event
        else {
            continue;
        };
        let Some(target_event) = by_eid.get(target.as_str()) else {
            return Err(LedgerError::MissingReplacementTarget {
                event: eid.clone(),
                target: target.clone(),
            });
        };
        let Event::AddVersion {
            block: target_block,
            ..
        } = target_event
        else {
            return Err(LedgerError::ReplacementTargetNotVersion {
                event: eid.clone(),
                target: target.clone(),
            });
        };
        if block != target_block {
            return Err(LedgerError::ReplacementBlockMismatch {
                event: eid.clone(),
                target: target.clone(),
                expected: target_block.clone(),
                actual: block.clone(),
            });
        }
        let replace = latest_by_target
            .get(target.as_str())
            .is_none_or(|previous| event_key(event) > event_key(previous));
        if replace {
            latest_by_target.insert(target, event);
        }
    }

    let mut effective_by_add: HashMap<&str, &str> = HashMap::with_capacity(add_by_eid.len());
    let mut effective_by_original: HashMap<&str, &str> = HashMap::with_capacity(add_by_eid.len());
    let mut original_by_block_effective: HashMap<(&str, &str), &str> =
        HashMap::with_capacity(add_by_eid.len());
    // O(n) where n = unique ledger events.
    for event in &ordered {
        let Event::AddVersion {
            eid, block, hash, ..
        } = event
        else {
            continue;
        };
        let effective = latest_by_target
            .get(eid.as_str())
            .and_then(|replacement| replacement_hash(replacement))
            .unwrap_or(hash);
        if let Some(previous) = effective_by_original.insert(hash, effective) {
            if previous != effective {
                return Err(LedgerError::InconsistentReplacement {
                    original: hash.clone(),
                    first: previous.to_string(),
                    second: effective.to_string(),
                });
            }
        }
        if let Some(previous) = original_by_block_effective.insert((block, effective), hash) {
            if previous != hash {
                return Err(LedgerError::EffectiveHashCollision {
                    block: block.clone(),
                    first: previous.to_string(),
                    second: hash.clone(),
                    effective: effective.to_string(),
                });
            }
        }
        effective_by_add.insert(eid, effective);
    }

    // Hash-bearing events written after a replacement refer to the then-visible
    // effective hash. Keep every original and replacement hash as an alias for
    // the target add event's current winner so a later replacement/rollback
    // retargets those references too. An alias shared by distinct versions in
    // one block is inherently ambiguous and therefore corruption.
    let mut effective_by_block_alias: HashMap<(&str, &str), (&str, &str)> =
        HashMap::with_capacity(add_by_eid.len() + latest_by_target.len());
    for event in &ordered {
        let Event::AddVersion {
            eid, block, hash, ..
        } = event
        else {
            continue;
        };
        let effective = effective_by_add.get(eid.as_str()).copied().unwrap_or(hash);
        if let Some((previous_original, _)) =
            effective_by_block_alias.insert((block, hash), (hash, effective))
        {
            if previous_original != hash {
                return Err(LedgerError::AmbiguousHashAlias {
                    block: block.clone(),
                    alias: hash.clone(),
                    first: previous_original.to_string(),
                    second: hash.clone(),
                });
            }
        }
    }
    for event in &ordered {
        let Event::ReplaceVersion {
            block,
            target,
            hash,
            ..
        } = event
        else {
            continue;
        };
        let Some(Event::AddVersion { hash: original, .. }) = by_eid.get(target.as_str()).copied()
        else {
            // Replacement targets were validated above.
            continue;
        };
        let effective = effective_by_add
            .get(target.as_str())
            .copied()
            .unwrap_or(original);
        if let Some((previous_original, _)) =
            effective_by_block_alias.insert((block, hash), (original, effective))
        {
            if previous_original != original {
                return Err(LedgerError::AmbiguousHashAlias {
                    block: block.clone(),
                    alias: hash.clone(),
                    first: previous_original.to_string(),
                    second: original.clone(),
                });
            }
        }
    }

    let mut replacements = Vec::new();
    // O(n) where n = unique ledger events.
    for event in &ordered {
        if let Event::ReplaceVersion {
            eid,
            ts,
            block,
            target,
            hash,
            ..
        } = event
        {
            let Some(original) = add_by_eid.get(target.as_str()) else {
                continue;
            };
            let active = latest_by_target
                .get(target.as_str())
                .is_some_and(|winner| event_eid(winner) == eid);
            replacements.push(ResolvedReplacement {
                event: eid.clone(),
                ts: *ts,
                target: target.clone(),
                block: block.clone(),
                original: (*original).to_string(),
                replacement: hash.clone(),
                active,
            });
        }
    }

    let version_count = ordered
        .iter()
        .filter(|event| matches!(event, Event::AddVersion { .. } | Event::Checkpoint { .. }))
        .count();
    let mut state: HashMap<String, BlockState> = HashMap::new();
    let mut record_by_id: HashMap<String, (String, usize)> = HashMap::with_capacity(version_count);
    let mut id_by_block_hash: HashMap<(String, String), String> =
        HashMap::with_capacity(version_count);
    let mut legacy_alias: HashMap<String, String> = HashMap::new();
    let mut raw_head: HashMap<String, Option<String>> = HashMap::new();
    // Legacy migrations occasionally published a live object with `set-head`
    // before (or without) adding that object as a timeline row. Preserve that
    // detached hash exactly; later identity-bearing events may supersede it.
    let mut detached_legacy_head: HashMap<String, String> = HashMap::new();
    // Ordered record of what HEAD pointed at. A legacy ledger omits parents, so
    // this progression is the only evidence of descent it retains.
    let mut head_sequence: HashMap<String, Vec<String>> = HashMap::new();
    // O(n) where n = unique ledger events; every lookup is O(1) expected.
    for event in ordered {
        match event {
            Event::AddVersion {
                eid,
                block,
                hash,
                ts,
                label,
                origin,
                parent,
            } => {
                let effective = effective_by_add.get(eid.as_str()).copied().unwrap_or(hash);
                let key = (block.clone(), effective.to_string());
                if let Some(existing) = id_by_block_hash.get(&key) {
                    legacy_alias.insert(eid.clone(), existing.clone());
                    continue;
                }
                let parent_hash = parent
                    .as_deref()
                    .map(|hash| resolve_hash(&effective_by_block_alias, block, hash).to_string());
                let parent_id = parent_hash
                    .as_ref()
                    .and_then(|hash| id_by_block_hash.get(&(block.clone(), hash.clone())))
                    .cloned();
                let block_state = state.entry(block.clone()).or_default();
                let lineage_root =
                    parent.is_none() && (origin.is_some() || block_state.versions.is_empty());
                let index = block_state.versions.len();
                block_state.versions.push(VersionMeta {
                    version_id: eid.clone(),
                    hash: effective.to_string(),
                    ts: *ts,
                    label: label.clone(),
                    parent: parent_hash,
                    parent_version_id: parent_id,
                    effective_parent_version_id: None,
                    lineage_root,
                    source_version_id: None,
                    cause: None,
                    visible: true,
                });
                record_by_id.insert(eid.clone(), (block.clone(), index));
                id_by_block_hash.insert(key, eid.clone());
            }
            Event::ReplaceVersion { .. } => {}
            Event::SetHead { block, hash, .. } => {
                state.entry(block.clone()).or_default();
                let effective = resolve_hash(&effective_by_block_alias, block, hash);
                if let Some(target) = id_by_block_hash
                    .get(&(block.clone(), effective.to_string()))
                    .cloned()
                {
                    head_sequence
                        .entry(block.clone())
                        .or_default()
                        .push(target.clone());
                    raw_head.insert(block.clone(), Some(target));
                    detached_legacy_head.remove(block);
                } else {
                    // This was valid in the hash-based ledger: HEAD could name
                    // an immutable object that was not itself a visible
                    // version. Do not manufacture a user-visible checkpoint or
                    // reject the entire history merely because stable inner
                    // identity was introduced later.
                    raw_head.remove(block);
                    detached_legacy_head.insert(block.clone(), effective.to_string());
                }
            }
            Event::Label {
                block, hash, label, ..
            } => {
                let effective = resolve_hash(&effective_by_block_alias, block, hash);
                if let Some(id) = id_by_block_hash.get(&(block.clone(), effective.to_string())) {
                    let (owner, index) = record_by_id.get(id).cloned().ok_or_else(|| {
                        LedgerError::MissingVersionTarget {
                            event: event_eid(event).to_string(),
                            target: id.clone(),
                        }
                    })?;
                    if let Some(version) = state
                        .get_mut(&owner)
                        .and_then(|block_state| block_state.versions.get_mut(index))
                    {
                        version.label = label.clone();
                    }
                }
            }
            Event::Checkpoint {
                eid,
                ts,
                block,
                hash,
                parent,
                source,
                cause,
            } => {
                for target in [parent.as_ref(), source.as_ref()].into_iter().flatten() {
                    validate_version_owner(&record_by_id, &legacy_alias, eid, block, target)?;
                }
                let block_state = state.entry(block.clone()).or_default();
                let index = block_state.versions.len();
                block_state.versions.push(VersionMeta {
                    version_id: eid.clone(),
                    hash: hash.clone(),
                    ts: *ts,
                    label: None,
                    parent: None,
                    parent_version_id: parent.as_ref().map(|id| canonical_id(&legacy_alias, id)),
                    effective_parent_version_id: None,
                    lineage_root: parent.is_none(),
                    source_version_id: source.as_ref().map(|id| canonical_id(&legacy_alias, id)),
                    cause: cause.clone(),
                    visible: true,
                });
                record_by_id.insert(eid.clone(), (block.clone(), index));
                id_by_block_hash
                    .entry((block.clone(), hash.clone()))
                    .or_insert_with(|| eid.clone());
            }
            Event::MoveHead {
                eid, block, target, ..
            } => {
                state.entry(block.clone()).or_default();
                detached_legacy_head.remove(block);
                if let Some(target) = target {
                    validate_version_owner(&record_by_id, &legacy_alias, eid, block, target)?;
                    raw_head.insert(block.clone(), Some(canonical_id(&legacy_alias, target)));
                } else {
                    raw_head.insert(block.clone(), None);
                }
            }
            Event::VersionLabel {
                eid,
                block,
                target,
                label,
                ..
            } => {
                let (owner, index) =
                    validate_version_owner(&record_by_id, &legacy_alias, eid, block, target)?;
                if let Some(version) = state
                    .get_mut(&owner)
                    .and_then(|block_state| block_state.versions.get_mut(index))
                {
                    version.label = label.clone();
                }
            }
            Event::VersionVisibility {
                eid,
                block,
                target,
                visible,
                ..
            } => {
                let (owner, index) =
                    validate_version_owner(&record_by_id, &legacy_alias, eid, block, target)?;
                if let Some(version) = state
                    .get_mut(&owner)
                    .and_then(|block_state| block_state.versions.get_mut(index))
                {
                    version.visible = *visible;
                }
            }
        }
    }

    // O(v) across logical checkpoints. Hidden ancestors remain present for
    // recovery and matching, while ordinary Auto comparison skips them.
    for (block, block_state) in &mut state {
        let mut identities: Vec<CheckpointIdentity> = block_state
            .versions
            .iter()
            .map(|version| CheckpointIdentity {
                id: version.version_id.clone(),
                parent: version.parent_version_id.clone(),
                visible: version.visible,
            })
            .collect();
        // Recover lineage a legacy ledger never wrote down, but only where its
        // own head progression proves no branch could have occurred.
        if let Some(inferred) = inferred_linear_parents(
            &identities,
            head_sequence.get(block).map(Vec::as_slice).unwrap_or(&[]),
        ) {
            for identity in &mut identities {
                identity.parent = inferred.get(&identity.id).cloned();
            }
            for version in &mut block_state.versions {
                if let Some(parent) = inferred.get(&version.version_id) {
                    version.parent_version_id = Some(parent.clone());
                    version.lineage_root = false;
                } else {
                    version.lineage_root = true;
                }
            }
        }
        let effective = effective_visible_parents(&identities);
        let hash_by_id: HashMap<String, String> = block_state
            .versions
            .iter()
            .map(|version| (version.version_id.clone(), version.hash.clone()))
            .collect();
        for version in &mut block_state.versions {
            version.effective_parent_version_id =
                effective.get(&version.version_id).cloned().flatten();
            if version.parent_version_id.is_some() {
                version.parent = version
                    .effective_parent_version_id
                    .as_ref()
                    .and_then(|id| hash_by_id.get(id))
                    .cloned();
            }
        }
        let detached_head = detached_legacy_head.get(block).cloned();
        let raw_head_version_id = match raw_head.get(block) {
            Some(target) => target.clone(),
            None => detached_head
                .as_ref()
                .and_then(|hash| id_by_block_hash.get(&(block.clone(), hash.clone())))
                .cloned(),
        };
        let raw_head_hash = match raw_head.get(block) {
            Some(Some(id)) => hash_by_id.get(id).cloned(),
            Some(None) => None,
            None => detached_head.clone(),
        };
        let effective_head = raw_head_version_id.clone().and_then(|id| {
            block_state
                .versions
                .iter()
                .find(|version| version.version_id == id)
                .and_then(|version| {
                    version
                        .visible
                        .then_some(version.version_id.clone())
                        .or_else(|| effective.get(&id).cloned().flatten())
                })
        });
        block_state.raw_head = raw_head_hash;
        block_state.raw_head_version_id = raw_head_version_id;
        let effective_head_hash = effective_head
            .as_ref()
            .and_then(|id| hash_by_id.get(id))
            .cloned();
        block_state.head = if raw_head.contains_key(block) {
            effective_head_hash
        } else {
            effective_head_hash.or(detached_head)
        };
        block_state.head_version_id = effective_head;
        let all = std::mem::take(&mut block_state.versions);
        let (visible, removed): (Vec<_>, Vec<_>) =
            all.into_iter().partition(|version| version.visible);
        block_state.versions = visible;
        block_state.removed_versions = removed;
    }

    Ok(LedgerResolution {
        blocks: state.into_iter().collect(),
        replacements,
    })
}

/// Fold the append-only ledger into current state, keyed by block id.
///
/// # Arguments
/// * `events` - parsed ledger events in arbitrary file order
///
/// # Returns
/// Per-block state, or a structured semantic error.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let state = mica_core::fold_ledger_impl(&[]).unwrap();
/// assert!(state.is_empty());
/// ```
pub fn fold_ledger_impl(events: &[Event]) -> Result<BTreeMap<String, BlockState>, LedgerError> {
    Ok(resolve_ledger_impl(events)?.blocks)
}

fn canonical_id(aliases: &HashMap<String, String>, id: &str) -> String {
    aliases.get(id).cloned().unwrap_or_else(|| id.to_string())
}

fn validate_version_owner(
    records: &HashMap<String, (String, usize)>,
    aliases: &HashMap<String, String>,
    event: &str,
    block: &str,
    target: &str,
) -> Result<(String, usize), LedgerError> {
    let canonical = canonical_id(aliases, target);
    let Some((owner, index)) = records.get(&canonical) else {
        return Err(LedgerError::MissingVersionTarget {
            event: event.to_string(),
            target: target.to_string(),
        });
    };
    if owner != block {
        return Err(LedgerError::VersionBlockMismatch {
            event: event.to_string(),
            target: target.to_string(),
            expected: owner.clone(),
            actual: block.to_string(),
        });
    }
    Ok((owner.clone(), *index))
}

fn event_eid(event: &Event) -> &str {
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

fn event_key(event: &Event) -> (u64, &str) {
    match event {
        Event::AddVersion { ts, eid, .. }
        | Event::ReplaceVersion { ts, eid, .. }
        | Event::SetHead { ts, eid, .. }
        | Event::Label { ts, eid, .. }
        | Event::Checkpoint { ts, eid, .. }
        | Event::MoveHead { ts, eid, .. }
        | Event::VersionLabel { ts, eid, .. }
        | Event::VersionVisibility { ts, eid, .. } => (*ts, eid),
    }
}

fn replacement_hash(event: &Event) -> Option<&str> {
    if let Event::ReplaceVersion { hash, .. } = event {
        Some(hash)
    } else {
        None
    }
}

fn resolve_hash<'a>(
    effective_by_block_alias: &HashMap<(&'a str, &'a str), (&'a str, &'a str)>,
    block: &'a str,
    hash: &'a str,
) -> &'a str {
    effective_by_block_alias
        .get(&(block, hash))
        .map(|(_, effective)| *effective)
        .unwrap_or(hash)
}

/// Concatenated, trimmed, sorted leaf content of block `content` — the identity
/// versioning gates on, so structure-only churn never mints a version.
///
/// Purpose: shared "did the words change?" key for the plugin and the CLI.
///
/// # Arguments
/// * `content` - a block's inner source
///
/// # Returns
/// A `b3s2:`-tagged full BLAKE3 hash of the sorted non-empty leaf texts.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// let a = mica_core::content_signature_impl("tab: A\nhello\n");
/// let b = mica_core::content_signature_impl("tab: RENAMED\nhello\n");
/// assert_eq!(a, b, "renames don't change the signature");
/// ```
pub fn content_signature_impl(content: &str) -> String {
    let cst = crate::parser::parse_block_impl(content);
    let mut texts = Vec::new();
    collect_leaf_text(&cst.children, &mut texts);
    texts.sort_unstable();
    // Version 2 frames every leaf with its byte length. The previous
    // space-joined encoding made ["a", "b"] collide with ["a b"]. The
    // explicit tag makes this one compatibility transition discoverable and
    // prevents future algorithm changes from silently reusing the namespace.
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"mica-content-signature\0v2\0");
    for t in texts {
        hasher.update(&(t.len() as u64).to_le_bytes());
        hasher.update(t.as_bytes());
    }
    format!("b3s2:{}", hasher.finalize().to_hex())
}

/// Depth-first trimmed non-empty leaf texts (code leaves included — code IS
/// content). Borrows from the CST — no per-leaf copies.
fn collect_leaf_text<'a>(nodes: &'a [crate::parser::Node], out: &mut Vec<&'a str>) {
    for n in nodes {
        match n {
            crate::parser::Node::Leaf { text, .. } => {
                let t = text.trim();
                if !t.is_empty() {
                    out.push(t);
                }
            }
            crate::parser::Node::Container { children, .. } => collect_leaf_text(children, out),
        }
    }
}

/// Whether any leaf under `nodes` carries non-whitespace text (early-out).
fn has_leaf_text(nodes: &[crate::parser::Node]) -> bool {
    nodes.iter().any(|n| match n {
        crate::parser::Node::Leaf { text, .. } => !text.trim().is_empty(),
        crate::parser::Node::Container { children, .. } => has_leaf_text(children),
    })
}

/// Whether a block has any non-empty leaf content (including code and callouts).
///
/// Purpose: the first snapshot requires actual content.
///
/// # Arguments
/// * `content` - a block's inner source
///
/// # Returns
/// `true` when any leaf carries non-whitespace text.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// assert!(!mica_core::has_content_impl("tab: A\n\n"));
/// assert!(mica_core::has_content_impl("tab: A\nhi\n"));
/// ```
pub fn has_content_impl(content: &str) -> bool {
    has_leaf_text(&crate::parser::parse_block_impl(content).children)
}

/// The stored head a snapshot decision compares against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadRef<'a> {
    /// The block has no stored head yet.
    None,
    /// The ledger names a head but its object file is missing.
    Missing,
    /// The head object's content.
    Content(&'a str),
}

/// The snapshot change-gate shared by every host.
///
/// Purpose: decide whether `content` deserves a new version relative to the
/// stored head, using the content signature so structural churn never snapshots.
/// Hosts must already have skipped byte-identical heads (same content hash).
///
/// # Arguments
/// * `content` - the block's current inner source
/// * `head` - the stored head's content, or why it's unavailable
/// * `force` - a manual "Save version" bypasses the signature gate
///
/// # Returns
/// `true` when a snapshot should be written.
///
/// # Panics
/// None.
///
/// # Examples
/// ```
/// use mica_core::{should_snapshot_impl, HeadRef};
/// // First snapshot requires real content:
/// assert!(!should_snapshot_impl("tab: A\n\n", HeadRef::None, false));
/// assert!(should_snapshot_impl("tab: A\nhi\n", HeadRef::None, false));
/// ```
pub fn should_snapshot_impl(content: &str, head: HeadRef<'_>, force: bool) -> bool {
    match head {
        HeadRef::None => {
            if force {
                return true;
            }
            has_content_impl(content) // the first real version requires actual content
        }
        HeadRef::Missing => true, // head object missing — snapshot to be safe
        HeadRef::Content(head_content) => {
            if force {
                return true;
            }
            content_signature_impl(head_content) != content_signature_impl(content)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    fn add(block: &str, hash: &str, ts: u64) -> Event {
        Event::AddVersion {
            eid: format!("e{ts}"),
            ts,
            block: block.into(),
            hash: hash.into(),
            label: None,
            origin: None,
            parent: None,
        }
    }
    fn set(block: &str, hash: &str, ts: u64) -> Event {
        Event::SetHead {
            eid: format!("s{ts}"),
            ts,
            block: block.into(),
            hash: hash.into(),
        }
    }

    fn fold(events: &[Event]) -> BTreeMap<String, BlockState> {
        fold_ledger_impl(events).expect("valid ledger fixture")
    }

    #[test]
    fn folds_head_and_versions() {
        let ev = vec![
            add("b", "h1", 1),
            set("b", "h1", 1),
            add("b", "h2", 2),
            set("b", "h2", 2),
        ];
        let st = fold(&ev);
        assert_eq!(st["b"].head.as_deref(), Some("h2"));
        assert_eq!(st["b"].versions.len(), 2);
    }

    #[test]
    fn legacy_linear_ledger_recovers_comparable_lineage() {
        // The shape a pre-parent-tracking ledger actually has: every
        // `add-version` carries only a hash and a timestamp, each followed by
        // `set-head` onto that same hash. Nothing records descent, so before
        // inference every checkpoint after the first compared against nothing.
        let events = vec![
            add("b", "h1", 1),
            set("b", "h1", 1),
            add("b", "h2", 2),
            set("b", "h2", 2),
            add("b", "h3", 3),
            set("b", "h3", 3),
        ];
        let state = fold(&events);
        let block = &state["b"];
        assert_eq!(block.versions.len(), 3);
        assert!(
            block.versions[0].lineage_root,
            "the oldest checkpoint remains a root"
        );
        assert_eq!(block.versions[0].parent_version_id, None);
        assert_eq!(
            block.versions[1].effective_parent_version_id.as_deref(),
            Some(block.versions[0].version_id.as_str()),
            "a provably linear head progression makes the predecessor the parent"
        );
        assert_eq!(
            block.versions[2].effective_parent_version_id.as_deref(),
            Some(block.versions[1].version_id.as_str())
        );
    }

    #[test]
    fn legacy_ledger_with_a_head_reset_keeps_refusing_to_guess() {
        // Head returns to the first checkpoint before the third is written, so
        // list order is NOT descent. Inferring here would report a diff against
        // a checkpoint that was never this one's parent.
        let events = vec![
            add("b", "h1", 1),
            set("b", "h1", 1),
            add("b", "h2", 2),
            set("b", "h2", 2),
            set("b", "h1", 3),
            add("b", "h3", 4),
            set("b", "h3", 4),
        ];
        let state = fold(&events);
        let block = &state["b"];
        assert_eq!(block.versions.len(), 3);
        for version in &block.versions {
            assert_eq!(
                version.effective_parent_version_id, None,
                "an ambiguous legacy history stays explicitly unknown"
            );
        }
    }

    #[test]
    fn legacy_detached_head_does_not_invalidate_later_history() {
        let events = vec![
            add("b", "visible-root", 1),
            set("b", "detached-live-object", 2),
            Event::AddVersion {
                eid: "child".into(),
                ts: 3,
                block: "b".into(),
                hash: "visible-child".into(),
                label: None,
                origin: None,
                parent: Some("detached-live-object".into()),
            },
            set("b", "visible-child", 4),
        ];
        let state = fold(&events);
        let block = &state["b"];
        assert_eq!(block.head.as_deref(), Some("visible-child"));
        assert_eq!(block.head_version_id.as_deref(), Some("child"));
        assert_eq!(block.versions.len(), 2);
        assert_eq!(
            block.versions[1].parent.as_deref(),
            Some("detached-live-object"),
            "unresolved legacy lineage remains explicit instead of being invented"
        );
        assert_eq!(block.versions[1].parent_version_id, None);
    }

    #[test]
    fn migrated_histories_preserve_multiple_explicit_lineage_roots() {
        let events = vec![
            Event::AddVersion {
                eid: "first-root".into(),
                ts: 1,
                block: "b".into(),
                hash: "first".into(),
                label: Some("V1".into()),
                origin: Some("migrated:success".into()),
                parent: None,
            },
            Event::AddVersion {
                eid: "second-root".into(),
                ts: 2,
                block: "b".into(),
                hash: "second".into(),
                label: Some("V1".into()),
                origin: Some("migrated:bug".into()),
                parent: None,
            },
        ];
        let state = fold(&events);
        let block = &state["b"];
        assert!(block.versions[0].lineage_root);
        assert!(
            block.versions[1].lineage_root,
            "dense visible ordering must not erase a later migrated branch root"
        );
    }

    #[test]
    fn final_legacy_detached_head_preserves_hash_without_inventing_a_row() {
        let state = fold(&[add("b", "visible", 1), set("b", "detached", 2)]);
        let block = &state["b"];
        assert_eq!(block.head.as_deref(), Some("detached"));
        assert_eq!(block.head_version_id, None);
        assert_eq!(block.versions.len(), 1);
    }

    #[test]
    fn legacy_set_head_without_a_version_still_materializes_block_state() {
        let state = fold(&[set("b", "detached", 1)]);
        let block = &state["b"];

        assert_eq!(block.head.as_deref(), Some("detached"));
        assert_eq!(block.raw_head.as_deref(), Some("detached"));
        assert_eq!(block.head_version_id, None);
        assert_eq!(block.raw_head_version_id, None);
        assert!(block.versions.is_empty());
        assert!(block.removed_versions.is_empty());
    }

    #[test]
    fn move_head_to_none_without_a_version_materializes_empty_block_state() {
        let state = fold(&[Event::MoveHead {
            eid: "clear".into(),
            ts: 1,
            block: "b".into(),
            target: None,
        }]);
        let block = &state["b"];

        assert_eq!(block.head, None);
        assert_eq!(block.raw_head, None);
        assert_eq!(block.head_version_id, None);
        assert_eq!(block.raw_head_version_id, None);
        assert!(block.versions.is_empty());
        assert!(block.removed_versions.is_empty());
    }

    #[test]
    fn checkpoint_restore_keeps_duplicate_content_identity() {
        let events = vec![
            Event::Checkpoint {
                eid: "a-v1".into(),
                ts: 1,
                block: "b".into(),
                hash: "h1".into(),
                parent: None,
                source: None,
                cause: None,
            },
            Event::MoveHead {
                eid: "b-head-1".into(),
                ts: 1,
                block: "b".into(),
                target: Some("a-v1".into()),
            },
            Event::Checkpoint {
                eid: "c-v2".into(),
                ts: 2,
                block: "b".into(),
                hash: "h2".into(),
                parent: Some("a-v1".into()),
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "d-v3".into(),
                ts: 3,
                block: "b".into(),
                hash: "h1".into(),
                parent: Some("c-v2".into()),
                source: Some("a-v1".into()),
                cause: Some("restore".into()),
            },
            Event::MoveHead {
                eid: "e-head-3".into(),
                ts: 3,
                block: "b".into(),
                target: Some("d-v3".into()),
            },
        ];
        let state = fold(&events);
        assert_eq!(state["b"].versions.len(), 3);
        assert_eq!(state["b"].versions[0].hash, state["b"].versions[2].hash);
        assert_eq!(state["b"].head_version_id.as_deref(), Some("d-v3"));
        assert_eq!(
            state["b"].versions[2].source_version_id.as_deref(),
            Some("a-v1")
        );
    }

    #[test]
    fn hidden_versions_are_recoverable_and_spliced_from_visible_lineage() {
        let events = vec![
            Event::Checkpoint {
                eid: "v1".into(),
                ts: 1,
                block: "b".into(),
                hash: "h1".into(),
                parent: None,
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "v2".into(),
                ts: 2,
                block: "b".into(),
                hash: "h2".into(),
                parent: Some("v1".into()),
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "v3".into(),
                ts: 3,
                block: "b".into(),
                hash: "h3".into(),
                parent: Some("v2".into()),
                source: None,
                cause: None,
            },
            Event::MoveHead {
                eid: "head".into(),
                ts: 3,
                block: "b".into(),
                target: Some("v2".into()),
            },
            Event::VersionVisibility {
                eid: "hide".into(),
                ts: 4,
                block: "b".into(),
                target: "v2".into(),
                visible: false,
            },
        ];
        let state = fold(&events);
        assert_eq!(state["b"].versions.len(), 2);
        assert_eq!(state["b"].removed_versions.len(), 1);
        assert_eq!(
            state["b"].versions[1]
                .effective_parent_version_id
                .as_deref(),
            Some("v1")
        );
        assert_eq!(state["b"].head_version_id.as_deref(), Some("v1"));
        assert_eq!(state["b"].raw_head.as_deref(), Some("h2"));
        assert_eq!(state["b"].raw_head_version_id.as_deref(), Some("v2"));
    }

    #[test]
    fn consecutive_hidden_ancestors_and_branches_reconnect_independently() {
        let mut events = vec![
            Event::Checkpoint {
                eid: "v1".into(),
                ts: 1,
                block: "b".into(),
                hash: "h1".into(),
                parent: None,
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "v2".into(),
                ts: 2,
                block: "b".into(),
                hash: "h2".into(),
                parent: Some("v1".into()),
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "v3".into(),
                ts: 3,
                block: "b".into(),
                hash: "h3".into(),
                parent: Some("v2".into()),
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "main".into(),
                ts: 4,
                block: "b".into(),
                hash: "main-hash".into(),
                parent: Some("v3".into()),
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "branch".into(),
                ts: 5,
                block: "b".into(),
                hash: "branch-hash".into(),
                parent: Some("v2".into()),
                source: None,
                cause: None,
            },
        ];
        for (at, target) in ["v2", "v3"].into_iter().enumerate() {
            events.push(Event::VersionVisibility {
                eid: format!("hide-{target}"),
                ts: 10 + at as u64,
                block: "b".into(),
                target: target.into(),
                visible: false,
            });
        }
        let state = fold(&events);
        let block = &state["b"];
        assert_eq!(block.versions.len(), 3);
        assert_eq!(block.removed_versions.len(), 2);
        for id in ["main", "branch"] {
            let version = block
                .versions
                .iter()
                .find(|version| version.version_id == id)
                .expect("branch checkpoint");
            assert_eq!(
                version.effective_parent_version_id.as_deref(),
                Some("v1"),
                "each branch reconnects to its own nearest retained ancestor"
            );
        }
    }

    #[test]
    fn restoring_visibility_restores_original_lineage_without_rewriting_content() {
        let events = vec![
            Event::Checkpoint {
                eid: "v1".into(),
                ts: 1,
                block: "b".into(),
                hash: "same".into(),
                parent: None,
                source: None,
                cause: None,
            },
            Event::Checkpoint {
                eid: "v2".into(),
                ts: 2,
                block: "b".into(),
                hash: "same".into(),
                parent: Some("v1".into()),
                source: None,
                cause: None,
            },
            Event::VersionVisibility {
                eid: "hide".into(),
                ts: 3,
                block: "b".into(),
                target: "v1".into(),
                visible: false,
            },
            Event::VersionVisibility {
                eid: "show".into(),
                ts: 4,
                block: "b".into(),
                target: "v1".into(),
                visible: true,
            },
        ];
        let state = fold(&events);
        let block = &state["b"];
        assert_eq!(block.versions.len(), 2);
        assert!(block.removed_versions.is_empty());
        assert_eq!(block.versions[0].hash, "same");
        assert_eq!(block.versions[1].hash, "same");
        assert_eq!(
            block.versions[1].effective_parent_version_id.as_deref(),
            Some("v1")
        );
    }

    #[test]
    fn dedups_versions_and_is_idempotent() {
        let once = fold(&[add("b", "h1", 1)]);
        let twice = fold(&[add("b", "h1", 1), add("b", "h1", 1)]);
        assert_eq!(once, twice);
        assert_eq!(twice["b"].versions.len(), 1);
    }

    #[test]
    fn conflicting_event_id_is_rejected_before_resolution() {
        let first = add("b", "h1", 1);
        let mut conflicting = add("b", "h2", 1);
        if let Event::AddVersion { eid, .. } = &mut conflicting {
            *eid = "e1".into();
        }
        assert!(matches!(
            resolve_ledger_impl(&[first, conflicting]),
            Err(LedgerError::ConflictingEventId { eid }) if eid == "e1"
        ));
    }

    #[test]
    fn fold_is_order_independent() {
        // Sync/git merges union lines in arbitrary order; the fold must not care.
        let forward = vec![
            add("b", "h1", 1),
            set("b", "h1", 1),
            add("b", "h2", 2),
            set("b", "h2", 2),
        ];
        let mut reversed = forward.clone();
        reversed.reverse();
        assert_eq!(fold(&forward), fold(&reversed));
        assert_eq!(fold(&reversed)["b"].head.as_deref(), Some("h2"));
    }

    #[test]
    fn revert_is_set_head_to_older_version() {
        let ev = vec![
            add("b", "h1", 1),
            set("b", "h1", 1),
            add("b", "h2", 2),
            set("b", "h2", 2),
            set("b", "h1", 3), // revert
        ];
        let st = fold(&ev);
        assert_eq!(st["b"].head.as_deref(), Some("h1"));
        assert_eq!(st["b"].versions.len(), 2, "revert doesn't drop history");
    }

    #[test]
    fn label_event_relabels_and_clears() {
        let ev = vec![
            add("b", "h1", 1),
            Event::Label {
                eid: "l1".into(),
                ts: 2,
                block: "b".into(),
                hash: "h1".into(),
                label: Some("v1.0".into()),
            },
        ];
        let st = fold(&ev);
        assert_eq!(st["b"].versions[0].label.as_deref(), Some("v1.0"));

        let ev2 = vec![
            add("b", "h1", 1),
            Event::Label {
                eid: "l1".into(),
                ts: 2,
                block: "b".into(),
                hash: "h1".into(),
                label: Some("v1.0".into()),
            },
            Event::Label {
                eid: "l2".into(),
                ts: 3,
                block: "b".into(),
                hash: "h1".into(),
                label: None,
            },
        ];
        assert_eq!(
            fold(&ev2)["b"].versions[0].label,
            None,
            "later label event wins"
        );
    }

    #[test]
    fn label_for_unknown_hash_is_ignored() {
        let ev = vec![
            add("b", "h1", 1),
            Event::Label {
                eid: "l1".into(),
                ts: 2,
                block: "b".into(),
                hash: "nope".into(),
                label: Some("x".into()),
            },
        ];
        let st = fold(&ev);
        assert_eq!(st["b"].versions.len(), 1);
        assert_eq!(st["b"].versions[0].label, None);
    }

    #[test]
    fn replacement_resolves_version_head_label_and_parent_without_adding_a_row() {
        let events = vec![
            Event::AddVersion {
                eid: "add-old".into(),
                ts: 1,
                block: "b".into(),
                hash: "old".into(),
                label: Some("archive".into()),
                origin: None,
                parent: None,
            },
            Event::AddVersion {
                eid: "add-child".into(),
                ts: 2,
                block: "b".into(),
                hash: "child".into(),
                label: Some("child-label".into()),
                origin: None,
                parent: Some("old".into()),
            },
            Event::Label {
                eid: "label-old".into(),
                ts: 3,
                block: "b".into(),
                hash: "old".into(),
                label: Some("renamed".into()),
            },
            Event::SetHead {
                eid: "head-old".into(),
                ts: 4,
                block: "b".into(),
                hash: "old".into(),
            },
            Event::ReplaceVersion {
                eid: "replace-old".into(),
                ts: 5,
                block: "b".into(),
                target: "add-old".into(),
                hash: "wrapped".into(),
            },
        ];

        let resolved = resolve_ledger_impl(&events).expect("valid replacement ledger");
        let block = &resolved.blocks["b"];
        assert_eq!(block.head.as_deref(), Some("wrapped"));
        assert_eq!(block.versions.len(), 2, "replacement is not a version row");
        assert_eq!(block.versions[0].hash, "wrapped");
        assert_eq!(
            block.versions[0].ts, 1,
            "original add timestamp is retained"
        );
        assert_eq!(block.versions[0].label.as_deref(), Some("renamed"));
        assert_eq!(block.versions[1].label.as_deref(), Some("child-label"));
        assert_eq!(block.versions[1].parent.as_deref(), Some("wrapped"));
        assert_eq!(resolved.replacements.len(), 1);
        assert_eq!(resolved.replacements[0].ts, 5);
        assert!(resolved.replacements[0].active);
        assert_eq!(resolved.replacements[0].original, "old");
        assert_eq!(resolved.replacements[0].replacement, "wrapped");
    }

    #[test]
    fn latest_replacement_by_timestamp_and_event_id_can_restore_original_hash() {
        let events = vec![
            Event::ReplaceVersion {
                eid: "z-rollback".into(),
                ts: 10,
                block: "b".into(),
                target: "add".into(),
                hash: "old".into(),
            },
            Event::ReplaceVersion {
                eid: "physically-later-but-older".into(),
                ts: 9,
                block: "b".into(),
                target: "add".into(),
                hash: "must-not-win".into(),
            },
            Event::ReplaceVersion {
                eid: "a-wrapped".into(),
                ts: 10,
                block: "b".into(),
                target: "add".into(),
                hash: "wrapped".into(),
            },
            Event::AddVersion {
                eid: "add".into(),
                ts: 1,
                block: "b".into(),
                hash: "old".into(),
                label: None,
                origin: None,
                parent: None,
            },
        ];

        let resolved = resolve_ledger_impl(&events).expect("valid rollback ledger");
        assert_eq!(resolved.blocks["b"].versions[0].hash, "old");
        assert_eq!(resolved.replacements.len(), 3);
        assert_eq!(
            resolved
                .replacements
                .iter()
                .map(|replacement| replacement.ts)
                .collect::<Vec<_>>(),
            vec![9, 10, 10],
            "all replacement events are exposed in authoritative order"
        );
        assert_eq!(
            resolved
                .replacements
                .iter()
                .filter(|replacement| replacement.active)
                .map(|replacement| replacement.event.as_str())
                .collect::<Vec<_>>(),
            vec!["z-rollback"]
        );

        let mut reversed = events;
        reversed.reverse();
        assert_eq!(
            resolve_ledger_impl(&reversed).expect("reversed ledger"),
            resolved,
            "file order cannot affect replacement selection or metadata ordering"
        );
    }

    #[test]
    fn rollback_retargets_references_emitted_against_an_earlier_effective_hash() {
        let events = vec![
            Event::AddVersion {
                eid: "add-old".into(),
                ts: 1,
                block: "b".into(),
                hash: "old".into(),
                label: None,
                origin: None,
                parent: None,
            },
            Event::ReplaceVersion {
                eid: "replace-wrapped".into(),
                ts: 2,
                block: "b".into(),
                target: "add-old".into(),
                hash: "wrapped".into(),
            },
            Event::SetHead {
                eid: "head-wrapped".into(),
                ts: 3,
                block: "b".into(),
                hash: "wrapped".into(),
            },
            Event::Label {
                eid: "label-wrapped".into(),
                ts: 4,
                block: "b".into(),
                hash: "wrapped".into(),
                label: Some("after normalization".into()),
            },
            Event::AddVersion {
                eid: "add-child".into(),
                ts: 5,
                block: "b".into(),
                hash: "child".into(),
                label: None,
                origin: None,
                parent: Some("wrapped".into()),
            },
            Event::ReplaceVersion {
                eid: "replace-rollback".into(),
                ts: 6,
                block: "b".into(),
                target: "add-old".into(),
                hash: "old".into(),
            },
        ];

        let resolved = resolve_ledger_impl(&events).expect("valid rollback ledger");
        let block = &resolved.blocks["b"];
        assert_eq!(block.head.as_deref(), Some("old"));
        assert_eq!(block.versions[0].hash, "old");
        assert_eq!(
            block.versions[0].label.as_deref(),
            Some("after normalization")
        );
        assert_eq!(block.versions[1].parent.as_deref(), Some("old"));
    }

    #[test]
    fn replacement_rejects_missing_non_version_and_cross_block_targets() {
        let replacement = |target: &str, block: &str| Event::ReplaceVersion {
            eid: "replace".into(),
            ts: 2,
            block: block.into(),
            target: target.into(),
            hash: "wrapped".into(),
        };
        assert!(matches!(
            resolve_ledger_impl(&[replacement("missing", "b")]),
            Err(LedgerError::MissingReplacementTarget { event, target })
                if event == "replace" && target == "missing"
        ));

        let head = Event::SetHead {
            eid: "head".into(),
            ts: 1,
            block: "b".into(),
            hash: "old".into(),
        };
        assert!(matches!(
            resolve_ledger_impl(&[head, replacement("head", "b")]),
            Err(LedgerError::ReplacementTargetNotVersion { event, target })
                if event == "replace" && target == "head"
        ));

        let add = Event::AddVersion {
            eid: "add".into(),
            ts: 1,
            block: "expected".into(),
            hash: "old".into(),
            label: None,
            origin: None,
            parent: None,
        };
        assert!(matches!(
            resolve_ledger_impl(&[add, replacement("add", "actual")]),
            Err(LedgerError::ReplacementBlockMismatch {
                event,
                target,
                expected,
                actual,
            }) if event == "replace"
                && target == "add"
                && expected == "expected"
                && actual == "actual"
        ));
    }

    #[test]
    fn replacement_rejects_inconsistent_shared_hash_resolution() {
        let events = vec![
            Event::AddVersion {
                eid: "add-a".into(),
                ts: 1,
                block: "a".into(),
                hash: "old".into(),
                label: None,
                origin: None,
                parent: None,
            },
            Event::ReplaceVersion {
                eid: "replace-a".into(),
                ts: 2,
                block: "a".into(),
                target: "add-a".into(),
                hash: "wrapped".into(),
            },
            Event::AddVersion {
                eid: "add-b".into(),
                ts: 3,
                block: "b".into(),
                hash: "old".into(),
                label: None,
                origin: None,
                parent: None,
            },
        ];

        assert!(matches!(
            resolve_ledger_impl(&events),
            Err(LedgerError::InconsistentReplacement {
                original,
                first,
                second,
            }) if original == "old" && first == "wrapped" && second == "old"
        ));
    }

    #[test]
    fn duplicate_raw_hashes_can_resolve_consistently_across_blocks() {
        let add_a = Event::AddVersion {
            eid: "add-a".into(),
            ts: 1,
            block: "a".into(),
            hash: "old".into(),
            label: None,
            origin: None,
            parent: None,
        };
        let add_b = Event::AddVersion {
            eid: "add-b".into(),
            ts: 2,
            block: "b".into(),
            hash: "old".into(),
            label: None,
            origin: None,
            parent: None,
        };
        let replace_a = Event::ReplaceVersion {
            eid: "replace-a".into(),
            ts: 3,
            block: "a".into(),
            target: "add-a".into(),
            hash: "wrapped".into(),
        };
        let replace_b = Event::ReplaceVersion {
            eid: "replace-b".into(),
            ts: 4,
            block: "b".into(),
            target: "add-b".into(),
            hash: "wrapped".into(),
        };

        let resolved = resolve_ledger_impl(&[add_a, replace_b, add_b, replace_a])
            .expect("consistent replacements");
        assert_eq!(resolved.blocks["a"].versions[0].hash, "wrapped");
        assert_eq!(resolved.blocks["b"].versions[0].hash, "wrapped");
    }

    #[test]
    fn replacement_rejects_an_alias_shared_by_distinct_versions_in_one_block() {
        let events = vec![
            Event::AddVersion {
                eid: "add-a".into(),
                ts: 1,
                block: "b".into(),
                hash: "raw-a".into(),
                label: None,
                origin: None,
                parent: None,
            },
            Event::ReplaceVersion {
                eid: "replace-a".into(),
                ts: 2,
                block: "b".into(),
                target: "add-a".into(),
                hash: "shared-alias".into(),
            },
            Event::ReplaceVersion {
                eid: "rollback-a".into(),
                ts: 3,
                block: "b".into(),
                target: "add-a".into(),
                hash: "raw-a".into(),
            },
            Event::AddVersion {
                eid: "add-b".into(),
                ts: 4,
                block: "b".into(),
                hash: "shared-alias".into(),
                label: None,
                origin: None,
                parent: None,
            },
        ];

        assert!(matches!(
            resolve_ledger_impl(&events),
            Err(LedgerError::AmbiguousHashAlias {
                block,
                alias,
                first,
                second,
            }) if block == "b"
                && alias == "shared-alias"
                && [first.as_str(), second.as_str()].contains(&"raw-a")
                && [first.as_str(), second.as_str()].contains(&"shared-alias")
        ));
    }

    #[test]
    fn replacement_rejects_effective_hash_collision_that_changes_version_count() {
        let events = vec![
            Event::AddVersion {
                eid: "add-a".into(),
                ts: 1,
                block: "b".into(),
                hash: "raw-a".into(),
                label: None,
                origin: None,
                parent: None,
            },
            Event::ReplaceVersion {
                eid: "replace-a".into(),
                ts: 2,
                block: "b".into(),
                target: "add-a".into(),
                hash: "raw-b".into(),
            },
            Event::AddVersion {
                eid: "add-b".into(),
                ts: 3,
                block: "b".into(),
                hash: "raw-b".into(),
                label: None,
                origin: None,
                parent: None,
            },
        ];

        assert!(matches!(
            resolve_ledger_impl(&events),
            Err(LedgerError::EffectiveHashCollision {
                block,
                first,
                second,
                effective,
            }) if block == "b"
                && first == "raw-a"
                && second == "raw-b"
                && effective == "raw-b"
        ));
    }

    #[test]
    fn signature_value_is_pinned() {
        // The signature is persisted in sidecars and gates versioning — its
        // exact VALUE must never drift across refactors.
        assert_eq!(
            content_signature_impl("tab: A\nhello\n\n```js\nx\n```\n> [!note] Hi\n> body\n"),
            "b3s2:59b295a30da5525139eadb8ad09532023f6b4d0c7d370e07f72301dbac463e97"
        );
        assert_eq!(
            content_signature_impl(""),
            "b3s2:5b1b20ab57091d0069745c51f28361a8a52edc8a21037864c0301c742589da98"
        );
    }

    #[test]
    fn signature_frames_leaf_boundaries_without_collisions() {
        // Joining leaves with one space made these distinct content sets hash
        // identically: ["a", "b"] and ["a b"].
        assert_ne!(
            content_signature_impl("a\n\nb\n"),
            content_signature_impl("a b\n")
        );
    }

    #[test]
    fn signature_ignores_structure_orders_and_titles() {
        let a = content_signature_impl("tab: A\nhello\ntab: B\nworld\n");
        let b = content_signature_impl("tab: RENAMED\nworld\ntab: Z\nhello\n");
        assert_eq!(a, b, "titles, order, and structure are not content");
        let c = content_signature_impl("tab: A\nhello EDITED\ntab: B\nworld\n");
        assert_ne!(a, c, "prose changes ARE content");
    }

    #[test]
    fn signature_treats_code_leaves_as_content() {
        let a = content_signature_impl("tab: A\n```js\nx\n```\n");
        let b = content_signature_impl("tab: A\n```js\ny\n```\n");
        assert_ne!(a, b);
    }

    #[test]
    fn has_content_requires_non_whitespace_leaf_content() {
        assert!(!has_content_impl(""));
        assert!(!has_content_impl("tab: A\n\n"));
        assert!(has_content_impl("tab: A\nhi\n"));
        assert!(has_content_impl("```js\nx\n```\n"));
    }

    #[test]
    fn signature_is_independent_of_leaf_granularity() {
        // Prose hashes per PARAGRAPH — parser leaf-boundary changes (and the
        // number of blank lines between sections) can never churn signatures.
        assert_eq!(
            content_signature_impl("a\n\nb\n"),
            content_signature_impl("a\n\n\n\nb\n")
        );
        assert_eq!(
            content_signature_impl("a\n\nb\n"),
            content_signature_impl("b\n\na\n"),
            "paragraph order is structure, not content (sorted collection)"
        );
        assert_ne!(
            content_signature_impl("a\n\nb\n"),
            content_signature_impl("a\n\nb EDITED\n")
        );
    }

    #[test]
    fn snapshot_gate_matches_plugin_semantics() {
        // No head yet: gate on having content at all.
        assert!(!should_snapshot_impl("tab: A\n\n", HeadRef::None, false));
        assert!(should_snapshot_impl("tab: A\nhi\n", HeadRef::None, false));
        // Head object missing: snapshot to be safe.
        assert!(should_snapshot_impl(
            "tab: A\nhi\n",
            HeadRef::Missing,
            false
        ));
        // Structural-only churn vs the head: no snapshot...
        assert!(!should_snapshot_impl(
            "tab: RENAMED\nhi\ntab: New tab\n",
            HeadRef::Content("tab: A\nhi\n"),
            false
        ));
        // ...unless forced.
        assert!(should_snapshot_impl(
            "tab: RENAMED\nhi\ntab: New tab\n",
            HeadRef::Content("tab: A\nhi\n"),
            true
        ));
        // Prose change: snapshot.
        assert!(should_snapshot_impl(
            "tab: A\nhi2\n",
            HeadRef::Content("tab: A\nhi\n"),
            false
        ));
    }
}

//! Append-only version ledger: events plus a pure fold to current per-block
//! state. `eid`/`ts` are minted by the plugin (JS) because wasm has no clock;
//! everything here is a deterministic, idempotent function of the event list.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
}

/// Metadata for one stored version.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VersionMeta {
    /// Content hash (also the object filename).
    pub hash: String,
    /// First-seen time, unix milliseconds.
    pub ts: u64,
    /// Human label, when one was ever set.
    pub label: Option<String>,
}

/// Current state of one block: its head hash and known versions (in add order).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BlockState {
    /// Hash of the current head version, when one exists.
    pub head: Option<String>,
    /// Every stored version, in add order.
    pub versions: Vec<VersionMeta>,
}

/// Fold the append-only ledger into current state, keyed by block id.
///
/// Events are folded in (ts, eid) order — NOT file order — so a line-union
/// merge from Obsidian Sync / git folds to the same state on every device.
pub fn fold_ledger_impl(events: &[Event]) -> BTreeMap<String, BlockState> {
    let mut events: Vec<Event> = events.to_vec();
    events.sort_by(|a, b| {
        let key = |e: &Event| match e {
            Event::AddVersion { ts, eid, .. }
            | Event::SetHead { ts, eid, .. }
            | Event::Label { ts, eid, .. } => (*ts, eid.clone()),
        };
        key(a).cmp(&key(b))
    });
    let mut state: BTreeMap<String, BlockState> = BTreeMap::new();
    for e in &events {
        match e {
            Event::AddVersion {
                block,
                hash,
                ts,
                label,
                ..
            } => {
                let bs = state.entry(block.clone()).or_default();
                if !bs.versions.iter().any(|v| &v.hash == hash) {
                    bs.versions.push(VersionMeta {
                        hash: hash.clone(),
                        ts: *ts,
                        label: label.clone(),
                    });
                }
            }
            Event::SetHead { block, hash, .. } => {
                state.entry(block.clone()).or_default().head = Some(hash.clone());
            }
            Event::Label {
                block, hash, label, ..
            } => {
                let bs = state.entry(block.clone()).or_default();
                if let Some(v) = bs.versions.iter_mut().find(|v| &v.hash == hash) {
                    v.label = label.clone();
                }
            }
        }
    }
    state
}

/// Concatenated, trimmed, sorted leaf prose of block `content` — the identity
/// versioning gates on, so structure-only churn never mints a version.
///
/// Purpose: shared "did the words change?" key for the plugin and the CLI.
///
/// # Arguments
/// * `content` - a block's inner source
///
/// # Returns
/// A `b3:`-tagged hash of the sorted non-empty leaf texts.
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
    let mut texts = Vec::new();
    collect_leaf_text(
        &crate::parser::parse_block_impl(content).children,
        &mut texts,
    );
    texts.sort_unstable();
    crate::hash_content_impl(&texts.join(" "))
}

/// Depth-first trimmed non-empty leaf texts (code leaves included — code IS content).
fn collect_leaf_text(nodes: &[crate::parser::Node], out: &mut Vec<String>) {
    for n in nodes {
        match n {
            crate::parser::Node::Leaf { text, .. } => {
                let t = text.trim();
                if !t.is_empty() {
                    out.push(t.to_string());
                }
            }
            crate::parser::Node::Container { children, .. } => collect_leaf_text(children, out),
        }
    }
}

/// Whether a block has any non-empty prose (used to skip versioning empty scaffolds).
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
    let mut texts = Vec::new();
    collect_leaf_text(
        &crate::parser::parse_block_impl(content).children,
        &mut texts,
    );
    !texts.is_empty()
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

    #[test]
    fn folds_head_and_versions() {
        let ev = vec![
            add("b", "h1", 1),
            set("b", "h1", 1),
            add("b", "h2", 2),
            set("b", "h2", 2),
        ];
        let st = fold_ledger_impl(&ev);
        assert_eq!(st["b"].head.as_deref(), Some("h2"));
        assert_eq!(st["b"].versions.len(), 2);
    }

    #[test]
    fn dedups_versions_and_is_idempotent() {
        let once = fold_ledger_impl(&[add("b", "h1", 1)]);
        let twice = fold_ledger_impl(&[add("b", "h1", 1), add("b", "h1", 1)]);
        assert_eq!(once, twice);
        assert_eq!(twice["b"].versions.len(), 1);
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
        assert_eq!(fold_ledger_impl(&forward), fold_ledger_impl(&reversed));
        assert_eq!(fold_ledger_impl(&reversed)["b"].head.as_deref(), Some("h2"));
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
        let st = fold_ledger_impl(&ev);
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
        let st = fold_ledger_impl(&ev);
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
            fold_ledger_impl(&ev2)["b"].versions[0].label,
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
        let st = fold_ledger_impl(&ev);
        assert_eq!(st["b"].versions.len(), 1);
        assert_eq!(st["b"].versions[0].label, None);
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
    fn has_content_requires_non_whitespace_prose() {
        assert!(!has_content_impl(""));
        assert!(!has_content_impl("tab: A\n\n"));
        assert!(has_content_impl("tab: A\nhi\n"));
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

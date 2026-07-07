//! Append-only version ledger: events plus a pure fold to current per-block
//! state. `eid`/`ts` are minted by the plugin (JS) because wasm has no clock;
//! everything here is a deterministic, idempotent function of the event list.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One ledger event.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    AddVersion {
        eid: String,
        ts: u64,
        block: String,
        hash: String,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        origin: Option<String>,
        /// Lineage: the hash this version was derived from (branch/edit-previous).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
    },
    SetHead {
        eid: String,
        ts: u64,
        block: String,
        hash: String,
    },
}

/// Metadata for one stored version.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct VersionMeta {
    pub hash: String,
    pub ts: u64,
    pub label: Option<String>,
}

/// Current state of one block: its head hash and known versions (in add order).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BlockState {
    pub head: Option<String>,
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
            Event::AddVersion { ts, eid, .. } | Event::SetHead { ts, eid, .. } => (*ts, eid.clone()),
        };
        key(a).cmp(&key(b))
    });
    let mut state: BTreeMap<String, BlockState> = BTreeMap::new();
    for e in &events {
        match e {
            Event::AddVersion { block, hash, ts, label, .. } => {
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
        }
    }
    state
}

#[cfg(test)]
mod tests {
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
        let ev = vec![add("b", "h1", 1), set("b", "h1", 1), add("b", "h2", 2), set("b", "h2", 2)];
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
        let forward = vec![add("b", "h1", 1), set("b", "h1", 1), add("b", "h2", 2), set("b", "h2", 2)];
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
}

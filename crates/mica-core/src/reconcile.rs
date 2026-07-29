//! Pure reconciliation: given the block ids found in notes (content) and the
//! ids tracked by sidecars, classify what's out of sync. The plugin gathers the
//! two indexes via the Vault API and applies the actions; the classification is
//! deterministic and unit-tested here.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// A block id occurrence inside a note.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ContentRef {
    /// Block id found in a note.
    pub block: String,
    /// Vault-relative note path.
    pub note: String,
}

/// A block id tracked by a sidecar's ledger.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SidecarRef {
    /// Block id found in a sidecar ledger.
    pub block: String,
    /// Vault-relative sidecar path.
    pub sidecar: String,
}

/// A detected inconsistency for the plugin to resolve.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReconcileAction {
    /// History exists but no live block carries the id (note/block deleted).
    OrphanSidecar {
        /// The orphaned block id.
        block: String,
        /// The sidecar holding its history.
        sidecar: String,
    },
    /// A live block has no stored history yet.
    OrphanBlock {
        /// The unversioned block id.
        block: String,
        /// The note carrying it.
        note: String,
    },
    /// The same id appears in more than one note (copy-paste).
    DuplicateBlock {
        /// The duplicated block id.
        block: String,
        /// Every note carrying it.
        notes: Vec<String>,
    },
}

/// Classify the content vs sidecar indexes into actions.
pub fn reconcile_impl(content: &[ContentRef], sidecar: &[SidecarRef]) -> Vec<ReconcileAction> {
    let mut by_block: HashMap<&str, Vec<&str>> = HashMap::with_capacity(content.len());
    // O(c) expected for c live block occurrences.
    for c in content {
        by_block.entry(&c.block).or_default().push(&c.note);
    }
    // Membership only: hash lookup keeps the per-content check O(1) expected;
    // deterministic action order still comes from `by_block` below.
    let sidecar_blocks: HashSet<&str> = sidecar.iter().map(|s| s.block.as_str()).collect();

    let mut actions = Vec::with_capacity(by_block.len() + sidecar.len());
    let mut ordered_blocks: Vec<_> = by_block.iter().collect();
    // O(u log u) for u unique live ids preserves deterministic action order.
    ordered_blocks.sort_unstable_by_key(|(block, _)| *block);
    for (block, notes) in ordered_blocks {
        if notes.len() > 1 {
            let mut ns: Vec<String> = notes.iter().map(|n| (*n).to_string()).collect();
            ns.sort();
            actions.push(ReconcileAction::DuplicateBlock {
                block: (*block).into(),
                notes: ns,
            });
        } else if !sidecar_blocks.contains(*block) {
            actions.push(ReconcileAction::OrphanBlock {
                block: (*block).into(),
                note: notes[0].to_string(),
            });
        }
    }
    for s in sidecar {
        // `by_block` is already the authoritative content-id index. Reusing it
        // avoids retaining a second O(unique blocks) tree solely for membership.
        if !by_block.contains_key(s.block.as_str()) {
            actions.push(ReconcileAction::OrphanSidecar {
                block: s.block.clone(),
                sidecar: s.sidecar.clone(),
            });
        }
    }
    actions
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // Reason: test-only assertions
    use super::*;

    fn c(b: &str, n: &str) -> ContentRef {
        ContentRef {
            block: b.into(),
            note: n.into(),
        }
    }
    fn s(b: &str, sc: &str) -> SidecarRef {
        SidecarRef {
            block: b.into(),
            sidecar: sc.into(),
        }
    }

    #[test]
    fn healthy_produces_no_actions() {
        assert!(reconcile_impl(&[c("b", "n.md")], &[s("b", "n.mica")]).is_empty());
    }

    #[test]
    fn orphan_block_when_no_history() {
        assert_eq!(
            reconcile_impl(&[c("b", "n.md")], &[]),
            vec![ReconcileAction::OrphanBlock {
                block: "b".into(),
                note: "n.md".into()
            }]
        );
    }

    #[test]
    fn orphan_sidecar_when_block_gone() {
        assert_eq!(
            reconcile_impl(&[], &[s("b", "n.mica")]),
            vec![ReconcileAction::OrphanSidecar {
                block: "b".into(),
                sidecar: "n.mica".into()
            }]
        );
    }

    #[test]
    fn duplicate_block_across_notes_sorted() {
        assert_eq!(
            reconcile_impl(&[c("b", "b.md"), c("b", "a.md")], &[s("b", "x.mica")]),
            vec![ReconcileAction::DuplicateBlock {
                block: "b".into(),
                notes: vec!["a.md".into(), "b.md".into()]
            }]
        );
    }

    #[test]
    fn actions_keep_block_order_before_input_ordered_orphan_sidecars() {
        assert_eq!(
            reconcile_impl(
                &[
                    c("z", "z.md"),
                    c("a", "b.md"),
                    c("m", "m.md"),
                    c("a", "a.md"),
                ],
                &[s("z", "z.mica"), s("x", "x.mica")],
            ),
            vec![
                ReconcileAction::DuplicateBlock {
                    block: "a".into(),
                    notes: vec!["a.md".into(), "b.md".into()],
                },
                ReconcileAction::OrphanBlock {
                    block: "m".into(),
                    note: "m.md".into(),
                },
                ReconcileAction::OrphanSidecar {
                    block: "x".into(),
                    sidecar: "x.mica".into(),
                },
            ]
        );
    }
}

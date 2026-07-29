//! Identity-bearing checkpoint helpers for the append-only version ledger.

use std::collections::{HashMap, HashSet};

/// One logical checkpoint's lineage and visibility inputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointIdentity {
    /// Stable ledger event identity.
    pub(crate) id: String,
    /// Original logical parent identity.
    pub(crate) parent: Option<String>,
    /// Whether the checkpoint is visible in the ordinary timeline.
    pub(crate) visible: bool,
}

/// Resolve the nearest visible ancestor for every checkpoint.
///
/// # Arguments
/// * `checkpoints` - logical checkpoints in authoritative ledger order
///
/// # Returns
/// A map from checkpoint identity to its nearest visible ancestor.
///
/// # Panics
/// None.
pub(crate) fn effective_visible_parents(
    checkpoints: &[CheckpointIdentity],
) -> HashMap<String, Option<String>> {
    let by_id: HashMap<&str, &CheckpointIdentity> = checkpoints
        .iter()
        .map(|checkpoint| (checkpoint.id.as_str(), checkpoint))
        .collect();
    let mut resolved: HashMap<String, Option<String>> = HashMap::with_capacity(checkpoints.len());

    // O(n) expected across all checkpoints: once a hidden chain is traversed,
    // every node on that chain is memoized for subsequent descendants.
    for checkpoint in checkpoints {
        if resolved.contains_key(checkpoint.id.as_str()) {
            continue;
        }
        let mut cursor = checkpoint.parent.as_deref();
        let mut hidden = Vec::new();
        let mut seen = HashSet::new();
        let ancestor = loop {
            let Some(id) = cursor else {
                break None;
            };
            if !seen.insert(id) {
                break None;
            }
            let Some(parent) = by_id.get(id) else {
                break None;
            };
            if parent.visible {
                break Some(parent.id.clone());
            }
            if let Some(cached) = resolved.get(id) {
                break cached.clone();
            }
            hidden.push(parent.id.as_str());
            cursor = parent.parent.as_deref();
        };
        for id in hidden {
            resolved.insert(id.to_string(), ancestor.clone());
        }
        resolved.insert(checkpoint.id.clone(), ancestor);
    }
    resolved
}

/// Recover lineage for a legacy ledger that never recorded parents.
///
/// Ledgers written before parent tracking carry only `hash` and `ts` per
/// checkpoint, so every version after the first resolves to "no parent" and
/// automatic comparison has nothing to work with. Timeline position alone is
/// never evidence of descent — a reset or a branch edit reorders history
/// without reordering the list. The recorded head progression *is* evidence:
/// when head advanced to each checkpoint exactly once, in the order they were
/// added, and never returned to an earlier one, no branch can have occurred and
/// each checkpoint's predecessor is necessarily its parent.
///
/// # Arguments
/// * `checkpoints` - logical checkpoints in authoritative ledger order
/// * `head_sequence` - checkpoint ids that head pointed at, in ledger order
///
/// # Returns
/// A child-to-parent map when the ledger is provably linear, otherwise `None`.
///
/// # Panics
/// None.
pub(crate) fn inferred_linear_parents(
    checkpoints: &[CheckpointIdentity],
    head_sequence: &[String],
) -> Option<HashMap<String, String>> {
    if checkpoints.len() < 2 {
        return None;
    }
    // A ledger that records any parent is not a legacy ledger. Whatever it
    // omits elsewhere was omitted deliberately, so nothing here may override it.
    if checkpoints.iter().any(|entry| entry.parent.is_some()) {
        return None;
    }
    // Strict equality is the whole proof: same length, same order, no repeats.
    // A reset re-points head at an earlier checkpoint and a branch adds one out
    // of order; either breaks this comparison and lineage stays unknown.
    if head_sequence.len() != checkpoints.len() {
        return None;
    }
    if head_sequence
        .iter()
        .zip(checkpoints)
        .any(|(head, checkpoint)| head != &checkpoint.id)
    {
        return None;
    }
    Some(
        checkpoints
            .windows(2)
            .map(|pair| (pair[1].id.clone(), pair[0].id.clone()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::{effective_visible_parents, inferred_linear_parents, CheckpointIdentity};

    fn legacy(id: &str) -> CheckpointIdentity {
        CheckpointIdentity {
            id: id.to_string(),
            parent: None,
            visible: true,
        }
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn linear_legacy_head_progression_recovers_parents() {
        // An empty map on refusal makes the assertions below the failure
        // message, rather than a panic that hides which expectation broke.
        let inferred = inferred_linear_parents(
            &[legacy("v1"), legacy("v2"), legacy("v3")],
            &ids(&["v1", "v2", "v3"]),
        )
        .unwrap_or_default();
        assert_eq!(
            inferred.get("v2"),
            Some(&"v1".to_string()),
            "a strictly advancing head proves descent"
        );
        assert_eq!(inferred.get("v3"), Some(&"v2".to_string()));
        assert_eq!(
            inferred.get("v1"),
            None,
            "the first checkpoint stays a root"
        );
    }

    #[test]
    fn a_head_that_returns_to_an_earlier_checkpoint_is_not_linear() {
        // Reset HEAD: head goes back to v1 before v3 is written, so v3 descends
        // from v1, not from v2. Order alone would have guessed wrong.
        assert_eq!(
            inferred_linear_parents(
                &[legacy("v1"), legacy("v2"), legacy("v3")],
                &ids(&["v1", "v2", "v1", "v3"])
            ),
            None
        );
    }

    #[test]
    fn a_head_that_skips_a_checkpoint_is_not_linear() {
        assert_eq!(
            inferred_linear_parents(
                &[legacy("v1"), legacy("v2"), legacy("v3")],
                &ids(&["v1", "v3"])
            ),
            None
        );
    }

    #[test]
    fn out_of_order_head_progression_is_not_linear() {
        assert_eq!(
            inferred_linear_parents(
                &[legacy("v1"), legacy("v2"), legacy("v3")],
                &ids(&["v1", "v3", "v2"])
            ),
            None
        );
    }

    #[test]
    fn a_ledger_that_records_any_parent_is_left_alone() {
        let mut recorded = legacy("v2");
        recorded.parent = Some("v1".to_string());
        assert_eq!(
            inferred_linear_parents(
                &[legacy("v1"), recorded, legacy("v3")],
                &ids(&["v1", "v2", "v3"])
            ),
            None,
            "a ledger with real lineage must never be second-guessed"
        );
    }

    #[test]
    fn a_single_checkpoint_has_nothing_to_infer() {
        assert_eq!(
            inferred_linear_parents(&[legacy("v1")], &ids(&["v1"])),
            None
        );
        assert_eq!(inferred_linear_parents(&[], &[]), None);
    }

    #[test]
    fn a_removed_checkpoint_still_participates_in_the_chain() {
        // Visibility is a timeline concern; lineage runs through hidden
        // checkpoints so `effective_visible_parents` can splice them out after.
        let mut hidden = legacy("v2");
        hidden.visible = false;
        let inferred = inferred_linear_parents(
            &[legacy("v1"), hidden, legacy("v3")],
            &ids(&["v1", "v2", "v3"]),
        )
        .unwrap_or_default();
        assert_eq!(inferred.get("v3"), Some(&"v2".to_string()));
    }

    #[test]
    fn hidden_checkpoint_is_spliced_out() {
        let resolved = effective_visible_parents(&[
            CheckpointIdentity {
                id: "v1".to_string(),
                parent: None,
                visible: true,
            },
            CheckpointIdentity {
                id: "v2".to_string(),
                parent: Some("v1".to_string()),
                visible: false,
            },
            CheckpointIdentity {
                id: "v3".to_string(),
                parent: Some("v2".to_string()),
                visible: true,
            },
        ]);
        assert_eq!(resolved.get("v1"), Some(&None));
        assert_eq!(resolved.get("v2"), Some(&Some("v1".to_string())));
        assert_eq!(resolved.get("v3"), Some(&Some("v1".to_string())));
    }

    #[test]
    fn missing_or_cyclic_lineage_stops_safely() {
        let resolved = effective_visible_parents(&[
            CheckpointIdentity {
                id: "missing".to_string(),
                parent: Some("absent".to_string()),
                visible: true,
            },
            CheckpointIdentity {
                id: "a".to_string(),
                parent: Some("b".to_string()),
                visible: false,
            },
            CheckpointIdentity {
                id: "b".to_string(),
                parent: Some("a".to_string()),
                visible: false,
            },
        ]);
        assert_eq!(resolved.get("missing"), Some(&None));
        assert_eq!(resolved.get("a"), Some(&None));
        assert_eq!(resolved.get("b"), Some(&None));
    }
}

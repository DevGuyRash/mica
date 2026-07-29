import { scopeParentFamilyKey, type ScopeIndex, type VersionScope } from "./versionScopeCore";

export const MAX_SELECTED_SCOPES = 8;

export interface ScopeSelectionState {
	mode: "one" | "multiple";
	keys: string[];
	anchor: string | null;
}

export type ScopeSelectionResult =
	{ ok: true; state: ScopeSelectionState } | { ok: false; state: ScopeSelectionState; reason: string };

export function selectScope(
	state: ScopeSelectionState,
	index: ScopeIndex,
	key: string,
	modifiers: { toggle?: boolean; range?: boolean; additive?: boolean } = {},
): ScopeSelectionResult {
	const scope = index.byKey.get(key);
	if (!scope) return { ok: false, state, reason: "That element is no longer present." };
	const modified = Boolean(modifiers.toggle || modifiers.range || modifiers.additive);
	if (state.mode !== "multiple" && !modified) return { ok: true, state: { mode: "one", keys: [key], anchor: key } };
	// A plain tap accumulates only where the user asked for that — Multiple mode
	// exists for coarse pointers, which have no modifier keys. A modifier held on
	// a single click must NOT promote the mode: doing so silently converts every
	// later unmodified click, which reads as "Ctrl stopped working".
	const plainMultipleToggle = state.mode === "multiple" && !modified;

	let requested: VersionScope[];
	if (modifiers.range) {
		const anchor = state.anchor ? index.byKey.get(state.anchor) : null;
		if (!anchor || anchor.parentKey !== scope.parentKey || anchor.family !== scope.family) {
			return {
				ok: false,
				state,
				reason: "Range selection works between sibling elements of the same type.",
			};
		}
		const low = Math.min(anchor.siblingOrdinal, scope.siblingOrdinal);
		const high = Math.max(anchor.siblingOrdinal, scope.siblingOrdinal);
		const siblings = index.byParentFamily.get(scopeParentFamilyKey(scope.parentKey, scope.family)) ?? [];
		requested = siblings.slice(low, high + 1);
	} else {
		requested = [scope];
	}

	const selected =
		modifiers.additive || modifiers.toggle || plainMultipleToggle ? new Set(state.keys) : new Set<string>();
	for (const candidate of requested) {
		if ((modifiers.toggle || plainMultipleToggle) && requested.length === 1 && selected.has(candidate.key))
			selected.delete(candidate.key);
		else {
			for (const selectedKey of [...selected]) {
				const current = index.byKey.get(selectedKey);
				if (current && overlapsAncestry(current, candidate)) selected.delete(selectedKey);
			}
			selected.add(candidate.key);
		}
	}
	const keys = [...selected]
		.map((selectedKey) => index.byKey.get(selectedKey))
		.filter((candidate): candidate is VersionScope => Boolean(candidate))
		.sort((left, right) => left.start - right.start || right.end - left.end)
		.map((candidate) => candidate.key);
	if (keys.length > MAX_SELECTED_SCOPES)
		return {
			ok: false,
			state,
			reason: `Choose at most ${MAX_SELECTED_SCOPES} elements at once.`,
		};
	return {
		ok: true,
		state: { mode: state.mode, keys, anchor: scope.key },
	};
}

/** Which elements a Shift-range can reach from the current anchor. Ranges only
 * span siblings of one parent and family, because nothing orders elements
 * across containers. The UI needs this *before* the click so the constraint is
 * visible rather than reported by a Notice after a refused one. */
export function rangeCandidates(state: ScopeSelectionState, index: ScopeIndex): Set<string> {
	const anchor = state.anchor ? index.byKey.get(state.anchor) : null;
	if (!anchor) return new Set();
	const siblings = index.byParentFamily.get(scopeParentFamilyKey(anchor.parentKey, anchor.family)) ?? [];
	return new Set(siblings.map((sibling) => sibling.key));
}

export function reconcileScopeSelection(state: ScopeSelectionState, index: ScopeIndex): ScopeSelectionState {
	const keys = state.keys.filter((key) => index.byKey.has(key));
	return {
		mode: state.mode,
		keys: keys.length || state.mode === "multiple" ? keys : ["block:"],
		anchor: state.anchor && index.byKey.has(state.anchor) ? state.anchor : (keys[0] ?? null),
	};
}

function overlapsAncestry(left: VersionScope, right: VersionScope): boolean {
	return (left.start <= right.start && left.end >= right.end) || (right.start <= left.start && right.end >= left.end);
}

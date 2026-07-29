export type DirectActionPriority = 0 | 1 | 2 | 3 | 4;

export interface ResponsiveActionCandidate {
	id: string;
	width: number;
	directPriority?: DirectActionPriority;
	overflowOnly?: boolean;
	pinned?: boolean;
}

export interface ResponsiveActionPacking {
	direct: string[];
	overflow: string[];
}

/** Pure responsive packing contract. The production mount is added after the
 * behavior is pinned by tests. */
export function packResponsiveActions(
	actions: readonly ResponsiveActionCandidate[],
	availableWidth: number,
	gap: number,
	menuWidth: number,
	_menuOnly = false,
): ResponsiveActionPacking {
	const candidates: ResponsiveActionCandidate[][] = [[], [], [], [], []];
	const pinned: ResponsiveActionCandidate[] = [];
	let ordinaryCount = 0;
	let hasOverflowOnly = false;
	for (const action of actions) {
		if (action.pinned) {
			pinned.push(action);
			continue;
		}
		ordinaryCount++;
		if (action.overflowOnly || action.directPriority === undefined) {
			hasOverflowOnly = true;
			continue;
		}
		candidates[action.directPriority].push(action);
	}
	if (_menuOnly) {
		const direct: string[] = [];
		const overflow: string[] = [];
		for (const action of actions) (action.pinned ? direct : overflow).push(action.id);
		return { direct, overflow };
	}

	const selectableIds = new Set<string>();
	let allDirectWidth = 0;
	let allDirectCount = 0;
	for (const action of pinned) {
		selectableIds.add(action.id);
		allDirectWidth += action.width;
		allDirectCount++;
	}
	for (const tier of candidates) {
		for (const action of tier) {
			selectableIds.add(action.id);
			allDirectWidth += action.width;
			allDirectCount++;
		}
	}
	const allDirectGaps = Math.max(0, allDirectCount - 1) * gap;
	if (!hasOverflowOnly && allDirectWidth + allDirectGaps <= availableWidth) {
		const direct: string[] = [];
		for (const action of actions) if (selectableIds.has(action.id)) direct.push(action.id);
		return { direct, overflow: [] };
	}

	const selected = new Set<string>();
	let pinnedWidth = 0;
	for (const action of pinned) {
		selected.add(action.id);
		pinnedWidth += action.width;
	}
	let visibleCount = pinned.length + (ordinaryCount ? 1 : 0);
	let used = pinnedWidth + (ordinaryCount ? menuWidth : 0);
	used += Math.max(0, visibleCount - 1) * gap;
	for (const tier of candidates) {
		for (const action of tier) {
			const extra = action.width + (visibleCount ? gap : 0);
			if (used + extra > availableWidth) continue;
			selected.add(action.id);
			used += extra;
			visibleCount++;
		}
	}
	const direct: string[] = [];
	const overflow: string[] = [];
	for (const action of actions) (selected.has(action.id) ? direct : overflow).push(action.id);
	return { direct, overflow };
}

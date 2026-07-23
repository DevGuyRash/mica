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
	const pinned = actions.filter((action) => action.pinned);
	const ordinary = actions.filter((action) => !action.pinned);
	if (_menuOnly)
		return {
			direct: pinned.map((action) => action.id),
			overflow: ordinary.map((action) => action.id),
		};

	const candidates: ResponsiveActionCandidate[][] = [[], [], [], [], []];
	let hasOverflowOnly = false;
	for (const action of ordinary) {
		if (action.overflowOnly || action.directPriority === undefined) {
			hasOverflowOnly = true;
			continue;
		}
		candidates[action.directPriority].push(action);
	}

	const allDirect = [...pinned, ...candidates.flat()];
	const allDirectWidth = allDirect.reduce((total, action) => total + action.width, 0);
	const allDirectGaps = Math.max(0, allDirect.length - 1) * gap;
	if (!hasOverflowOnly && allDirectWidth + allDirectGaps <= availableWidth) {
		const directIds = new Set(allDirect.map((action) => action.id));
		return {
			direct: actions.filter((action) => directIds.has(action.id)).map((action) => action.id),
			overflow: [],
		};
	}

	const selected = new Set(pinned.map((action) => action.id));
	let visibleCount = pinned.length + (ordinary.length ? 1 : 0);
	let used = pinned.reduce((total, action) => total + action.width, 0) + (ordinary.length ? menuWidth : 0);
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
	return {
		direct: actions.filter((action) => selected.has(action.id)).map((action) => action.id),
		overflow: actions.filter((action) => !selected.has(action.id)).map((action) => action.id),
	};
}

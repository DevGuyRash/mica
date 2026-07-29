/**
 * The single answer to "what am I comparing right now".
 *
 * Every version-history surface — the diff render, the caption, the copied
 * patch, and control enablement — derives from one plan, so the clipboard can
 * never describe a different comparison than the screen. `planCells` fixes the
 * order once and both the renderer and the copier walk it.
 */

/** Grid layouts stay readable to about four columns beside the base. Stacked
 * layouts (patch) pass `Number.POSITIVE_INFINITY` instead. */
export const MAX_COMPARISON_COLUMNS = 4;

/** A version taking part in a comparison. `key` is the modal's version key (a
 * version id, or the working-copy/empty sentinel); `label` is display text. */
export interface ComparisonTarget {
	readonly key: string;
	readonly label: string;
}

/** A focused element, identified by locator id so open state and de-duplication
 * survive re-render and version switches. */
export interface ComparisonElement {
	readonly id: string;
	readonly name: string;
}

export interface ComparisonPlan {
	/** `"pair"` compares one selected version; `"multi"` compares picked ones. */
	readonly kind: "pair" | "multi";
	readonly base: ComparisonTarget;
	/** Displayed targets, in timeline order, capped at the column budget. In
	 * `"multi"` this never contains `base.key`. */
	readonly targets: ComparisonTarget[];
	/** The base, when it was also picked as a target — reported, never hidden. */
	readonly droppedBase: ComparisonTarget | null;
	/** Picked targets the cap excluded from display, and therefore from copy. */
	readonly overflow: ComparisonTarget[];
	/** Empty means the whole block. */
	readonly elements: ComparisonElement[];
}

/** One diff to render or copy. Cells are element-major: each focused element
 * owns a row, and each row spans the targets. */
export interface ComparisonCell {
	readonly element: ComparisonElement | null;
	readonly elementIndex: number;
	readonly target: ComparisonTarget;
	readonly targetIndex: number;
}

export interface ComparisonPlanInput {
	readonly base: ComparisonTarget;
	/** Timeline-ordered versions the user checked. Empty means a pair compare. */
	readonly picks: readonly ComparisonTarget[];
	/** The comparison subject when nothing is checked. */
	readonly selected: ComparisonTarget;
	readonly elements: readonly ComparisonElement[];
	readonly columnCap?: number;
}

/**
 * Two invariants, deliberately distinct:
 *
 * 1. A *picked* target never duplicates the base — it moves to `droppedBase`.
 *    This is what stops the base appearing as its own column.
 * 2. When picks resolve to nothing the plan degrades to a pair on the selected
 *    version, *even if that equals the base*. Pinning the version you are
 *    viewing is a self-comparison the user asked for, not a defect to suppress.
 */
export function planComparison(input: ComparisonPlanInput): ComparisonPlan {
	const cap = Math.max(0, input.columnCap ?? MAX_COMPARISON_COLUMNS);
	const seen = new Set<string>();
	const picked: ComparisonTarget[] = [];
	let droppedBase: ComparisonTarget | null = null;
	for (const pick of input.picks) {
		if (pick.key === input.base.key) {
			droppedBase ??= pick;
			continue;
		}
		if (seen.has(pick.key)) continue;
		seen.add(pick.key);
		picked.push(pick);
	}
	const multi = picked.length > 0;
	const all = multi ? picked : [input.selected];
	return {
		kind: multi ? "multi" : "pair",
		base: input.base,
		targets: all.slice(0, cap),
		droppedBase,
		overflow: all.length > cap ? all.slice(cap) : [],
		elements: [...input.elements],
	};
}

/** Display order, fixed once. A renderer that walks this and a copier that
 * walks this cannot disagree about what the comparison contains. */
export function planCells(plan: ComparisonPlan): ComparisonCell[] {
	const cells: ComparisonCell[] = [];
	const elements: (ComparisonElement | null)[] = plan.elements.length ? plan.elements : [null];
	for (const [elementIndex, element] of elements.entries()) {
		for (const [targetIndex, target] of plan.targets.entries()) {
			cells.push({
				element,
				elementIndex: plan.elements.length ? elementIndex : -1,
				target,
				targetIndex,
			});
		}
	}
	return cells;
}

/** Every version key the plan needs loaded before it can render or copy. The
 * empty/working sentinels are the caller's to filter — this stays pure. */
export function planKeys(plan: ComparisonPlan): string[] {
	const keys = [plan.base.key];
	for (const target of plan.targets) if (!keys.includes(target.key)) keys.push(target.key);
	return keys;
}

/** One line stating the comparison in words, for the caption and the bar. */
export function describePlan(plan: ComparisonPlan): string {
	const scope = plan.elements.length
		? `${plan.elements.length === 1 ? plan.elements[0].name : `${plan.elements.length} elements`} · `
		: "";
	if (plan.kind === "pair") return `${scope}${plan.base.label} → ${plan.targets[0]?.label ?? "nothing"}`;
	return `${scope}${plan.base.label} → ${plan.targets.map((target) => target.label).join(", ")}`;
}

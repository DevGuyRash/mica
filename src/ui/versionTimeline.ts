/**
 * Timeline composition and selection policy, kept free of the DOM so the two
 * pieces of logic most likely to go wrong — where a removed checkpoint belongs
 * chronologically, and what a modified click selects — can be checked exactly
 * instead of inferred from a rendered list.
 */

export interface TimelineRow {
	readonly meta: { readonly versionId: string };
	/** Index into the whole history in chronological order, removed checkpoints
	 * included. This is what survives a checkpoint leaving the timeline; the
	 * dense `v{n}` label does not. */
	readonly originalIndex: number;
	readonly removed?: boolean;
}

/**
 * Interleave removed checkpoints back into their chronological slots.
 *
 * Both inputs arrive newest-first, so this merges in one pass rather than
 * concatenating and re-sorting the whole timeline on every render. Ties cannot
 * occur — `originalIndex` is a position in one ordering — but if a corrupt
 * ledger produced one, live rows win so the timeline never loses a checkpoint
 * the user can still select.
 */
export function mergeTimelineRows<T extends TimelineRow>(live: readonly T[], removed: readonly T[]): T[] {
	if (!removed.length) return [...live];
	if (!live.length) return [...removed];
	const merged: T[] = [];
	let liveAt = 0;
	let removedAt = 0;
	while (liveAt < live.length || removedAt < removed.length) {
		const takeLive =
			removedAt >= removed.length ||
			(liveAt < live.length && live[liveAt].originalIndex >= removed[removedAt].originalIndex);
		merged.push(takeLive ? live[liveAt++] : removed[removedAt++]);
	}
	return merged;
}

export interface PickRequest {
	readonly picked: ReadonlySet<string>;
	readonly anchor: string | null;
	readonly versionId: string;
	readonly shift?: boolean;
	/** Ctrl/Cmd: extend rather than replace when a range is taken. */
	readonly additive?: boolean;
	/** Timeline position of a checkpoint, or -1 when it is not selectable. */
	readonly positionOf: (versionId: string) => number;
	/** The checkpoint at a timeline position, or null past the ends. */
	readonly idAt: (position: number) => string | null;
}

export interface PickResult {
	readonly picked: Set<string>;
	readonly anchor: string;
}

/**
 * What a checkbox activation selects.
 *
 * Shift spans from the anchor, replacing the selection unless Ctrl/Cmd is also
 * held; anything else toggles the one checkpoint. A range whose endpoints are
 * not both on the timeline — a removed checkpoint has no position — degrades to
 * a plain toggle rather than silently selecting a span the user cannot see.
 */
export function nextPickedSelection(request: PickRequest): PickResult {
	const { picked, anchor, versionId, positionOf, idAt } = request;
	if (request.shift && anchor) {
		const from = positionOf(anchor);
		const to = positionOf(versionId);
		if (from >= 0 && to >= 0) {
			const next = request.additive ? new Set(picked) : new Set<string>();
			for (let at = Math.min(from, to); at <= Math.max(from, to); at++) {
				const id = idAt(at);
				if (id !== null) next.add(id);
			}
			return { picked: next, anchor: versionId };
		}
	}
	const next = new Set(picked);
	if (!next.delete(versionId)) next.add(versionId);
	return { picked: next, anchor: versionId };
}

/** Split a selection into what bulk actions can act on. A removed checkpoint
 * stays selectable so restore can reach it, but it has left the timeline and can
 * never be a comparison target. */
export function partitionPicked(
	picked: ReadonlySet<string>,
	isRemoved: (versionId: string) => boolean,
): { live: string[]; removed: string[] } {
	const live: string[] = [];
	const removed: string[] = [];
	for (const id of picked) (isRemoved(id) ? removed : live).push(id);
	return { live, removed };
}

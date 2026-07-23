/** A resolved authoring-ribbon entry. Separators only survive between tools. */
export type ToolbarLayoutEntry<T> = { kind: "tool"; value: T } | { kind: "separator" };

/**
 * Resolve surface-specific tools before normalizing separators. This prevents
 * Markdown-only controls from leaving vertical lines in code ribbons.
 */
export function normalizeToolbarLayout<T>(
	layout: readonly string[],
	resolve: (id: string) => T | null,
): ToolbarLayoutEntry<T>[] {
	const entries: ToolbarLayoutEntry<T>[] = [];
	let separatorPending = false;
	for (const id of layout) {
		if (id === "|") {
			if (entries.length > 0) separatorPending = true;
			continue;
		}
		const value = resolve(id);
		if (value === null) continue;
		if (separatorPending) entries.push({ kind: "separator" });
		entries.push({ kind: "tool", value });
		separatorPending = false;
	}
	return entries;
}

export interface ToolbarMeasuredEntry {
	kind: "tool" | "separator";
	width: number;
}

export interface ToolbarPacking {
	/** Entries in the stable prefix that remain directly visible. */
	direct: boolean[];
	/** Tool entries moved into More. Separators never enter the panel. */
	overflow: boolean[];
	showMore: boolean;
}

/**
 * Pack a stable toolbar prefix in O(entries). The real More width and gap are
 * part of every overflow candidate, so the trigger cannot displace or clip the
 * last direct tool. A separator is direct only when a following tool fits.
 */
export function packToolbarEntries(
	entries: readonly ToolbarMeasuredEntry[],
	availableWidth: number,
	moreWidth: number,
	gap: number,
): ToolbarPacking {
	const direct = entries.map(() => false);
	const overflow = entries.map(() => false);
	const finiteAvailable = Math.max(0, Number.isFinite(availableWidth) ? availableWidth : 0);
	const finiteMore = Math.max(0, Number.isFinite(moreWidth) ? moreWidth : 0);
	const finiteGap = Math.max(0, Number.isFinite(gap) ? gap : 0);

	let total = 0;
	for (let i = 0; i < entries.length; i++) {
		total += Math.max(0, entries[i].width);
		if (i > 0) total += finiteGap;
	}
	if (total <= finiteAvailable) {
		direct.fill(true);
		return { direct, overflow, showMore: false };
	}

	let prefixWidth = 0;
	let directEnd = -1;
	for (let i = 0; i < entries.length; i++) {
		prefixWidth += Math.max(0, entries[i].width);
		if (i > 0) prefixWidth += finiteGap;
		if (entries[i].kind === "tool" && prefixWidth + finiteGap + finiteMore <= finiteAvailable) {
			directEnd = i;
		}
	}

	for (let i = 0; i < entries.length; i++) {
		direct[i] = i <= directEnd;
		overflow[i] = entries[i].kind === "tool" && i > directEnd;
	}
	return { direct, overflow, showMore: overflow.some(Boolean) };
}

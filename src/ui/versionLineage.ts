import type { VersionLookupRow } from "./versionWindow";

export interface LineageStep {
	/** The actual lineage edge is always parent → child. */
	parent: string;
	child: string;
	/** Direction traveled from comparison base toward selected snapshot. */
	direction: "forward" | "backward";
}

export function buildVersionParentIndex(
	rows: readonly VersionLookupRow[],
	workingKey: string,
	workingParent: string | null,
): Map<string, string | null> {
	const parents = new Map<string, string | null>();
	for (const row of rows)
		parents.set(row.meta.versionId, row.meta.effectiveParentVersionId ?? row.meta.parent ?? null);
	parents.set(workingKey, workingParent);
	return parents;
}

/** Find a bounded route through the version-parent graph, including sibling
 * branches via their nearest common ancestor. An empty result means both
 * endpoints are the same; `null` means lineage is unavailable or exceeds the
 * safety bound. The route never invents an add-order relationship. */
export function versionLineageRoute(
	rows: readonly VersionLookupRow[],
	from: string,
	to: string,
	workingKey: string,
	workingParent: string | null,
	maxSteps = 256,
): LineageStep[] | null {
	return versionLineageRouteFromParents(buildVersionParentIndex(rows, workingKey, workingParent), from, to, maxSteps);
}

/** Indexed adapter for interactive history surfaces that resolve many routes
 * against the same immutable ledger fold. */
export function versionLineageRouteFromParents(
	parents: ReadonlyMap<string, string | null>,
	from: string,
	to: string,
	maxSteps = 256,
): LineageStep[] | null {
	if (from === to) return [];
	if (!parents.has(from) || !parents.has(to)) return null;

	const fromChain = ancestorChain(from, parents, maxSteps + 1);
	const toChain = ancestorChain(to, parents, maxSteps + 1);
	if (!fromChain || !toChain) return null;
	const toAncestors = new Set(toChain);
	const lca = fromChain.find((hash) => toAncestors.has(hash));
	if (!lca) return null;

	const steps: LineageStep[] = [];
	let cursor = from;
	while (cursor !== lca) {
		const parent = parents.get(cursor);
		if (!parent) return null;
		steps.push({ parent, child: cursor, direction: "backward" });
		cursor = parent;
	}
	const down: { parent: string; child: string }[] = [];
	cursor = to;
	while (cursor !== lca) {
		const parent = parents.get(cursor);
		if (!parent) return null;
		down.push({ parent, child: cursor });
		cursor = parent;
	}
	for (const edge of down.reverse()) steps.push({ ...edge, direction: "forward" });
	return steps.length <= maxSteps ? steps : null;
}

function ancestorChain(start: string, parents: ReadonlyMap<string, string | null>, limit: number): string[] | null {
	const chain: string[] = [];
	const seen = new Set<string>();
	let cursor: string | null = start;
	while (cursor) {
		if (!parents.has(cursor) || seen.has(cursor) || chain.length > limit) return null;
		chain.push(cursor);
		seen.add(cursor);
		cursor = parents.get(cursor) ?? null;
	}
	return chain;
}

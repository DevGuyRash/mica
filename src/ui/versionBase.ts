import type { VersionLookupRow } from "./versionWindow";

/** "auto" and "head" are special selectors; other strings name a version. */
export type VersionBaseMode = string;
export type AutoBaseReason = "current-head" | "parent" | "before-first" | "unavailable-parent";

export interface ResolvedVersionBase {
	key: string;
	autoReason?: AutoBaseReason;
}

export interface VersionBaseIndex<T extends VersionLookupRow = VersionLookupRow> {
	readonly byId: ReadonlyMap<string, T>;
	readonly head: string | null;
}

/** Build once for a history view; base resolution can then remain O(1) while
 * preserving the array-only adapter for small one-shot callers. */
export function buildVersionBaseIndex<T extends VersionLookupRow>(rows: readonly T[]): VersionBaseIndex<T> {
	const byId = new Map<string, T>();
	let head: string | null = null;
	for (const row of rows) {
		byId.set(row.meta.versionId, row);
		if (row.head && head === null) head = row.meta.versionId;
	}
	return { byId, head };
}

/** Resolve comparison intent without substituting add-order neighbors. */
export function resolveVersionBase(
	rows: readonly VersionLookupRow[],
	selected: string,
	mode: VersionBaseMode,
	workingKey: string,
	emptyKey: string,
	prebuiltIndex?: VersionBaseIndex,
): ResolvedVersionBase {
	if (mode !== "auto" && mode !== "head") return { key: mode };
	const head = prebuiltIndex ? (prebuiltIndex.head ?? undefined) : rows.find((row) => row.head)?.meta.versionId;
	if (mode === "head") return { key: head ?? emptyKey };
	if (selected === workingKey)
		return head
			? { key: head, autoReason: "current-head" }
			: rows.length
				? { key: emptyKey, autoReason: "unavailable-parent" }
				: { key: emptyKey, autoReason: "before-first" };
	const row = prebuiltIndex
		? prebuiltIndex.byId.get(selected)
		: rows.find((candidate) => candidate.meta.versionId === selected);
	if (!row) return { key: emptyKey, autoReason: "unavailable-parent" };
	if (row.meta.effectiveParentVersionId) return { key: row.meta.effectiveParentVersionId, autoReason: "parent" };
	return row.meta.lineageRoot || row.n === 1
		? { key: emptyKey, autoReason: "before-first" }
		: { key: emptyKey, autoReason: "unavailable-parent" };
}

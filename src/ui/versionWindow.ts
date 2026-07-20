export const VERSION_ROW_PAGE_SIZE = 100;

export interface VersionLookupRow {
	readonly n: number;
	readonly meta: {
		readonly hash: string;
		readonly label?: string | null;
	};
}

/** Clamp one fixed-size history window. The UI replaces pages instead of
 * accumulating rows, so rendered DOM and listeners remain bounded. */
export function versionPageBounds(total: number, requestedStart: number): { start: number; end: number } {
	const lastStart = Math.max(0, Math.floor(Math.max(0, total - 1) / VERSION_ROW_PAGE_SIZE) * VERSION_ROW_PAGE_SIZE);
	const start = Math.min(lastStart, Math.max(0, requestedStart));
	return { start, end: Math.min(total, start + VERSION_ROW_PAGE_SIZE) };
}

/** Resolve the base-picker's explicit search without materializing one menu
 * item per historical version. At most two rows are returned: the caller only
 * needs to distinguish missing, unique, and ambiguous results. */
export function matchingVersions<T extends VersionLookupRow>(rows: readonly T[], rawQuery: string): T[] {
	const query = rawQuery.trim();
	if (!query) return [];
	const ordinal = /^v(\d+)$/i.exec(query);
	const wantedNumber = ordinal ? Number.parseInt(ordinal[1], 10) : null;
	const matches: T[] = [];
	for (const row of rows) {
		const matchesQuery =
			wantedNumber !== null
				? row.n === wantedNumber
				: row.meta.label === query ||
					row.meta.hash.startsWith(query) ||
					row.meta.hash.slice(3).startsWith(query);
		if (matchesQuery) matches.push(row);
		if (matches.length === 2) break;
	}
	return matches;
}

export const VERSION_ROW_PAGE_SIZE = 100;

export interface VersionLookupRow {
	readonly n: number;
	readonly head?: boolean;
	readonly meta: {
		readonly versionId: string;
		readonly hash: string;
		readonly label?: string | null;
		readonly ts?: number;
		readonly parent?: string | null;
		readonly effectiveParentVersionId?: string | null;
		readonly lineageRoot?: boolean;
	};
}

export type VersionMatchReason = "recent" | "number" | "id" | "hash" | "label" | "date";

export interface VersionSearchResult<T extends VersionLookupRow> {
	readonly row: T;
	readonly reason: VersionMatchReason;
	readonly score: number;
}

export interface VersionSearchIndexEntry<T extends VersionLookupRow> {
	readonly row: T;
	readonly versionId: string;
	readonly hash: string;
	readonly hashBody: string;
	readonly label: string;
	readonly date: string;
}

export interface VersionSearchWindow<T extends VersionLookupRow> {
	readonly results: VersionSearchResult<T>[];
	readonly total: number;
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
	return searchVersions(rows, rawQuery, 2).map((result) => result.row);
}

/** Search version metadata without loading historical objects. The returned
 * window keeps the picker DOM bounded even for histories with many thousands
 * of versions. Exact identities outrank labels, then dates and fuzzy labels. */
export function searchVersions<T extends VersionLookupRow>(
	rows: readonly T[],
	rawQuery: string,
	limit = VERSION_ROW_PAGE_SIZE,
): VersionSearchResult<T>[] {
	return searchVersionIndex(buildVersionSearchIndex(rows), rawQuery, limit).results;
}

/** Normalize immutable metadata once per picker instead of repeating locale
 * date formatting and case folding on every keystroke. */
export function buildVersionSearchIndex<T extends VersionLookupRow>(rows: readonly T[]): VersionSearchIndexEntry<T>[] {
	return rows.map((row) => {
		const hash = row.meta.hash.toLocaleLowerCase();
		const hashSeparator = hash.indexOf(":");
		const timestamp = row.meta.ts;
		const date = timestamp ? new Date(timestamp) : null;
		return {
			row,
			versionId: row.meta.versionId.toLocaleLowerCase(),
			hash,
			hashBody: hashSeparator >= 0 ? hash.slice(hashSeparator + 1) : hash,
			label: row.meta.label?.trim().toLocaleLowerCase() ?? "",
			date: date
				? `${date.toISOString()} ${date.toLocaleString()} ${date.toDateString()}`.toLocaleLowerCase()
				: "",
		};
	});
}

export function searchVersionIndex<T extends VersionLookupRow>(
	index: readonly VersionSearchIndexEntry<T>[],
	rawQuery: string,
	limit = VERSION_ROW_PAGE_SIZE,
): VersionSearchWindow<T> {
	const query = rawQuery.trim().toLocaleLowerCase();
	const boundedLimit = Math.max(0, Math.floor(limit));
	if (!boundedLimit) return { results: [], total: 0 };
	if (!query)
		return {
			results: index.slice(0, boundedLimit).map((entry, at) => ({
				row: entry.row,
				reason: "recent",
				score: index.length - at,
			})),
			total: index.length,
		};

	const ordinal = /^v?(\d+)$/.exec(query);
	const wantedNumber = ordinal ? Number.parseInt(ordinal[1], 10) : null;
	const matches: VersionSearchResult<T>[] = [];
	let total = 0;
	for (const entry of index) {
		const row = entry.row;
		let reason: VersionMatchReason | null = null;
		let score = 0;
		if (wantedNumber !== null && row.n === wantedNumber) {
			reason = "number";
			score = 10_000;
		} else {
			if (entry.versionId === query) {
				reason = "id";
				score = 9_900;
			} else if (entry.versionId.startsWith(query)) {
				reason = "id";
				score = 9_700 + Math.min(200, query.length);
			} else if (entry.hash === query || entry.hashBody === query) {
				reason = "hash";
				score = 9_500;
			} else if (entry.hash.startsWith(query) || entry.hashBody.startsWith(query)) {
				reason = "hash";
				score = 9_000 + Math.min(400, query.length);
			} else {
				if (entry.label === query) {
					reason = "label";
					score = 8_000;
				} else if (entry.label.startsWith(query)) {
					reason = "label";
					score = 7_000 + Math.min(400, query.length);
				} else if (entry.label.includes(query)) {
					reason = "label";
					score = 6_000 + Math.min(400, query.length);
				} else {
					const fuzzy = entry.label ? subsequenceScore(entry.label, query) : 0;
					if (fuzzy) {
						reason = "label";
						score = 4_000 + fuzzy;
					} else if (entry.date.includes(query)) {
						reason = "date";
						score = 3_000 + Math.min(400, query.length);
					}
				}
			}
		}
		if (reason) {
			total++;
			insertRanked(matches, { row, reason, score }, boundedLimit);
		}
	}
	return { results: matches, total };
}

/** Maintain a bounded best-result window. Searching thousands of versions is
 * O(rows · log(limit)) time and O(limit) space instead of retaining and sorting
 * every fuzzy match. The UI limit is fixed at 100. */
function insertRanked<T extends VersionLookupRow>(
	results: VersionSearchResult<T>[],
	candidate: VersionSearchResult<T>,
	limit: number,
): void {
	let low = 0;
	let high = results.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const current = results[middle];
		if (candidate.score > current.score || (candidate.score === current.score && candidate.row.n > current.row.n))
			high = middle;
		else low = middle + 1;
	}
	if (low >= limit) return;
	results.splice(low, 0, candidate);
	if (results.length > limit) results.pop();
}

/** A compact fuzzy fallback: every query character must appear in order.
 * Consecutive and word-start matches rank higher, without allocating grams or
 * running edit-distance matrices on every picker keystroke. */
function subsequenceScore(value: string, query: string): number {
	if (!query) return 0;
	let at = 0;
	let score = 0;
	let previous = -2;
	for (let index = 0; index < value.length && at < query.length; index++) {
		if (value[index] !== query[at]) continue;
		score += index === previous + 1 ? 8 : index === 0 || /\s|[-_/]/.test(value[index - 1]) ? 5 : 1;
		previous = index;
		at++;
	}
	return at === query.length ? score : 0;
}

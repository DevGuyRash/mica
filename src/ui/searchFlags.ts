export interface SearchFlagOptions {
	matchCase: boolean;
	multiline: boolean;
	dotAll: boolean;
	otherFlags: string;
}

export type SearchFlagResult = { ok: true; flags: string } | { ok: false; error: string };

/** Canonical UI-to-worker ECMAScript flag projection. */
export function buildSearchFlags(options: SearchFlagOptions): SearchFlagResult {
	const other = options.otherFlags.trim();
	const seen = new Set<string>();
	for (const flag of other) {
		if (seen.has(flag)) return { ok: false, error: `Duplicate regular expression flag “${flag}”.` };
		seen.add(flag);
		if (flag === "g")
			return {
				ok: false,
				error: "Flag “g” is controlled by the Global search checkbox.",
			};
		if (flag === "i" || flag === "m" || flag === "s")
			return { ok: false, error: `Flag “${flag}” is controlled by the search checkboxes.` };
	}
	return {
		ok: true,
		flags: `${options.matchCase ? "" : "i"}${options.multiline ? "m" : ""}${options.dotAll ? "s" : ""}${other}`,
	};
}

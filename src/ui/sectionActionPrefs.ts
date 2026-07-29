export const SECTION_ACTION_OPTIONS = [
	{ id: "copy", label: "Copy contents", icon: "copy" },
	{ id: "edit", label: "Quick edit source", icon: "file-code" },
	{ id: "lightbox", label: "Edit source in lightbox", icon: "maximize-2" },
	{ id: "fields", label: "Edit callout or code details", icon: "sliders-horizontal" },
	{ id: "convert", label: "Convert section type", icon: "replace" },
	{ id: "combine", label: "Combine with an adjacent section", icon: "combine" },
	{ id: "uncombine", label: "Uncombine section", icon: "separator-horizontal" },
	{ id: "fold", label: "Fold section", icon: "chevrons-down-up" },
	{ id: "delete", label: "Delete section", icon: "trash-2" },
] as const;

export type SectionActionPreferenceId = (typeof SECTION_ACTION_OPTIONS)[number]["id"];

const KNOWN_IDS = new Set<string>(SECTION_ACTION_OPTIONS.map((option) => option.id));

export interface NormalizedSectionActionPrefs {
	hidden: SectionActionPreferenceId[];
	changed: boolean;
}

/** Hidden-list persistence is forward compatible: newly introduced actions are
 * visible by default, while stale or duplicate ids are discarded on load. */
export function normalizeHiddenSectionActions(value: unknown): NormalizedSectionActionPrefs {
	if (!Array.isArray(value)) return { hidden: [], changed: value !== undefined };
	const hidden: SectionActionPreferenceId[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !KNOWN_IDS.has(entry) || seen.has(entry)) continue;
		seen.add(entry);
		hidden.push(entry as SectionActionPreferenceId);
	}
	return {
		hidden,
		changed: hidden.length !== value.length || hidden.some((entry, index) => entry !== value[index]),
	};
}

/** Several contextual commands share one user-facing preference. For example,
 * all conversion destinations disappear together instead of exposing a brittle
 * checkbox for actions that are not valid for every section type. */
export function sectionActionPreferenceId(actionId: string): SectionActionPreferenceId | null {
	if (actionId === "copy" || actionId.startsWith("copy-")) return "copy";
	if (actionId.startsWith("convert-")) return "convert";
	if (actionId.startsWith("combine-")) return "combine";
	return KNOWN_IDS.has(actionId) ? (actionId as SectionActionPreferenceId) : null;
}

export function filterSectionActions<T extends { id: string }>(
	actions: readonly T[],
	hidden: ReadonlySet<string> | undefined,
): T[] {
	if (!hidden?.size) return [...actions];
	return actions.filter((action) => {
		const preferenceId = sectionActionPreferenceId(action.id);
		return preferenceId === null || !hidden.has(preferenceId);
	});
}

export type DockCopyTargetMode = "contextual" | "block" | "manual";
export type DockSurfaceMode = "theme" | "frosted" | "accent" | "custom";
export type DockActionId =
	"copy" | "save" | "undo" | "redo" | "history" | "revert" | "jump-top" | "jump-bottom" | "navigator" | "appearance";

export interface DockActionOption {
	id: DockActionId;
	label: string;
	icon: string;
}

export const DOCK_ACTION_OPTIONS: readonly DockActionOption[] = [
	{ id: "copy", label: "Copy current scope", icon: "copy" },
	{ id: "save", label: "Save version", icon: "save" },
	{ id: "undo", label: "Undo block edit", icon: "undo-2" },
	{ id: "redo", label: "Redo block edit", icon: "redo-2" },
	{ id: "history", label: "Version history", icon: "history" },
	{ id: "revert", label: "Revert to HEAD", icon: "rotate-ccw" },
	{ id: "jump-top", label: "Jump to block top", icon: "arrow-up-to-line" },
	{ id: "jump-bottom", label: "Jump to block bottom", icon: "arrow-down-to-line" },
	{ id: "navigator", label: "Object navigator", icon: "list-tree" },
	{ id: "appearance", label: "Block appearance", icon: "palette" },
] as const;

export const DEFAULT_DOCK_ACTION_LAYOUT: readonly DockActionId[] = [
	"copy",
	"save",
	"undo",
	"redo",
	"history",
	"revert",
	"jump-top",
	"jump-bottom",
] as const;

const validActionIds = new Set<DockActionId>(DOCK_ACTION_OPTIONS.map((option) => option.id));

/** Normalize persisted configuration without turning omission into disablement
 * for users upgrading from a build that did not yet store a dock layout. */
export function normalizeDockActionLayout(value: unknown): DockActionId[] {
	if (!Array.isArray(value)) return [...DEFAULT_DOCK_ACTION_LAYOUT];
	const normalized: DockActionId[] = [];
	const seen = new Set<DockActionId>();
	for (const candidate of value) {
		if (typeof candidate !== "string" || !validActionIds.has(candidate as DockActionId)) continue;
		const id = candidate as DockActionId;
		if (seen.has(id)) continue;
		seen.add(id);
		normalized.push(id);
	}
	return normalized;
}

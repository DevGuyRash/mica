import type { CustomTool } from "./toolSpec";

export interface NormalizedCustomToolConfig {
	customTools: CustomTool[];
	toolbarLayout: string[];
	changed: boolean;
}

/** Repair legacy name-derived ID collisions deterministically. Distinct old
 * IDs keep their first spelling; duplicate occurrences receive a suffix that
 * cannot collide with any pre-existing ID. Repeated layout references follow
 * duplicate tools in occurrence order. */
export function normalizeCustomToolConfig(
	customTools: readonly CustomTool[],
	toolbarLayout: readonly string[],
): NormalizedCustomToolConfig {
	const reserved = new Set(customTools.map((tool) => tool.id.trim()).filter(Boolean));
	const used = new Set<string>();
	const remapped = new Map<string, string[]>();
	let changed = false;
	const normalized = customTools.map((tool) => {
		const oldId = tool.id;
		const preferred = oldId.trim() || slug(tool.name) || "button";
		let id = preferred;
		if (used.has(id)) {
			for (let suffix = 2; ; suffix++) {
				const candidate = `${preferred}-${suffix}`;
				if (!used.has(candidate) && !reserved.has(candidate)) {
					id = candidate;
					break;
				}
			}
		}
		used.add(id);
		const ids = remapped.get(oldId) ?? [];
		ids.push(id);
		remapped.set(oldId, ids);
		const surface = tool.surface ?? "markdown";
		changed ||= id !== oldId || surface !== tool.surface;
		return { ...tool, id, surface };
	});

	const occurrences = new Map<string, number>();
	const layout = toolbarLayout.map((entry) => {
		if (!entry.startsWith("custom:")) return entry;
		const oldId = entry.slice("custom:".length);
		const ids = remapped.get(oldId);
		if (!ids?.length) return entry;
		const occurrence = occurrences.get(oldId) ?? 0;
		occurrences.set(oldId, occurrence + 1);
		const mapped = ids[Math.min(occurrence, ids.length - 1)];
		const next = `custom:${mapped}`;
		changed ||= next !== entry;
		return next;
	});
	return { customTools: normalized, toolbarLayout: layout, changed };
}

function slug(value: string): string {
	return value
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

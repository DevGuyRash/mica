import { TFile } from "obsidian";
import type MicaPlugin from "../main";
import { ensureIds, newId, scanBlocksView } from "../wasm/bridge";

/**
 * Ensure the note has a stable `mica-id` in frontmatter (written via
 * `processFrontMatter`, so it never clobbers an existing `uuid`). Returns the id.
 */
export async function ensureNoteId(plugin: MicaPlugin, file: TFile): Promise<string> {
	let id = "";
	await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		const current = fm["mica-id"];
		if (typeof current === "string" && current) {
			id = current;
			return;
		}
		id = newId();
		fm["mica-id"] = id;
	});
	return id;
}

/** Ensure every ` ```mica ` block carries an `id=`. Returns true if the note changed. */
export async function ensureBlockIds(plugin: MicaPlugin, file: TFile): Promise<boolean> {
	const initial = await plugin.app.vault.read(file);
	if (!scanBlocksView(initial).some((block) => !block.id)) return false;

	let changed = false;
	await plugin.app.vault.process(file, (doc) => {
		const next = ensureIds(doc);
		changed = next !== doc;
		return next;
	});
	return changed;
}
